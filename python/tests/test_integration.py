"""Starts the real server with a demo device and talks to it like a script does."""

import json
import os
import shutil
import signal
import socket
from dataclasses import dataclass
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

import laborchestra
from helpers import DEMO, DEVICES, PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import AuthError, RemoteError

BASE_DEVICES = {
    "pressure": {"file": "devices/demo_pressure.py", "config": {"noise": 0.0}},
    "counter": {"file": "devices/counter.py"},
    "broken": {"file": "devices/demo_pressure.py", "config": {"speed": 1}},  # no such option
}


@dataclass
class Server:
    url: str
    data_dir: Path
    workspace: Path

    @property
    def recordings(self) -> Path:
        return self.data_dir / "recordings"


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    build_server()
    workspace = tmp_path_factory.mktemp("workspace")
    (workspace / "devices").mkdir()
    shutil.copy(DEMO, workspace / "devices" / "demo_pressure.py")
    for name in ("counter.py", "secretive.py"):
        shutil.copy(DEVICES / name, workspace / "devices" / name)
    (workspace / "devices.json").write_text(json.dumps({"devices": BASE_DEVICES}))
    data_dir = tmp_path_factory.mktemp("data")
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data_dir, url)
    try:
        yield Server(url, data_dir, workspace)
    finally:
        print(stop_server(process, log, workspace, url))


def write_devices(server, devices):
    target = server.workspace / "devices.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"devices": devices}))
    os.replace(temporary, target)  # like an editor: write elsewhere, then rename


@pytest.fixture()
def reset_devices(server):
    yield
    write_devices(server, BASE_DEVICES)
    with laborchestra.connect(server.url, PASSPHRASE) as lab:
        wait_for(lambda: sorted(lab.devices) == sorted(BASE_DEVICES), message="devices back to normal")


@pytest.fixture()
def lab(server):
    with laborchestra.connect(server.url, PASSPHRASE) as lab:
        try:
            wait_for(lambda: lab.devices and lab.pressure.status == "ready", 40, "device ready")
        except AssertionError as e:  # say what the device was doing: this has failed once in a while on a slow Linux runner
            entries = "\n".join(f"  {x['level']} {x['logger']}: {x['message']}" for x in lab.pressure.logs()) if "pressure" in lab.devices else "(no device)"
            server_log = "\n".join(f"  {x['level']} {x['message']}" for x in lab.logs("server", limit=60))
            raise AssertionError(f"{e}\ndevices: {dict((k, lab[k].status) for k in lab.devices)}\npressure error: {lab.pressure.error if 'pressure' in lab.devices else None}\npressure log:\n{entries}\nserver log:\n{server_log}") from None
        yield lab


def test_script_reads_state_and_calls_actions(lab):
    assert sorted(lab.devices) == ["broken", "counter", "pressure"]
    assert lab.pressure.state["channels"][0]["status"] == "ok"
    assert lab.pressure.schema["class"] == "DemoPressure"
    assert [a["name"] for a in lab.pressure.schema["actions"]] == ["set_pressure"]

    assert lab.pressure.set_pressure(0, 4.5e-3) is None
    wait_for(lambda: lab.pressure.state["channels"][0]["pressure"] == 4.5e-3, message="state update")


def test_two_clients_see_the_same_state(server, lab):
    with laborchestra.connect(server.url, PASSPHRASE) as other:
        lab.pressure.set_pressure(0, 1.25e-2)
        wait_for(lambda: other.pressure.state["channels"][0]["pressure"] == 1.25e-2, message="state in second client")


def test_errors_reach_the_caller(lab):
    with pytest.raises(RemoteError) as e:
        lab.pressure.set_pressure(7, 1.0)
    assert e.value.type == "ValueError" and "no channel 7" in e.value.message and "Traceback" in e.value.traceback
    with pytest.raises(RemoteError) as e:
        lab.pressure.set_pressure("a", 1.0)
    assert e.value.type == "TypeError" and "channel" in e.value.message
    with pytest.raises(AttributeError, match="no action 'nope'"):
        lab.pressure.nope
    with pytest.raises(RemoteError) as e:
        lab.pressure.call("nope")
    assert e.value.type == "LookupError"
    with pytest.raises(laborchestra.LabOrchestraError, match="does not exist"):
        lab.missing.state


