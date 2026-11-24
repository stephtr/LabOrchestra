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
from laborchestra import AuthError, RemoteError

ROOT = Path(__file__).resolve().parents[2]
CSPROJ = ROOT / "server" / "LabOrchestra.Server" / "LabOrchestra.Server.csproj"
DEMO = ROOT / "workspace" / "devices" / "demo_pressure.py"
PASSPHRASE = "test-passphrase"


@dataclass
class Server:
    url: str
    data_dir: Path


def wait_for(condition, timeout=20, message="condition", interval=0.1):
    end = time.time() + timeout
    while time.time() < end:
        try:
            value = condition()
            if value:
                return value
        except Exception:
            pass
        time.sleep(interval)
    raise AssertionError(f"Timed out waiting for {message}")


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    build = subprocess.run(
        ["dotnet", "build", str(CSPROJ), "-c", "Release", "-v", "q", "--nologo"], capture_output=True, text=True
    )
    assert build.returncode == 0, build.stdout + build.stderr
    out = CSPROJ.parent / "bin" / "Release" / "net11.0" / "LabOrchestra.Server.dll"

    workspace = tmp_path_factory.mktemp("workspace")
    (workspace / "devices").mkdir()
    shutil.copy(DEMO, workspace / "devices" / "demo_pressure.py")
    shutil.copy(Path(__file__).parent / "devices" / "counter.py", workspace / "devices" / "counter.py")
    (workspace / "devices.json").write_text(
        json.dumps(
            {
                "devices": {
                    "pressure": {"file": "devices/demo_pressure.py", "config": {"noise": 0.0}},
                    "counter": {"file": "devices/counter.py"},
                    "broken": {"file": "devices/demo_pressure.py", "config": {"speed": 1}},  # no such option
                }
            }
        )
    )
    data_dir = tmp_path_factory.mktemp("data")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "LABORCHESTRA_WORKSPACE": str(workspace),
        "LABORCHESTRA_PYTHON": sys.executable,
        "LABORCHESTRA_PASSPHRASE": PASSPHRASE,
        "LABORCHESTRA_DATA_DIR": str(data_dir),
    }
    log = (workspace / "server.log").open("w")
    process = subprocess.Popen(
        ["dotnet", str(out), "--urls", url], env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL
    )
    try:
        def up():
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True

        wait_for(up, 30, "server start")
        yield Server(url, data_dir)
    finally:
        process.terminate()
        try:
            process.wait(15)
        except subprocess.TimeoutExpired:
            process.kill()
        log.close()
        print((workspace / "server.log").read_text())


@pytest.fixture()
def lab(server):
    with laborchestra.connect(server.url, PASSPHRASE) as lab:
        wait_for(lambda: lab.devices and lab.pressure.status == "ready", message="device ready")
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
    failed = wait_for(lambda: lab.pressure.logs(level="WARNING"), message="warning in the log")
    assert "set_pressure failed" in failed[-1]["message"] and "no channel 7" in failed[-1]["traceback"]

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

    pid = lab.counter.state.get("process_id")
    psutil_pid = next(p.pid for p in psutil.process_iter(["cmdline"]) if "counter.py" in " ".join(p.info["cmdline"] or []))
    os.kill(psutil_pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
    wait_for(lambda: lab.counter.status == "ready" and lab.counter.state["scratch"] == 0, 20, "restart")
    assert lab.counter.state["count"] == start + 2
    assert lab.counter.state["channels"] == [21, 2]
    assert lab.counter.state["scratch"] == 0  # not persisted: back to the default


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
