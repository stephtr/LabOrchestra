"""C# devices run inside the server and must behave like Python devices: same schema, state patches, actions, errors, logs."""

import json
import time

import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError


@pytest.fixture(scope="module")
def cs_server(tmp_path_factory):
    build_server()
    workspace, data = tmp_path_factory.mktemp("workspace"), tmp_path_factory.mktemp("data")
    devices = {
        "demo": {"driver": "demo_counter", "config": {"step": 5, "tick_seconds": 0.1}},
        "failing": {"driver": "demo_counter", "config": {"fail_on_start": True}},
        "bad_option": {"driver": "demo_counter", "config": {"nope": 1}},
        "no_such_driver": {"driver": "does_not_exist"},
    }
    (workspace / "devices.json").write_text(json.dumps({"devices": devices}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        yield url, workspace, data
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(cs_server):
    with laborchestra.connect(cs_server[0], PASSPHRASE) as lab:
        lab.demo.wait_ready(30)
        yield lab


def test_a_csharp_device_registers_with_the_same_schema_as_a_python_one(lab):
    schema = lab.demo.schema
    assert schema["class"] == "DemoCounter" and schema["doc"].startswith("A counter")
    options = {o["name"]: o for o in schema["config"]}
    assert (options["step"]["type"], options["step"]["default"], options["step"]["required"]) == ("int", 1, False)
    assert options["tick_seconds"]["type"] == "float" and options["fail_on_start"]["type"] == "bool"
    actions = {a["name"]: a for a in schema["actions"]}
    assert sorted(actions) == ["fail", "increment", "set_channel", "wait"]
    assert [(p["name"], p["type"], p["required"]) for p in actions["set_channel"]["params"]] == [("channel", "int", True), ("value", "float", True)]
    assert [p["name"] for p in actions["wait"]["params"]] == ["seconds"]  # the cancellation token is not a parameter
    assert actions["fail"]["params"][0]["default"] == "failed on purpose"
    assert lab.demo.state["channels"] == [{"name": "Channel 0", "value": 1.5, "status": "ok"}, {"name": "Channel 1", "value": 0.0, "status": "ok"}]  # named by the host


def test_state_changes_of_the_run_loop_and_of_actions_arrive_as_patches(cs_server, lab):
    ticks = lab.demo.state["ticks"]
    wait_for(lambda: lab.demo.state["ticks"] > ticks + 2, message="the run loop ticks")
    before = lab.demo.state["count"]
    assert lab.demo.increment() is None
    assert lab.demo.state["count"] == before + 5  # the option step; and there at once when the call returns
    lab.demo.set_channel(1, 2.5)
    assert lab.demo.state["channels"][1]["value"] == 2.5

    with lab.recording(f"cs {int(time.time() * 1000)}") as _:
        lab.demo.set_channel(0, 9.0)
        name = lab.get_recording()["name"]
        time.sleep(0.4)
    rec = laborchestra.load_recording(cs_server[2] / "recordings" / name)
    by_script = [e for e in rec.changes(device="demo", by="script") if "set" in e]
    # a patch of the value, not the whole list (a tick of the run loop in the same 50 ms may come along: both are in one patch)
    assert by_script and by_script[0]["set"]["channels.0.value"] == 9.0 and set(by_script[0]["set"]) <= {"channels.0.value", "ticks"}
    assert any(e["by"] == "device" and "ticks" in json.dumps(e) for e in rec.events)  # the run loop is not blamed on the script


def test_errors_reach_the_caller_with_type_message_and_traceback(lab):
    with pytest.raises(RemoteError, match="no channel 7") as e:
        lab.demo.set_channel(7, 1.0)
    assert e.value.type == "ValueError" and "DemoCounter" in e.value.traceback
    with pytest.raises(RemoteError, match="Parameter 'channel' must be int") as e:
        lab.demo.set_channel("x", 1.0)
    assert e.value.type == "ValueError"
    with pytest.raises(RemoteError, match="missing the argument 'value'"):
        lab.demo.call("set_channel", 1)
    with pytest.raises(RemoteError) as e:
        lab.demo.call("nope")
    assert e.value.type == "LookupError"

    before = lab.demo.state["count"]
    with pytest.raises(RemoteError, match="boom") as e:
        lab.demo.fail("boom")
    assert e.value.type == "InvalidOperationException"
    assert lab.demo.state["count"] == before + 100  # what the action changed before it failed is there
    assert any("Action fail failed" in e["message"] and e["level"] == "WARNING" for e in lab.demo.logs(level="WARNING"))


def test_async_actions_return_their_result(lab):
    assert lab.demo.wait(0.2) == 0.2


def test_logs_and_a_second_script_see_the_same_device(cs_server, lab):
    assert any("Demo counter ready (step 5)" in e["message"] and e["source"] == "device:demo" for e in lab.demo.logs())
    with laborchestra.connect(cs_server[0], PASSPHRASE) as other:
        lab.demo.increment()
        wait_for(lambda: other.demo.state["count"] == lab.demo.state["count"], message="state in the second client")


def test_devices_that_cannot_start_say_why_and_do_not_disturb_the_others(lab):
    wait_for(lambda: lab.failing.status == "error" and "told to fail on start" in lab.failing.error, 20, "start failure")
    wait_for(lambda: lab.bad_option.status == "error" and "nope" in lab.bad_option.error, 20, "bad option")
    wait_for(lambda: lab.no_such_driver.status == "error" and "does_not_exist" in lab.no_such_driver.error, 20, "unknown driver")
    assert "demo_counter" in lab.no_such_driver.error  # says which drivers there are
    assert any(e["logger"] == "supervisor" and "starting again" in e["message"] for e in lab.failing.logs())
    assert lab.demo.status == "ready"


def test_restart_gives_a_fresh_device(lab):
    lab.demo.increment()
    lab.demo.restart()
    wait_for(lambda: lab.demo.status == "ready" and lab.demo.state["count"] == 0, 20, "fresh device")


def test_drivers_can_be_listed_and_used_through_the_management_api(lab, cs_server):
    assert {"driver": "demo_counter", "class": "DemoCounter", "doc": lab.demo.schema["doc"]} in lab.list_drivers()
    assert lab.describe_driver("demo_counter")["class"] == "DemoCounter"
    with pytest.raises(RemoteError, match="no driver 'nope'"):
        lab.describe_driver("nope")

    lab.add_device("added_cs", driver="demo_counter", config={"step": 2}, description="from the test")
    wait_for(lambda: "added_cs" in lab.devices and lab.added_cs.status == "ready", message="added device")
    saved = json.loads((cs_server[1] / "devices.json").read_text())["devices"]["added_cs"]
    assert saved == {"driver": "demo_counter", "config": {"step": 2}, "description": "from the test"}
    lab.added_cs.increment()
    assert lab.added_cs.state["count"] == 2
    with pytest.raises(RemoteError, match="exactly one of 'file'"):
        lab.add_device("both", file="devices/x.py", driver="demo_counter")
    with pytest.raises(RemoteError, match="There is no driver 'ghost'"):
        lab.add_device("ghost_device", driver="ghost")
    lab.remove_device("added_cs")
    wait_for(lambda: "added_cs" not in lab.devices, message="removed")


def test_files_can_be_listed_while_devices_without_a_file_exist(lab):
    """Regression: list_device_files failed with a NullReferenceException as soon as a C# driver device (no file) was configured."""
    assert isinstance(lab.list_device_files(), list)
