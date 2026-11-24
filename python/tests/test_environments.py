"""Environments with uv: every device gets the dependencies of its own file. Needs uv (a dev dependency) and network access."""

import json
import shutil
import sys
from pathlib import Path

import pytest

import laborchestra
from helpers import DEMO, PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

TEMPLATE = '''# /// script
# requires-python = ">=3.11"
# dependencies = [{deps}]
# ///
import sys

from laborchestra import Device


class Probe(Device):
    state = {{"python": "", "six": ""}}

    def connect(self):
        import six  # only there in environments that ask for it

        self.state["python"] = sys.executable
        self.state["six"] = six.__version__
'''


def finished(data: Path) -> list[str]:
    """The environments that are complete (the failing device builds and removes one all the time)."""
    return sorted(p.parent.name for p in (data / "envs").glob("*/.ready"))


def uv_path() -> str:
    found = shutil.which("uv") or str(Path(sys.executable).parent / ("uv.exe" if sys.platform == "win32" else "uv"))
    if not Path(found).exists():
        pytest.fail("uv is needed for these tests (pip install uv)")
    return found


@pytest.fixture(scope="module")
def uv_server(tmp_path_factory):
    build_server()
    workspace, data = tmp_path_factory.mktemp("workspace"), tmp_path_factory.mktemp("data")
    (workspace / "devices").mkdir()
    shutil.copy(DEMO, workspace / "devices" / "plain.py")
    for name, deps in {"six_a": '"six"', "six_b": '"six"', "six_idna": '"six", "idna>=3"', "wrong": '"no-such-package-xyz-123"'}.items():
        (workspace / "devices" / f"{name}.py").write_text(TEMPLATE.format(deps=deps))
    # a header that names laborchestra itself must not make uv look for it on PyPI
    (workspace / "devices" / "names_itself.py").write_text(TEMPLATE.format(deps='"six", "laborchestra>=0"'))
    devices = {n: {"file": f"devices/{n}.py"} for n in ("plain", "six_a", "six_b", "six_idna", "wrong", "names_itself")}
    (workspace / "devices.json").write_text(json.dumps({"devices": devices}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, python=None, env={"LABORCHESTRA_UV": uv_path()})
    try:
        yield workspace, data, url
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(uv_server):
    with laborchestra.connect(uv_server[2], PASSPHRASE, timeout=30) as lab:
        yield lab


def test_each_device_gets_the_environment_its_file_asks_for(uv_server, lab):
    workspace, data, _ = uv_server
    for device in ("plain", "six_a", "six_b", "six_idna", "names_itself"):
        wait_for(lambda: lab[device].status == "ready", 180, f"{device} ready")
    python = {d: lab[d].state.get("python") for d in ("six_a", "six_b", "six_idna", "names_itself")}
    assert python["six_a"] == python["six_b"] == python["names_itself"]  # same needs: one environment
    assert python["six_idna"] != python["six_a"]  # other dependencies: another one
    assert lab.six_a.state["six"] and all(str(data / "envs") in p for p in python.values())

    assert len(finished(data)) == 3, finished(data)  # plain (nothing extra), six, six + idna

    prepared = [d for d in ("six_a", "six_b", "names_itself") if any("Preparing the Python environment" in e["message"] for e in lab[d].logs())]
    assert len(prepared) == 1  # the others found it ready or waited for it


def test_restart_reuses_the_environment(uv_server, lab):
    data = uv_server[1]
    wait_for(lambda: lab.six_a.status == "ready", 180, "six_a ready")
    before = finished(data)
    lab.six_a.restart()
    wait_for(lambda: lab.six_a.status == "ready", 20, "restart")
    assert finished(data) == before


def test_a_dependency_that_cannot_be_installed_is_reported_and_leaves_nothing_behind(uv_server, lab):
    workspace, data, _ = uv_server
    wait_for(lambda: lab.wrong.status == "error" and "no-such-package-xyz-123" in (lab.wrong.error or ""), 120, "install error")
    assert "Could not start the worker" in lab.wrong.error
    assert any(e["logger"] == "uv" and e["level"] == "ERROR" for e in lab.wrong.logs())
    # between two attempts nothing half-built is left in the folder
    wait_for(lambda: all((d / ".ready").exists() for d in (data / "envs").iterdir()), 40, "cleaned up", interval=0.02)

    (workspace / "devices" / "wrong.py").write_text(TEMPLATE.format(deps='"six"'))  # fixed: restarting picks it up
    lab.wrong.restart()
    wait_for(lambda: lab.wrong.status == "ready", 60, "ready after the fix")
    assert lab.wrong.state["python"] == lab.six_a.state["python"]


@pytest.mark.skipif(sys.platform == "win32", reason="relies on a PATH without any Python that has laborchestra")
def test_without_uv_and_without_the_package_the_error_says_what_to_do(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    shutil.copy(DEMO, workspace / "devices" / "plain.py")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"plain": {"file": "devices/plain.py"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, python=None, env={"LABORCHESTRA_UV": "/nonexistent/uv", "PATH": "/usr/bin:/bin"})
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            wait_for(lambda: lab.plain.status == "error" and "Install uv" in (lab.plain.error or ""), 30, "hint")
            assert "No module named" in lab.plain.error
    finally:
        stop_server(process, log, workspace, url)
