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
    profiles: list = []  # the profiles this device conforms to, e.g. [PressureSensor] (laborchestra.profiles)
    units: dict = {}  # units of fields that no profile names: {"channels.*.temperature": "K"}
    channel_names: list = []  # the names of the channels in order (an option of every device with `channels` in its state, set in devices.json); see _name_channels
    kind: str = "device"  # "service" for a Service: the same thing, shown as a background task (see below)

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

    def _name_channels(self) -> None:
        """Every channel in ``state["channels"]`` gets a ``name``, without the driver doing anything: the option ``channel_names`` wins, then a name
        the driver set itself, else ``Channel <index>``. So dashboards, scripts, recordings and MCP can all say which channel is which."""
        channels = self.state.get("channels") if isinstance(self.state, dict) else None
        if not isinstance(channels, list) or getattr(self, "_naming", False):
            return
        object.__setattr__(self, "_naming", True)
        try:
            names = getattr(self, "channel_names", None) or []
            for i, channel in enumerate(channels):
                if not isinstance(channel, dict):
                    return  # not the channels of a profile (a list of numbers, say)
                wanted = str(names[i]) if i < len(names) and names[i] else None
                if wanted is not None and channel.get("name") != wanted:
                    channel["name"] = wanted
                elif wanted is None and not channel.get("name"):
                    channel["name"] = f"Channel {i}"
        finally:
            object.__setattr__(self, "_naming", False)

    def _state_changed(self) -> None:
        self._name_channels()
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


class Service(Device):
    """A background task: it runs all the time, watches or does things, and is no instrument.

    A service **is** a device (the same lifecycle, restart with backoff, logs, state, settings, options with secrets, and it can read and call
    other devices), and the interface treats it as what it is for the people who use it: it has its own section on the Devices page, is kept
    off the dashboards, and restarts by itself when its file changes (there is no hardware to touch)::

        class PressureUploader(Service):
            device: str = "pressure"           # options, as in any device
            api_key: str                       # (a secret is given by reference in devices.json)

            def run(self):
                while self.running:
                    ...                          # self.lab["pressure"].state, self.lab["turbo"].start(0)
                    self.sleep(60)
    """

    kind = "service"

