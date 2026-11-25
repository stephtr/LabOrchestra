"""Procedures: @procedure functions in procedures/*.py, run by the server in processes of their own."""

import json
import os
import shutil
import sqlite3
import time
from pathlib import Path

import pytest

import laborchestra
from helpers import DEVICES, PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

HEAD = "import asyncio, os\nfrom laborchestra import procedure\n\n"

PROCEDURES = {
    "counting.py": HEAD + '''
@procedure(devices=["knob"], title="Count up")
async def count_up(lab, times: int = 3, step_s: float = 0.05, label: str = "steps"):
    """Turns the knob a few times.

    Args:
        times: how often
        step_s: pause between two turns
    """
    print("starting to count")
    for i in lab.progress(times, label):
        await lab.knob.set_value(float(i + 1))
        await lab.sleep(step_s)
    lab.status("all done")
    return {"value": lab.knob.state["value"]}


@procedure(devices=["knob"])
async def explode(lab):
    await lab.knob.set_value(5)
    raise ValueError("this went wrong")
''',
    "scans.py": HEAD + '''
@procedure(devices=["knob"])
async def long_scan(lab, hold_s: float = 120, name: str = "scan_a"):
    try:
        async with lab.recording(name, tags={"detuning": 3}):
            await lab.knob.set_value(7)
            await lab.sleep(hold_s)
    finally:
        await lab.knob.set_value(-1)  # back to a defined state, also when aborted


@procedure(devices=["knob"])
async def stubborn(lab):
    """Does not stop when told to."""
    async with lab.recording("scan_stubborn"):
        while True:
            try:
                await asyncio.sleep(0.1)
            except asyncio.CancelledError:
                pass


@procedure(devices=["knob"])
async def dies(lab):
    async with lab.recording("scan_dies"):
        await asyncio.sleep(0.3)
        os._exit(3)  # the process is gone: no report, no cleanup


@procedure(devices=["other"])
async def on_the_other(lab, seconds: float = 0.3):
    await lab.other.set_value(2)
    await lab.sleep(seconds)


@procedure(devices=[])
async def undeclared(lab):
    lab.knob  # not declared


@procedure(devices=[])
async def sneaky(lab):
    await lab.raw["knob"].set_value(9)  # around the check of the lab object: the server refuses


@procedure(devices=["knob"])
async def pausing(lab):
    for i in lab.progress(6, "pieces"):
        await lab.sleep(0.4)
''',
    "broken.py": "def oops(:\n",
    "_helper.py": "x = 1\n",
}

TRIGGERS = HEAD + '''
@procedure(devices=["knob"], on="recording.finished")
async def after_recording(lab, event: dict | None = None):
    """Runs after a recording."""
    text = open(event["header"]).read()  # the files are closed: the header is complete
    ended = "end_time" in text
    await lab.knob.set_value(float(len(event["name"])) if ended else -99.0)


@procedure(devices=["other"], on=["snapshot.saved", "recording.discarded"])
async def after_snapshot(lab, event: dict | None = None):
    await lab.other.set_value(float(len(event["name"])))


@procedure(devices=[], on="recording.finished")
async def always_fails(lab):
    raise RuntimeError("the trigger is broken")
'''


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    build_server()
    root = tmp_path_factory.mktemp("procedures")
    workspace, data = root / "workspace", root / "data"
    (workspace / "devices").mkdir(parents=True)
    (workspace / "procedures").mkdir()
    for name in ("knob", "other"):
        shutil.copy(DEVICES / "knob.py", workspace / "devices" / f"{name}.py")
    for name, text in PROCEDURES.items():
        (workspace / "procedures" / name).write_text(text)
    (workspace / "devices.json").write_text(json.dumps({"devices": {"knob": {"file": "devices/knob.py"}, "other": {"file": "devices/other.py"}}}))
    # a run that was going when an earlier server ended
    data.mkdir()
    with sqlite3.connect(data / "runs.db") as db:
        db.execute("CREATE TABLE runs (id TEXT PRIMARY KEY, started REAL NOT NULL, record TEXT NOT NULL)")
        record = {"id": "leftover0001", "procedure": "count_up", "status": "running", "started": time.time() - 100, "ended": None, "params": {}, "devices": []}
        db.execute("INSERT INTO runs VALUES (?, ?, ?)", ("leftover0001", record["started"], json.dumps(record)))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, env={"LABORCHESTRA_ABORT_GRACE_S": "2"})
    try:
        yield url, workspace, data
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(server):
    with laborchestra.connect(server[0], PASSPHRASE) as lab:
        lab.knob.wait_ready(30)
        lab.other.wait_ready(30)
        yield lab


