# /// script
# requires-python = ">=3.11"
# dependencies = ["smaract.ctl"]
# ///
"""SmarAct positioners on an MCS2 controller (SmarAct CTL library).

Positions depend on the mode of the channel: **closed-loop** µm (or degrees for a rotary axis), **scan** percent of the scan
range, **open-loop** steps (`move_steps`; `target_position` counts the steps taken since the mode was set). Velocities are in
the unit of the position per second.

A move lasts a while, so `set_position` and `move_steps` return when the stage has arrived. `stop` ends a move in progress
(from any other thread, that is what actions running in parallel are for); the interrupted call then fails with "stopped"."""

import threading
import time

from laborchestra import Device, action

MODES = ["closed-loop", "open-loop", "scan"]


class _Simulated:
    """Stages that move at their velocity (closed-loop: µm/s, scan: %/s) and stop when told to."""

    def __init__(self, count):
        self.count = count
        self._mode = ["closed-loop"] * count
        self._position = [0.0] * count  # closed-loop µm
        self._scan = [0.0] * count
        self._velocity = [1000.0] * count
        self._target = [0.0] * count
        self._moving_until = [0.0] * count
        self._start = [(0.0, 0.0, 0.0)] * count  # (time, from, to)

    def _now(self, i):
        t0, a, b = self._start[i]
        duration = abs(b - a) / max(self._velocity[i], 1e-9)
        done = min(1.0, (time.monotonic() - t0) / duration) if duration > 0 else 1.0
        return a + (b - a) * done

    def info(self, i):
        return {"type": "rotation" if i % 2 else "linear", "mode": self._mode[i], "position": self.position(i), "target": self._target[i], "velocity": self._velocity[i]}

    def position(self, i):
        return self._now(i) if self._mode[i] != "open-loop" else self._position[i]

    def set_mode(self, i, mode):
        self._mode[i] = mode
        self._target[i] = 0.0 if mode == "open-loop" else self._now(i)
        return self._target[i], (0.0 if mode == "open-loop" else self._velocity[i])

    def move(self, i, position, mode):
        self._start[i] = (time.monotonic(), self._now(i), position)
        self._target[i] = position

    def step(self, i, steps):
        self._start[i] = (time.monotonic(), self._position[i], self._position[i])
        self._position[i] += steps * 0.1  # a step is about 100 nm
        self._moving_until[i] = time.monotonic() + min(0.5, abs(steps) * 0.001)

    def set_velocity(self, i, velocity, mode):
        self._velocity[i] = velocity

    def is_moving(self, i):
        t0, a, b = self._start[i]
        return time.monotonic() < self._moving_until[i] or (a != b and abs(self._now(i) - b) > 1e-9)

    def stop(self, i):
        here = self._now(i)
        self._start[i] = (time.monotonic(), here, here)
        self._moving_until[i] = 0.0

    def close(self):
        pass


