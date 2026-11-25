"""Profiles: the common shape of devices of a kind, checked against what the drivers do."""

import importlib.util
import inspect
from typing import Annotated, Literal

import pytest

from helpers import DEVICES, ROOT
from laborchestra import Device, SchemaError, action
from laborchestra.profiles import (
    STANDARD, FrequencyGenerator, Polarimeter, Positioner, PressureSensor, Profile, Unit,
    check_actions, check_driver, check_state, describe, optional, units,
)
from laborchestra.worker import build_schema
from laborchestra._schema import action_methods


def drivers():
    """Every Device class in drivers/ and in the test devices that names profiles."""
    found = []
    for path in sorted((ROOT / "drivers").glob("*.py")) + sorted(DEVICES.glob("*.py")) + [ROOT / "workspace" / "devices" / "demo_pressure.py"]:
        spec = importlib.util.spec_from_file_location(f"driver_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        found += [(path.name, c) for _, c in inspect.getmembers(module, inspect.isclass) if issubclass(c, Device) and c is not Device and c.__module__ == module.__name__ and c.profiles]
    return found


def test_the_standard_profiles_export_json_derived_from_the_code():
    description = describe(PressureSensor)
    assert description["name"] == "pressure_sensor" and description["version"] == 1
    channel = description["state"]["channels"]["items"]["fields"]
    assert channel["pressure"] == {"type": "float", "nullable": True, "unit": "mbar", "required": True}  # None, never 0, when the status is not ok
    assert description["units"] == {"channels.*.pressure": "mbar"}
    positioner = describe(Positioner)
    assert [(a["name"], a["optional"]) for a in positioner["actions"]] == [("set_position", False), ("stop", True)]
    assert positioner["actions"][0]["params"] == [{"name": "channel", "type": "int", "required": True}, {"name": "position", "type": "float", "required": True}]
    assert describe(FrequencyGenerator)["units"] == {"channels.*.frequency": "Hz", "channels.*.power": "dBm"}
    assert units(Polarimeter) == {"theta": "rad", "eta": "rad", "dop": "1", "power": "W"}
    assert {p.name for p in STANDARD} == {"pressure_sensor", "polarimeter", "positioner", "frequency_generator", "oscilloscope", "turbo_pump"}


def test_state_is_checked_against_a_profile_and_the_problems_are_named():
    good = {"channels": [{"pressure": 1e-3, "status": "ok"}, {"pressure": None, "status": "error"}], "extra": 1}  # None for an invalid reading; more fields are fine
    assert check_state(PressureSensor, good) == []
    bad = {"channels": [{"pressure": "high"}, {"status": 3, "pressure": 0.0}]}
    assert check_state(PressureSensor, bad) == [
        "channels[0].status is missing", "channels[0].pressure must be float, got str", "channels[1].status must be str, got int"]
    assert check_state(PressureSensor, {}) == ["channels is missing"]
    unit_wrong = {"channels": [{"type": "linear", "unit": "deg", "target_position": 1.0, "actual_position": None, "status": "ok"}]}
    assert "its unit must be one of" in check_state(Positioner, unit_wrong)[0]  # a rule that a type cannot say
    assert check_state(Positioner, {"channels": [{**unit_wrong["channels"][0], "unit": "um"}]}) == []


def test_a_driver_that_does_not_fit_its_profile_is_refused_with_what_is_wrong():
    class NoAction(Device):
        profiles = [FrequencyGenerator]

        @action
        def set_frequency(self, channel: int, frequency: float): ...

    class WrongNames(Device):
        profiles = [FrequencyGenerator]

        @action
        def set_frequency(self, chan: int, frequency: float): ...

        @action
        def set_power(self, channel: int, power: float, extra: float): ...

        @action
        def set_on(self, channel: int, is_on: bool): ...

    assert check_actions(FrequencyGenerator, NoAction) == ["the action set_power is missing", "the action set_on is missing"]
    problems = check_driver(FrequencyGenerator, WrongNames)
    assert problems == ["set_frequency: parameter 1 must be called 'channel'", "set_power: the extra parameter 'extra' needs a default"]
    with pytest.raises(SchemaError, match="says it is a frequency_generator .* the action set_power is missing"):
        build_schema("gen", NoAction, action_methods(NoAction))


def test_a_driver_may_add_actions_and_leave_out_a_capability():
    class Mine(Device):
        profiles = [Positioner]
        units = {"channels.*.temperature": "K"}

        @action
        def set_position(self, channel: int, position: float, wait: bool = True): ...

        @action
        def calibrate(self): ...

    assert check_driver(Positioner, Mine) == []  # no stop: it is optional; an extra parameter with a default is fine
    schema = build_schema("stage", Mine, action_methods(Mine))
    assert schema["profiles"] == [{"name": "positioner", "version": 1}] and schema["units"] == {"channels.*.temperature": "K"}

    class BadStop(Device):
        profiles = [Positioner]

        @action
        def set_position(self, channel: int, position: float): ...

        @action
        def stop(self, which: int | None = None): ...

    assert check_driver(Positioner, BadStop) == ["stop: parameter 1 must be called 'channel'"]  # a capability that is there must fit


def test_new_profiles_are_plain_classes_with_checked_names():
    class Thermometer(Profile):
        """Temperature."""

        name = "thermometer"
        version = 1
        temperature: Annotated[float | None, Unit("K")]
        mode: Literal["fast", "slow"]

        @optional
        def set_mode(self, mode: str): ...

    assert describe(Thermometer)["state"]["mode"] == {"type": "enum", "values": ["fast", "slow"]}
    assert check_state(Thermometer, {"temperature": 4.2, "mode": "medium"}) == ["mode is 'medium', expected one of ['fast', 'slow']"]
    with pytest.raises(SchemaError, match="snake_case"):
        class Bad(Profile):
            name = "Bad Name"
    with pytest.raises(SchemaError, match="snake_case"):
        class AlsoBad(Profile):
            name = "also_bad"
            camelCase: int


@pytest.mark.parametrize("filename, driver", drivers(), ids=lambda v: v if isinstance(v, str) else v.__name__)
def test_every_driver_that_names_a_profile_fits_it(filename, driver):
    for profile in driver.profiles:
        assert check_driver(profile, driver) == [], f"{filename}: {driver.__name__} does not fit {profile.name}"
    build_schema("x", driver, action_methods(driver))  # also what the worker does at start
    assert len(drivers()) >= 6  # Elliptec, Smaract, Pfeiffer, polarimeter, SMA100B, the demo gauge and the physics test device


def test_a_profile_can_be_mounted_under_a_key_so_that_two_profiles_with_the_same_field_names_fit_one_device():
    generator = FrequencyGenerator.at("generator")
    assert generator.name == "frequency_generator" and generator.mount == "generator" and FrequencyGenerator.mount is None
    assert units(generator) == {"generator.channels.*.frequency": "Hz", "generator.channels.*.power": "dBm"}
    assert describe(generator)["at"] == "generator" and "at" not in describe(FrequencyGenerator)
    assert {a["name"] for a in describe(generator)["actions"]} == {"set_frequency", "set_power", "set_on"}  # the actions are inherited
    good = {"generator": {"channels": [{"frequency": 1e5, "power": 0.0, "is_on": True}]}, "channels": [{"channel_active": True}]}
    assert check_state(generator, good) == []
    assert check_state(generator, {"channels": []}) == ["generator is missing"]
    bad = {"generator": {"channels": [{"frequency": "fast", "power": 0.0, "is_on": True}]}}
    assert check_state(generator, bad) == ["generator.channels[0].frequency must be float, got str"]
    with pytest.raises(SchemaError):
        FrequencyGenerator.at("Not Snake")
