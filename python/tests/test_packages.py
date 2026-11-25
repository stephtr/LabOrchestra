"""Devices and widgets that an installed Python package offers (entry points). Needs uv and network access, like the environment tests."""

import json
import shutil
from pathlib import Path

import pytest

import laborchestra
from helpers import PASSPHRASE, ROOT, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

PACKAGE = Path(__file__).parent / "packages" / "lab_test_pkg"

pytestmark = pytest.mark.skipif(shutil.which("uv") is None, reason="needs uv")


def invoke(lab, method, *args):
    return lab._run(lab._async._hub.invoke(method, *args))


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    build_server()
    root = tmp_path_factory.mktemp("package_test")
    workspace, data = root / "workspace", root / "data"
    workspace.mkdir()
    client = root / "client"  # a built client, as far as the stylesheet needs it
    (client / "_lo").mkdir(parents=True)
    (client / "index.html").write_text("<div></div>")
    compiler = ROOT / "client" / "dist" / "_lo" / "tailwind-compiler.js"
    if not compiler.exists():
        compiler = ROOT / "client" / "public" / "_lo" / "tailwind-compiler.js"
    if compiler.exists():
        shutil.copy(compiler, client / "_lo" / "tailwind-compiler.js")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"packaged": {"package": str(PACKAGE), "entry": "test_counter", "config": {"step": 5}}}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, python=None, env={"LABORCHESTRA_CLIENT_DIR": str(client)})
    try:
        yield url, workspace
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(server):
    with laborchestra.connect(server[0], PASSPHRASE) as lab:
        yield lab


def test_a_device_runs_from_its_package_with_its_options(lab):
    lab.packaged.wait_ready(300)  # the first time uv builds an environment with the package
    assert lab.packaged.schema["class"] == "TestCounter"
    assert [o["name"] for o in lab.packaged.schema["config"]] == ["step"]
    lab.packaged.increment()
    lab.packaged.increment()
    assert lab.packaged.state["count"] == 10  # step 5, from devices.json


def test_the_widgets_of_a_package_are_listed_served_and_styled(lab):
    def listed():
        return {w["name"]: w for w in invoke(lab, "list_widgets")["widgets"]}

    wait_for(lambda: "pkg:packaged_tile" in listed(), 120, "the widget of the package")
    assert listed()["pkg:packaged_tile"]["error"] is None
    code = invoke(lab, "get_widget", "pkg:packaged_tile")["code"]
    assert "Packaged tile" in code and "@laborchestra/widget" in code
    if "text-lime-600" not in invoke(lab, "get_widget_css"):  # the compiler is only there when the client was built
        pytest.skip("no Tailwind compiler (pnpm build in client/)")


def test_a_package_can_be_looked_at_before_it_is_added(lab):
    found = invoke(lab, "describe_package", str(PACKAGE), None, None)  # one device: chosen by itself
    assert [d["name"] for d in found["devices"]] == ["test_counter"] and found["devices"][0]["package"] == "lab-test-pkg"
    assert [w["name"] for w in found["widgets"]] == ["packaged_tile"] and found["widgets"][0]["error"] is None
    assert found["entry"] == "test_counter" and [o["name"] for o in found["schema"]["config"]] == ["step"]
    with pytest.raises(RemoteError, match="does not offer a device 'nothing'"):
        invoke(lab, "describe_package", str(PACKAGE), "nothing", None)
    with pytest.raises(RemoteError, match="Name a package"):
        invoke(lab, "describe_package", " ", None, None)


def test_a_package_device_is_added_and_changed_like_any_other_and_shown_in_the_entries(lab):
    invoke(lab, "add_device", "second_counter", {"package": str(PACKAGE), "entry": "test_counter", "config": {"step": 2}})
    lab.second_counter.wait_ready(120)
    lab.second_counter.increment()
    assert lab.second_counter.state["count"] == 2
    entries = invoke(lab, "list_device_entries")
    assert entries["second_counter"]["package"] == str(PACKAGE) and entries["second_counter"]["entry"] == "test_counter" and entries["second_counter"]["file"] is None
    with pytest.raises(RemoteError, match="exactly one of"):
        invoke(lab, "add_device", "both", {"package": str(PACKAGE), "file": "devices/x.py"})
    invoke(lab, "remove_device", "second_counter")
