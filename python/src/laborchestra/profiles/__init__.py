"""Profiles: the common shape of devices of a kind. See ``laborchestra.profiles.standard`` for the ones that ship."""

from ._machinery import Profile, Unit, check_actions, check_driver, check_schema, check_state, check_value, describe, optional, state_fields, units
from .standard import FrequencyGenerator, Oscilloscope, Polarimeter, Positioner, PressureSensor, TurboPump

STANDARD = [PressureSensor, Polarimeter, Positioner, FrequencyGenerator, Oscilloscope, TurboPump]

__all__ = [
    "Profile", "Unit", "optional", "describe", "units", "state_fields", "check_state", "check_actions", "check_driver", "check_schema", "check_value",
    "PressureSensor", "Polarimeter", "Positioner", "FrequencyGenerator", "Oscilloscope", "TurboPump", "STANDARD",
]
