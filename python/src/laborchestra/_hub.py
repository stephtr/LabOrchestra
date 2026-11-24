"""Minimal asyncio client for the SignalR MessagePack protocol.

Supports invocations in both directions with results and errors (``client results``), binary
payloads, automatic reconnect and a callback after every (re)connect. No negotiation: it speaks
WebSocket directly.
"""

from __future__ import annotations

import asyncio
import inspect
import itertools
import json
import logging
import traceback
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

import msgpack
import websockets
from websockets.exceptions import InvalidStatus, WebSocketException

from .errors import AuthError, ConnectionLost, RemoteError

log = logging.getLogger("laborchestra.hub")
_RS = b"\x1e"


def _default(obj: Any) -> Any:
    if hasattr(obj, "tolist"):  # numpy arrays and scalars
        return obj.tolist()
    if hasattr(obj, "item"):
        return obj.item()
    raise TypeError(f"Cannot serialize {type(obj).__name__}")


def _pack(message: list) -> bytes:
    body = msgpack.packb(message, default=_default)
    n, prefix = len(body), bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        prefix.append(b | (0x80 if n else 0))
        if not n:
            return bytes(prefix) + body


def _unpack(raw: bytes):
    offset = 0
    while offset < len(raw):
        n = shift = 0
        while True:
            b = raw[offset]
            offset += 1
            n |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        yield msgpack.unpackb(raw[offset : offset + n], strict_map_key=False)
        offset += n


def _ws_url(url: str) -> str:
    parts = urlsplit(url)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, ""))


def error_text(exc: BaseException) -> str:
    """The error as it is sent to the caller: JSON with type, message and traceback."""
    if isinstance(exc, RemoteError):
        return json.dumps({"type": exc.type, "message": exc.message, "traceback": exc.traceback})
    return json.dumps(
        {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": "".join(traceback.format_exception(exc)),
        }
    )


class Hub:
    def __init__(
        self,
        url: str,
        token: str | None = None,
        *,
        on_connected: Callable[[], Awaitable[None]] | None = None,
        retry_delay: float = 0.5,
    ):
        self.url = _ws_url(url)
        self.token = token
        self.connects = 0
        self.fatal: Exception | None = None
        self._on_connected = on_connected
        self._retry_delay = retry_delay
        self._handlers: dict[str, Callable] = {}
        self._pending: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._connected = asyncio.Event()
        self._ws = None
        self._task: asyncio.Task | None = None

    def on(self, name: str):
        def register(fn):
            self._handlers[name] = fn
            return fn

        return register

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="hub")

    async def wait_connected(self, timeout: float | None = None) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout)
        if self.fatal:
            raise self.fatal

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set() and not self.fatal

    async def invoke(self, target: str, *args: Any, timeout: float | None = 30) -> Any:
        await self.wait_connected()
        iid = str(next(self._ids))
        future = self._pending[iid] = asyncio.get_running_loop().create_future()
        try:
            await self._ws.send(_pack([1, {}, iid, target, list(args), []]))
            return await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(iid, None)

    async def send(self, target: str, *args: Any) -> None:
        await self.wait_connected()
        await self._ws.send(_pack([1, {}, None, target, list(args), []]))

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        while True:
            try:
                headers = {"Authorization": f"Bearer {self.token}"} if self.token else None
                async with websockets.connect(
                    self.url, additional_headers=headers, max_size=None, compression=None, open_timeout=10
                ) as ws:
                    await ws.send(json.dumps({"protocol": "messagepack", "version": 1}) + "\x1e")
                    raw = await ws.recv()
                    head, _, rest = (raw.encode() if isinstance(raw, str) else raw).partition(_RS)
                    if error := json.loads(head).get("error"):
                        self.fatal = ConnectionError(f"Server rejected the handshake: {error}")
                        self._connected.set()
                        return
                    self._ws = ws
                    self.connects += 1
                    self._connected.set()
                    background = {asyncio.create_task(self._ping(ws))}
                    if self._on_connected:
                        background.add(asyncio.create_task(self._safe(self._on_connected())))
                    try:
                        for message in _unpack(rest):
                            self._dispatch(ws, message, background)
                        async for raw in ws:
                            for message in _unpack(raw):
                                if self._dispatch(ws, message, background) == "close":
                                    raise ConnectionError("closed by server")
                    finally:
                        for task in background:
                            task.cancel()
            except InvalidStatus as e:
                if e.response.status_code in (401, 403):
                    self.fatal = AuthError(f"The server rejected the token (HTTP {e.response.status_code})")
                    self._connected.set()
                    return
                log.warning("Connection failed: %s", e)
            except (OSError, WebSocketException, ConnectionError, asyncio.TimeoutError) as e:
                log.debug("Connection lost: %s", e)
            self._connected.clear()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionLost("Connection lost"))
            self._pending.clear()
            await asyncio.sleep(self._retry_delay)

    async def _safe(self, coroutine) -> None:
        try:
            await coroutine
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Error after connecting")

    async def _ping(self, ws) -> None:
        while True:
            await asyncio.sleep(10)
            await ws.send(_pack([6]))

    def _dispatch(self, ws, message: list, background: set) -> str | None:
        kind = message[0]
        if kind == 1:  # invocation
            task = asyncio.create_task(self._handle(ws, message[2], message[3], message[4]))
            background.add(task)
            task.add_done_callback(background.discard)
        elif kind == 3:  # completion
            future = self._pending.get(message[2])
            if future and not future.done():
                if message[3] == 1:
                    future.set_exception(RemoteError.parse(message[4]))
                else:
                    future.set_result(message[4] if message[3] == 3 else None)
        elif kind == 7:
            return "close"
        return None

    async def _handle(self, ws, iid: str | None, target: str, args: list) -> None:
        try:
            handler = self._handlers.get(target)
            if handler is None:
                raise LookupError(f"No handler for '{target}'")
            result = handler(*args)
            if inspect.isawaitable(result):
                result = await result
            # always a result (possibly null): SignalR rejects a void completion for a call that expects a result
            reply = [3, {}, iid, 3, result]
        except Exception as e:
            if iid is None:
                log.exception("Error in handler '%s'", target)
            reply = [3, {}, iid, 1, error_text(e)]
        if iid is not None:
            try:
                await ws.send(_pack(reply))
            except WebSocketException:
                pass
