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
        else:
            assert len(node["sizes"]) == len(node["children"]) and abs(sum(node["sizes"]) - 100) < 1e-6
            for child in node["children"]:
                walk(child)

    walk(view["root"])
    widgets += view["strip"]
    assert len({w["id"] for w in widgets}) == len(widgets)
    for w in widgets:
        assert "device" not in w or w["device"] in devices, w
