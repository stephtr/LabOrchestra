# /// script
# requires-python = ">=3.11"
# dependencies = ["pfeiffer-turbo"]
# ///
"""Pfeiffer turbo pumps with a TM 700 drive unit, one serial port per pump (the library is `pfeiffer-turbo`).

Every pump is a channel. A pump that cannot be reached does not stop the others: its channel says why (`status`), its values are
`None`, and the driver tries to connect again every `reconnect_s`. A reading that fails is tried `attempts` times (the drive unit
now and then answers with a bad checksum) before the channel reports an error, once in the log, not at every poll.

The fast values (speed, current, power, running) are read at every poll; the slow ones (voltage, operating hours, error code,
standby, target speed) at every tenth. The drive unit wants a pause between two requests (`pause_s`)."""

import time

from laborchestra import Device, action
from laborchestra.profiles import TurboPump

SLOW_EVERY = 10  # polls
NO_ERROR = ("", "0", "000000")


class _Simulated:
    """Stands in for a drive unit when `simulate` is on: runs up and down at 200 Hz per second."""

    def __init__(self):
        self.running, self.standby, self.target, self.speed, self._at = False, False, 1000, 0.0, time.monotonic()

    def _advance(self):
        now = time.monotonic()
        goal = (self.target * (0.6 if self.standby else 1.0)) if self.running else 0.0
        step = 200.0 * (now - self._at)
        self.speed = min(goal, self.speed + step) if goal > self.speed else max(goal, self.speed - step)
        self._at = now

    def read_fast(self):
        self._advance()
        return self.speed, 0.1 + 0.4 * self.speed / 1500 if self.speed else 0.0, round(self.speed * 0.3), self.running

    def read_slow(self):
        return 24.0, 1234, "000000", self.standby, self.target

    def set_running(self, running):
        self._advance()
        self.running = running

    def set_target(self, speed):
        self.target = int(speed)

    def set_standby(self, standby):
        self.standby = standby

    def close(self):
        pass


class _DriveUnit:
    """A real TM 700 on a serial port."""

    def __init__(self, port, address, pause_s):
        from pfeiffer_turbo import TM700

        self._unit, self._pause = TM700.from_serial(port, address=address), pause_s

    def _get(self, name):
        for attempt in range(3):
            try:
                return getattr(self._unit, name)
            except Exception as e:
                if "Checksum" in str(e) and attempt < 2:  # the drive unit garbles an answer now and then
                    time.sleep(self._pause)
                    continue
                raise

    def _read(self, *names):
        values = []
        for name in names:
            values.append(self._get(name))
            time.sleep(self._pause)
        return values

    def read_fast(self):
        speed, current, power, running = self._read("actual_spd", "drv_current", "drv_power", "pumpg_statn")
        return float(speed), float(current), int(power), bool(running)

    def read_slow(self):
        voltage, hours, error, standby, target = self._read("drv_voltage", "op_hrs_pump", "error_code", "standby", "set_rot_spd")
        return float(voltage), int(hours), str(error), bool(standby), int(target)

    def set_running(self, running):
        self._unit.pumpg_statn = running

    def set_target(self, speed):
        self._unit.set_rot_spd = int(speed)

    def set_standby(self, standby):
        self._unit.standby = standby

    def close(self):
        transport = getattr(self._unit, "transport", None)
        if transport is not None and hasattr(transport, "close"):
            transport.close()


def _blank(name):
    return {
        "name": name, "status": "connecting", "is_running": None, "is_standby": None, "actual_speed": None, "target_speed": None,
        "current": None, "power": None, "voltage": None, "operating_hours": None, "error_code": None,
    }


