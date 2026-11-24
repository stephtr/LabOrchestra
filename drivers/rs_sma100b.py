# /// script
# requires-python = ">=3.11"
# dependencies = ["RsSmab"]
# ///
"""Rohde & Schwarz SMA100B RF signal generator over the network (HiSLIP). Frequency in Hz, power in dBm.

The state is read back from the instrument every `poll_s`, so a change at its front panel shows up too."""

from laborchestra import Device, action


class _Simulated:
    """Stands in for the instrument when `simulate` is on."""

    def __init__(self):
        self.frequency, self.power, self.on = 1e6, -30.0, False

    def read(self):
        return self.frequency, self.power, self.on

    def write(self, frequency=None, power=None, on=None):
        self.frequency = self.frequency if frequency is None else frequency
        self.power = self.power if power is None else power
        self.on = self.on if on is None else on

    def close(self):
        pass


class _Instrument:
    def __init__(self, address):
        from RsSmab import RsSmab

        self._smab = RsSmab(f"TCPIP::{address}::hislip0")

    def read(self):
        smab = self._smab
        return smab.source.frequency.get_frequency(), smab.source.power.get_power(), bool(smab.output.state.get_value())

    def write(self, frequency=None, power=None, on=None):
        smab = self._smab
        if frequency is not None:
            smab.source.frequency.set_frequency(frequency)
        if power is not None:
            smab.source.power.set_power(power)
        if on is not None:
            smab.output.state.set_value(on)

    def close(self):
        self._smab.close()


class RohdeSchwarzSma100b(Device):
    address: str = ""  # IP address or host name, e.g. "192.168.0.10"; not needed when simulating
    simulate = False  # no hardware: a generator that remembers what it is told
    poll_s = 2.0  # how often the instrument is read back

    state = {"simulated": False, "status": "starting", "channels": [{"frequency": 0.0, "power": 0.0, "is_on": False}]}

    def _open(self):
        return _Instrument(self.address)

    def connect(self):
        self.state["simulated"] = self.simulate
        if self.simulate:
            self._instrument = _Simulated()
        else:
            if not self.address:
                raise ValueError("Set the option 'address' (IP address of the generator), or 'simulate' to run without hardware")
            self._instrument = self._open()
        self._read_back()

    def _read_back(self):
        with self.lock:
            frequency, power, on = self._instrument.read()
        self.state["channels"][0].update(frequency=frequency, power=power, is_on=on)
        self.state["status"] = "ok"

    @staticmethod
    def _check_channel(channel):
        if channel != 0:
            raise ValueError(f"There is no channel {channel!r}: this generator has the single channel 0")

    @action
    def set_frequency(self, channel: int, frequency: float):
        """Hz."""
        self._check_channel(channel)
        if frequency <= 0:
            raise ValueError("The frequency must be positive")
        self._write(frequency=frequency)

    @action
    def set_power(self, channel: int, power: float):
        """dBm."""
        self._check_channel(channel)
        self._write(power=power)

    @action
    def set_on(self, channel: int, is_on: bool):
        """Switches the RF output on or off."""
        self._check_channel(channel)
        self._write(on=bool(is_on))

    def _write(self, **values):
        with self.lock:
            self._instrument.write(**values)
        self._read_back()  # the state is what the instrument says, e.g. when it limited the value

    def run(self):
        failing = False
        while not self.sleep(self.poll_s):
            try:
                self._read_back()
                failing = False
            except Exception as e:
                if not failing:  # once, not at every poll
                    self.log.warning("Could not read the generator: %s", e)
                failing = True
                self.state["status"] = "error"

    def close(self):
        if getattr(self, "_instrument", None):
            self._instrument.close()
