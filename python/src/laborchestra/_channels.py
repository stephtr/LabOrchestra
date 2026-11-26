"""Names for the channels of a device, filled in by the framework: a driver does nothing for them."""

from __future__ import annotations

from typing import Any


def name_channels(state: dict, names: list | dict | None = None) -> None:
    """Gives every channel in ``state`` (a ``channels`` list of dicts, at the top or under a mounted profile such as ``generator.channels``) a
    ``name``, in place: from the option ``channel_names`` (a list for the top-level ``channels``, or a dict from the path of a channel list to
    its list: ``{"channels": [...], "generator.channels": [...]}``), else ``Channel <index>``. A driver does not name its channels."""
    wanted = {"channels": names} if isinstance(names, list) else dict(names or {})

    def walk(node: dict, path: str) -> None:
        for key, value in node.items():
            here = f"{path}.{key}" if path else key
            if key == "channels" and isinstance(value, list) and value and all(isinstance(c, dict) for c in value):
                given = wanted.get(here) or []
                for i, channel in enumerate(value):
                    channel["name"] = str(given[i]) if i < len(given) and given[i] else f"Channel {i}"
            elif isinstance(value, dict):
                walk(value, here)

    walk(state, "")
