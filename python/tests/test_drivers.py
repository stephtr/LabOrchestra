"""The ported drivers of drivers/ (simulated) working together, through the real server."""

import json
import shutil
import time

import pytest

import laborchestra
from helpers import DEVICES, PASSPHRASE, ROOT, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

CHANNELS = [{"type": "rotation", "address": "A"}, {"type": "rotation", "address": "B"}, {"type": "slider", "address": "9"}]


@pytest.fixture(scope="module")
def drivers_server(tmp_path_factory):
    build_server()
    workspace, data = tmp_path_factory.mktemp("workspace"), tmp_path_factory.mktemp("data")
    (workspace / "devices").mkdir()
    for name in ("elliptec.py", "thorlabs_polarimeter.py", "polarization_lock.py"):
        shutil.copy(ROOT / "drivers" / name, workspace / "devices" / name)
    shutil.copy(DEVICES / "physics_polarimeter.py", workspace / "devices" / "physics_polarimeter.py")
    devices = {
        "elliptec": {"file": "devices/elliptec.py", "config": {"simulate": True, "channels": CHANNELS, "poll_seconds": 1}},
        "tweezer_polarization": {"file": "devices/physics_polarimeter.py"},
        "real_polarimeter": {"file": "devices/thorlabs_polarimeter.py", "config": {"simulate": True}},
        "polarization_lock": {"file": "devices/polarization_lock.py"},
        "no_hardware": {"file": "devices/elliptec.py"},  # neither a port nor simulate
    }
    (workspace / "devices.json").write_text(json.dumps({"devices": devices}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        yield url, data
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(drivers_server):
    with laborchestra.connect(drivers_server[0], PASSPHRASE) as lab:
        for name in ("elliptec", "tweezer_polarization", "real_polarimeter", "polarization_lock"):
            lab[name].wait_ready(30)
        yield lab


def test_elliptec_moves_channels_and_keeps_its_state_honest(lab):
    state = lab.elliptec.state
    assert state["simulated"] is True and [c["type"] for c in state["channels"]] == ["rotation", "rotation", "slider"]
    assert set(state["channels"][0]) == {"type", "target_position", "actual_position", "status"}

    assert lab.elliptec.set_position(0, 12.5) is None  # returns when the stage got there
    assert lab.elliptec.state["channels"][0]["actual_position"] == 12.5 and lab.elliptec.state["channels"][0]["status"] == "ok"
    lab.elliptec.set_position(2, 3)
    wait_for(lambda: lab.elliptec.state["channels"][2]["target_position"] == 3, message="slider")

    with pytest.raises(RemoteError, match="no channel 7") as e:
        lab.elliptec.set_position(7, 1.0)
    assert e.value.type == "ValueError"
    with pytest.raises(RemoteError) as e:
        lab.elliptec.set_position("x", 1.0)
    assert e.value.type == "TypeError"
    lab.elliptec.update_positions()


def test_a_driver_that_cannot_work_says_what_to_set(lab):
    wait_for(lambda: lab.no_hardware.status == "error", 20, "error status")
    assert "Set the option 'port'" in lab.no_hardware.error
    assert any("Set the option 'port'" in e["message"] for e in lab.no_hardware.logs())  # also in its log


def test_simulated_polarimeter_says_it_is_simulated(lab):
    state = lab.real_polarimeter.state
    assert state["simulated"] is True and state["status"] == "ok" and state["dop"] == 0.95
    assert abs(state["theta"] - 0.04) < 0.01
    assert [a["name"] for a in lab.real_polarimeter.schema["actions"]] == []


def test_the_lock_brings_the_polarization_to_zero_and_its_actions_are_attributed(drivers_server, lab):
    lab.elliptec.set_position(1, 42.0)  # half-wave plate
    lab.elliptec.set_position(0, 11.0)  # quarter-wave plate
    wait_for(lambda: lab.polarization_lock.state["out_of_lock_range"] is False, 20, "measurement in range")
    assert lab.polarization_lock.state["is_locking"] is False

    with lab.recording(f"lock {int(time.time() * 1000)}") as _:
        lab.polarization_lock.start_lock()
        lab.elliptec.wait_for(
            lambda s: abs(s["channels"][1]["target_position"] - 40) < 0.05 and abs(s["channels"][0]["target_position"] - 10) < 0.05,
            timeout=40,
        )
        lab.polarization_lock.stop_lock()
        name = lab.get_recording()["name"]
    rec = laborchestra.load_recording(drivers_server[1] / "recordings" / name)

    moves = [e for e in rec.changes(device="elliptec") if "action" in e]
    assert moves and all(e["by"] == "device:polarization_lock" and e["action"] == "set_position" for e in moves)
    assert any(e["device"] == "polarization_lock" and e["by"] == "script" and "is_locking" in json.dumps(e) for e in rec.events)
    t, target = rec.series("elliptec.channels.1.target_position")
    assert target[0] == 42.0 and abs(target[-1] - 40) < 0.05 and all(a != b for a, b in zip(target, target[1:]))


def test_the_lock_does_nothing_outside_its_range_and_says_so_once(lab):
    lab.elliptec.set_position(1, 70.0)  # far away: theta is about -60 degrees
    lab.polarization_lock.wait_for(lambda s: s["out_of_lock_range"] is True, 10)
    lab.polarization_lock.start_lock()
    try:
        time.sleep(3.5)
        assert lab.elliptec.state["channels"][1]["target_position"] == 70.0  # untouched
        warnings = [e for e in lab.polarization_lock.logs(level="WARNING") if "out of the lock range" in e["message"]]
        assert len(warnings) == 1
    finally:
        lab.polarization_lock.stop_lock()
