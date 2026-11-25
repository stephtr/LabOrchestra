"""The persistent memory of the server: events, history of numeric fields, notes, ids."""

import json
import shutil
import subprocess
import time

import pytest

import laborchestra
from helpers import DEVICES, PASSPHRASE, build_server, free_port, launch, wait_for


def stop(server, log):
    server.terminate()
    try:
        server.wait(15)
    except subprocess.TimeoutExpired:
        server.kill()
    log.close()


def test_events_history_and_notes_are_kept_and_survive_a_restart(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    shutil.copy(DEVICES / "counter.py", workspace / "devices" / "counter.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"counter": {"file": "devices/counter.py"}}}))
    env = {"LABORCHESTRA_HISTORY_INTERVAL_S": "0.3"}
    server, log = launch(workspace, data, f"http://127.0.0.1:{free_port()}", env=env)
    url = f"http://127.0.0.1:{server.args[-1].rsplit(':', 1)[1]}"
    started = time.time()
    try:
        with laborchestra.connect(url, PASSPHRASE, name="notebook") as lab:
            lab.counter.wait_ready(30)
            base = lab.counter.state["count"]
            time.sleep(0.4)  # the registration sampled the value just now; wait out the interval
            for _ in range(4):
                lab.counter.increment()
                time.sleep(0.4)  # longer than the sampling interval: every value is kept

            events = lab.events("counter", "action", since=started)
            assert [(e["by"], e["data"]["action"]) for e in events] == [("notebook", "increment")] * 4
            assert all(a["time"] <= b["time"] for a, b in zip(events, events[1:])) and events[0]["id"] < events[-1]["id"]
            statuses = [e["data"]["status"] for e in lab.events("counter", "status", since=started - 60)]
            assert "ready" in statuses

            history = lab.history("counter", "count", since=started)
            assert [v for _, v in history][-4:] == [base + i for i in range(1, 5)]
            assert all(started - 1 < t < time.time() + 1 for t, _ in history)
            assert len(lab.history("counter", "count", since=started, max_points=2)) == 2  # longer series are averaged down
            assert lab.history("counter", "no.such.field") == []

            first = lab.add_note("Tweezer realigned after the pump was serviced", ["counter"])
            lab.add_note("Unrelated", ["elsewhere"])
            assert len(first) == 32 and first != lab.add_note("same text", None)  # unique ids
            mine = lab.notes("counter")
            assert [(n["text"], n["refs"], n["author"]) for n in mine] == [("Tweezer realigned after the pump was serviced", ["counter"], "notebook")]
            with pytest.raises(laborchestra.RemoteError, match="needs text"):
                lab.add_note("  ")
    finally:
        stop(server, log)

    second, log2 = launch(workspace, data, f"http://127.0.0.1:{free_port()}", env=env)  # the same data folder
    try:
        url = f"http://127.0.0.1:{second.args[-1].rsplit(':', 1)[1]}"
        with laborchestra.connect(url, PASSPHRASE) as lab:
            assert len(lab.events("counter", "action", since=started)) == 4
            assert lab.notes("counter")[0]["text"].startswith("Tweezer")
            assert len(lab.history("counter", "count", since=started)) >= 4
    finally:
        stop(second, log2)


def test_recordings_have_a_unique_id(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    server, log = launch(workspace, data, f"http://127.0.0.1:{free_port()}")
    try:
        url = f"http://127.0.0.1:{server.args[-1].rsplit(':', 1)[1]}"
        with laborchestra.connect(url, PASSPHRASE) as lab:
            ids = []
            for name in ("one", "two"):
                with lab.recording(name):
                    pass
                ids.append(laborchestra.load_recording(data / "recordings" / name).header["id"])
            assert len(set(ids)) == 2 and all(len(i) == 32 for i in ids)
    finally:
        stop(server, log)
