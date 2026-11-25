"""Access to a running LabOrchestra server from scripts, notebooks and other devices."""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Any

from ._hub import Hub
from ._patch import PatchError, apply_patch
from .stream import AsyncStream, SyncStream
from .errors import LabOrchestraError

DEFAULT_URL = "http://127.0.0.1:5095"


class AsyncDevice:
    def __init__(self, lab: "AsyncLab", device_id: str):
        self._lab = lab
        self.id = device_id

    @property
    def _info(self) -> dict:
        try:
            return self._lab._devices[self.id]
        except KeyError:
            raise LabOrchestraError(f"Device '{self.id}' does not exist (devices: {', '.join(self._lab.devices)})") from None

    @property
    def state(self) -> dict:
        """Last known state (read-only, kept up to date by the server)."""
        return self._info["state"]

    @property
    def status(self) -> str:
        return self._info["status"]

    @property
    def schema(self) -> dict:
        return self._info["schema"]

    @property
    def changed(self) -> bool:
        """True when the device's file changed after it started: what runs is not what is on disk."""
        return bool(self._info.get("changed"))

    @property
    def error(self) -> str | None:
        return self._info.get("error")

    async def call(self, action: str, *args: Any) -> Any:
        return await self._lab._call(self.id, action, args)

    async def wait_for(self, predicate, timeout: float = 30) -> dict:
        """Wait until the device is ready and ``predicate(state)`` is true; returns the state. Raises TimeoutError."""
        return await self._lab._wait_for(self.id, predicate, timeout)

    async def wait_ready(self, timeout: float = 30) -> dict:
        """Wait until the device is ready (registered and running); returns its state."""
        return await self._lab._wait_for(self.id, lambda state: True, timeout)

    async def restart(self) -> None:
        """Stop the worker of this device and start it again."""
        await self._lab.restart_device(self.id)

    async def logs(self, level: str | None = None, since: int = 0, limit: int = 200) -> list[dict]:
        """Log entries of this device (see AsyncLab.logs)."""
        return await self._lab.logs(f"device:{self.id}", level, since, limit)

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        names = [a["name"] for a in (self._info.get("schema") or {}).get("actions", [])]
        if name not in names:
            raise AttributeError(f"Device '{self.id}' has no action '{name}' (actions: {', '.join(names)})")

        async def call(*args: Any) -> Any:
            return await self._lab._call(self.id, name, args)

        call.__name__ = name
        return call

    def __repr__(self) -> str:
        return f"<device {self.id}>"


