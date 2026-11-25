"""The example workspace (workspace/) must stay consistent: its copies of the drivers, and its view."""

import json

from helpers import ROOT

WORKSPACE = ROOT / "workspace"


def test_the_drivers_in_the_example_workspace_are_the_ones_of_drivers():
    for copy in (WORKSPACE / "devices").glob("*.py"):
        original = ROOT / "drivers" / copy.name
        if original.exists():
            assert copy.read_text() == original.read_text(), f"{copy.name} differs from drivers/{copy.name}: copy it again"


def test_the_example_view_shows_devices_of_the_example_workspace_and_only_those():
    devices = json.loads((WORKSPACE / "devices.json").read_text())["devices"]
    for entry in devices.values():
        if "file" in entry:
            assert (WORKSPACE / entry["file"]).exists(), entry
    view = json.loads((WORKSPACE / "views" / "dashboard.json").read_text())
    widgets = []

    def walk(node):
        if node["kind"] == "main":
            widgets.append(node["widget"])
        elif node["kind"] == "area":
            widgets.extend(node["widgets"])
        else:
            assert len(node["sizes"]) == len(node["children"]) and abs(sum(node["sizes"]) - 100) < 1e-6
            for child in node["children"]:
                walk(child)

    walk(view["root"])
    widgets += view.get("strip", [])  # version 1 views have a strip; version 2 has areas in the tree
    assert len({w["id"] for w in widgets}) == len(widgets)
    for w in widgets:
        assert "device" not in w or w["device"] in devices, w


def test_the_example_procedure_is_valid_and_declares_only_devices_of_the_example_workspace():
    from laborchestra.procedures import describe, load

    found, _ = load(str(WORKSPACE / "procedures" / "detuning_scan.py"))
    procedure = describe(found[0])
    devices = json.loads((WORKSPACE / "devices.json").read_text())["devices"]
    assert set(procedure["devices"]) <= set(devices)
    assert [p["name"] for p in procedure["params"]][:2] == ["offsets_khz", "duration_s"] and procedure["params"][0]["items"] == "float"
