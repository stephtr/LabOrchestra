# /// script
# requires-python = ">=3.11"
# dependencies = ["pyserial"]
# ///
"""Pfeiffer vacuum gauge controller (TPG 36x series and compatible) on a serial port. Pressures are in mbar (the controller's
unit 0, or 4 = hPa, which is the same number).

The controller is put into continuous mode and then sends one line per second, `status,pressure,status,pressure,...`, one
pair per gauge. A reading that is not valid (under range, over range, error, gauge off) is `None` with the status saying why,
never 0. If the controller falls silent the driver says so once and starts it again."""

import math
import random
import time

from laborchestra import Device
from laborchestra.profiles import PressureSensor

STATUS = ["ok", "underrange", "overrange", "error", "off", "no sensor", "identification error"]
ACK, NAK, ENQ = "\x06", "\x15", b"\x05"


class PfeifferPressure(Device):
    profiles = [PressureSensor]

    port: str = ""  # e.g. "COM4"; not needed when simulating
    simulate = False  # no hardware: pressures that drift and wiggle
    channel_count = 2  # with `simulate`: how many gauges; with hardware the controller says
    silence_s = 5.0  # no line for this long: the controller is started again
    simulate_fault = False  # with `simulate`: gauge 2 reports an error, to see how the dashboard copes

    state = {"simulated": False, "status": "starting", "channels": []}

    # --- the serial line -------------------------------------------------------------------------
    def _open_port(self):
        import serial

        return serial.Serial(self.port, 9600, 8, serial.PARITY_NONE, serial.STOPBITS_ONE, timeout=0.5)

    def _read_line(self, wait: float) -> str | None:
        """The next complete line within `wait` seconds, or None. Short timeouts keep stopping responsive."""
        end = time.monotonic() + wait
        while True:
            self._buffer += self._serial.read(self._serial.in_waiting or 1)
            if b"\n" in self._buffer:
                line, _, self._buffer = self._buffer.partition(b"\n")
                return line.decode(errors="replace").strip()
            if time.monotonic() >= end or not self.running:
                return None

    def _send(self, command: str) -> None:
        self._serial.reset_input_buffer()
        self._buffer = b""
        self._serial.write((command + "\r\n").encode())
        answer = self._read_line(2)
        if answer == NAK:
            raise OSError(f"The controller refused '{command}': {self._request(None)}")
        if answer != ACK:
            raise OSError(f"The controller answered '{command}' with {answer!r}")
        self.sleep(0.05)

    def _request(self, command: str | None) -> str:
        if command is not None:
            self._send(command)
        self._serial.write(ENQ)
        answer = self._read_line(2)
        if answer is None:
            raise OSError("The controller did not answer")
        return answer

    def _start_controller(self) -> None:
        # The controller may already be sending when we connect, and then the answer to the reset arrives late: try again.
        last = None
        for _ in range(3):
            try:
                self._request("RES")
                unit = int(self._request("UNI"))
                if unit not in (0, 4):  # mbar, hPa
                    raise ValueError(f"The controller shows pressures in unit {unit}; set it to mbar or hPa")
                self._send("COM,1")  # continuous mode
                return
            except ValueError:
                raise
            except Exception as e:
                last = e
        raise OSError(f"The pressure controller does not start ({last})")

    # --- device ----------------------------------------------------------------------------------
    def connect(self):
        self.state["simulated"] = self.simulate
        if self.simulate:
            return
        if not self.port:
            raise ValueError("Set the option 'port' (e.g. COM4), or 'simulate' to run without hardware")
        self._buffer = b""
        self._serial = self._open_port()
        self._start_controller()

    def _publish(self, readings):
        """readings: [(status, pressure)]; a pressure only counts when the status is ok."""
        self.state["channels"] = [{"pressure": p if s == "ok" else None, "status": s} for s, p in readings]
        self.state["status"] = "ok" if all(s == "ok" for s, _ in readings) else "check gauges"

    def _parse(self, line: str):
        fields = line.split(",")
        if len(fields) < 2 or len(fields) % 2:
            raise ValueError(f"Unexpected line from the controller: {line!r}")
        return [(STATUS[int(s)] if 0 <= int(s) < len(STATUS) else f"status {s}", float(p)) for s, p in zip(fields[::2], fields[1::2])]

    def run(self):
        if self.simulate:
            return self._run_simulated()
        silent_since, complained = time.monotonic(), False
        while self.running:
            try:
                line = self._read_line(1.0)
                if line is not None:
                    self._publish(self._parse(line))
                    silent_since, complained = time.monotonic(), False
                    continue
            except ValueError as e:
                self.log.warning("%s", e)
                continue
            if time.monotonic() - silent_since > self.silence_s:
                if not complained:  # say it once, not at every attempt
                    self.log.warning("The controller is silent; starting it again")
                    complained = True
                    self.state["status"] = "no data"
                    self.state["channels"] = [{"pressure": None, "status": "error"} for _ in self.state["channels"]]
                try:
                    self._start_controller()
                except OSError as e:
                    self.log.debug("%s", e)
                    self.sleep(1)
                silent_since = time.monotonic()

    def _run_simulated(self):
        start = time.monotonic()
        while self.running:
            t = time.monotonic() - start
            readings = []
            for i in range(self.channel_count):
                if self.simulate_fault and i == 1:
                    readings.append(("error", 0.0))
                else:
                    readings.append(("ok", 1e-6 * 10 ** (i + 0.3 * math.sin(t / 30 + i)) * (1 + random.gauss(0, 0.01))))
            self._publish(readings)
            self.sleep(1)

    def close(self):
        if not self.simulate and getattr(self, "_serial", None):
            try:
                self._serial.write(b"COM,0\r\n")  # back to polling, as the controller expects after a program
            finally:
                self._serial.close()