class AsyncLab:
    def __init__(self, url: str | None = None, token: str | None = None, name: str = "script"):
        self.url = (url or os.environ.get("LABORCHESTRA_URL") or DEFAULT_URL).rstrip("/")
        self.token = token or os.environ.get("LABORCHESTRA_TOKEN")
        self._devices: dict[str, dict] = {}
        self._synced = asyncio.Event()
        self._hub = Hub(f"{self.url}/hub/control?client={name}", self.token, on_connected=self._sync)  # name: who changes things
        self._hub.on("device")(self._on_device)
        self._hub.on("device_patch")(self._on_patch)
        self._resyncing: set[str] = set()
        self._waiters: list[asyncio.Future] = []
        self._subscriptions: dict[str, AsyncStream] = {}
        self._streams_hub: Hub | None = None
        self._name = name
        self._hub.on("device_removed")(lambda device_id: self._devices.pop(device_id, None) and None)

    async def connect(self, timeout: float = 10) -> "AsyncLab":
        await self._hub.start()
        try:
            await self._hub.wait_connected(timeout)
            await asyncio.wait_for(self._synced.wait(), timeout)
        except asyncio.TimeoutError:
            await self._hub.close()
            raise LabOrchestraError(f"Could not connect to {self.url} within {timeout} s") from None
        except BaseException:
            await self._hub.close()
            raise
        return self

    async def _stream_hub(self) -> Hub:
        """The second connection, for frames; made when the first stream is opened."""
        if self._streams_hub is None:
            self._streams_hub = Hub(f"{self.url}/hub/streaming?client={self._name}", self.token, on_connected=self._resubscribe)
            self._streams_hub.on("frame")(self._on_frame)
            await self._streams_hub.start()
        await self._streams_hub.wait_connected(10)
        return self._streams_hub

    def _on_frame(self, subscription: str, sequence: int, meta: dict, data: bytes) -> None:
        if (stream := self._subscriptions.get(subscription)) is not None:
            stream._on_frame(sequence, meta, data)

    async def _resubscribe(self) -> None:
        """After a reconnect the server knows nothing of our subscriptions: subscribe again."""
        for old_id, stream in list(self._subscriptions.items()):
            if self._streams_hub is not None and stream._id == old_id and self._streams_hub.connects > 1:
                self._subscriptions.pop(old_id)
                await stream._subscribe()

    def stream(self, device: str, stream: str, parameters: dict | None = None, window: int = 8, max_fps: float = 30) -> AsyncStream:
        """``async with lab.stream("het", "display", {...}) as frames: async for frame in frames:`` (see laborchestra.stream)."""
        return AsyncStream(self, device, stream, parameters, window, max_fps)

    async def close(self) -> None:
        if self._streams_hub is not None:
            await self._streams_hub.close()
        await self._hub.close()

    async def __aenter__(self) -> "AsyncLab":
        return await self.connect()

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def _sync(self) -> None:
        self._devices = dict(await self._hub.invoke("get_devices"))
        self._wake()
        self._synced.set()

    def _wake(self) -> None:
        waiters, self._waiters = self._waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    async def _wait_for(self, device_id: str, predicate, timeout: float) -> dict:
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while True:
            info = self._devices.get(device_id)
            if info is not None and info.get("status") in ("ready", "degraded") and info.get("state") is not None and predicate(info["state"]):
                return info["state"]
            remaining = end - loop.time()
            if remaining <= 0:
                status = info.get("status") if info else "missing"
                raise TimeoutError(f"Device '{device_id}' ({status}) did not get there within {timeout} s")
            waiter = loop.create_future()  # no change can slip in between the check above and this registration
            self._waiters.append(waiter)
            try:
                await asyncio.wait_for(waiter, remaining)
            except asyncio.TimeoutError:
                pass

    def _on_device(self, device_id: str, info: dict) -> None:
        self._devices[device_id] = info
        self._wake()

    def _on_patch(self, device_id: str, revision: int, patch: dict) -> None:
        info = self._devices.get(device_id)
        if info and info.get("state") is not None and info.get("revision", -1) + 1 == revision:
            try:
                apply_patch(info["state"], patch)
                info["revision"] = revision
                self._wake()
                return
            except PatchError:
                pass
        # a patch was missed or does not fit: fetch the whole device again
        if device_id not in self._resyncing:
            self._resyncing.add(device_id)
            asyncio.get_running_loop().create_task(self._resync(device_id))

    async def _resync(self, device_id: str) -> None:
        try:
            self._devices[device_id] = await self._hub.invoke("get_device", device_id)
            self._wake()
        except Exception:
            pass  # the next change or reconnect brings it back
        finally:
            self._resyncing.discard(device_id)

    async def _call(self, device_id: str, action: str, args: tuple) -> Any:
        return await self._hub.invoke("action", device_id, action, list(args), timeout=None)

    async def get_recording(self) -> dict:
        """{"active": False} or name, start_time, elapsed_s, events, tags of the running recording."""
        return await self._hub.invoke("get_recording")

    async def start_recording(self, name: str, tags: dict | None = None) -> dict:
        """Start recording every change of every device (and the data streams) under this name."""
        return await self._hub.invoke("start_recording", name, tags)

    async def stop_recording(self) -> dict:
        return await self._hub.invoke("stop_recording")

    async def abort_recording(self, discard: bool = False) -> dict:
        return await self._hub.invoke("abort_recording", discard)

    async def snapshot(self, name: str, tags: dict | None = None) -> dict:
        """Save the state of all devices now, in one file."""
        return await self._hub.invoke("snapshot", name, tags)

    async def list_recordings(self, limit: int = 100) -> list[dict]:
        return await self._hub.invoke("list_recordings", limit)

    def recording(self, name: str, tags: dict | None = None) -> "_AsyncRecording":
        """``async with lab.recording("scan 1", tags={...}):`` starts and, even after an error, stops it."""
        return _AsyncRecording(self, name, tags)

    async def restart_device(self, device_id: str) -> None:
        await self._hub.invoke("restart_device", device_id)

    async def list_device_files(self) -> list[dict]:
        """Python files of the workspace with the ids of the devices that use them: {"file", "devices"}."""
        return await self._hub.invoke("list_device_files")

    async def describe_device_file(self, file: str) -> dict:
        """What a device file offers, without starting it: class, doc, options (name, type, default, required), actions."""
        return await self._hub.invoke("describe_device_file", file, timeout=180)

    @staticmethod
    def _device_entry(file, config, python, description, driver=None, remote=None) -> dict:
        entry = {"file": file, "driver": driver, "config": config, "python": python, "description": description, "remote": remote or None}
        return {k: v for k, v in entry.items() if v is not None}

    async def list_drivers(self) -> list[dict]:
        """C# drivers that can be used with ``driver=``: driver, class, doc."""
        return await self._hub.invoke("list_drivers")

    async def describe_driver(self, driver: str) -> dict:
        return await self._hub.invoke("describe_driver", driver)

    async def add_device(self, device_id: str, file: str | None = None, config: dict | None = None, python: str | None = None, description: str | None = None, driver: str | None = None, remote: bool = False) -> None:
        """Add a device to devices.json and start it: a Python ``file``, a C# ``driver``, or ``remote=True`` for a worker on another machine
        (then ``create_token`` gives that worker its token). ``config`` holds its options; a value ``{"secret": "name"}`` refers to a secret."""
        await self._hub.invoke("add_device", device_id, self._device_entry(file, config, python, description, driver, remote))

    async def list_environments(self) -> list[dict]:
        """The Python environments of the devices: key, python, dependencies, size_mb, last_used (unix time), used_by (device ids)."""
        return await self._hub.invoke("list_environments")

    async def cleanup_environments(self, older_than_days: int = 30) -> list[dict]:
        """Delete environments that no device runs in and that were not used for ``older_than_days`` days; returns those removed."""
        return await self._hub.invoke("cleanup_environments", older_than_days)

    async def list_pythons(self) -> list[dict]:
        """Pythons on this computer that a device may use (``python=`` of ``add_device``): version, path, implementation."""
        return await self._hub.invoke("list_pythons")

    async def create_token(self, device_id: str, label: str | None = None) -> dict:
        """A token for a worker on another machine that runs the remote device ``device_id``. Returns ``{"token", "id", ...}``; the token is
        shown only now. Start the worker with ``laborchestra-worker device.py --id <device_id> --url <server> --token <token>``."""
        return await self._hub.invoke("create_token", device_id, label)

    async def list_tokens(self) -> list[dict]:
        return await self._hub.invoke("list_tokens")

    async def revoke_token(self, token_id: str) -> None:
        await self._hub.invoke("revoke_token", token_id)

    async def update_device(self, device_id: str, file: str | None = None, config: dict | None = None, python: str | None = None, description: str | None = None, driver: str | None = None) -> None:
        """Replace the entry of a device (it restarts if anything but the description changed)."""
        await self._hub.invoke("update_device", device_id, self._device_entry(file, config, python, description, driver))

    async def remove_device(self, device_id: str) -> None:
        await self._hub.invoke("remove_device", device_id)

    async def get_device_config(self, device_id: str) -> dict:
        """The entry of devices.json: file, python, config, description."""
        return await self._hub.invoke("get_device_config", device_id)

    async def list_secrets(self) -> list[str]:
        """Names of the stored secrets (their values are never sent back)."""
        return await self._hub.invoke("list_secrets")

    async def set_secret(self, name: str, value: str) -> None:
        """Store a secret; devices whose config has {"secret": name} are restarted."""
        await self._hub.invoke("set_secret", name, value)

    async def delete_secret(self, name: str) -> None:
        await self._hub.invoke("delete_secret", name)

    async def events(self, device: str | None = None, kind: str | None = None, since: float = 0, until: float = 0, limit: int = 500) -> list[dict]:
        """What happened to devices, oldest first (persistent, also when nothing was recording): ``kind`` is "action" (data: action, args)
        or "status" (data: status, error); ``by`` says who caused it. ``since``/``until`` are unix times."""
        return await self._hub.invoke("get_events", device, kind, since, until, limit)

    async def history(self, device: str, path: str, since: float = 0, until: float = 0, max_points: int = 1000) -> list[list[float]]:
        """A numeric state field over time as [unix time, value] pairs, e.g. ``history("pressure", "channels.1.pressure", since=time.time() - 86400)``.
        The server keeps one value per field per ten seconds for 30 days; longer series are averaged into ``max_points``."""
        return await self._hub.invoke("get_history", device, path, since, until, max_points)

    async def add_note(self, text: str, refs: list[str] | None = None) -> str:
        """A note, optionally pointing at devices, recordings or other ids (``refs``); returns its id."""
        return await self._hub.invoke("add_note", text, refs or [])

    async def notes(self, ref: str | None = None, since: float = 0, limit: int = 200) -> list[dict]:
        """Notes (id, time, author, text, refs), oldest first; with ``ref`` only those that point at it."""
        return await self._hub.invoke("get_notes", ref, since, limit)

    async def logs(self, source: str | None = None, level: str | None = None, since: int = 0, limit: int = 200) -> list[dict]:
        """Log entries as dicts (seq, time, level, source, logger, message, traceback).

        ``source`` is "server", "device:<id>" or None for all. With ``since=0`` you get the latest entries,
        otherwise the entries after that ``seq``, so that ``since=entries[-1]["seq"]`` follows the log.
        """
        return await self._hub.invoke("get_logs", source, level, since, limit)

    @property
    def devices(self) -> list[str]:
        return list(self._devices)

    def __getitem__(self, device_id: str) -> AsyncDevice:
        return AsyncDevice(self, device_id)

    def __getattr__(self, name: str) -> AsyncDevice:
        if name.startswith("_"):
            raise AttributeError(name)
        return AsyncDevice(self, name)


