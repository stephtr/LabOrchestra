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
