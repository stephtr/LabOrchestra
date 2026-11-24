# /// script
# requires-python = ">=3.11"
# dependencies = ["pyvisa", "pyvisa-py"]
# ///
"""Thorlabs PAX polarimeter. theta and eta (the polarization ellipse) are in radians, dop is the degree of polarization,
power in watts."""

import random

from laborchestra import Device

FLAGS = [  # first match wins, as in the manual
    (0x01, "motor speed too low"),
    (0x02, "motor speed too high"),
    (0x04, "power too low"),
    (0x08, "power too high"),
    (0x10, "temperature too low"),
    (0x0DFF, "error"),
]


def status_of(flags: int) -> str:
    return next((text for mask, text in FLAGS if flags & mask), "ok")


class ThorlabsPolarimeter(Device):
    device: str = ""  # VISA resource, e.g. "USB0::0x1313::0x8031::M00503241::INSTR"; not needed when simulating
    wavelength_nm = 1550.0
    simulate = False  # no hardware: a polarization that hardly changes

    state = {"simulated": False, "status": "not found", "theta": 0.0, "eta": 0.0, "dop": 0.0, "power": 0.0}

    def connect(self):
        self.state["simulated"] = self.simulate
        if self.simulate:
            return
        if not self.device:
            raise ValueError("Set the option 'device' (the VISA resource), or 'simulate' to run without hardware")
        import pyvisa

        self._instrument = pyvisa.ResourceManager().open_resource(self.device)
        identity = self._instrument.query("*IDN?")
        if not identity.startswith("THORLABS,PAX"):
            raise ValueError(f"This is not a Thorlabs polarimeter: {identity.strip()}")
        for command in ("SENS:CALC:MODE F1024", f"SENS:CORR:WAV {self.wavelength_nm * 1e-9:e}", "SENS:POW:RANG:AUTO ON", "INP:ROT:STAT ON"):
            self._instrument.write(command)

    def _read(self):
        # revs, timestamp, mode, flags, tia range, adc min, adc max, rev time, misadjustment, theta, eta, dop, power
        fields = self._instrument.query("SENS:DATA:LAT?").split(",")
        return status_of(int(fields[3])), float(fields[9]), float(fields[10]), float(fields[11]), float(fields[12])

    def run(self):
        failing = False
        while self.running:
            try:
                if self.simulate:
                    status, theta, eta, dop, power = "ok", 0.04 + random.gauss(0, 1e-4), 0.07 + random.gauss(0, 1e-4), 0.95, 1e-5
                else:
                    status, theta, eta, dop, power = self._read()
                failing = False
            except Exception as e:
                if not failing:  # say it once, not three times a second
                    self.log.warning("Could not read the polarimeter: %s", e)
                failing = True
                status, theta, eta, dop, power = "error", 0.0, 0.0, 0.0, 0.0
            self.state.update(status=status, theta=theta, eta=eta, dop=dop, power=power)
            self.sleep(0.33)

    def close(self):
        if not self.simulate and hasattr(self, "_instrument"):
            self._instrument.write("INP:ROT:STAT OFF")
            self._instrument.close()
