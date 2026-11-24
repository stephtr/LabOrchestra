"""Read recordings and snapshots written by the server.

    rec = laborchestra.load_recording("D:/data/scan 1")
    rec.tags, rec.duration
    t, p = rec.series("pressure.channels.1.pressure")   # every value the field had, with its time
    rec.state_at(12.5)["pressure"]                       # the state of every device at t = 12.5 s
    rec.channel("het", 1)                                # data stream (numpy memory map)

Needs ``pip install laborchestra[analysis]`` (pyyaml, numpy). Recordings that a crash left open are read up to the
last complete event.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from ._patch import apply_patch


def _yaml_load(text: str) -> dict:
    try:
        import yaml
    except ImportError as e:
        raise ImportError("Reading recordings needs pyyaml: pip install laborchestra[analysis]") from e
    return yaml.safe_load(text)


def _as_time(value: Any) -> datetime | None:
    """Times are UTC datetimes (YAML turns ISO timestamps into datetimes by itself)."""
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if isinstance(value, datetime) and value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def _read_events(file: Path) -> list[dict]:
    if not file.exists():
        return []
    text = file.read_text(encoding="utf-8")
    if not text.rstrip().endswith("]"):  # the writer died: everything after the last newline is incomplete
        text = text[: text.rfind("\n") + 1] + "]"
    return json.loads(text)


def _get(state: Any, path: list[str]) -> Any:
    for part in path:
        try:
            state = state[int(part)] if isinstance(state, list) else state[part]
        except (KeyError, IndexError, ValueError, TypeError):
            return None
    return state


class Recording:
    def __init__(self, base: Path, header: dict, events: list[dict]):
        self.base = base  # folder with events and streams (without the extension)
        self.header = header
        self.events = events
        self.name: str = header.get("name", base.name)
        self.kind: str = header.get("kind", "recording")
        self.tags: dict = header.get("tags") or {}
        self.start_time: datetime | None = _as_time(header.get("start_time") or header.get("time"))
        self.end_time: datetime | None = _as_time(header.get("end_time"))
        self.interrupted: bool = bool(header.get("interrupted", False))
        self.duration: float | None = header.get("duration_s") or (events[-1]["t"] if events else None)

    @property
    def devices(self) -> list[str]:
        return list(self.header.get("devices", {}))

    def _initial(self) -> dict[str, dict]:
        return {d: copy.deepcopy(info.get("state") or {}) for d, info in self.header.get("devices", {}).items()}

    @staticmethod
    def _apply(states: dict[str, dict], event: dict) -> None:
        device = event["device"]
        if "state" in event:
            states[device] = copy.deepcopy(event["state"])
        elif ("set" in event or "del" in event) and device in states:
            apply_patch(states[device], event)

    def state_at(self, t: float | None = None) -> dict[str, dict]:
        """The state of every device at time ``t`` (seconds since the start); without ``t`` the state at the end."""
        states = self._initial()
        for event in self.events:
            if t is not None and event["t"] > t:
                break
            self._apply(states, event)
        return states

    def changes(self, device: str | None = None, by: str | None = None) -> Iterator[dict]:
        """Events, optionally of one device and/or caused by ``by`` ("script", "ui", "device", ...)."""
        for event in self.events:
            if (device is None or event["device"] == device) and (by is None or by in event["by"].split(",")):
                yield event

    def series(self, path: str):
        """Times and values of one field, e.g. ``"pressure.channels.1.pressure"``: the value at the start, then at
        every change. Returns numpy arrays if numpy is installed, else lists."""
        device, _, rest = path.partition(".")
        parts = rest.split(".") if rest else []
        states = self._initial()
        if device not in states:
            raise KeyError(f"No device '{device}' in this recording (devices: {', '.join(states)})")
        times, values = [0.0], [_get(states[device], parts)]
        for event in self.events:
            if event["device"] != device:
                continue
            self._apply(states, event)
            value = _get(states.get(device), parts)
            if value != values[-1] or type(value) is not type(values[-1]):
                times.append(event["t"])
                values.append(value)
        try:
            import numpy as np

            return np.array(times), np.array(values)
        except ImportError:
            return times, values

    def channel(self, device: str, index: int, mmap: bool = True):
        """A data stream the device wrote (``<device>_C<index>.npy``), by default as a memory map."""
        import numpy as np

        return np.load(self.base / f"{device}_C{index}.npy", mmap_mode="r" if mmap else None)

    def __repr__(self) -> str:
        what = f"{len(self.events)} events, {self.duration} s" if self.kind == "recording" else "snapshot"
        return f"<{self.kind} '{self.name}': {what}{', interrupted' if self.interrupted else ''}>"


def load_recording(path: str | Path) -> Recording:
    """Load a recording or snapshot: pass the ``.yaml`` file or the name without extension."""
    text = str(path)
    yaml_file = Path(text if text.endswith(".yaml") else text + ".yaml")
    base = Path(str(yaml_file)[: -len(".yaml")])
    header = _yaml_load(yaml_file.read_text(encoding="utf-8"))
    events = _read_events(base / "events.json") if header.get("kind", "recording") == "recording" else []
    return Recording(base, header, events)