class PfeifferTurboPump(Device):
    """Turbo pumps, one channel per entry of `pumps`. Speeds are in Hz."""

    profiles = [TurboPump]

    pumps = [{"name": "Turbo", "port": "", "address": 1}]  # one entry per pump: name, serial port (e.g. "COM7"), drive unit address
    simulate = False  # no hardware: pumps that run up and down
    max_speed = 1500  # Hz, the highest speed set_speed accepts
    poll_s = 0.5
    pause_s = 0.05  # between two requests to a drive unit
    attempts = 3  # failed polls in a row before a channel reports an error
    reconnect_s = 10.0

    state = {"simulated": False, "channels": []}

    def connect(self):
        bad = [p for p in self.pumps if not isinstance(p, dict) or "name" not in p or (not self.simulate and not p.get("port"))]
        if bad:
            raise ValueError(f"Every pump needs a name and a port (or set 'simulate'): {bad}")
        self.state["simulated"] = self.simulate
        self._units = [None] * len(self.pumps)
        self._failures = [0] * len(self.pumps)
        self._polls = [0] * len(self.pumps)
        self._next_try = [0.0] * len(self.pumps)
        self._complained = set()  # channels whose problem is in the log already
        self.state["channels"] = [_blank(p["name"]) for p in self.pumps]
        for channel in range(len(self.pumps)):
            self._open(channel)

    def _open(self, channel: int):
        config = self.pumps[channel]
        try:
            self._units[channel] = _Simulated() if self.simulate else _DriveUnit(config["port"], int(config.get("address", 1)), self.pause_s)
            self._poll(channel, slow=True)
        except Exception as e:
            self._units[channel] = None
            self._next_try[channel] = time.monotonic() + self.reconnect_s
            self._fail(channel, f"not connected: {e}")

    def _fail(self, channel: int, status: str):
        """The channel cannot be read: say it once in the log, show it in the state, and drop the values (never show old ones)."""
        state = self.state["channels"][channel]
        if channel not in self._complained:
            self._complained.add(channel)
            self.log.warning("%s: %s", state["name"], status)
        state["status"] = status
        for key in ("is_running", "is_standby", "actual_speed", "target_speed", "current", "power", "voltage", "operating_hours", "error_code"):
            state[key] = None

    def _poll(self, channel: int, slow: bool = False):
        unit, state = self._units[channel], self.state["channels"][channel]
        speed, current, power, running = unit.read_fast()
        if slow or self._polls[channel] % SLOW_EVERY == 0 or state["voltage"] is None:
            voltage, hours, error, standby, target = unit.read_slow()
            state["voltage"], state["operating_hours"], state["is_standby"], state["target_speed"] = voltage, hours, standby, target
            state["error_code"] = None if error in NO_ERROR else error
        self._polls[channel] += 1
        state["actual_speed"], state["current"], state["power"], state["is_running"] = speed, current, power, running
        if channel in self._complained:
            self._complained.discard(channel)
            self.log.info("%s: reading again", state["name"])
        state["status"] = "ok"
        self._failures[channel] = 0

    def run(self):
        while self.running:
            for channel in range(len(self.pumps)):
                with self.lock:
                    if self._units[channel] is None:
                        if time.monotonic() >= self._next_try[channel]:
                            self._open(channel)
                        continue
                    try:
                        self._poll(channel)
                    except Exception as e:
                        self._failures[channel] += 1
                        self.log.debug("%s: reading failed (%d of %d): %s", self.state["channels"][channel]["name"], self._failures[channel], self.attempts, e)
                        if self._failures[channel] >= self.attempts:
                            self._fail(channel, f"error: {e}")
            if self.sleep(self.poll_s):
                return

    def close(self):
        for unit in getattr(self, "_units", []):
            if unit is not None:
                try:
                    unit.close()
                except Exception as e:
                    self.log.debug("closing: %s", e)

    # --- actions ---------------------------------------------------------------------------------
    def _unit(self, channel: int):
        if not 0 <= channel < len(self.pumps):
            raise ValueError(f"There is no pump {channel} (0 to {len(self.pumps) - 1})")
        if self._units[channel] is None:
            raise RuntimeError(f"{self.pumps[channel]['name']} is not connected: {self.state['channels'][channel]['status']}")
        return self._units[channel]

    def _command(self, channel: int, change):
        """Sends a command, waits a moment, and reads the pump back so that the state shows the effect when the action returns."""
        with self.lock:
            unit = self._unit(channel)
            change(unit)
            self.sleep(self.pause_s * 3)
            self._poll(channel, slow=True)

    @action
    def start(self, channel: int):
        """Switches the pump on; the speed follows."""
        self._command(channel, lambda unit: unit.set_running(True))

    @action
    def stop(self, channel: int):
        """Switches the pump off; it runs down."""
        self._command(channel, lambda unit: unit.set_running(False))

    @action
    def set_speed(self, channel: int, speed: float):
        """The speed the pump runs at, in Hz (0 to max_speed)."""
        if not 0 <= speed <= self.max_speed:
            raise ValueError(f"The speed must be between 0 and {self.max_speed} Hz")
        self._command(channel, lambda unit: unit.set_target(speed))

    @action
    def set_standby(self, channel: int, is_standby: bool):
        """Switches the reduced-speed mode on or off."""
        self._command(channel, lambda unit: unit.set_standby(bool(is_standby)))

    @action
    def emergency_stop(self, channel: int):
        """Switches the pump off and leaves standby."""

        def stop(unit):
            unit.set_running(False)
            time.sleep(self.pause_s * 2)
            unit.set_standby(False)

        self._command(channel, stop)
