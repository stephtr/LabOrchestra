"""Dict and list that report every change (also nested ones)."""

from __future__ import annotations

from typing import Any, Callable


def wrap(value: Any, notify: Callable[[], None]) -> Any:
    if isinstance(value, TrackedDict) or isinstance(value, TrackedList):
        value._notify = notify
        return value
    if isinstance(value, dict):
        return TrackedDict(notify, value)
    if isinstance(value, (list, tuple)):
        return TrackedList(notify, value)
    return value


def plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


class TrackedDict(dict):
    def __init__(self, notify: Callable[[], None], data: dict | None = None):
        super().__init__()
        self._notify = notify
        for k, v in (data or {}).items():
            dict.__setitem__(self, k, wrap(v, self._changed))

    def _changed(self) -> None:
        self._notify()

    def __setitem__(self, key, value):
        dict.__setitem__(self, key, wrap(value, self._changed))
        self._changed()

    def __delitem__(self, key):
        dict.__delitem__(self, key)
        self._changed()

    def update(self, *args, **kwargs):
        for k, v in dict(*args, **kwargs).items():
            dict.__setitem__(self, k, wrap(v, self._changed))
        self._changed()

    def setdefault(self, key, default=None):
        if key not in self:
            self[key] = default
        return self[key]

    def pop(self, *args):
        result = dict.pop(self, *args)
        self._changed()
        return result

    def popitem(self):
        result = dict.popitem(self)
        self._changed()
        return result

    def clear(self):
        dict.clear(self)
        self._changed()

    def __ior__(self, other):
        self.update(other)
        return self


class TrackedList(list):
    def __init__(self, notify: Callable[[], None], data=()):
        super().__init__()
        self._notify = notify
        for v in data:
            list.append(self, wrap(v, self._changed))

    def _changed(self) -> None:
        self._notify()

    def __setitem__(self, index, value):
        if isinstance(index, slice):
            value = [wrap(v, self._changed) for v in value]
        else:
            value = wrap(value, self._changed)
        list.__setitem__(self, index, value)
        self._changed()

    def __delitem__(self, index):
        list.__delitem__(self, index)
        self._changed()

    def append(self, value):
        list.append(self, wrap(value, self._changed))
        self._changed()

    def extend(self, values):
        for v in values:
            list.append(self, wrap(v, self._changed))
        self._changed()

    def __iadd__(self, values):
        self.extend(values)
        return self

    def insert(self, index, value):
        list.insert(self, index, wrap(value, self._changed))
        self._changed()

    def pop(self, *args):
        result = list.pop(self, *args)
        self._changed()
        return result

    def remove(self, value):
        list.remove(self, value)
        self._changed()

    def clear(self):
        list.clear(self)
        self._changed()

    def sort(self, *args, **kwargs):
        list.sort(self, *args, **kwargs)
        self._changed()

    def reverse(self):
        list.reverse(self)
        self._changed()
