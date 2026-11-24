import pytest

from laborchestra import Device, SchemaError, action
from laborchestra._schema import (
    action_methods,
    action_schema,
    coerce_arguments,
    config_options,
    validate_state,
)
from laborchestra._state import plain
from laborchestra.worker import build_schema, coerce_config


class Gauge(Device):
    """A gauge."""

    port: str
    baud = 9600
    threshold: float = 1e-2
    label = None
    state = {"channels": [{"pressure": 1.0, "status": "ok"}], "name": ""}
    persist = ["name"]

    @action
    def set_pressure(self, channel: int, pressure: float, note: str = ""):
        """Set a value."""

    def helper(self):
        pass


def make(**config):
    device = Gauge()
    device._setup("gauge", coerce_config(Gauge, config))
    return device


def test_options_from_class_attributes():
    options = {o["name"]: o for o in config_options(Gauge, Device)}
    assert set(options) == {"port", "baud", "threshold", "label"}
    assert options["port"] == {"name": "port", "type": "str", "default": None, "required": True}
    assert options["baud"]["type"] == "int" and options["baud"]["default"] == 9600 and not options["baud"]["required"]
    assert options["threshold"]["type"] == "float"


def test_only_marked_methods_are_actions():
    assert list(action_methods(Gauge)) == ["set_pressure"]
    schema = action_schema("set_pressure", action_methods(Gauge)["set_pressure"])
    assert [(p["name"], p["type"], p["required"]) for p in schema["params"]] == [
        ("channel", "int", True),
        ("pressure", "float", True),
        ("note", "str", False),
    ]
    assert schema["doc"] == "Set a value."


def test_schema_is_serializable():
    import msgpack

    schema = build_schema("gauge", Gauge, action_methods(Gauge))
    assert msgpack.unpackb(msgpack.packb(schema))["class"] == "Gauge"
    assert schema["doc"] == "A gauge."
    assert schema["persist"] == ["name"]


def test_config_is_checked():
    assert make(port="COM3", baud=19200).baud == 19200
    with pytest.raises(SchemaError, match="Missing required option.*port"):
        make()
    with pytest.raises(SchemaError, match="Unknown option.*speed"):
        make(port="x", speed=1)
    with pytest.raises(TypeError, match="Option 'baud' must be int"):
        make(port="x", baud="fast")
    assert make(port="x", threshold=1).threshold == 1.0  # int is fine for float


def test_arguments_are_converted_and_checked():
    fn = action_methods(Gauge)["set_pressure"]
    assert coerce_arguments(fn, [1.0, 2]) == [1, 2.0]
    with pytest.raises(TypeError, match="missing the argument 'pressure'"):
        coerce_arguments(fn, [1])
    with pytest.raises(TypeError, match="Parameter 'channel' must be int"):
        coerce_arguments(fn, ["a", 1.0])
    with pytest.raises(TypeError, match="takes 3"):
        coerce_arguments(fn, [1, 1.0, "", 4])


def test_state_changes_are_reported_also_nested():
    device = make(port="x")
    calls = []
    device._state_hook = lambda: calls.append(1)
    device.state["name"] = "a"
    device.state["channels"][0]["pressure"] = 2.0
    device.state["channels"].append({"pressure": 3.0, "status": "ok"})
    device.state["channels"][1]["status"] = "error"
    del device.state["name"]
    assert len(calls) == 5
    assert plain(device.state)["channels"][1] == {"pressure": 3.0, "status": "error"}
    device.state = {"other": 1}  # replacing the dict stays tracked
    device.state["other"] = 2
    assert len(calls) == 7


def test_class_state_is_not_shared_between_instances():
    a, b = make(port="x"), make(port="y")
    a.state["channels"][0]["pressure"] = 5.0
    assert b.state["channels"][0]["pressure"] == 1.0
    assert Gauge.state["channels"][0]["pressure"] == 1.0


def test_naming_rule():
    validate_state({"channels": [{"pressure": 1}], "is_ok": True})
    with pytest.raises(SchemaError, match="snake_case"):
        validate_state({"channels": [{"Pressure": 1}]})

    class Bad(Device):
        camelCase = 1

    with pytest.raises(SchemaError, match="camelCase"):
        config_options(Bad, Device)

    class BadAction(Device):
        @action
        def setValue(self, x):
            pass

    with pytest.raises(SchemaError, match="setValue"):
        action_methods(BadAction)


def test_describe_prints_the_schema_even_if_the_device_prints_while_loading(tmp_path):
    import json
    import subprocess
    import sys

    file = tmp_path / "chatty.py"
    file.write_text("from laborchestra import Device, action\nprint('loading...')\n\nclass Chatty(Device):\n    port: str\n\n    @action\n    def ping(self, n: int = 1):\n        pass\n")
    out = subprocess.run([sys.executable, "-m", "laborchestra.worker", str(file), "--describe"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    line = [l for l in out.stdout.splitlines() if l.startswith("LABORCHESTRA-SCHEMA ")][-1]
    schema = json.loads(line.split(" ", 1)[1])
    assert schema["class"] == "Chatty" and schema["config"][0]["required"] and schema["actions"][0]["params"][0]["name"] == "n"

    file.write_text("raise RuntimeError('does not load')\n")
    out = subprocess.run([sys.executable, "-m", "laborchestra.worker", str(file), "--describe"], capture_output=True, text=True)
    assert out.returncode == 2 and "does not load" in out.stderr


def test_persisted_keys_must_exist_in_the_state():
    class Bad(Device):
        state = {"a": 1}
        persist = ["b"]

    with pytest.raises(SchemaError, match="Persisted key 'b' is not in the state of Bad"):
        build_schema("bad", Bad, {})


def test_stop_flag():
    device = make(port="x")
    assert device.running
    device._stop.set()
    assert not device.running and device.sleep(5) is True
