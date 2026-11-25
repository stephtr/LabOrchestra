import math

from laborchestra import Device
from laborchestra.profiles import Polarimeter


class PhysicsPolarimeter(Device):
    """A polarimeter whose reading follows the waveplates of a simulated Elliptec: theta and eta are zero (in the lock's
    terms) when the half-wave plate is at 40 degrees and the quarter-wave plate at 10 degrees. It follows the commanded
    positions: the light feels the plates at once, while `actual_position` is only read now and then."""

    profiles = [Polarimeter]
    waveplates = "elliptec"
    state = {"status": "ok", "theta": 0.0, "eta": 0.0, "dop": 0.95, "power": 1e-5}

    def run(self):
        plates = self.lab[self.waveplates]
        while self.running:
            try:
                qwp, hwp = (c["target_position"] for c in plates.wait_ready(5)["channels"][:2])
                self.state["theta"] = math.radians(-2 * (hwp - 40) + 1.2)  # + the offsets the lock expects
                self.state["eta"] = math.radians(-2 * (qwp - 10) + 0.2)
            except TimeoutError:
                pass
            self.sleep(0.1)
