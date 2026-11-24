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
    for name in ("elliptec.py", "thorlabs_polarimeter.py", "pfeiffer_pressure.py"):
        shutil.copy(ROOT / "drivers" / name, workspace / "devices" / name)
    for name in ("physics_polarimeter.py", "polarization_lock.py"):  # test devices: a lab-internal control loop and some physics
        shutil.copy(DEVICES / name, workspace / "devices" / name)
    devices = {
        "elliptec": {"file": "devices/elliptec.py", "config": {"simulate": True, "channels": CHANNELS, "poll_seconds": 1}},
        "elliptec_quiet": {"file": "devices/elliptec.py", "config": {"simulate": True, "channels": CHANNELS[:1], "poll_seconds": 3600}},
        "elliptec_checked": {"file": "devices/elliptec.py", "config": {"simulate": True, "channels": CHANNELS[:1], "poll_seconds": 3600, "read_after_move": True}},
        "elliptec_flaky": {"file": "devices/elliptec.py", "config": {"simulate": True, "channels": CHANNELS[:1], "poll_seconds": 3600, "simulate_timeouts": 2, "attempts": 3, "retry_delay_s": 0.01}},
        "elliptec_hopeless": {"file": "devices/elliptec.py", "config": {"simulate": True, "channels": CHANNELS[:1], "simulate_timeouts": 3, "attempts": 2, "retry_delay_s": 0.01}},
        "tweezer_polarization": {"file": "devices/physics_polarimeter.py"},
        "real_polarimeter": {"file": "devices/thorlabs_polarimeter.py", "config": {"simulate": True}},
        "polarization_lock": {"file": "devices/polarization_lock.py"},
        "pressure": {"file": "devices/pfeiffer_pressure.py", "config": {"simulate": True}},
        "pressure_faulty": {"file": "devices/pfeiffer_pressure.py", "config": {"simulate": True, "simulate_fault": True}},
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
        for name in ("elliptec", "elliptec_quiet", "elliptec_checked", "elliptec_flaky", "tweezer_polarization", "real_polarimeter", "polarization_lock", "pressure", "pressure_faulty"):
            lab[name].wait_ready(30)
        yield lab


def test_elliptec_moves_channels_and_keeps_its_state_honest(lab):
    state = lab.elliptec.state
    assert state["simulated"] is True and [c["type"] for c in state["channels"]] == ["rotation", "rotation", "slider"]
    assert set(state["channels"][0]) == {"type", "target_position", "actual_position", "status"}

    assert lab.elliptec.set_position(0, 12.5) is None  # returns when the stage got there
    assert lab.elliptec.state["channels"][0]["target_position"] == 12.5 and lab.elliptec.state["channels"][0]["status"] == "ok"
    lab.elliptec.set_position(2, 3)
    assert lab.elliptec.state["channels"][2]["target_position"] == 3

    with pytest.raises(RemoteError, match="no channel 7") as e:
        lab.elliptec.set_position(7, 1.0)
    assert e.value.type == "ValueError"
    with pytest.raises(RemoteError) as e:
        lab.elliptec.set_position("x", 1.0)
    assert e.value.type == "TypeError"
    lab.elliptec.update_positions()


def test_the_bus_is_not_asked_after_every_move_unless_requested(lab):
    # the Elliptec bus times out when it is asked too often: by default only the poll reads positions
    lab.elliptec_quiet.set_position(0, 12.5)
    assert lab.elliptec_quiet.state["channels"][0]["target_position"] == 12.5
    assert lab.elliptec_quiet.state["channels"][0]["actual_position"] == 0.0  # not read yet
    lab.elliptec_quiet.update_positions()
    assert lab.elliptec_quiet.state["channels"][0]["actual_position"] == 12.5

    lab.elliptec_checked.set_position(0, 7.0)  # read_after_move: the position is there at once
    assert lab.elliptec_checked.state["channels"][0]["actual_position"] == 7.0


def test_timeouts_of_the_bus_are_ridden_out_and_counted(lab):
    # every access to this simulated bus times out twice before it works; three attempts are enough
    # at the start: reading the positions (2 timeouts) and the first poll (2 more)
    wait_for(lambda: lab.elliptec_flaky.state["timeouts"] == 4, message="start finished")
    start = 4
    lab.elliptec_flaky.set_position(0, 9.0)  # works although the move timed out twice
    assert lab.elliptec_flaky.state["channels"][0]["target_position"] == 9.0 and lab.elliptec_flaky.state["channels"][0]["status"] == "ok"
    assert lab.elliptec_flaky.state["timeouts"] == start + 2
    lab.elliptec_flaky.update_positions()
    assert lab.elliptec_flaky.state["channels"][0]["actual_position"] == 9.0 and lab.elliptec_flaky.state["timeouts"] == start + 4
    assert not lab.elliptec_flaky.logs(level="WARNING")  # nothing to complain about: the attempts did their job

    # too many timeouts for the attempts: the device cannot start, and says why
    wait_for(lambda: lab.elliptec_hopeless.status == "error", 20, "error status")
    assert "simulated timeout" in lab.elliptec_hopeless.error


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
    since = (lab.polarization_lock.logs() or [{"seq": 0}])[-1]["seq"]
    lab.polarization_lock.start_lock()
    try:
        time.sleep(3.5)
        assert lab.elliptec.state["channels"][1]["target_position"] == 70.0  # untouched
        warnings = [e for e in lab.polarization_lock.logs(level="WARNING", since=since) if "out of the lock range" in e["message"]]
        assert len(warnings) == 1
    finally:
        lab.polarization_lock.stop_lock()


# --- Pfeiffer pressure controller -----------------------------------------------------------------------------------------
import importlib.util
import threading

from laborchestra.worker import coerce_config


class FakeController:
    """What the serial port of a gauge controller does: acknowledges commands, answers ENQ, and in continuous mode sends lines."""

    def __init__(self, lines=(), refuse=(), lose_first_reset=False):
        self.lines, self.refuse, self.written, self.in_waiting = list(lines), set(refuse), [], 0
        self._out, self._continuous, self._lose_reset = b"", False, lose_first_reset

    def reset_input_buffer(self):
        self._out = b""

    def write(self, data):
        self.written.append(data)
        command = data.decode().strip()
        if data == b"\x05":
            self._out += (self._answer + "\r\n").encode()
        elif command == "RES" and self._lose_reset:
            self._lose_reset = False  # no answer at all: the first reset is lost
        elif command in self.refuse:
            self._out += b"\x15\r\n"
            self._answer = "Unknown command"
        else:
            self._out += b"\x06\r\n"
            self._answer = {"UNI": "0"}.get(command.split(",")[0], "")
            if command == "COM,1":
                self._continuous = True

    def read(self, count):
        if not self._out and self._continuous and self.lines:
            self._out = (self.lines.pop(0) + "\r\n").encode()
        data, self._out = self._out, b""
        if not data:
            time.sleep(0.01)
        return data

    def close(self):
        pass


def pfeiffer(controller, **config):
    spec = importlib.util.spec_from_file_location("pfeiffer_pressure", ROOT / "drivers" / "pfeiffer_pressure.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class Device(module.PfeifferPressure):
        def _open_port(self):
            return controller

    device = Device()
    device._setup("pressure", coerce_config(Device, {"port": "COM1", "silence_s": 0.3, **config}))
    return device


def run_until(device, condition, timeout=5):
    thread = threading.Thread(target=device.run)
    thread.start()
    try:
        wait_for(condition, timeout, "the driver to publish")
    finally:
        device._stop.set()
        thread.join(5)
    assert not thread.is_alive()


def test_pfeiffer_reads_the_continuous_lines_and_never_reports_zero_for_a_bad_gauge():
    controller = FakeController(["0,1.5e-07,2,1.0e+03", "0,1.6e-07,3,0.0e+00"], lose_first_reset=True)  # also rides out a lost first reset
    device = pfeiffer(controller)
    device.connect()
    assert controller.written[:1] == [b"RES\r\n"] and b"COM,1\r\n" in controller.written
    run_until(device, lambda: device.state["channels"] and device.state["channels"][1]["status"] == "error")
    assert device.state["channels"] == [{"pressure": 1.6e-07, "status": "ok"}, {"pressure": None, "status": "error"}]
    assert device.state["status"] == "check gauges"


def test_pfeiffer_refuses_a_controller_that_shows_another_unit_and_says_what_to_do():
    controller = FakeController()
    controller.read = FakeController.read.__get__(controller)
    original = controller.write

    def write(data):  # unit 1 = Torr
        original(data)
        if data.strip() == b"UNI":
            controller._answer = "1"

    controller.write = write
    device = pfeiffer(controller)
    with pytest.raises(ValueError, match="unit 1"):
        device.connect()


def test_pfeiffer_restarts_a_silent_controller_and_says_so_once():
    controller = FakeController(["0,1.0e-06"])
    device = pfeiffer(controller)
    device.connect()
    warnings = []
    device.log = type("Log", (), {"warning": lambda self, *a: warnings.append(a[0]), "debug": lambda self, *a: None})()
    controller.written.clear()
    run_until(device, lambda: device.state["status"] == "no data" and controller.written.count(b"COM,1\r\n") >= 2)  # restarted more than once
    assert device.state["channels"] == [{"pressure": None, "status": "error"}]  # not the last value, which would be a lie
    assert [w for w in warnings if "silent" in w] == ["The controller is silent; starting it again"]


def test_pfeiffer_without_a_port_says_what_to_set():
    device = pfeiffer(FakeController(), port="")
    with pytest.raises(ValueError, match="'port'"):
        device.connect()


def test_pfeiffer_simulated_runs_in_the_server_and_a_fault_is_none(lab):
    assert lab.pressure.state["simulated"] is True
    wait_for(lambda: len(lab.pressure.state["channels"]) == 2, 10, "readings")
    assert all(c["status"] == "ok" and c["pressure"] > 0 for c in lab.pressure.state["channels"])
    wait_for(lambda: len(lab.pressure_faulty.state["channels"]) == 2, 10, "readings")
    assert lab.pressure_faulty.state["channels"][1] == {"pressure": None, "status": "error"}
    assert lab.pressure_faulty.state["status"] == "check gauges"
