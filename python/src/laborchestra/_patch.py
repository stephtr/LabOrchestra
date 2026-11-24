"""State patches: ``{"set": {"channels.1.pressure": 3e-7}, "del": ["name"]}``.

Paths are dot separated keys; numeric parts index lists. Keys are snake_case and cannot contain dots, so paths
are unambiguous. Lists whose length changed are replaced as a whole (``set`` on the path of the list).
"""

from __future__ import annotations

from typing import Any


class PatchError(ValueError):
    pass


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, float) and isinstance(b, float) and a != a and b != b:
        return True  # NaN == NaN here
    return type(a) is type(b) and a == b


def diff(old: Any, new: Any) -> dict:
    """The patch that turns ``old`` into ``new`` (both plain dicts); empty if they are equal."""
    sets: dict[str, Any] = {}
    dels: list[str] = []

    def walk(a: Any, b: Any, path: str) -> None:
        if isinstance(a, dict) and isinstance(b, dict):
            for key in a.keys() - b.keys():
                dels.append(f"{path}.{key}" if path else key)
            for key, value in b.items():
                child = f"{path}.{key}" if path else key
                if key not in a:
                    sets[child] = value
                else:
                    walk(a[key], value, child)
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            for i, (x, y) in enumerate(zip(a, b)):
                walk(x, y, f"{path}.{i}")
        elif not _same(a, b):
            sets[path] = b

    walk(old, new, "")
    patch: dict = {}
    if sets:
        patch["set"] = sets
    if dels:
        patch["del"] = sorted(dels)
    return patch


def _resolve(root: Any, path: str):
    parts = path.split(".")
    node = root
    for part in parts[:-1]:
        node = node[int(part)] if isinstance(node, list) else node[part]
    return node, parts[-1]


def apply_patch(state: dict, patch: dict) -> None:
    """Change ``state`` in place. Raises PatchError if a path does not exist (the caller then resyncs)."""
    try:
        for path in patch.get("del", []):
            parent, key = _resolve(state, path)
            if isinstance(parent, list):
                raise PatchError(f"Cannot delete the list element {path}")
            del parent[key]
        for path, value in patch.get("set", {}).items():
            parent, key = _resolve(state, path)
            if isinstance(parent, list):
                parent[int(key)] = value
            else:
                parent[key] = value
    except (KeyError, IndexError, ValueError, TypeError) as e:
        if isinstance(e, PatchError):
            raise
        raise PatchError(f"Cannot apply the patch: {type(e).__name__}: {e}") from e
