# /// script
# requires-python = ">=3.11"
# dependencies = ["elliptec"]
# ///
"""Thorlabs Elliptec stages (rotation, linear, slider) on one serial bus.

The bus times out when it is asked too often. That is why the actual positions are read only every `poll_seconds` (20 s)
and not after every move: a lock that corrects every second would otherwise double the accesses."""

import time

from laborchestra import Device, action

KINDS = ("rotation", "linear", "slider")


class _Simulated:
    """Stands in for an axis when `simulate` is on: moves a little later, always gets there."""

    position = 0.0

    def read(self):
        return self.position

    def move(self, target):
        time.sleep(0.05)
        self.position = float(target)


class _Axis:
    """One axis of the real controller."""

    def __init__(self, library, controller, kind, address):
        motor = {"rotation": library.Rotator, "linear": library.Linear, "slider": library.Slider}[kind](controller, address, False)
        self.read = {"rotation": motor.get_angle, "linear": motor.get_distance, "slider": motor.get_slot}[kind]
        self.move = {"rotation": motor.set_angle, "linear": motor.set_distance, "slider": motor.set_slot}[kind]


class Elliptec(Device):
    """Elliptec stages on one bus. Positions are degrees (rotation), mm (linear) or the slot number (slider)."""

    port: str = ""  # e.g. "COM3"; not needed when simulating
    channels = [{"type": "rotation", "address": "0"}]  # one entry per stage, in the order of the channels below
    simulate = False  # no hardware: the stages move instantly
    poll_seconds = 20.0  # how often the actual positions are read; the bus times out when it is asked too often
    read_after_move = False  # also read the position right after a move: one more access each time, see above

    state = {"simulated": False, "channels": []}

    def connect(self):
        bad = [c for c in self.channels if c.get("type") not in KINDS]
        if bad:
            raise ValueError(f"A channel needs a type of {', '.join(KINDS)}: {bad}")
        if self.simulate:
            self._axes = [_Simulated() for _ in self.channels]
        else:
            if not self.port:
                raise ValueError("Set the option 'port' (e.g. COM3), or 'simulate' to run without hardware")
            import elliptec

            controller = elliptec.Controller(self.port, debug=False)
            self._axes = [_Axis(elliptec, controller, c["type"], c["address"]) for c in self.channels]
        self.state["simulated"] = self.simulate
        positions = [axis.read() for axis in self._axes]
        self.state["channels"] = [
            {"type": c["type"], "target_position": p, "actual_position": p, "status": "ok"} for c, p in zip(self.channels, positions)
        ]

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
                self._axes[channel].move(position)
                if self.read_after_move:
                    state["actual_position"] = self._axes[channel].read()
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
                    state["actual_position"] = axis.read()
                    state["status"] = "ok"
                except Exception as e:
                    if state["status"] != "error":  # say it once, not at every poll
                        self.log.warning("Channel %d: could not read the position: %s", i, e)
                    state["status"] = "error"

    def run(self):
        while self.running:
            self.update_positions()
            self.sleep(self.poll_seconds)
