"""The profiles that ship with LabOrchestra. Version 1 of each: additions are allowed within a version, changes need version 2."""

from typing import Annotated, Literal, TypedDict

from ._machinery import Profile, Unit, optional

class PressureChannel(TypedDict):
    pressure: Annotated[float | None, Unit("mbar")]  # None unless the status is ok, never 0
    status: str  # "ok", "underrange", "overrange", "error", ...


class PressureSensor(Profile):
    """A vacuum gauge controller with one or more gauges."""

    name = "pressure_sensor"
    version = 1
    channels: list[PressureChannel]


class Polarimeter(Profile):
    """Polarization of a light beam: the ellipse (theta, eta), the degree of polarization and the power."""

    name = "polarimeter"
    version = 1
    status: str  # "ok", or why the values are not valid (power too low, ...)
    theta: Annotated[float | None, Unit("rad")]  # azimuth of the ellipse
    eta: Annotated[float | None, Unit("rad")]  # ellipticity angle
    dop: Annotated[float | None, Unit("1")]  # degree of polarization, 0 to 1
    power: Annotated[float | None, Unit("W")]


class PositionerChannel(TypedDict):
    type: Literal["rotation", "linear", "slider", "unknown"]  # unknown: the controller has a channel that this driver cannot move
    unit: Literal["deg", "um", "slot", "percent", "steps", "none"]  # follows the type (and the mode of a stage that has modes)
    target_position: float | None
    actual_position: float | None
    status: str  # "ok", or why the position is not known


class Positioner(Profile):
    """Motorized stages, one channel each: rotation (degrees), linear (micrometers), sliders (slot number). The unit of a channel is in its
    ``unit`` field and follows its type; the driver converts. A stage with modes (SmarAct) uses "percent" (scan range) or "steps" (open
    loop) while it is in such a mode."""

    name = "positioner"
    version = 1
    channels: list[PositionerChannel]

    @classmethod
    def validate(cls, state: dict) -> list[str]:
        allowed = {"rotation": {"deg", "percent", "steps"}, "linear": {"um", "percent", "steps"}, "slider": {"slot"}, "unknown": {"none"}}
        return [
            f"channels[{i}] is a {c['type']}, so its unit must be one of {sorted(allowed[c['type']])}, not {c['unit']}"
            for i, c in enumerate(state["channels"])
            if c["unit"] not in allowed[c["type"]]
        ]

    def set_position(self, channel: int, position: float):
        """Moves a channel to a position and returns when it is there."""

    @optional
    def stop(self, channel: int | None = None):
        """Stops a move in progress (one channel, or all); the interrupted set_position fails with InterruptedError."""


class FrequencyChannel(TypedDict):
    frequency: Annotated[float, Unit("Hz")]
    power: Annotated[float, Unit("dBm")]
    is_on: bool


class FrequencyGenerator(Profile):
    """An RF signal generator with one or more outputs."""

    name = "frequency_generator"
    version = 1
    channels: list[FrequencyChannel]

    def set_frequency(self, channel: int, frequency: float):
        """Hz."""

    def set_power(self, channel: int, power: float):
        """dBm."""

    def set_on(self, channel: int, is_on: bool):
        """Switches the output on or off."""


class TurboPumpChannel(TypedDict):
    name: str  # what the controller is called ("Turbo 1")
    status: str  # "ok", or why the values are not valid (not connected, no answer, ...)
    is_running: bool | None  # None unless the status is ok
    is_standby: bool | None  # the reduced speed some controllers offer
    actual_speed: Annotated[float | None, Unit("Hz")]
    target_speed: Annotated[float | None, Unit("Hz")]
    current: Annotated[float | None, Unit("A")]
    power: Annotated[float | None, Unit("W")]
    voltage: Annotated[float | None, Unit("V")]
    operating_hours: Annotated[int | None, Unit("h")]
    error_code: str | None  # the controller's own error, None when it reports none


class TurboPump(Profile):
    """Turbo molecular pumps, one channel each (a controller per pump or several in one box)."""

    name = "turbo_pump"
    version = 1
    channels: list[TurboPumpChannel]

    def start(self, channel: int):
        """Switches the pump on; the speed follows."""

    def stop(self, channel: int):
        """Switches the pump off; it runs down."""

    def set_speed(self, channel: int, speed: float):
        """The speed the pump runs at, in Hz."""

    @optional
    def set_standby(self, channel: int, is_standby: bool):
        """Switches the reduced-speed mode on or off."""

    @optional
    def emergency_stop(self, channel: int):
        """Switches the pump off and leaves standby, without waiting for anything else."""


class OscilloscopeChannel(TypedDict):
    channel_active: bool
    range_in_millivolts: Annotated[int, Unit("mV")]  # the full range of the input
    coupling: Literal["AC", "DC"]


class Oscilloscope(Profile):
    """An oscilloscope that streams samples to a pipeline on the server (spectrum and trace as the ``display`` stream, raw channels into
    recordings). Its drivers are written in C# (the data rate does not allow a process in between), so the profile is declared there with
    ``[Profile("oscilloscope", 1)]``; this class is the definition they are checked against."""

    name = "oscilloscope"
    version = 1
    running: bool
    recording: bool
    sample_rate: Annotated[float, Unit("Hz")]
    fft_frequency: Annotated[float, Unit("Hz")]  # the top of the spectrum, half the sample rate
    fft_length: int
    channels: list[OscilloscopeChannel]

    def start(self):
        """Starts the acquisition."""

    def stop(self):
        """Stops it."""

    def set_range(self, channel: int, range_in_millivolts: int):
        """The full range of an input, in millivolts."""

    def set_channel_active(self, channel: int, active: bool):
        """Switches an input on or off."""

    def set_coupling(self, channel: int, coupling: str):
        """AC or DC."""

    def set_fft_frequency(self, frequency: float):
        """The top of the spectrum in Hz; the sample rate is twice that."""
