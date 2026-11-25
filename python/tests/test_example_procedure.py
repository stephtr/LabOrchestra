"""The example procedure of the example workspace, with the simulated RF generator: a port of the lab's detuning scan."""

import json
import shutil

import pytest

import laborchestra
from helpers import PASSPHRASE, ROOT, build_server, free_port, launch, stop_server, wait_for


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    build_server()
    root = tmp_path_factory.mktemp("scan")
    workspace, data = root / "workspace", root / "data"
    (workspace / "devices").mkdir(parents=True)
    (workspace / "procedures").mkdir()
    shutil.copy(ROOT / "drivers" / "rs_sma100b.py", workspace / "devices" / "rs_sma100b.py")
    shutil.copy(ROOT / "workspace" / "procedures" / "detuning_scan.py", workspace / "procedures" / "detuning_scan.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"rf": {"file": "devices/rs_sma100b.py", "config": {"simulate": True, "poll_s": 0.2}}}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, env={"LABORCHESTRA_ABORT_GRACE_S": "5"})
    try:
        yield url, data
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(server):
    with laborchestra.connect(server[0], PASSPHRASE) as lab:
        lab.rf.wait_ready(30)
        yield lab


def test_the_scan_records_every_offset_and_leaves_the_generator_where_it_was(server, lab):
    base = lab.rf.state["channels"][0]["frequency"]
    run = lab.wait_for_run(lab.start_procedure("detuning_scan", offsets_khz=[-200, 0, 300], duration_s=0.3, name="ok")["id"], 120)
    assert run["status"] == "finished" and run["result"]["recordings"] == 3, run
    names = sorted(r["name"] for r in lab.list_recordings() if r["name"].startswith("ok_"))
    assert names == ["ok_000", "ok_001", "ok_002"]
    assert lab.rf.state["channels"][0]["frequency"] == base
    import yaml

    header = yaml.safe_load((server[1] / "recordings" / "ok_000.yaml").read_text())
    assert header["tags"]["offset_khz"] == -200 and header["run"]["procedure"] == "detuning_scan" and header["run"]["params"]["offsets_khz"] == [-200, 0, 300]
    # the recording starts with the generator at the offset (its full initial state is in the header)
    assert header["devices"]["rf"]["state"]["channels"][0]["frequency"] == base - 200e3


def test_an_abort_in_the_middle_restores_the_frequency_and_closes_the_recording(server, lab):
    base = lab.rf.state["channels"][0]["frequency"]
    run = lab.start_procedure("detuning_scan", offsets_khz=[500, 600], duration_s=60, name="cut")
    wait_for(lambda: lab.get_recording().get("name") == "cut_000" and lab.rf.state["channels"][0]["frequency"] == base + 500e3, 60, "the first offset to be recorded")
    lab.abort_run(run["id"])
    done = lab.wait_for_run(run["id"], 30)
    assert done["status"] == "aborted"
    assert lab.rf.state["channels"][0]["frequency"] == base  # back where it was
    assert lab.get_recording() == {"active": False}
    import yaml

    assert yaml.safe_load((server[1] / "recordings" / "cut_000.yaml").read_text())["end_time"]


def test_offsets_beyond_the_limit_are_refused_before_anything_changes(server, lab):
    base = lab.rf.state["channels"][0]["frequency"]
    run = lab.wait_for_run(lab.start_procedure("detuning_scan", offsets_khz=[0, 20_000], duration_s=0.3)["id"], 60)
    assert run["status"] == "failed" and "beyond the limit" in run["error"]["message"]
    assert lab.rf.state["channels"][0]["frequency"] == base and not any(r["name"].startswith("scan_") for r in lab.list_recordings())
