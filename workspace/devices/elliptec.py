# /// script
# requires-python = ">=3.11"
# dependencies = ["elliptec"]
# ///
"""Thorlabs Elliptec stages (rotation, linear, slider) on one serial bus.

The bus times out when it is asked too often, and it times out now and then even when it is not. That is why the actual
positions are read only every `poll_seconds` (20 s) and not after every move (a lock that corrects every second would
otherwise double the accesses), and why every access is tried `attempts` times before it counts as failed. Moves are
absolute and reads change nothing, so trying again is safe."""

import time

from laborchestra import Device, action
from laborchestra.profiles import Positioner

KINDS = ("rotation", "linear", "slider")
UNIT = {"rotation": "deg", "linear": "um", "slider": "slot"}  # what the state has (the Positioner profile)
SCALE = {"rotation": 1.0, "linear": 1000.0, "slider": 1.0}  # the library speaks mm for linear stages; the state has micrometers


class _Simulated:
    """Stands in for an axis when `simulate` is on: moves a little later and gets there. With `timeouts`, every access times
    out that many times in a row first, like a bus that is having a bad day."""

    def __init__(self, timeouts):
        self.position, self.timeouts, self._left = 0.0, timeouts, timeouts

    def _access(self):
        if self._left > 0:
            self._left -= 1
            raise TimeoutError("simulated timeout")
        self._left = self.timeouts

    def read(self):
        self._access()
        return self.position

    def move(self, target):
        self._access()
        time.sleep(0.05)
        self.position = float(target)


class _Axis:
    """One axis of the real controller."""

    def __init__(self, library, controller, kind, address):
        motor = {"rotation": library.Rotator, "linear": library.Linear, "slider": library.Slider}[kind](controller, address, False)
        self.read = {"rotation": motor.get_angle, "linear": motor.get_distance, "slider": motor.get_slot}[kind]
        self.move = {"rotation": motor.set_angle, "linear": motor.set_distance, "slider": motor.set_slot}[kind]


class Elliptec(Device):
    """Elliptec stages on one bus. Positions are degrees (rotation), micrometers (linear) or the slot number (slider)."""

    profiles = [Positioner]

    port: str = ""  # e.g. "COM3"; not needed when simulating
    channels = [{"type": "rotation", "address": "0"}]  # one entry per stage, in the order of the channels below; an entry may have a "name" ("QWP"), or use channel_names
    simulate = False  # no hardware: the stages move instantly
    poll_seconds = 20.0  # how often the actual positions are read; the bus times out when it is asked too often
    read_after_move = False  # also read the position right after a move: one more access each time, see above
    attempts = 3  # tries per access before it counts as failed
    retry_delay_s = 0.2
    simulate_timeouts = 0  # with `simulate`: every access times out this many times first (to see how the dashboard copes)

    state = {"simulated": False, "timeouts": 0, "channels": []}  # timeouts: failed attempts since the start, a sign of the bus' health

    def connect(self):
        bad = [c for c in self.channels if c.get("type") not in KINDS]
        if bad:
            raise ValueError(f"A channel needs a type of {', '.join(KINDS)}: {bad}")
        if self.simulate:
            self._axes = [_Simulated(self.simulate_timeouts) for _ in self.channels]
        else:
            if not self.port:
                raise ValueError("Set the option 'port' (e.g. COM3), or 'simulate' to run without hardware")
            import elliptec

            controller = elliptec.Controller(self.port, debug=False)
            self._axes = [_Axis(elliptec, controller, c["type"], c["address"]) for c in self.channels]
        self.state["simulated"] = self.simulate
        positions = [self._attempt(f"Channel {i}: reading the position", axis.read) * SCALE[c["type"]] for i, (c, axis) in enumerate(zip(self.channels, self._axes))]
        self.state["channels"] = [
            {**({"name": c["name"]} if c.get("name") else {}), "type": c["type"], "unit": UNIT[c["type"]], "target_position": p, "actual_position": p, "status": "ok"} for c, p in zip(self.channels, positions)
        ]

    def _attempt(self, what, access):
        """Run one access to the bus, trying again when it fails (the bus times out now and then)."""
        for attempt in range(1, self.attempts + 1):
            try:
                return access()
            except Exception as e:
                self.state["timeouts"] += 1
                self.log.debug("%s failed (attempt %d of %d): %s", what, attempt, self.attempts, e)
                if attempt == self.attempts or self.sleep(self.retry_delay_s):  # the sleep says True when we are stopping
                    raise

    def _channel(self, channel: int) -> dict:
        if not 0 <= channel < len(self._axes):
            raise ValueError(f"There is no channel {channel} (0 to {len(self._axes) - 1})")
        return self.state["channels"][channel]

    @action
    def set_position(self, channel: int, position: float):
        """Move a channel and wait until it got there. The actual position follows at the next poll."""
        state = self._channel(channel)
        state["target_position"] = position
        try:
            with self.lock:
                axis = self._axes[channel]
                scale = SCALE[state["type"]]
                self._attempt(f"Channel {channel}: move", lambda: axis.move(position / scale))
                if self.read_after_move:
                    state["actual_position"] = self._attempt(f"Channel {channel}: reading the position", axis.read) * scale
            state["status"] = "ok"
        except Exception:
            state["status"] = "error"
            raise

    @action
    def update_positions(self):
        """Read the actual positions of all channels (one bus access per channel: do not call this often)."""
        with self.lock:
            for i, (state, axis) in enumerate(zip(self.state["channels"], self._axes)):
                try:
                    state["actual_position"] = self._attempt(f"Channel {i}: reading the position", axis.read) * SCALE[state["type"]]
                    state["status"] = "ok"
                except Exception as e:  # all attempts failed
                    if state["status"] != "error":  # say it once, not at every poll
                        self.log.warning("Channel %d: could not read the position (%d attempts): %s", i, self.attempts, e)
                    state["status"] = "error"

    def run(self):
        while self.running:
            self.update_positions()
            self.sleep(self.poll_seconds)
