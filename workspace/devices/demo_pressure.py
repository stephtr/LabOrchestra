import os
import random

from laborchestra import Device, action
from laborchestra.profiles import PressureSensor


class DemoPressure(Device):
    """Simulated two-channel vacuum gauge (fore-vacuum and chamber)."""

    profiles = [PressureSensor]
    noise = 0.02  # relative noise of the chamber reading
    channel_names: list = []  # what the gauges are called, in order

    state = {
        "simulated": True,
        "process_id": 0,
        "channels": [
            {"name": "Fore vacuum", "pressure": 3.7e-2, "status": "ok"},  # mbar
            {"name": "Chamber", "pressure": 1.7e-8, "status": "ok"},
        ],
    }

    def connect(self):
        self.state["process_id"] = os.getpid()
        for i, channel in enumerate(self.state["channels"]):
            channel["name"] = self.channel_name(i, channel["name"])
        self.log.info("Demo gauge ready (noise %.1f %%)", 100 * self.noise)

    @action
    def set_pressure(self, channel: int, pressure: float):
        """Set the reading of a channel (mbar)."""
        if not 0 <= channel < len(self.state["channels"]):
            raise ValueError(f"There is no channel {channel}")
        self.state["channels"][channel]["pressure"] = pressure

    def run(self):
        while self.running:
            chamber = self.state["channels"][1]
            chamber["pressure"] *= 1 + random.uniform(-self.noise, self.noise)
            self.sleep(0.5)
