"""Services: background tasks. The same thing as a device, shown and treated as a task."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

SERVICE = '''from laborchestra import Service


class Ticker(Service):
    """Counts."""

    interval_s: float = 0.1
    state = {"ticks": 0, "version": VERSION}

    def run(self):
        while self.running:
            self.state["ticks"] += 1
            self.sleep(self.interval_s)
'''


@pytest.fixture()
def server(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    (workspace / "services").mkdir()
    (workspace / "devices" / "plain.py").write_text('from laborchestra import Device\n\n\nclass Plain(Device):\n    state = {"x": 1}\n')
    (workspace / "services" / "ticker.py").write_text(SERVICE.replace("VERSION", "1"))
    (workspace / "devices.json").write_text(json.dumps({"devices": {"plain": {"file": "devices/plain.py"}, "ticker": {"file": "services/ticker.py"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            yield lab, workspace
    finally:
        stop_server(process, log, workspace, url)


def invoke(lab, method, *args):
    return lab._run(lab._async._hub.invoke(method, *args))


def test_a_service_is_a_device_that_says_what_it_is(server):
    lab, _ = server
    lab.plain.wait_ready(30)
    lab.ticker.wait_ready(30)
    assert lab.plain.schema["kind"] == "device" and lab.ticker.schema["kind"] == "service"
    assert [o["name"] for o in lab.ticker.schema["config"]] == ["interval_s"]  # `kind` is not an option
    wait_for(lambda: lab.ticker.state["ticks"] >= 3, 10, "the service to run")  # state, logs, everything as in a device


def test_a_service_restarts_by_itself_when_its_file_changes_a_device_does_not(server):
    lab, workspace = server
    lab.ticker.wait_ready(30)
    lab.plain.wait_ready(30)
    (workspace / "services" / "ticker.py").write_text(SERVICE.replace("VERSION", "2"))
    (workspace / "devices" / "plain.py").write_text('from laborchestra import Device\n\n\nclass Plain(Device):\n    state = {"x": 2}\n')
    wait_for(lambda: lab.ticker.state.get("version") == 2, 30, "the service to run its new file by itself")
    time.sleep(2.5)  # the file watcher looks every second
    assert lab.plain.state["x"] == 1 and lab.plain.changed  # the device asks first: it may touch hardware


def test_every_service_template_makes_a_service_that_runs_and_the_uploader_reports_that_it_is_not_set_up(server):
    lab, workspace = server
    templates = {t["id"]: t for t in invoke(lab, "list_service_templates")}
    assert set(templates) == {"blank", "uploader"}
    for template in templates:
        made = invoke(lab, "scaffold_service", template, f"my_{template}", None)
        assert made["file"] == f"services/my_{template}.py" and made["kind"] == "service"
        text = (workspace / made["file"]).read_text()
        assert "{{" not in text and "(Service)" in text
        device = lab[f"my_{template}"]
        device.wait_ready(60)
        assert device.schema["kind"] == "service"
    wait_for(lambda: lab.my_blank.state["checks"] >= 2, 20, "the blank service to loop")
    assert lab.my_uploader.state["status"].startswith("not configured")
    (workspace / "services" / "orphan.py").write_text("# mine\n")
    with pytest.raises(RemoteError, match="never overwritten"):
        invoke(lab, "scaffold_service", "blank", "orphan", None)  # a file of that name exists already
    assert (workspace / "services" / "orphan.py").read_text() == "# mine\n"
    with pytest.raises(RemoteError, match="no service template"):
        invoke(lab, "scaffold_service", "nothing", "other", None)


class Sink(BaseHTTPRequestHandler):
    received: list = []

    def do_POST(self):
        Sink.received.append((self.headers.get("Authorization"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def test_the_uploader_sends_the_average_of_a_field_with_its_unit_and_the_key(server):
    lab, workspace = server
    sink = HTTPServer(("127.0.0.1", 0), Sink)
    threading.Thread(target=sink.serve_forever, daemon=True).start()
    try:
        invoke(lab, "scaffold_service", "uploader", "gauge_upload", None)
        lab.gauge_upload.wait_ready(60)
        invoke(lab, "update_device", "gauge_upload", {"file": "services/gauge_upload.py", "config": {
            "device": "plain", "path": "x", "url": f"http://127.0.0.1:{sink.server_port}/in", "api_key": "k-123", "interval_s": 1.0, "unit": "mbar"}})
        wait_for(lambda: Sink.received, 60, "the first upload")
        auth, body = Sink.received[0]
        assert auth == "Bearer k-123" and body == {"sensors": [{"id": "plain-x", "value": 1.0, "unit": "mbar"}]}
        wait_for(lambda: lab.gauge_upload.state["status"] == "ok" and lab.gauge_upload.state["uploads"] >= 1, 20, "the state to say so")  # published just after the request
    finally:
        sink.shutdown()
