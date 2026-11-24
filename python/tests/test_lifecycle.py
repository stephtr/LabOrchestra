"""Workers must not outlive the server, also when they are stuck and cannot see that their input has ended."""

import json
import shutil
import subprocess
import sys

import psutil
import pytest

import laborchestra
from helpers import DEVICES, PASSPHRASE, build_server, free_port, launch, wait_for


def alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def test_a_stuck_worker_does_not_survive_a_killed_server(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    shutil.copy(DEVICES / "stuck.py", workspace / "devices" / "stuck.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"stuck": {"file": "devices/stuck.py"}}}))
    first, log1 = launch(workspace, data, f"http://127.0.0.1:{free_port()}")
    second = log2 = None
    try:
        url = f"http://127.0.0.1:{first.args[-1].rsplit(':', 1)[1]}"
        with laborchestra.connect(url, PASSPHRASE) as lab:
            wait_for(lambda: lab.stuck.status == "ready" and lab.stuck.state["pid"], 30, "worker")
            pid = lab.stuck.state["pid"]
        wait_for(lambda: any(e["pid"] == pid for e in json.loads((data / "workers.json").read_text())), 5, "the worker is recorded")
        first.kill()  # no chance to tell the worker
        first.wait()
        if sys.platform != "darwin":  # Job Object (Windows) and PR_SET_PDEATHSIG (Linux): the operating system ends it
            wait_for(lambda: not alive(pid), 10, "the operating system to end the stuck worker")
        else:
            assert alive(pid), "macOS has nothing but the cleanup at the next start (this assertion shows the test is meaningful)"
        second, log2 = launch(workspace, data, f"http://127.0.0.1:{free_port()}")  # kills what is left before starting devices
        wait_for(lambda: not alive(pid), 20, "the next server to end the leftover worker")
        assert not any(e["pid"] == pid for e in json.loads((data / "workers.json").read_text()))  # and it is no longer recorded
    finally:
        for server, log in ((first, log1), (second, log2)):
            if server is not None:
                server.terminate()
                try:
                    server.wait(15)
                except subprocess.TimeoutExpired:
                    server.kill()
                log.close()


def test_a_device_whose_actions_keep_failing_is_degraded_until_one_works(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    shutil.copy(DEVICES / "shaky.py", workspace / "devices" / "shaky.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"shaky": {"file": "devices/shaky.py"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    server, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            lab.shaky.wait_ready(30)
            for _ in range(5):  # a caller's mistakes and an interrupted move do not say that the device has a problem
                with pytest.raises(laborchestra.RemoteError):
                    lab.shaky.wrong_argument()
                with pytest.raises(laborchestra.RemoteError):
                    lab.shaky.stopped_on_purpose()
            assert lab.shaky.status == "ready"
            for _ in range(2):
                with pytest.raises(laborchestra.RemoteError):
                    lab.shaky.break_down()
            assert lab.shaky.status == "ready"
            with pytest.raises(laborchestra.RemoteError):
                lab.shaky.break_down()
            wait_for(lambda: lab.shaky.status == "degraded", 5, "degraded after three failures in a row")
            assert "3 actions in a row failed" in lab.shaky.error and "bus does not answer" in lab.shaky.error
            lab.shaky.fine()  # a degraded device can still be used, and a success ends it
            wait_for(lambda: lab.shaky.status == "ready" and not lab.shaky.error, 5, "ready again")
            assert lab.shaky.state["calls"] == 1
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()


def test_a_client_of_another_protocol_version_is_refused_with_a_clear_message(tmp_path, monkeypatch):
    import urllib.error
    import urllib.request

    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    url = f"http://127.0.0.1:{free_port()}"
    server, log = launch(workspace, data, url)
    try:
        assert json.load(urllib.request.urlopen(f"{url}/api/protocol")) == {"protocol": 1, "supported": [1]}
        with pytest.raises(urllib.error.HTTPError) as refused:
            urllib.request.urlopen(f"{url}/hub/control?protocol=7")
        assert refused.value.code == 426 and "protocol 1" in json.loads(refused.value.read())["error"]
        import laborchestra._hub as hub

        monkeypatch.setattr(hub, "PROTOCOL", 7)
        with pytest.raises(ConnectionError, match="protocol 1"):
            laborchestra.connect(url, PASSPHRASE)
        monkeypatch.undo()
        with laborchestra.connect(url, PASSPHRASE):
            pass  # the right version works
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()


def test_errors_of_the_browser_reach_the_servers_log(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    url = f"http://127.0.0.1:{free_port()}"
    server, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE, name="ui") as lab:
            lab._run(lab._async._hub.invoke("report_client_error", "TypeError: x is undefined", "at Foo (app.js:1:1)", "react"))
            entries = [e for e in lab.logs("client")]
            assert len(entries) == 1
            assert entries[0]["message"] == "TypeError: x is undefined" and entries[0]["level"] == "ERROR"
            assert entries[0]["traceback"] == "at Foo (app.js:1:1)" and entries[0]["logger"] == "ui:react"
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()