def recording_header(server, name):
    import yaml

    return yaml.safe_load(next(Path(server[2]).glob(f"recordings/{name}.yaml")).read_text())


def test_procedures_are_listed_with_their_parameters_and_a_broken_file_with_its_error(lab):
    listed = {p.get("name") or p["file"]: p for p in lab.list_procedures()}
    count = listed["count_up"]
    assert count["title"] == "Count up" and count["devices"] == ["knob"] and count["doc"] == "Turns the knob a few times."
    assert [(p["name"], p["type"], p["default"], p["required"], p["doc"]) for p in count["params"]] == [
        ("times", "int", 3, False, "how often"), ("step_s", "float", 0.05, False, "pause between two turns"), ("label", "str", "steps", False, None)]
    assert "oops" in listed["procedures/broken.py"]["error"] or "SyntaxError" in listed["procedures/broken.py"]["error"]
    assert "_helper.py" not in str(list(listed))  # files that start with an underscore are not procedures


def test_a_run_reports_progress_and_result_keeps_its_log_and_stays_in_the_history(lab):
    started = lab.start_procedure("count_up", times=4, step_s=0.05)
    assert started["procedure"] == "count_up" and started["params"] == {"times": 4, "step_s": 0.05}
    run = lab.wait_for_run(started["id"], 60)
    assert run["status"] == "finished" and run["ended"] >= run["started"] and run["error"] is None
    assert run["result"] == {"value": 4.0} and run["message"] == "all done"
    assert run["progress"] == {"done": 4, "total": 4, "label": "steps"}
    assert lab.knob.state["value"] == 4.0  # its effect is in the state
    entries = lab.logs(f"run:{started['id']}")
    assert any("starting to count" in e["message"] for e in entries)
    assert started["id"] in [r["id"] for r in lab.list_runs()] and lab.get_run(started["id"])["status"] == "finished"
    assert len(run["source_hash"]) == 12


def test_wrong_parameters_end_the_run_at_once_and_say_which(lab):
    for params, message in [({"times": "many"}, "must be int"), ({"nope": 1}, "Unknown parameter"), ({"times": True}, "must be int")]:
        run = lab.wait_for_run(lab.start_procedure("count_up", **params)["id"], 60)
        assert run["status"] == "failed" and message in run["error"]["message"], run
    with pytest.raises(RemoteError, match="There is no procedure 'nothing'"):
        lab.start_procedure("nothing")


def test_a_failing_procedure_ends_failed_with_the_error_of_the_procedure(lab):
    run = lab.wait_for_run(lab.start_procedure("explode")["id"], 60)
    assert run["status"] == "failed"
    assert run["error"]["type"] == "ValueError" and run["error"]["message"] == "this went wrong" and "explode" in run["error"]["traceback"]
    assert lab.knob.state["value"] == 5.0


def test_an_abort_runs_the_finally_block_and_closes_the_recording_with_the_run_in_its_header(server, lab):
    run = lab.start_procedure("long_scan")
    wait_for(lambda: lab.get_recording()["active"] and lab.knob.state["value"] == 7.0, 60, "the scan to be recording")
    assert lab.get_run(run["id"])["status"] == "running"
    lab.abort_run(run["id"])
    done = lab.wait_for_run(run["id"], 30)
    assert done["status"] == "aborted" and done["reason"] == "aborted by the user"
    assert lab.knob.state["value"] == -1.0  # the finally block ran: the device is in a defined state
    assert lab.get_recording() == {"active": False}
    header = recording_header(server, "scan_a")
    assert header["end_time"] and header["tags"] == {"detuning": 3}
    assert header["run"]["procedure"] == "long_scan" and header["run"]["id"] == run["id"] and header["run"]["source_hash"] == done["source_hash"]
    assert header["started_by"] == f"run:{run['id']}"


def test_a_procedure_that_ignores_the_abort_is_killed_and_its_recording_is_still_closed(server, lab):
    run = lab.start_procedure("stubborn")
    wait_for(lambda: lab.get_recording()["active"], 60, "the recording")
    lab.abort_run(run["id"])
    done = lab.wait_for_run(run["id"], 30)  # the grace period of this server is 2 s
    assert done["status"] == "aborted" and "did not stop in time" in done["reason"]
    assert lab.get_recording() == {"active": False}
    assert recording_header(server, "scan_stubborn")["interrupted"] is True


