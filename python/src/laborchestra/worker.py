"""Runs one device in its own process and connects it to the server.

    python -m laborchestra.worker path/to/device.py[:Class] --id my_device

Exit codes: 0 stopped, 1 runtime error, 2 configuration error, 3 had to be forced, 4 rejected by server.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import importlib.util
import inspect
import json
import logging
import os
import signal
import sys
import threading
from pathlib import Path
from typing import Any

from ._hub import Hub
from ._schema import (
    action_methods,
    action_schema,
    check_name,
    coerce,
    coerce_arguments,
    config_options,
    validate_state,
)
from ._state import plain
from .device import Device
from .errors import ConnectionLost, RemoteError, SchemaError
from .lab import DEFAULT_URL

EXIT_OK, EXIT_ERROR, EXIT_CONFIG, EXIT_FORCED, EXIT_AUTH = 0, 1, 2, 3, 4
log = logging.getLogger("laborchestra.worker")


def load_class(target: str) -> type[Device]:
    path, name = target, None
    head, sep, tail = target.rpartition(":")
    if sep and tail.isidentifier() and len(head) > 1:
        path, name = head, tail
    if path.endswith(".py") or os.path.isfile(path):
        file = Path(path).resolve()
        sys.path.insert(0, str(file.parent))
        spec = importlib.util.spec_from_file_location(f"lab_device_{file.stem}", file)
        if spec is None or spec.loader is None:
            raise SchemaError(f"Cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    else:
        module = importlib.import_module(path)
    found = {
        n: c
        for n, c in vars(module).items()
        if isinstance(c, type) and issubclass(c, Device) and c is not Device and c.__module__ == module.__name__
    }
    if name:
        if name not in found:
            raise SchemaError(f"{path} has no Device class '{name}' (found: {', '.join(found) or 'none'})")
        return found[name]
    if len(found) != 1:
        raise SchemaError(
            f"{path} must define exactly one Device subclass, or select it as file.py:Class (found: {', '.join(found) or 'none'})"
        )
    return next(iter(found.values()))


def build_schema(device_id: str, cls: type[Device], actions: dict) -> dict:
    for key in cls.persist:
        check_name(key, "Persisted state key")
    return {
        "id": device_id,
        "class": cls.__name__,
        "doc": inspect.cleandoc(cls.__doc__) if cls.__doc__ else None,
        "config": config_options(cls, Device),
        "actions": [action_schema(n, f) for n, f in sorted(actions.items())],
        "persist": list(cls.persist),
    }


def coerce_config(cls: type[Device], config: dict) -> dict:
    options = {o["name"]: o for o in config_options(cls, Device)}
    unknown = sorted(set(config) - set(options))
    if unknown:
        raise SchemaError(f"Unknown option(s): {', '.join(unknown)} (available: {', '.join(options) or 'none'})")
    missing = [n for n, o in options.items() if o["required"] and n not in config]
    if missing:
        raise SchemaError(f"Missing required option(s): {', '.join(missing)}")
    return {
        n: coerce(v, options[n]["type"], f"Option '{n}'", allow_none=options[n]["default"] is None)
        for n, v in config.items()
    }


class Worker:
    def __init__(self, target: str, device_id: str, url: str, token: str | None, config: dict, watch_stdin: bool):
        self.target, self.device_id, self.url, self.token = target, device_id, url.rstrip("/"), token
        self.config, self.watch_stdin = config, watch_stdin
        self.exit_code = EXIT_OK
        self._registered_gen = 0
        self._run_thread: threading.Thread | None = None
        self._run_task: asyncio.Task | None = None

    # ---------------------------------------------------------------------------------------
    def run(self) -> int:
        try:
            self._prepare()
        except Exception as e:
            log.error("Cannot start %s: %s", self.device_id, e, exc_info=not isinstance(e, (SchemaError, TypeError)))
            return EXIT_CONFIG
        return asyncio.run(self._main())

    def _prepare(self) -> None:
        cls = load_class(self.target)
        self.actions = action_methods(cls)
        self.schema = build_schema(self.device_id, cls, self.actions)
        config = coerce_config(cls, self.config)
        self.device = cls()
        self.device._setup(self.device_id, config, self._make_lab)
        validate_state(plain(self.device.state))

    def _make_lab(self):
        from .lab import Lab

        return Lab(self.url, self.token)

    # ---------------------------------------------------------------------------------------
    async def _main(self) -> int:
        self.loop = asyncio.get_running_loop()
        self.stop = asyncio.Event()
        self.dirty = asyncio.Event()
        self._install_signal_handlers()
        if self.watch_stdin:
            threading.Thread(target=self._watch_stdin, name="stdin-watch", daemon=True).start()

        try:
            await self._hook(self.device.connect)
        except Exception:
            log.exception("connect() failed")
            return EXIT_ERROR

        self.hub = Hub(f"{self.url}/hub/devices", self.token, on_connected=self._register)
        self.hub.on("call")(self._on_call)
        self.hub.on("get_state")(self._snapshot)
        self.device._state_hook = lambda: self.loop.call_soon_threadsafe(self.dirty.set)
        await self.hub.start()
        background = [asyncio.create_task(self._flush_loop()), asyncio.create_task(self._watch_hub())]
        self._start_run()

        await self.stop.wait()
        return await self._shutdown(background)

    async def _shutdown(self, background: list) -> int:
        timer = threading.Timer(3.0, lambda: os._exit(EXIT_FORCED))  # last resort for stuck drivers
        timer.daemon = True
        timer.start()
        self.device._stop.set()
        if self._run_task:
            self._run_task.cancel()
            await asyncio.gather(self._run_task, return_exceptions=True)
        if self._run_thread:
            await self.loop.run_in_executor(None, self._run_thread.join, 1.5)
        try:
            await self._hook(self.device.close)
        except Exception:
            log.exception("close() failed")
        for task in background:
            task.cancel()
        await self.hub.close()
        timer.cancel()
        return self.exit_code

    def _fail(self, code: int = EXIT_ERROR) -> None:
        self.exit_code = code
        self.stop.set()

    async def _hook(self, fn) -> None:
        if inspect.iscoroutinefunction(fn):
            await fn()
        else:
            await self.loop.run_in_executor(None, fn)

    def _install_signal_handlers(self) -> None:
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                self.loop.add_signal_handler(sig, self.stop.set)
            except (NotImplementedError, RuntimeError):
                signal.signal(sig, lambda *_: self.loop.call_soon_threadsafe(self.stop.set))

    def _watch_stdin(self) -> None:
        """The server keeps our stdin open; end of input means: stop (also when the server dies)."""
        try:
            while os.read(0, 4096):
                pass
        except OSError:
            pass
        self.loop.call_soon_threadsafe(self.stop.set)

    async def _watch_hub(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            if self.hub.fatal:
                log.error("%s", self.hub.fatal)
                self._fail(EXIT_AUTH)
                return

    # run() of the device -------------------------------------------------------------------
    def _start_run(self) -> None:
        fn = type(self.device).run
        if fn is Device.run:
            return
        if inspect.iscoroutinefunction(fn):
            self._run_task = asyncio.create_task(self._run_async())
        else:
            self._run_thread = threading.Thread(target=self._run_sync, name="device-run", daemon=True)
            self._run_thread.start()

    async def _run_async(self) -> None:
        try:
            await self.device.run()
            log.info("run() finished")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("run() failed")
            self._fail()

    def _run_sync(self) -> None:
        try:
            self.device.run()
            log.info("run() finished")
        except Exception:
            log.exception("run() failed")
            self.loop.call_soon_threadsafe(self._fail)

    # protocol --------------------------------------------------------------------------------
    def _snapshot(self) -> dict:
        for _ in range(5):
            try:
                return plain(self.device.state)
            except RuntimeError:  # changed by another thread while copying
                continue
        raise RuntimeError("Could not take a consistent snapshot of the state")

    async def _register(self) -> None:
        generation = self.hub.connects
        await self.hub.invoke("register", self.schema, self._snapshot())
        self._registered_gen = generation

    async def _flush_loop(self) -> None:
        while True:
            await self.dirty.wait()
            await asyncio.sleep(0.05)  # collect further changes
            if self._registered_gen != self.hub.connects:
                await asyncio.sleep(0.1)  # not registered on this connection yet
                continue
            self.dirty.clear()
            state = self._snapshot()
            try:
                validate_state(state)
                await self.hub.invoke("update_state", state)
            except SchemaError as e:
                log.error("Rejected state update: %s", e)
            except (ConnectionLost, asyncio.TimeoutError):
                pass  # the full state is sent again after reconnecting
            except RemoteError as e:
                log.warning("Server rejected the state update: %s", e)

    async def _on_call(self, name: str, args: list | None) -> Any:
        fn = self.actions.get(name)
        if fn is None:
            raise LookupError(f"Device '{self.device_id}' has no action '{name}' (actions: {', '.join(self.actions)})")
        arguments = coerce_arguments(fn, list(args or []))
        if inspect.iscoroutinefunction(fn):
            result = await fn(self.device, *arguments)
        else:
            result = await self.loop.run_in_executor(None, lambda: fn(self.device, *arguments))
        return plain(result)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="laborchestra-worker", description="Run one LabOrchestra device.")
    parser.add_argument("target", help="path/to/device.py[:Class] or module:Class")
    parser.add_argument("--id", default=os.environ.get("LABORCHESTRA_DEVICE_ID"), help="device id (snake_case)")
    parser.add_argument("--url", default=os.environ.get("LABORCHESTRA_URL", DEFAULT_URL))
    parser.add_argument("--token", default=os.environ.get("LABORCHESTRA_TOKEN"))
    parser.add_argument("--config", default=os.environ.get("LABORCHESTRA_CONFIG", "{}"), help="options as JSON")
    args = parser.parse_args(argv)
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("LABORCHESTRA_LOG_LEVEL", "INFO"),
        format="%(levelname)s %(name)s: %(message)s",
    )
    if not args.id:
        parser.error("--id (or LABORCHESTRA_DEVICE_ID) is required")
    try:
        check_name(args.id, "Device id")
        config = json.loads(args.config)
        if not isinstance(config, dict):
            raise ValueError("must be an object")
    except (SchemaError, ValueError) as e:
        log.error("Invalid argument: %s", e)
        sys.exit(EXIT_CONFIG)
    code = Worker(args.target, args.id, args.url, args.token, config, bool(os.environ.get("LABORCHESTRA_WATCH_STDIN"))).run()
    sys.exit(code)


if __name__ == "__main__":
    main()
