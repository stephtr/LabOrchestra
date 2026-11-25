"""Procedures: measurement runs written as Python functions with typed parameters.

    from laborchestra import procedure

    @procedure(devices=["cavity_detuning"])
    async def detuning_scan(lab, detunings: list[float], duration_s: float = 60):
        '''Records the signal at several detunings.'''
        base = lab.cavity_detuning.state["channels"][0]["frequency"]
        try:
            for detuning in lab.progress(detunings):
                await lab.cavity_detuning.set_frequency(0, base + detuning)
                async with lab.recording(f"scan {detuning:+.0f}", tags={"detuning": detuning}):
                    await lab.sleep(duration_s)
        finally:  # runs when the procedure is aborted, too: leave the devices as they were
            await lab.cavity_detuning.set_frequency(0, base)

The server runs a procedure in its own process (``python -m laborchestra.procedure_runner file.py:name``), with the same API as a script. The type
hints make the form in the UI. ``devices`` are the devices it uses: they are reserved against other procedures while it runs, and it may call
no others. An abort cancels the function (its ``finally`` blocks run); a pause takes effect at the next ``lab.sleep``, ``lab.checkpoint`` or
call of a device.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import logging
import sys
import typing
from pathlib import Path
from typing import Any, Callable, Iterable

from ._load import load_file
from ._schema import _json_default, coerce
from .errors import LabOrchestraError, SchemaError
from .lab import AsyncDevice, AsyncLab

# --- declaring a procedure ----------------------------------------------------------------------------------------------
#: The events a procedure can be started by (``on=``). The server publishes them; the event itself is passed as the parameter ``event`` if the procedure has one.
EVENTS = ("recording.finished", "recording.discarded", "snapshot.saved", "device.error")


def procedure(fn: Callable | None = None, *, devices: Iterable[str] = (), title: str | None = None, on: str | Iterable[str] = ()):
    """Marks an ``async def`` as a procedure. The first parameter receives the ``lab`` (see :class:`Run`), the others are the parameters
    of the run: type hints make the form, defaults make them optional. ``devices`` lists every device the procedure uses. ``on`` starts the procedure by itself
    when such an event happens (``"recording.finished"``, ...): a parameter named ``event`` (``event: dict | None = None``) receives what the server says about it."""

    def mark(f: Callable) -> Callable:
        if not inspect.iscoroutinefunction(f):
            raise SchemaError(f"The procedure {f.__name__} must be 'async def': an abort cancels it between two awaits, so that its finally blocks run")
        if not f.__name__.islower() or not f.__name__.replace("_", "").isalnum() or f.__name__[0].isdigit() or f.__name__.startswith("_"):
            raise SchemaError(f"The name of the procedure {f.__name__} must be snake_case")
        params = list(inspect.signature(f).parameters.values())
        if not params:
            raise SchemaError(f"The procedure {f.__name__} needs the lab as its first parameter: async def {f.__name__}(lab, ...)")
        for p in params[1:]:
            if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD, p.POSITIONAL_ONLY):
                raise SchemaError(f"The procedure {f.__name__}: parameter '{p.name}' must be an ordinary named parameter")
        used = list(devices)
        for d in used:
            if not isinstance(d, str) or not d or not d.replace("_", "").isalnum() or d != d.lower():
                raise SchemaError(f"The procedure {f.__name__}: '{d}' is not a device id (snake_case)")
        triggers = [on] if isinstance(on, str) else list(on)
        for t in triggers:
            if t not in EVENTS:
                raise SchemaError(f"The procedure {f.__name__}: '{t}' is not an event (events: {', '.join(EVENTS)})")
        f.__lab_procedure__ = {"devices": used, "title": title, "on": triggers}
        return f

    return mark(fn) if fn is not None else mark


def _parameters(fn: Callable) -> list[inspect.Parameter]:
    hints = typing.get_type_hints(fn) if _hints_ok(fn) else {}
    params = list(inspect.signature(fn).parameters.values())[1:]
    return [p.replace(annotation=hints.get(p.name, p.annotation)) for p in params]


def _hints_ok(fn: Callable) -> bool:
    try:
        typing.get_type_hints(fn)
        return True
    except Exception:
        return False


def _kind(annotation: Any, default: Any) -> tuple[str, str | None]:
    """(type, item type): bool, int, float, str, list of one of those, or json for anything else."""
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, getattr(__import__("types"), "UnionType", None)):
        rest = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _kind(rest[0], default) if len(rest) == 1 else ("json", None)
    if origin in (list, typing.List):
        args = typing.get_args(annotation)
        item = _kind(args[0], MISSING)[0] if args else "json"
        return ("list", item if item in ("bool", "int", "float", "str") else "json")
    if annotation in (bool, int, float, str):
        return annotation.__name__, None
    if isinstance(default, bool):
        return "bool", None
    if isinstance(default, int):
        return "int", None
    if isinstance(default, float):
        return "float", None
    if isinstance(default, str):
        return "str", None
    if isinstance(default, list) and default and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in default):
        return "list", "float"
    return "json", None


MISSING = object()


def _docs(fn: Callable) -> tuple[str | None, dict[str, str]]:
    """The docstring, and what its 'Args:' / 'Parameters:' section says about each parameter ("name: text")."""
    text = inspect.getdoc(fn)
    if not text:
        return None, {}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip().rstrip(":").lower() in ("args", "arguments", "parameters", "params"):
            docs: dict[str, str] = {}
            for entry in lines[i + 1:]:
                name, sep, rest = entry.strip().partition(":")
                if sep and name.replace("_", "").isalnum():
                    docs[name] = rest.strip()
                elif entry.strip() and not entry.startswith((" ", "\t")):
                    break
            return "\n".join(lines[:i]).strip() or None, docs
    return text, {}


def describe(fn: Callable) -> dict:
    """The procedure as JSON for the UI: name, title, doc, devices, and the parameters (type, item type of lists, default, whether required)."""
    meta = fn.__lab_procedure__
    doc, param_docs = _docs(fn)
    params = []
    for p in _parameters(fn):
        kind, item = _kind(p.annotation, p.default if p.default is not p.empty else MISSING)
        params.append(
            {
                "name": p.name,
                "type": kind,
                **({"items": item} if item else {}),
                "default": None if p.default is p.empty else _json_default(p.default),
                "required": p.default is p.empty,
                "doc": param_docs.get(p.name),
            }
        )
    return {"name": fn.__name__, "title": meta["title"] or fn.__name__.replace("_", " ").capitalize(), "doc": doc, "devices": meta["devices"], "on": meta.get("on", []), "params": params}


def coerce_params(fn: Callable, given: dict) -> dict:
    """The parameters of a run, checked against the signature: unknown or missing ones and wrong types are errors that say which."""
    params = {p.name: p for p in _parameters(fn)}
    unknown = sorted(set(given) - set(params))
    if unknown:
        raise TypeError(f"Unknown parameter(s): {', '.join(unknown)} (the procedure takes: {', '.join(params) or 'none'})")
    result = {}
    for name, p in params.items():
        if name not in given:
            if p.default is p.empty:
                raise TypeError(f"The parameter '{name}' is required")
            continue
        kind, item = _kind(p.annotation, p.default if p.default is not p.empty else MISSING)
        value = given[name]
        what = f"Parameter '{name}'"
        if kind == "list":
            if isinstance(value, str):  # "1, 2, 3" typed into a form
                value = [x.strip() for x in value.split(",") if x.strip()]
                value = [float(x) if item in ("float", "int") else x for x in value] if item != "str" else value
            if not isinstance(value, (list, tuple)):
                raise TypeError(f"{what} must be a list, got {type(value).__name__}")
            value = [coerce(v, item or "json", f"{what}[{i}]") for i, v in enumerate(value)]
        else:
            value = coerce(value, kind, what, allow_none=p.default is None)
        result[name] = value
    return result


def load(target: str) -> tuple[list[Callable], str | None]:
    """The procedures of a file, and the one that was named ("file.py:name"; None: all of them). Importing the file runs its top level."""
    path, _, name = target.rpartition(":")
    if not path or len(path) < 2 or not name.isidentifier():
        path, name = target, None
    module = load_file(path, f"lab_procedure_{Path(path).stem}")
    found = [f for f in vars(module).values() if inspect.isfunction(f) and hasattr(f, "__lab_procedure__") and f.__module__ == module.__name__]
    if name and name not in [f.__name__ for f in found]:
        raise SchemaError(f"{path} has no procedure '{name}' (found: {', '.join(f.__name__ for f in found) or 'none'})")
    return found, name


# --- what a procedure sees: the lab --------------------------------------------------------------------------------------
class _Device:
    """A device as a procedure sees it: its actions wait while the run is paused; it must have been declared."""

    def __init__(self, run: "Run", device: AsyncDevice):
        self._run, self._device = run, device

    @property
    def state(self) -> dict:
        return self._device.state

    @property
    def status(self) -> str:
        return self._device.status

    async def wait_for(self, predicate, timeout: float = 30) -> dict:
        return await self._device.wait_for(predicate, timeout)

    async def wait_ready(self, timeout: float = 30) -> dict:
        return await self._device.wait_ready(timeout)

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        action = getattr(self._device, name)

        async def call(*args: Any) -> Any:
            await self._run.checkpoint()
            return await action(*args)

        call.__name__ = name
        return call


class _Progress:
    def __init__(self, run: "Run", items: Iterable, total: int | None, label: str | None):
        self._run, self._items, self._total, self._label = run, items, total, label

    def __iter__(self):
        done = 0
        for item in self._items:
            self._run._progress(done, self._total, self._label)
            yield item
            done += 1
        self._run._progress(done, done if self._total is None else self._total, self._label)

    async def __aiter__(self):
        done = 0
        for item in self._items:
            await self._run.checkpoint()
            self._run._progress(done, self._total, self._label)
            yield item
            done += 1
        self._run._progress(done, done if self._total is None else self._total, self._label)


class _Recording:
    def __init__(self, run: "Run", name: str, tags: dict | None):
        self._run, self._name, self._tags = run, name, tags
        self._inner = None

    async def __aenter__(self):
        await self._run.checkpoint()
        self._inner = self._run.raw.recording(self._name, self._tags)
        return await self._inner.__aenter__()

    async def __aexit__(self, *exc):
        return await self._inner.__aexit__(*exc)


class Run:
    """The ``lab`` of a procedure: the devices (``lab.cavity_detuning.set_frequency(0, 1e6)``), and what a run adds."""

    def __init__(self, raw: AsyncLab, run_id: str, name: str, declared: list[str], params: dict, send: Callable[[dict], None]):
        self.raw, self.run_id, self.name, self.params = raw, run_id, name, params
        self._declared, self._send = set(declared), send
        self._running = asyncio.Event()
        self._running.set()
        self._aborting = False
        self._last_progress: tuple | None = None

    # devices
    def device(self, device_id: str) -> _Device:
        """A device by id (also for ids that are not valid Python names)."""
        if device_id not in self._declared:
            raise LabOrchestraError(
                f"The procedure {self.name} did not declare the device '{device_id}': @procedure(devices=[..., '{device_id}']) "
                f"(declared: {', '.join(sorted(self._declared)) or 'none'})"
            )
        return _Device(self, AsyncDevice(self.raw, device_id))

    def __getattr__(self, name: str) -> _Device:
        if name.startswith("_"):
            raise AttributeError(name)
        return self.device(name)

    # time and progress
    async def checkpoint(self) -> None:
        """Waits here while the run is paused (a pause takes effect at the next checkpoint; sleep, progress over ``async for``, device calls and
        recordings have one). Never waits once the run is being aborted, so that cleanup can run."""
        if not self._running.is_set() and not self._aborting:
            self._send({"state": "paused"})
            await self._running.wait()
            if not self._aborting:
                self._send({"state": "running"})

    async def sleep(self, seconds: float) -> None:
        """Like ``asyncio.sleep``, but a pause stops the clock."""
        remaining = float(seconds)
        while remaining > 0:
            await self.checkpoint()
            step = min(0.25, remaining)
            await asyncio.sleep(step)
            if self._running.is_set():
                remaining -= step

    def progress(self, items: Iterable | int, label: str | None = None) -> _Progress:
        """``for x in lab.progress(items):`` shows the run's progress in the UI (``async for`` pauses at each item)."""
        if isinstance(items, int):
            items = range(items)
        try:
            total = len(items)  # type: ignore[arg-type]
        except TypeError:
            total = None
        return _Progress(self, items, total, label)

    def _progress(self, done: int, total: int | None, label: str | None) -> None:
        if (done, total, label) != self._last_progress:
            self._last_progress = (done, total, label)
            self._send({"progress": {"done": done, "total": total, "label": label}})

    def status(self, text: str) -> None:
        """A line that says what the run is doing now, shown next to the progress (and in the run's log)."""
        logging.getLogger("procedure").info("%s", text)
        self._send({"message": str(text)})

    def recording(self, name: str, tags: dict | None = None) -> _Recording:
        """``async with lab.recording("scan 1", tags={...}):`` a recording that is stopped when the block ends, however it ends. The server
        also stops it if the run dies, and notes the run (procedure, source, parameters) in its metadata."""
        return _Recording(self, name, tags)

    # control from the server
    def _command(self, command: str) -> None:
        if command == "pause":
            self._running.clear()
        elif command == "resume":
            self._running.set()
        elif command == "abort":
            self._aborting = True
            self._running.set()