def test_a_procedure_whose_process_dies_ends_crashed_and_leaves_no_recording_open(server, lab):
    run = lab.wait_for_run(lab.start_procedure("dies")["id"], 60)
    assert run["status"] == "crashed" and "exit code 3" in run["error"]["message"]
    assert lab.get_recording() == {"active": False}
    header = recording_header(server, "scan_dies")
    assert header["interrupted"] is True and "crashed" in header["end_reason"] and header["end_time"]


def test_a_device_is_reserved_for_the_procedure_that_declared_it_but_not_against_people(lab):
    first = lab.start_procedure("long_scan", name="scan_reserved")
    wait_for(lambda: lab.knob.state["value"] == 7.0, 60, "the scan to turn the knob")
    with pytest.raises(RemoteError, match="reserved by the run .* of 'long_scan'") as e:
        lab.start_procedure("count_up")
    assert e.value.type == "ReservationError"
    other = lab.wait_for_run(lab.start_procedure("on_the_other")["id"], 60)  # a device nobody holds
    assert other["status"] == "finished"
    lab.knob.set_value(3.0)  # manual input stays possible, from a script or the UI
    assert lab.knob.state["value"] == 3.0
    lab.abort_run(first["id"])
    lab.wait_for_run(first["id"], 30)
    assert lab.wait_for_run(lab.start_procedure("count_up", times=1)["id"], 60)["status"] == "finished"  # free again


def test_a_procedure_uses_only_the_devices_it_declared_checked_in_the_lab_object_and_by_the_server(lab):
    run = lab.wait_for_run(lab.start_procedure("undeclared")["id"], 60)
    assert run["status"] == "failed" and "did not declare the device 'knob'" in run["error"]["message"]
    run = lab.wait_for_run(lab.start_procedure("sneaky")["id"], 60)
    assert run["status"] == "failed" and run["error"]["type"] == "RemoteError" and "did not declare the device 'knob'" in run["error"]["message"]
    assert lab.knob.state["value"] != 9.0


def test_a_pause_stops_the_run_at_its_next_pause_point_and_a_resume_goes_on(lab):
    run = lab.start_procedure("pausing")
    wait_for(lambda: lab.get_run(run["id"])["status"] == "running" and (lab.get_run(run["id"])["progress"] or {}).get("done", 0) >= 1, 60, "the first piece")
    lab.pause_run(run["id"])
    paused = wait_for(lambda: lab.get_run(run["id"])["status"] == "paused" and lab.get_run(run["id"]), 10, "the pause")
    done_then = paused["progress"]["done"]
    time.sleep(1.0)  # longer than a piece takes
    assert lab.get_run(run["id"])["progress"]["done"] == done_then and lab.get_run(run["id"])["status"] == "paused"
    lab.resume_run(run["id"])
    finished = lab.wait_for_run(run["id"], 30)
    assert finished["status"] == "finished" and finished["progress"]["done"] == 6


def test_a_run_that_was_going_when_the_server_ended_is_marked_crashed(lab):
    leftover = lab.get_run("leftover0001")
    assert leftover["status"] == "crashed" and leftover["ended"] and "server ended" in leftover["reason"]


def test_events_start_procedures_after_the_files_are_closed_and_a_failing_one_does_not_touch_the_recording(server, lab):
    (server[1] / "procedures" / "triggers.py").write_text(TRIGGERS)  # only here: they react to every recording
    try:
        _events_test(server, lab)
    finally:
        (server[1] / "procedures" / "triggers.py").unlink()


def _events_test(server, lab):
    wait_for(lambda: any(p.get("name") == "after_recording" for p in lab.list_procedures()), 30)
    listed = {p["name"]: p for p in lab.list_procedures() if "name" in p}
    assert listed["after_recording"]["on"] == ["recording.finished"] and listed["after_snapshot"]["on"] == ["snapshot.saved", "recording.discarded"]
    lab.start_recording("trig_rec")
    result = lab.stop_recording()  # returns at once, the failing trigger cannot change that
    assert result["discarded"] is False
    wait_for(lambda: lab.knob.state["value"] == 8.0, 60)  # len("trig_rec"): it saw a finished header
    runs = {r["procedure"]: r for r in lab.list_runs() if r["procedure"] in ("after_recording", "always_fails")}
    assert runs["after_recording"]["caller"] == "event:recording.finished"
    wait_for(lambda: lab.get_run(runs["always_fails"]["id"])["status"] == "failed", 60)
    assert recording_header(server, "trig_rec").get("end_time") is not None
    lab.snapshot("snap_one")
    wait_for(lambda: lab.other.state["value"] == 8.0, 60)  # len("snap_one")
    lab.start_recording("dropped")
    lab.abort_recording(discard=True)
    wait_for(lambda: lab.other.state["value"] == 7.0, 60)  # len("dropped")
