from __future__ import annotations

import copy
import logging
import threading
from typing import Any, Callable

from ._state import TrackedDict


def action(fn: Callable) -> Callable:
    """Mark a method as callable from the dashboard, scripts and other devices."""
    fn.__lab_action__ = True
    return fn


class Device:
    """Base class of all Python devices.

    Class attributes configure it: annotated without default = required option, with a default =
    optional option. ``state`` is a dict that is published whenever it changes, ``persist`` lists
    the state keys that are saved.
    """

    state: dict = {}
    persist: list = []
    widget: str | None = None  # name of a built-in widget of the client; without one the generated card is used

    # set by the worker -----------------------------------------------------------------------
    id: str
    log: logging.Logger
    lock: threading.RLock  # for hardware that must not be used by two threads at once (actions run in parallel)

    def _setup(self, device_id: str, config: dict, lab_factory: Callable[[], Any] | None = None) -> None:
        object.__setattr__(self, "_state_hook", None)
        self.id = device_id
        self.log = logging.getLogger(f"lab.{device_id}")
        self._stop = threading.Event()
        self.lock = threading.RLock()
        self._lab = None
        self._lab_factory = lab_factory
        for name, value in config.items():
            setattr(self, name, value)
        self.state = copy.deepcopy(type(self).state)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "state":
            value = TrackedDict(self._state_changed, value)
            object.__setattr__(self, name, value)
            self._state_changed()
        else:
            object.__setattr__(self, name, value)

    def _state_changed(self) -> None:
        hook = getattr(self, "_state_hook", None)
        if hook:
            hook()

    # for use in the device -------------------------------------------------------------------
    @property
    def running(self) -> bool:
        """False once the device is asked to stop. Use it as ``while self.running:``."""
        return not self._stop.is_set()

    def sleep(self, seconds: float) -> bool:
        """Sleep, but wake up early when the device is asked to stop. Returns True if stopping."""
        return self._stop.wait(seconds)

    @property
    def lab(self):
        """Access to all devices of the lab: ``self.lab["pressure"].state``."""
        if self._lab is None:
            if self._lab_factory is None:
                raise RuntimeError("This device is not connected to a lab")
            self._lab = self._lab_factory()
        return self._lab

    # hooks to override -----------------------------------------------------------------------
    def connect(self) -> None:
        """Open connections to hardware. Raise to report that the device cannot start."""

    def run(self) -> None:
        """Long-running loop. Plain functions run in their own thread, coroutines as a task."""

    def close(self) -> None:
        """Release hardware after run() ended."""
