"""Access to a running LabOrchestra server from scripts, notebooks and other devices."""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Any

from ._hub import Hub
from ._patch import PatchError, apply_patch
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
    def error(self) -> str | None:
        return self._info.get("error")

    async def call(self, action: str, *args: Any) -> Any:
        return await self._lab._call(self.id, action, args)

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
    def __init__(self, url: str | None = None, token: str | None = None):
        self.url = (url or os.environ.get("LABORCHESTRA_URL") or DEFAULT_URL).rstrip("/")
        self.token = token or os.environ.get("LABORCHESTRA_TOKEN")
        self._devices: dict[str, dict] = {}
        self._synced = asyncio.Event()
        self._hub = Hub(f"{self.url}/hub/control", self.token, on_connected=self._sync)
        self._hub.on("device")(self._on_device)
        self._hub.on("device_patch")(self._on_patch)
        self._resyncing: set[str] = set()
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

    async def close(self) -> None:
        await self._hub.close()

    async def __aenter__(self) -> "AsyncLab":
        return await self.connect()

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def _sync(self) -> None:
        self._devices = dict(await self._hub.invoke("get_devices"))
        self._synced.set()

    def _on_device(self, device_id: str, info: dict) -> None:
        self._devices[device_id] = info

    def _on_patch(self, device_id: str, revision: int, patch: dict) -> None:
        info = self._devices.get(device_id)
        if info and info.get("state") is not None and info.get("revision", -1) + 1 == revision:
            try:
                apply_patch(info["state"], patch)
                info["revision"] = revision
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
        except Exception:
            pass  # the next change or reconnect brings it back
        finally:
            self._resyncing.discard(device_id)

    async def _call(self, device_id: str, action: str, args: tuple) -> Any:
        return await self._hub.invoke("action", device_id, action, list(args), timeout=None)

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


class SyncDevice:
    def __init__(self, lab: "Lab", device_id: str):
        self._lab = lab
        self._device = AsyncDevice(lab._async, device_id)
        self.id = device_id

    state = property(lambda self: self._device.state)
    status = property(lambda self: self._device.status)
    schema = property(lambda self: self._device.schema)
    error = property(lambda self: self._device.error)

    def call(self, action: str, *args: Any) -> Any:
        return self._lab._run(self._device.call(action, *args))

    def logs(self, level: str | None = None, since: int = 0, limit: int = 200) -> list[dict]:
        return self._lab._run(self._device.logs(level, since, limit))

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

    def __init__(self, url: str | None = None, token: str | None = None, timeout: float = 10):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="laborchestra-lab", daemon=True)
        self._thread.start()
        self._async: AsyncLab = self._run(self._create(url, token, timeout))

    @staticmethod
    async def _create(url, token, timeout) -> AsyncLab:
        return await AsyncLab(url, token).connect(timeout)

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

    @property
    def devices(self) -> list[str]:
        return self._async.devices

    def __getitem__(self, device_id: str) -> SyncDevice:
        return SyncDevice(self, device_id)

    def __getattr__(self, name: str) -> SyncDevice:
        if name.startswith("_"):
            raise AttributeError(name)
        return SyncDevice(self, name)


def connect(url: str | None = None, token: str | None = None, timeout: float = 10) -> Lab:
    """Connect to the server (``LABORCHESTRA_URL`` / ``LABORCHESTRA_TOKEN`` if not given)."""
    return Lab(url, token, timeout)


async def connect_async(url: str | None = None, token: str | None = None, timeout: float = 10) -> AsyncLab:
    return await AsyncLab(url, token).connect(timeout)
