import json

import pytest
import yaml

from laborchestra import load_recording

HEADER = {
    "format": 1,
    "kind": "recording",
    "name": "run 1.5",
    "start_time": "2026-11-24T12:00:00.000Z",
    "tags": {"detuning": 1.5},
    "devices": {
        "pressure": {"class": "Gauge", "status": "ready", "state": {"channels": [{"pressure": 1.0e-2}, {"pressure": 2.0e-8}]}},
        "name_tag": {"class": "Name", "status": "ready", "state": {"name": "Ada"}},
    },
}
EVENTS = [
    {"t": 1.0, "device": "pressure", "by": "device", "set": {"channels.1.pressure": 3.0e-8}},
    {"t": 2.0, "device": "pressure", "by": "script", "action": "set_pressure", "args": [0, 1]},
    {"t": 2.1, "device": "pressure", "by": "script", "set": {"channels.0.pressure": 1}},
    {"t": 3.0, "device": "pressure", "by": "supervisor", "status": "error", "error": "gone"},
    {"t": 4.0, "device": "pressure", "by": "device", "state": {"channels": [{"pressure": 5.0}]}},
    {"t": 5.0, "device": "name_tag", "by": "ui", "set": {"name": "Grace"}},
]


def write(tmp_path, events_text, header=HEADER, name="run 1.5"):
    (tmp_path / f"{name}.yaml").write_text(yaml.safe_dump(header))
    (tmp_path / name).mkdir()
    (tmp_path / name / "events.json").write_text(events_text)
    return tmp_path / name


def finished(events):
    return "[\n" + ",".join(json.dumps(e) + "\n" for e in events) + "]\n"


def test_reads_header_events_and_reconstructs_states(tmp_path):
    rec = load_recording(write(tmp_path, finished(EVENTS)))  # a name with a dot is not an extension
    assert rec.tags == {"detuning": 1.5} and rec.kind == "recording" and not rec.interrupted
    assert rec.start_time.year == 2026 and rec.start_time.tzinfo is not None and rec.end_time is None
    assert sorted(rec.devices) == ["name_tag", "pressure"] and rec.duration == 5.0

    assert rec.state_at(0)["pressure"]["channels"][1]["pressure"] == 2.0e-8
    assert rec.state_at(1.5)["pressure"]["channels"][1]["pressure"] == 3.0e-8
    assert rec.state_at(2.5)["pressure"]["channels"][0]["pressure"] == 1
    assert rec.state_at()["pressure"] == {"channels": [{"pressure": 5.0}]}  # replaced as a whole
    assert rec.state_at(4.5)["name_tag"]["name"] == "Ada" and rec.state_at()["name_tag"]["name"] == "Grace"


def test_series_has_the_start_value_and_every_change(tmp_path):
    rec = load_recording(write(tmp_path, finished(EVENTS)))
    t, v = rec.series("pressure.channels.1.pressure")
    assert list(t) == [0.0, 1.0, 4.0] and list(v) == [2.0e-8, 3.0e-8, None]  # gone after the replacement
    t, v = rec.series("name_tag.name")
    assert list(t) == [0.0, 5.0] and list(v) == ["Ada", "Grace"]
    with pytest.raises(KeyError, match="No device"):
        rec.series("nothing.x")


def test_changes_can_be_filtered_by_device_and_cause(tmp_path):
    rec = load_recording(write(tmp_path, finished(EVENTS)))
    assert [e["t"] for e in rec.changes(by="script")] == [2.0, 2.1]
    assert [e["t"] for e in rec.changes(device="name_tag")] == [5.0]
    assert [e["t"] for e in rec.changes(by="ui")] == [5.0]


def test_a_recording_that_was_cut_off_is_read_up_to_the_last_complete_event(tmp_path):
    cut = "[\n" + ",".join(json.dumps(e) + "\n" for e in EVENTS[:3]) + ',{"t": 2.5, "device": "pres'
    header = {**HEADER, "interrupted": True}
    rec = load_recording(write(tmp_path, cut, header))
    assert rec.interrupted and len(rec.events) == 3 and rec.duration == 2.1
    assert rec.state_at()["pressure"]["channels"][0]["pressure"] == 1


def test_snapshots_have_no_events(tmp_path):
    (tmp_path / "snap.yaml").write_text(yaml.safe_dump({**HEADER, "kind": "snapshot", "name": "snap", "time": "x"}))
    rec = load_recording(tmp_path / "snap")
    assert rec.kind == "snapshot" and rec.events == [] and rec.state_at()["name_tag"]["name"] == "Ada"
