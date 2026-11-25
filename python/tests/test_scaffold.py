"""'New device': a device file is made from a template, registered, and runs simulated at once."""

import json

import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

CALLS = {  # something to do with each template once it runs
    "blank": lambda d: d.set_value(2.5),
    "pressure_sensor": lambda d: None,
    "frequency_generator": lambda d: d.set_frequency(0, 2e6),
    "positioner": lambda d: d.set_position(0, 12.5),
}
CHECKS = {
    "blank": lambda s: s["value"] == 2.5,
    "pressure_sensor": lambda s: all(c["status"] == "ok" and c["pressure"] > 0 for c in s["channels"]),
    "frequency_generator": lambda s: s["channels"][0]["frequency"] == 2e6,
    "positioner": lambda s: s["channels"][0]["actual_position"] == 12.5,
}


@pytest.fixture()
def server(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            yield lab, workspace
    finally:
        stop_server(process, log, workspace, url)


def invoke(lab, method, *args):
    return lab._run(lab._async._hub.invoke(method, *args))


def test_every_template_makes_a_device_that_starts_simulated_and_fits_its_profile(server):
    lab, workspace = server
    templates = {t["id"]: t for t in invoke(lab, "list_templates")}
    assert set(templates) == set(CALLS) and templates["blank"]["source"] == "built-in"
    assert templates["pressure_sensor"]["profile"] == "pressure_sensor" and templates["blank"]["profile"] is None
    for template in templates:
        made = invoke(lab, "scaffold_device", template, f"my_{template}", "serial", None)
        assert made["file"] == f"devices/my_{template}.py"
        text = (workspace / made["file"]).read_text()
        assert "{{" not in text and "}}" not in text and f"class My{''.join(w.title() for w in template.split('_'))}(Device)" in text
        device = lab[f"my_{template}"]
        device.wait_ready(60)  # a state that does not fit the profile would refuse to start
        assert device.state["simulated"] is True
        assert {o["name"] for o in device.schema["config"]} >= {"port", "baudrate", "simulate"}  # the connection's options
        CALLS[template](device)
        wait_for(lambda: CHECKS[template](device.state), 10, f"the simulated {template}")
        assert [p["name"] for p in device.schema["profiles"]] == ([templates[template]["profile"]] if templates[template]["profile"] else [])
    entries = json.loads((workspace / "devices.json").read_text())["devices"]
    assert entries["my_blank"]["file"] == "devices/my_blank.py" and "simulated" in entries["my_blank"]["description"]


def test_the_connection_decides_the_options_and_none_gives_a_clean_file(server):
    lab, workspace = server
    expected = {"none": set(), "serial": {"port", "baudrate"}, "tcp": {"host", "tcp_port"}, "visa": {"resource"}}
    for connection, options in expected.items():
        invoke(lab, "scaffold_device", "blank", f"via_{connection}", connection, None)
        device = lab[f"via_{connection}"]
        device.wait_ready(60)
        names = {o["name"] for o in device.schema["config"]}
        assert options <= names and not ({"port", "baudrate", "host", "tcp_port", "resource"} - options) & names
    assert "\n\n\n    " not in (workspace / "devices" / "via_none.py").read_text()  # no gap inside the class where the options would be


def test_mistakes_are_explained_and_nothing_is_overwritten_or_left_behind(server):
    lab, workspace = server
    (workspace / "devices").mkdir()
    (workspace / "devices" / "taken.py").write_text("# mine\n")
    for args, message in [
        (("blank", "Not Snake", "none", None), "snake_case"),
        (("nothing", "fine", "none", None), "no template 'nothing'"),
        (("blank", "fine", "usb", None), "Unknown connection"),
        (("blank", "taken", "none", None), "never overwritten"),
    ]:
        with pytest.raises(RemoteError, match=message):
            invoke(lab, "scaffold_device", *args)
    assert (workspace / "devices" / "taken.py").read_text() == "# mine\n"
    assert not (workspace / "devices" / "fine.py").exists()
    invoke(lab, "scaffold_device", "blank", "twice", "none", None)
    with pytest.raises(RemoteError, match="already a device 'twice'"):
        invoke(lab, "scaffold_device", "blank", "twice", "none", None)


def test_templates_of_the_workspace_are_offered_and_win_over_built_in_ones(server):
    lab, workspace = server
    folder = workspace / "templates" / "device"
    folder.mkdir(parents=True)
    (folder / "blank.py.tmpl").write_text('# template {"title": "Our blank", "description": "With our header"}\n# lab standard header\n'
                                          'from laborchestra import Device\n\n\nclass {{class_name}}(Device):\n    state = {"x": 1}\n')
    (folder / "broken.py.tmpl").write_text("no header at all\n")
    templates = {t["id"]: t for t in invoke(lab, "list_templates")}
    assert templates["blank"]["title"] == "Our blank" and templates["blank"]["source"] == "workspace"
    assert templates["broken"]["title"] == "broken"  # works without a header, the id is the title
    invoke(lab, "scaffold_device", "blank", "ours", "none", None)
    lab.ours.wait_ready(60)
    assert "# lab standard header" in (workspace / "devices" / "ours.py").read_text()