def test_logs_of_devices_and_server(lab):
    entries = wait_for(lambda: [e for e in lab.pressure.logs() if "Demo gauge ready" in e["message"]], message="device log")
    assert entries[0]["level"] == "INFO" and entries[0]["source"] == "device:pressure"
    assert entries[0]["logger"] == "lab.pressure" and entries[0]["time"].endswith("Z")

    with pytest.raises(RemoteError):
        lab.pressure.set_pressure(7, 1.0)
    failed = wait_for(
        lambda: [e for e in lab.pressure.logs(level="WARNING") if "no channel 7" in (e["traceback"] or "")],
        message="warning with the traceback in the log",
    )
    assert "Action set_pressure failed: ValueError" in failed[-1]["message"]

    last = lab.pressure.logs()[-1]["seq"]
    assert lab.pressure.logs(since=last) == []  # following the log
    server_log = lab.logs("server", limit=500)
    assert any("pressure" in e["message"] and e["source"] == "server" for e in server_log)
    assert all(e["level"] in ("INFO", "WARNING", "ERROR") for e in server_log)
    assert {e["source"] for e in lab.logs()} >= {"server", "device:pressure"}


def test_device_that_cannot_start_reports_why(lab):
    wait_for(lambda: lab.broken.status == "error", message="error status")
    assert "Unknown option(s): speed" in lab.broken.error and "exit code 2" in lab.broken.error
    entries = wait_for(lambda: lab.broken.logs(), message="log of the broken device")
    assert any(e["logger"] == "process" and "Unknown option" in e["message"] for e in entries)
    assert any(e["logger"] == "supervisor" and "restarting" in e["message"] for e in entries)
    with pytest.raises(RemoteError) as e:
        lab.broken.call("set_pressure", 0, 1.0)
    assert e.value.type == "DeviceNotReady"
    assert lab.pressure.status == "ready"  # the others are not affected