class _AsyncRecording:
    def __init__(self, lab: AsyncLab, name: str, tags: dict | None):
        self._lab, self._name, self._tags = lab, name, tags

    async def __aenter__(self) -> AsyncLab:
        await self._lab.start_recording(self._name, self._tags)
        return self._lab

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._lab.stop_recording()


class _Recording:
    def __init__(self, lab: "Lab", name: str, tags: dict | None):
        self._lab, self._name, self._tags = lab, name, tags

    def __enter__(self) -> "Lab":
        self._lab.start_recording(self._name, self._tags)
        return self._lab

    def __exit__(self, exc_type, exc, tb) -> None:
        self._lab.stop_recording()


class SyncDevice:
    def __init__(self, lab: "Lab", device_id: str):
        self._lab = lab
        self._device = AsyncDevice(lab._async, device_id)
        self.id = device_id

    state = property(lambda self: self._device.state)
    status = property(lambda self: self._device.status)
    schema = property(lambda self: self._device.schema)
    error = property(lambda self: self._device.error)
    changed = property(lambda self: self._device.changed)

    def call(self, action: str, *args: Any) -> Any:
        return self._lab._run(self._device.call(action, *args))

    def logs(self, level: str | None = None, since: int = 0, limit: int = 200) -> list[dict]:
        return self._lab._run(self._device.logs(level, since, limit))

    def restart(self) -> None:
        self._lab._run(self._device.restart())

    def wait_for(self, predicate, timeout: float = 30) -> dict:
        """Wait until the device is ready and ``predicate(state)`` is true; returns the state. Raises TimeoutError."""
        return self._lab._run(self._device.wait_for(predicate, timeout))

    def wait_ready(self, timeout: float = 30) -> dict:
        return self._lab._run(self._device.wait_ready(timeout))

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        async_call = getattr(self._device, name)

        def call(*args: Any) -> Any:
            return self._lab._run(async_call(*args))

        call.__name__ = name
        return call

    def __repr__(self) -> str:
        return f"<device {self.id}>"


