"""Streams of devices (traces, spectra): frames come to you as fast as you take them, never faster.

    with lab.stream("het", "display", {"x_min": 0, "x_max": 5e6}) as frames:
        for frame in frames:
            frame.sequence, frame.meta, frame.array   # array: float32 numpy array (numpy is optional)

A frame counts as processed when you take the next one. The server keeps the frame rate for as long as you keep up, also over a
link with a long round trip (the number of frames on their way grows with the round trip time; ``window`` is the least). If you
fall behind, at most two frames wait for you (plus those that the distance has put on the way) instead of an ever longer backlog.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Frame:
    sequence: int
    meta: dict
    data: bytes
    _array: Any = field(default=None, repr=False)

    @property
    def array(self):
        """The data as a float32 numpy array (little endian)."""
        if self._array is None:
            import numpy as np

            self._array = np.frombuffer(self.data, dtype="<f4")
        return self._array

    def values(self) -> list[float]:
        """The data as a list of floats (no numpy needed)."""
        import array
        import sys

        a = array.array("f", self.data)
        if sys.byteorder == "big":
            a.byteswap()
        return a.tolist()


class AsyncStream:
    def __init__(self, lab, device: str, stream: str, parameters: dict | None, window: int, max_fps: float):
        self._lab = lab
        self.device, self.stream = device, stream
        self._parameters = parameters or {}
        self._window, self._max_fps = window, max_fps
        self._queue: asyncio.Queue = asyncio.Queue()
        self._id: str | None = None
        self._pending_ack: tuple[str, int] | None = None
        self._closed = False

    async def _subscribe(self) -> None:
        hub = await self._lab._stream_hub()
        self._id = await hub.invoke("subscribe", self.device, self.stream, self._parameters, self._window, self._max_fps)
        self._lab._subscriptions[self._id] = self

    async def __aenter__(self) -> "AsyncStream":
        await self._subscribe()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._id is not None:
            self._lab._subscriptions.pop(self._id, None)
            try:
                await (await self._lab._stream_hub()).invoke("unsubscribe", self._id, timeout=5)
            except Exception:
                pass

    async def update(self, parameters: dict) -> None:
        """Ask for another view (e.g. another range); the next frame has it."""
        self._parameters = parameters
        await (await self._lab._stream_hub()).invoke("update", self._id, parameters)

    async def stats(self) -> dict:
        """What the server knows about this subscription: sent, acked, skipped (frames replaced by newer ones), rtt_ms."""
        hub = await self._lab._stream_hub()
        return next((s for s in await hub.invoke("get_stats") if s["subscription"] == self._id), {})

    def __aiter__(self) -> "AsyncStream":
        return self

    async def __anext__(self) -> Frame:
        if self._pending_ack is not None:  # the previous frame is done with: the server may send another
            sub, sequence = self._pending_ack
            self._pending_ack = None
            await (await self._lab._stream_hub()).send("ack", sub, sequence)
        frame = await self._queue.get()
        self._pending_ack = (self._id, frame.sequence)
        return frame

    def _on_frame(self, sequence: int, meta: dict, data: bytes) -> None:
        self._queue.put_nowait(Frame(sequence, meta, bytes(data)))
        # at once: this is how the server measures the distance to us (taking the frame may take much longer)
        if self._id is not None:
            asyncio.ensure_future(self._send_received(self._id, sequence))

    async def _send_received(self, subscription: str, sequence: int) -> None:
        try:
            await (await self._lab._stream_hub()).send("received", subscription, sequence)
        except Exception:
            pass


class SyncStream:
    """The blocking version: ``for frame in stream`` waits for the next frame."""

    def __init__(self, lab, stream: AsyncStream):
        self._lab, self._stream = lab, stream

    def __enter__(self) -> "SyncStream":
        self._lab._run(self._stream.__aenter__())
        return self

    def __exit__(self, *exc) -> None:
        self._lab._run(self._stream.close())

    def __iter__(self) -> "SyncStream":
        return self

    def __next__(self) -> Frame:
        return self._lab._run(self._stream.__anext__())

    def next(self, timeout: float) -> Frame:
        """The next frame; raises TimeoutError if none comes within ``timeout`` seconds."""
        try:
            return self._lab._run(asyncio.wait_for(self._stream.__anext__(), timeout))
        except asyncio.TimeoutError:
            raise TimeoutError(f"No frame within {timeout} s") from None

    def update(self, parameters: dict) -> None:
        self._lab._run(self._stream.update(parameters))

    def stats(self) -> dict:
        return self._lab._run(self._stream.stats())

    @property
    def queued(self) -> int:
        """Frames that arrived and were not taken yet (never more than ``window``)."""
        return self._stream._queue.qsize()