class _Hardware:
    """The CTL library, in the units of the module docstring."""

    def __init__(self, locator):
        from smaract import ctl

        self.ctl, self.handle = ctl, ctl.Open(locator)
        self.count = ctl.GetProperty_i32(self.handle, 0, ctl.Property.NUMBER_OF_CHANNELS)

    @staticmethod
    def scale(mode):
        return {"closed-loop": 1_000_000, "scan": 65535 / 100}.get(mode, 1)  # pm per µm; counts per percent

    def info(self, i):
        ctl, h = self.ctl, self.handle
        kind = ctl.GetProperty_i32(h, i, ctl.Property.POS_MOVEMENT_TYPE)
        if kind not in (ctl.MovementType.LINEAR, ctl.MovementType.ROTATORY, ctl.MovementType.GONIOMETER):
            return {"type": "unknown", "mode": "unknown", "position": 0.0, "target": 0.0, "velocity": 0.0}
        move_mode = ctl.GetProperty_i32(h, i, ctl.Property.MOVE_MODE)
        mode = {ctl.MoveMode.CL_ABSOLUTE: "closed-loop", ctl.MoveMode.STEP: "open-loop", ctl.MoveMode.SCAN_ABSOLUTE: "scan"}.get(move_mode, "unknown")
        target, velocity = self._target_and_velocity(i, mode)
        return {"type": "linear" if kind == ctl.MovementType.LINEAR else "rotation", "mode": mode, "position": self.position(i), "target": target, "velocity": velocity}

    def _target_and_velocity(self, i, mode):
        ctl, h = self.ctl, self.handle
        if mode == "closed-loop":
            target, velocity = ctl.GetProperty_i64(h, i, ctl.Property.TARGET_POSITION), ctl.GetProperty_i64(h, i, ctl.Property.MOVE_VELOCITY)
        elif mode == "scan":
            target, velocity = ctl.GetProperty_i64(h, i, ctl.Property.SCAN_POSITION), ctl.GetProperty_i64(h, i, ctl.Property.SCAN_VELOCITY)
        else:
            target, velocity = 0, 0
        return target / self.scale(mode), velocity / self.scale(mode)

    def position(self, i):
        return self.ctl.GetProperty_i64(self.handle, i, self.ctl.Property.POSITION) / 1_000_000

    def set_mode(self, i, mode):
        ctl = self.ctl
        ctl.SetProperty_i32(self.handle, i, ctl.Property.MOVE_MODE, {"closed-loop": ctl.MoveMode.CL_ABSOLUTE, "open-loop": ctl.MoveMode.STEP, "scan": ctl.MoveMode.SCAN_ABSOLUTE}[mode])
        return self._target_and_velocity(i, mode)

    def move(self, i, position, mode):
        self.ctl.Move(self.handle, i, int(position * self.scale(mode) + 0.5))

    def step(self, i, steps):
        self.ctl.Move(self.handle, i, int(steps))

    def set_velocity(self, i, velocity, mode):
        ctl = self.ctl
        prop = ctl.Property.MOVE_VELOCITY if mode == "closed-loop" else ctl.Property.SCAN_VELOCITY
        ctl.SetProperty_i64(self.handle, i, prop, int(velocity * self.scale(mode) + 0.5))

    def is_moving(self, i):
        return bool(self.ctl.GetProperty_i32(self.handle, i, self.ctl.Property.CHANNEL_STATE) & self.ctl.ChannelState.ACTIVELY_MOVING)

    def stop(self, i):
        self.ctl.Stop(self.handle, i)

    def close(self):
        self.ctl.Close(self.handle)


