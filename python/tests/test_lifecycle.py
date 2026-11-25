"""Workers must not outlive the server, also when they are stuck and cannot see that their input has ended."""

import json
import shutil
import subprocess
import sys
import time

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


def test_a_changed_device_file_is_noticed_and_restarts_only_when_asked(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    for name in ("manual.py", "automatic.py"):
        shutil.copy(DEVICES / "shaky.py", workspace / "devices" / name)
    devices = {"manual": {"file": "devices/manual.py"}, "automatic": {"file": "devices/automatic.py", "auto_restart": True}}
    (workspace / "devices.json").write_text(json.dumps({"devices": devices}))
    url = f"http://127.0.0.1:{free_port()}"
    server, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            lab.manual.wait_ready(30)
            lab.automatic.wait_ready(30)
            assert not lab.manual.changed and not lab.automatic.changed
            lab.manual.fine()
            lab.automatic.fine()
            for name in ("manual.py", "automatic.py"):
                path = workspace / "devices" / name
                path.write_text(path.read_text() + "\n# edited\n")
            wait_for(lambda: lab.manual.changed, 10, "the change to be noticed")
            time.sleep(2)
            assert lab.manual.state["calls"] == 1 and lab.manual.status == "ready"  # it keeps running what it started with
            wait_for(lambda: lab.automatic.state["calls"] == 0 and lab.automatic.status == "ready", 30, "the automatic restart")  # fresh process
            assert not lab.automatic.changed
            lab.restart_device("manual")
            wait_for(lambda: lab.manual.status == "ready" and lab.manual.state["calls"] == 0 and not lab.manual.changed, 30, "the manual restart")
            assert lab.get_device_config("automatic")["auto_restart"] is True
            lab.update_device("automatic", "devices/automatic.py", description="renamed")  # not mentioned: stays as it was
            assert lab.get_device_config("automatic")["auto_restart"] is True
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()


def test_a_worker_on_another_machine_connects_with_a_token_that_can_be_revoked(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    (workspace / "devices.json").write_text(json.dumps({"devices": {"remote_counter": {"remote": True}}}))
    url = f"http://127.0.0.1:{free_port()}"
    server, log = launch(workspace, data, url)
    workers = []

    def start_worker(token):
        process = subprocess.Popen(
            [sys.executable, "-m", "laborchestra.worker", str(DEVICES / "counter.py"), "--id", "remote_counter", "--url", url, "--token", token],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        workers.append(process)
        return process

    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            wait_for(lambda: lab.remote_counter.status == "waiting", 30, "the remote device to wait")
            assert "Waiting for a worker" in lab.remote_counter.error
            with pytest.raises(laborchestra.RemoteError, match="not a remote device"):
                lab.create_token("no_such_device")

            created = lab.create_token("remote_counter", "lab PC 2")
            token = created["token"]
            assert token.startswith("lo_") and created["device"] == "remote_counter"
            assert [{k: v for k, v in t.items() if k != "created"} for t in lab.list_tokens()] == [{"id": created["id"], "kind": "worker", "device": "remote_counter", "label": "lab PC 2"}]
            assert token not in (data / "tokens.json").read_text()  # only a hash is stored

            first = start_worker(token)
            wait_for(lambda: lab.remote_counter.status == "ready", 30, "the remote worker to register")
            lab.remote_counter.increment()
            assert lab.remote_counter.state["count"] == 1
            first.terminate()
            first.wait(10)
            wait_for(lambda: lab.remote_counter.status == "reconnecting", 10, "the lost worker to be noticed")

            lab.revoke_token(created["id"])
            assert lab.list_tokens() == []
            second = start_worker(token)
            assert second.wait(30) != 0  # refused: the worker gives up instead of trying for ever
            assert lab.remote_counter.status != "ready"
            with pytest.raises(laborchestra.RemoteError, match="There is no token"):
                lab.revoke_token(created["id"])
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()


def test_workers_and_scripts_talk_to_a_server_over_tls(tmp_path):
    import shutil as sh

    if sh.which("openssl") is None:
        pytest.skip("openssl is needed to make a test certificate")
    build_server()
    certificate, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(certificate), "-days", "2",
         "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], check=True, capture_output=True)
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    shutil.copy(DEVICES / "counter.py", workspace / "devices" / "counter.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"counter": {"file": "devices/counter.py"}}}))
    url = f"https://127.0.0.1:{free_port()}"
    env = {"Kestrel__Certificates__Default__Path": str(certificate), "Kestrel__Certificates__Default__KeyPath": str(key), "LABORCHESTRA_CA_FILE": str(certificate)}
    server, log = launch(workspace, data, url, env=env)
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv("LABORCHESTRA_CA_FILE", str(certificate))
            with laborchestra.connect(url, PASSPHRASE) as lab:
                lab.counter.wait_ready(30)  # the worker the server started connected over TLS too
                lab.counter.increment()
                assert lab.counter.state["count"] == 1
            patch.delenv("LABORCHESTRA_CA_FILE")
            with pytest.raises(Exception, match="not trusted"):  # a certificate nobody trusts is refused
                laborchestra.connect(url, PASSPHRASE, timeout=5)
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()