def test_persisted_state_survives_a_restart_of_the_worker(server, lab):
    wait_for(lambda: lab.counter.status == "ready", message="counter ready")
    start = lab.counter.state["count"]
    lab.counter.increment()
    lab.counter.increment()
    wait_for(lambda: lab.counter.state["count"] == start + 2, message="count")
    saved = server.data_dir / "settings" / "counter.json"
    wait_for(lambda: saved.exists() and json.loads(saved.read_text())["count"] == start + 2, message="saved file")
    assert json.loads(saved.read_text()) == {"count": start + 2, "channels": [21, 2]}  # not `scratch`

    mine = str(server.workspace / "devices" / "counter.py")  # only the worker of this test server
    worker = next(p.pid for p in psutil.process_iter(["cmdline"]) if mine in (p.info["cmdline"] or []))
    os.kill(worker, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
    wait_for(lambda: lab.counter.status == "ready" and lab.counter.state["scratch"] == 0, 20, "restart")
    assert lab.counter.state["count"] == start + 2
    assert lab.counter.state["channels"] == [21, 2]
    assert lab.counter.state["scratch"] == 0  # not persisted: back to the default


def test_patches_keep_every_client_in_sync(server, lab):
    wait_for(lambda: lab.counter.status == "ready", message="counter ready")
    with laborchestra.connect(server.url, PASSPHRASE) as other:  # starts from the full state, then follows patches
        for seed in range(12):
            lab.counter.scramble(seed, 25)
            expected = None

            def converged():
                nonlocal expected
                with laborchestra.connect(server.url, PASSPHRASE) as fresh:  # always the full state of the server
                    expected = fresh.counter.state["tree"]
                    revision = fresh.counter._device._info["revision"]
                return (
                    lab.counter.state["tree"] == expected
                    and other.counter.state["tree"] == expected
                    and lab.counter._device._info["revision"] == revision
                )

            wait_for(converged, 10, f"all clients equal after scramble {seed}")


def test_devices_can_be_added_changed_and_removed(server, lab, reset_devices):
    late = {"file": "devices/demo_pressure.py", "config": {"noise": 0.0}}
    write_devices(server, {**BASE_DEVICES, "late": late})
    wait_for(lambda: "late" in lab.devices and lab.late.status == "ready", message="new device")
    late_pid, pressure_pid = lab.late.state["process_id"], lab.pressure.state["process_id"]

    write_devices(server, {**BASE_DEVICES, "late": {**late, "config": {"noise": 0.1}}})
    wait_for(lambda: lab.late.status == "ready" and lab.late.state["process_id"] != late_pid, message="restart after a change")
    assert lab.pressure.state["process_id"] == pressure_pid  # the others keep running

    (server.workspace / "devices.json").write_text("{ not json")
    wait_for(lambda: any("devices.json was not loaded" in e["message"] for e in lab.logs("server")), message="error report")
    assert lab.late.status == "ready" and lab.pressure.status == "ready"  # a broken file changes nothing

    write_devices(server, BASE_DEVICES)
    wait_for(lambda: "late" not in lab.devices, message="removal")
    assert lab.pressure.status == "ready"


def test_device_can_be_restarted(lab):
    pid = lab.pressure.state["process_id"]
    lab.pressure.restart()
    wait_for(lambda: lab.pressure.status == "ready" and lab.pressure.state["process_id"] != pid, message="restart")
    with pytest.raises(RemoteError) as e:
        lab.restart_device("nope")
    assert e.value.type == "LookupError"


def test_devices_can_be_managed_through_the_api(server, lab, reset_devices):
    files = lab.list_device_files()
    assert {"file": "devices/demo_pressure.py", "devices": ["broken", "pressure"]} in files
    assert all(not f["file"].startswith(("_", ".")) and f["file"].endswith(".py") for f in files)

    described = lab.describe_device_file("devices/demo_pressure.py")
    assert described["class"] == "DemoPressure" and described["doc"].startswith("Simulated")
    assert [(o["name"], o["type"], o["required"]) for o in described["config"]] == [("noise", "float", False)]
    assert [a["name"] for a in described["actions"]] == ["set_pressure"]

    entry = "devices/demo_pressure.py"
    lab.add_device("fresh", entry, config={"noise": 0.0}, description="added by the test")
    wait_for(lambda: "fresh" in lab.devices and lab.fresh.status == "ready", message="new device")
    saved = json.loads((server.workspace / "devices.json").read_text())["devices"]
    assert saved["fresh"] == {"file": entry, "config": {"noise": 0.0}, "description": "added by the test"}
    assert saved["pressure"] and saved["counter"]  # the others are kept
    assert lab.get_device_config("fresh") == {"file": entry, "driver": None, "python": None, "config": {"noise": 0.0}, "description": "added by the test"}

    pid = lab.fresh.state["process_id"]
    lab.update_device("fresh", entry, config={"noise": 0.0}, description="another text")  # only the description
    time.sleep(1.5)
    assert lab.fresh.state["process_id"] == pid and lab.get_device_config("fresh")["description"] == "another text"
    lab.update_device("fresh", entry, config={"noise": 0.2})
    wait_for(lambda: lab.fresh.status == "ready" and lab.fresh.state["process_id"] != pid, message="restart after a change")

    for bad, kind, text in [
        (("fresh", entry), "ValueError", "already a device"),
        (("Bad-Id", entry), "ValueError", "snake_case"),
        (("outside", "../outside.py"), "ValueError", "not a Python file in the workspace"),
        (("missing", "devices/nothing.py"), "ValueError", "not a Python file in the workspace"),
    ]:
        with pytest.raises(RemoteError, match=text) as e:
            lab.add_device(*bad)
        assert e.value.type == kind
    with pytest.raises(RemoteError, match="no device 'nope'"):
        lab.remove_device("nope")

    lab.remove_device("fresh")
    wait_for(lambda: "fresh" not in lab.devices, message="removal")
    assert "fresh" not in json.loads((server.workspace / "devices.json").read_text())["devices"]


def test_describing_a_file_that_cannot_be_loaded_says_why(server, lab):
    broken = server.workspace / "devices" / "broken_import.py"
    broken.write_text("from laborchestra import Device\nimport no_such_module_xyz\n\nclass B(Device):\n    pass\n")
    try:
        with pytest.raises(RemoteError, match="could not be loaded.*no_such_module_xyz") as e:
            lab.describe_device_file("devices/broken_import.py")
        assert e.value.type == "DeviceFileError"
    finally:
        broken.unlink()


def test_secrets_reach_the_device_and_nothing_else(server, lab, reset_devices):
    vault = {"file": "devices/secretive.py", "config": {"api_key": {"secret": "demo_key"}}}
    write_devices(server, {**BASE_DEVICES, "vault": vault})
    wait_for(lambda: "vault" in lab.devices and lab.vault.status == "error", message="missing secret")
    assert "demo_key" in lab.vault.error and "not defined" in lab.vault.error

    lab.set_secret("demo_key", "abcdef-secret")
    wait_for(lambda: lab.vault.status == "ready" and lab.vault.state["key_length"] == 13, message="secret delivered")
    assert "demo_key" in lab.list_secrets()
    everything = json.dumps([lab.logs(limit=2000), lab.vault.state, lab.vault.schema, lab.vault.error])
    assert "abcdef-secret" not in everything
    assert "abcdef-secret" not in (server.workspace / "devices.json").read_text()
    lab.delete_secret("demo_key")
    assert "demo_key" not in lab.list_secrets()


def test_when_an_action_returns_its_effects_are_already_in_the_state(lab):
    """No waiting, no sleeping: a script (or a lock loop) reads the state right after the call."""
    wait_for(lambda: lab.counter.status == "ready", message="counter ready")
    for _ in range(40):
        before = lab.counter.state["count"]
        lab.counter.increment()
        assert lab.counter.state["count"] == before + 1
    with pytest.raises(RemoteError):
        lab.counter.scramble("x", 1)  # a failing action: what it changed before failing is there as well


def test_recording_captures_every_change_with_its_cause(server, lab):
    name = f"run {int(time.time() * 1000)}.1"
    wait_for(lambda: lab.counter.status == "ready" and lab.pressure.status == "ready", message="devices ready")
    start = lab.counter.state["count"]
    with pytest.raises(RemoteError, match="already exists|Nothing"):
        lab.stop_recording()

    lab.start_recording(name, tags={"detuning": 1.5, "run": 3})
    assert lab.get_recording()["active"] and lab.get_recording()["name"] == name
    with pytest.raises(RemoteError, match="Already recording"):
        lab.start_recording("other")
    lab.counter.increment()
    lab.counter.scramble(5, 20)
    lab.pressure.restart()  # status changes and a new registration
    wait_for(lambda: lab.pressure.status == "ready" and lab.counter.state["count"] == start + 1, message="settled")
    time.sleep(0.5)
    lab.stop_recording()
    assert not lab.get_recording()["active"]
    assert name in [r["name"] for r in lab.list_recordings()]

    rec = laborchestra.load_recording(server.recordings / name)
    assert rec.kind == "recording" and not rec.interrupted and rec.duration > 0
    assert rec.tags == {"detuning": 1.5, "run": 3} and {"counter", "pressure"} <= set(rec.devices)
    assert rec.header["format"] == 1 and rec.header["started_by"] == "script" and rec.start_time.tzinfo is not None and rec.end_time > rec.start_time

    actions = list(rec.changes(device="counter", by="script"))
    assert [e["action"] for e in actions if "action" in e][:2] == ["increment", "scramble"]
    assert any("set" in e for e in actions)  # the changes made by the actions carry the caller
    assert any(e["device"] == "pressure" and e.get("status") == "starting" for e in rec.events)
    assert any(e["device"] == "pressure" and "state" in e and e["by"] == "device" for e in rec.events)
    assert [e["t"] for e in rec.events] == sorted(e["t"] for e in rec.events)

    # the header's final state and the states rebuilt from the start state and the events agree
    rebuilt, final = rec.state_at(), rec.header["final_state"]
    for device in ("counter", "pressure"):
        assert rebuilt[device] == final[device]["state"], device
    t, count = rec.series("counter.count")
    assert count[0] == start and count[-1] == start + 1 and t[0] == 0.0

    snapshot = f"snap {int(time.time() * 1000)}"
    lab.snapshot(snapshot, tags={"purpose": "test"})
    snap = laborchestra.load_recording(server.recordings / snapshot)
    assert snap.kind == "snapshot" and snap.tags == {"purpose": "test"} and snap.state_at()["counter"]["count"] == start + 1
    with pytest.raises(RemoteError, match="already exists"):
        lab.snapshot(snapshot)
    with pytest.raises(RemoteError) as e:
        lab.snapshot("../escape")
    assert e.value.type == "ValueError"


def test_recording_context_manager_and_discarding(server, lab):
    name = f"ctx {int(time.time() * 1000)}"
    with pytest.raises(ZeroDivisionError):
        with lab.recording(name):
            assert lab.get_recording()["active"]
            1 / 0
    assert not lab.get_recording()["active"]  # stopped although the block failed
    assert laborchestra.load_recording(server.recordings / name).kind == "recording"

    gone = f"gone {int(time.time() * 1000)}"
    lab.start_recording(gone)
    lab.abort_recording(discard=True)
    assert not (server.recordings / f"{gone}.yaml").exists() and not (server.recordings / gone).exists()


def test_interrupted_recording_is_repaired_when_the_server_starts_again(tmp_path):
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    shutil.copy(DEVICES / "counter.py", workspace / "devices" / "counter.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"counter": {"file": "devices/counter.py"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    first, log1 = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            wait_for(lambda: lab.counter.status == "ready", message="counter ready")
            lab.start_recording("crash", tags={"why": "kill"})
            for _ in range(5):
                lab.counter.increment()
            time.sleep(0.5)
        first.kill()  # no chance to close anything
        first.wait()
    finally:
        log1.close()
    yaml_file = data / "recordings" / "crash.yaml"
    assert "end_time" not in yaml_file.read_text()
    assert not (data / "recordings" / "crash" / "events.json").read_text().rstrip().endswith("]")

    second, log2 = launch(workspace, data, f"http://127.0.0.1:{free_port()}")
    try:
        assert "interrupted: true" in yaml_file.read_text()
        rec = laborchestra.load_recording(data / "recordings" / "crash")
        assert rec.interrupted and rec.tags == {"why": "kill"}
        assert len([e for e in rec.events if e.get("action") == "increment"]) == 5
        assert rec.state_at()["counter"]["count"] == 5 and rec.duration > 0
    finally:
        second.terminate()
        try:
            second.wait(15)
        except subprocess.TimeoutExpired:
            children = [f"{c.pid} {c.status()} {' '.join(c.cmdline())[-80:]}" for c in psutil.Process(second.pid).children(recursive=True)]
            second.kill()
            port = second.args[-1].rsplit(":", 1)[1]
            pytest.fail(f"the server did not stop; its children: {children}\n{(workspace / f'server-{port}.log').read_text()[-1800:]}")
        log2.close()
    assert not [p for p in psutil.process_iter(["cmdline"]) if str(workspace) in " ".join(p.info["cmdline"] or [])]


def test_wrong_or_missing_token_is_rejected(server):
    with pytest.raises(AuthError):
        laborchestra.connect(server.url, "wrong")
    with pytest.raises(AuthError):
        laborchestra.connect(server.url, "")


def test_killed_worker_is_reported_and_restarted(lab):
    pid = lab.pressure.state["process_id"]
    assert psutil.pid_exists(pid)
    os.kill(pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
    wait_for(lambda: lab.pressure.status in ("error", "starting"), 10, "status after the kill", interval=0.005)
    wait_for(lambda: lab.pressure.status == "ready" and lab.pressure.state["process_id"] != pid, 20, "restart")
    assert lab.pressure.set_pressure(1, 2e-8) is None  # works again
    wait_for(lambda: lab.pressure.state["channels"][1]["pressure"] == 2e-8, message="state after restart")