class Smaract(Device):
    locator: str = ""  # e.g. "usb:ix:0" or "network:sn:MCS2-00001234"; not needed when simulating
    simulate = False  # no hardware: stages that move at their velocity
    channel_count = 2  # with `simulate`: how many channels
    poll_s = 0.1  # how often the positions are read
    move_timeout_s = 120.0  # a move that lasts longer is stopped and fails

    state = {"simulated": False, "channels": []}

    def connect(self):
        self._hardware = _Simulated(self.channel_count) if self.simulate else self._open()
        self._stopped = [threading.Event() for _ in range(self._hardware.count)]
        self.state["simulated"] = self.simulate
        channels = []
        for i in range(self._hardware.count):
            info = self._hardware.info(i)
            known = info["mode"] in MODES
            channels.append({
                "type": info["type"], "mode": info["mode"], "supported_modes": MODES if known else [],  # todo: ask the device
                "target_position": info["target"], "actual_position": info["position"], "velocity": info["velocity"],
                "moving": False, "status": "ok" if known else "unknown",
            })
        self.state["channels"] = channels

    def _open(self):
        if not self.locator:
            raise ValueError("Set the option 'locator' (e.g. usb:ix:0), or 'simulate' to run without hardware")
        return _Hardware(self.locator)

    def _channel(self, channel):
        if not isinstance(channel, int) or isinstance(channel, bool) or not 0 <= channel < len(self.state["channels"]):
            raise ValueError(f"There is no channel {channel!r} (0 to {len(self.state['channels']) - 1})")
        if self.state["channels"][channel]["mode"] not in MODES:
            raise ValueError(f"Channel {channel} is not a positioner this driver can move")
        return self.state["channels"][channel]

    # --- actions ---------------------------------------------------------------------------------
    @action
    def set_mode(self, channel: int, mode: str):
        """closed-loop (µm), open-loop (steps) or scan (percent of the scan range)."""
        state = self._channel(channel)
        if mode not in MODES:
            raise ValueError(f"Invalid move mode '{mode}' ({', '.join(MODES)})")
        with self.lock:
            target, velocity = self._hardware.set_mode(channel, mode)
        state.update(mode=mode, target_position=target, velocity=velocity)

    @action
    def set_velocity(self, channel: int, velocity: float):
        """Closed-loop (µm/s) and scan (%/s) only."""
        state = self._channel(channel)
        if state["mode"] == "open-loop":
            raise ValueError("Open-loop moves have no velocity")
        if velocity <= 0:
            raise ValueError("The velocity must be positive")
        with self.lock:
            self._hardware.set_velocity(channel, velocity, state["mode"])
        state["velocity"] = velocity

    @action
    def set_position(self, channel: int, position: float):
        """Moves to a position (closed-loop µm, scan percent) and returns when the stage is there."""
        state = self._channel(channel)
        if state["mode"] == "open-loop":
            raise ValueError("Channel is in open-loop mode: use move_steps, or set_mode('closed-loop') first")
        if state["mode"] == "scan" and not 0 <= position <= 100:
            raise ValueError("A scan position is between 0 and 100 percent")
        self._stopped[channel].clear()
        with self.lock:
            self._hardware.move(channel, position, state["mode"])
        state["target_position"] = position
        self._wait_until_done(channel)

    @action
    def move_steps(self, channel: int, steps: int):
        """Open-loop: moves the given number of steps (negative: backwards) and returns when done."""
        state = self._channel(channel)
        if state["mode"] != "open-loop":
            raise ValueError("Channel is not in open-loop mode: use set_position, or set_mode('open-loop') first")
        self._stopped[channel].clear()
        with self.lock:
            self._hardware.step(channel, steps)
        state["target_position"] = state["target_position"] + steps
        self._wait_until_done(channel)

    @action
    def stop(self, channel: int | None = None):
        """Stops one channel, or all of them, at once; a move in progress there fails with 'stopped'."""
        for i in ([channel] if channel is not None else range(len(self.state["channels"]))):
            self._channel(i)
            self._stopped[i].set()
            with self.lock:
                self._hardware.stop(i)

    def _wait_until_done(self, channel):
        state, end = self.state["channels"][channel], time.monotonic() + self.move_timeout_s
        try:
            while True:
                with self.lock:
                    moving = self._hardware.is_moving(channel)
                    state["actual_position"] = self._hardware.position(channel)
                state["moving"] = moving
                if self._stopped[channel].is_set():
                    raise RuntimeError(f"The move of channel {channel} was stopped")
                if not moving:
                    return
                if time.monotonic() > end:
                    with self.lock:
                        self._hardware.stop(channel)
                    raise TimeoutError(f"Channel {channel} did not arrive within {self.move_timeout_s:g} s; stopped")
                if not self.running:
                    raise RuntimeError("The device is shutting down")
                self.sleep(0.02)
        finally:
            with self.lock:
                state["moving"] = self._hardware.is_moving(channel)

    # --- background ------------------------------------------------------------------------------
    def run(self):
        failing = False
        while self.running:
            try:
                for i, state in enumerate(self.state["channels"]):
                    if state["mode"] not in MODES:
                        continue
                    with self.lock:
                        position, moving = self._hardware.position(i), self._hardware.is_moving(i)
                    state["actual_position"], state["status"], state["moving"] = position, "ok", moving
                failing = False
            except Exception as e:
                if not failing:  # once, not ten times a second
                    self.log.warning("Could not read the positions: %s", e)
                failing = True
                for state in self.state["channels"]:
                    if state["mode"] in MODES:
                        state["status"] = "error"
            self.sleep(self.poll_s)

    def close(self):
        if getattr(self, "_hardware", None):
            for i in range(self._hardware.count):
                try:
                    self._hardware.stop(i)
                except Exception:
                    pass
            self._hardware.close()