class Lab:
    """Blocking client. ``lab = laborchestra.connect()``, then ``lab.pressure.state``."""

    def __init__(self, url: str | None = None, token: str | None = None, timeout: float = 10, name: str = "script"):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="laborchestra-lab", daemon=True)
        self._thread.start()
        self._async: AsyncLab = self._run(self._create(url, token, timeout, name))

    @staticmethod
    async def _create(url, token, timeout, name) -> AsyncLab:
        return await AsyncLab(url, token, name).connect(timeout)

    def _run(self, coroutine, timeout: float | None = None):
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result(timeout)

    def close(self) -> None:
        if self._loop.is_running():
            try:
                self._run(self._async.close(), 5)
            finally:
                self._loop.call_soon_threadsafe(self._loop.stop)
                self._thread.join(5)

    def __enter__(self) -> "Lab":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def logs(self, source: str | None = None, level: str | None = None, since: int = 0, limit: int = 200) -> list[dict]:
        return self._run(self._async.logs(source, level, since, limit))

    def events(self, device: str | None = None, kind: str | None = None, since: float = 0, until: float = 0, limit: int = 500) -> list[dict]:
        return self._run(self._async.events(device, kind, since, until, limit))

    def history(self, device: str, path: str, since: float = 0, until: float = 0, max_points: int = 1000) -> list[list[float]]:
        return self._run(self._async.history(device, path, since, until, max_points))

    def add_note(self, text: str, refs: list[str] | None = None) -> str:
        return self._run(self._async.add_note(text, refs))

    def notes(self, ref: str | None = None, since: float = 0, limit: int = 200) -> list[dict]:
        return self._run(self._async.notes(ref, since, limit))

    def stream(self, device: str, stream: str, parameters: dict | None = None, window: int = 8, max_fps: float = 30) -> SyncStream:
        """``with lab.stream("het", "display", {...}) as frames: for frame in frames:`` (see laborchestra.stream)."""
        return SyncStream(self, self._async.stream(device, stream, parameters, window, max_fps))

    def get_recording(self) -> dict:
        return self._run(self._async.get_recording())

    def start_recording(self, name: str, tags: dict | None = None) -> dict:
        return self._run(self._async.start_recording(name, tags))

    def stop_recording(self) -> dict:
        return self._run(self._async.stop_recording())

    def abort_recording(self, discard: bool = False) -> dict:
        return self._run(self._async.abort_recording(discard))

    def snapshot(self, name: str, tags: dict | None = None) -> dict:
        return self._run(self._async.snapshot(name, tags))

    def list_recordings(self, limit: int = 100) -> list[dict]:
        return self._run(self._async.list_recordings(limit))

    def recording(self, name: str, tags: dict | None = None) -> _Recording:
        """``with lab.recording("scan 1", tags={...}):`` starts and, even after an error, stops it."""
        return _Recording(self, name, tags)

    def restart_device(self, device_id: str) -> None:
        self._run(self._async.restart_device(device_id))

    def list_device_files(self) -> list[dict]:
        return self._run(self._async.list_device_files())

    def describe_device_file(self, file: str) -> dict:
        return self._run(self._async.describe_device_file(file))

    def list_drivers(self) -> list[dict]:
        return self._run(self._async.list_drivers())

    def describe_driver(self, driver: str) -> dict:
        return self._run(self._async.describe_driver(driver))

    def add_device(self, device_id: str, file: str | None = None, config: dict | None = None, python: str | None = None, description: str | None = None, driver: str | None = None, remote: bool = False) -> None:
        self._run(self._async.add_device(device_id, file, config, python, description, driver, remote))

    def list_environments(self) -> list[dict]:
        return self._run(self._async.list_environments())

    def cleanup_environments(self, older_than_days: int = 30) -> list[dict]:
        return self._run(self._async.cleanup_environments(older_than_days))

    def list_pythons(self) -> list[dict]:
        return self._run(self._async.list_pythons())

    def create_token(self, device_id: str, label: str | None = None) -> dict:
        return self._run(self._async.create_token(device_id, label))

    def list_tokens(self) -> list[dict]:
        return self._run(self._async.list_tokens())

    def revoke_token(self, token_id: str) -> None:
        self._run(self._async.revoke_token(token_id))

    def update_device(self, device_id: str, file: str | None = None, config: dict | None = None, python: str | None = None, description: str | None = None, driver: str | None = None) -> None:
        self._run(self._async.update_device(device_id, file, config, python, description, driver))

    def remove_device(self, device_id: str) -> None:
        self._run(self._async.remove_device(device_id))

    def get_device_config(self, device_id: str) -> dict:
        return self._run(self._async.get_device_config(device_id))

    def list_secrets(self) -> list[str]:
        return self._run(self._async.list_secrets())

    def set_secret(self, name: str, value: str) -> None:
        self._run(self._async.set_secret(name, value))

    def delete_secret(self, name: str) -> None:
        self._run(self._async.delete_secret(name))

    @property
    def devices(self) -> list[str]:
        return self._async.devices

    def __getitem__(self, device_id: str) -> SyncDevice:
        return SyncDevice(self, device_id)

    def __getattr__(self, name: str) -> SyncDevice:
        if name.startswith("_"):
            raise AttributeError(name)
        return SyncDevice(self, name)


def connect(url: str | None = None, token: str | None = None, timeout: float = 10, name: str = "script") -> Lab:
    """Connect to the server (``LABORCHESTRA_URL`` / ``LABORCHESTRA_TOKEN`` if not given).

    ``name`` says who you are in the record of changes ("script", or e.g. "notebook").
    """
    return Lab(url, token, timeout, name)


async def connect_async(url: str | None = None, token: str | None = None, timeout: float = 10, name: str = "script") -> AsyncLab:
    return await AsyncLab(url, token, name).connect(timeout)
