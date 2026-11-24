"""Starting the real server for tests."""

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSPROJ = ROOT / "server" / "LabOrchestra.Server" / "LabOrchestra.Server.csproj"
DEMO = ROOT / "workspace" / "devices" / "demo_pressure.py"
DEVICES = Path(__file__).parent / "devices"
PASSPHRASE = "test-passphrase"
DOTNET = shutil.which("dotnet") or "dotnet"


def wait_for(condition, timeout=20, message="condition", interval=0.1):
    end = time.time() + timeout
    while time.time() < end:
        try:
            value = condition()
            if value:
                return value
        except Exception:
            pass
        time.sleep(interval)
    raise AssertionError(f"Timed out waiting for {message}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def build_server() -> None:
    build = subprocess.run([DOTNET, "build", str(CSPROJ), "-c", "Release", "-v", "q", "--nologo"], capture_output=True, text=True)
    assert build.returncode == 0, build.stdout + build.stderr


def launch(workspace: Path, data_dir: Path, url: str, python: str | None = sys.executable, env: dict | None = None):
    """Start the server (already built). ``python=None``: no interpreter is named, so environments are made with uv."""
    dll = CSPROJ.parent / "bin" / "Release" / "net11.0" / "LabOrchestra.Server.dll"
    settings = {
        **{k: v for k, v in os.environ.items() if k != "LABORCHESTRA_PYTHON"},
        "LABORCHESTRA_WORKSPACE": str(workspace),
        "LABORCHESTRA_PASSPHRASE": PASSPHRASE,
        "LABORCHESTRA_DATA_DIR": str(data_dir),
        **({"LABORCHESTRA_PYTHON": python} if python else {}),
        **(env or {}),
    }
    log = (workspace / f"server-{url.rsplit(':', 1)[1]}.log").open("w")
    process = subprocess.Popen(
        [DOTNET, str(dll), "--urls", url], env=settings, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL
    )
    port = int(url.rsplit(":", 1)[1])

    def up():
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True

    wait_for(up, 30, "server start")
    return process, log


def stop_server(process, log, workspace: Path, url: str) -> str:
    process.terminate()
    try:
        process.wait(15)
    except subprocess.TimeoutExpired:
        process.kill()
    log.close()
    return (workspace / f"server-{url.rsplit(':', 1)[1]}.log").read_text()
