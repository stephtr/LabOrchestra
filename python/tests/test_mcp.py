"""AI access: the /mcp endpoint (tokens, modes, tools), the stdio bridge, and the installers."""

import json
import os
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request

import pytest

import laborchestra
from helpers import DEVICES, PASSPHRASE, build_server, free_port, launch, stop_server, wait_for


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    build_server()
    root = tmp_path_factory.mktemp("mcp")
    workspace, data = root / "workspace", root / "data"
    (workspace / "devices").mkdir(parents=True)
    (workspace / "procedures").mkdir()
    shutil.copy(DEVICES / "knob.py", workspace / "devices" / "knob.py")
    (workspace / "procedures" / "tiny.py").write_text('from laborchestra import procedure\n\n\n@procedure(devices=["knob"])\nasync def turn(lab, value: float = 3.0):\n    await lab.knob.set_value(value)\n    return {"value": value}\n')
    (workspace / "devices.json").write_text(json.dumps({"devices": {"knob": {"file": "devices/knob.py"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    desktop = root / "claude_desktop_config.json"
    claude = root / ("claude.cmd" if os.name == "nt" else "claude")  # a stand-in for Claude Code that writes down what it was asked
    record = root / "claude.log"
    claude.write_text(f'@echo %* >> "{record}"\r\n' if os.name == "nt" else f'#!/bin/sh\necho "$@" >> "{record}"\n')
    claude.chmod(claude.stat().st_mode | stat.S_IEXEC)
    process, log = launch(workspace, data, url, env={"LABORCHESTRA_CLAUDE_DESKTOP_CONFIG": str(desktop), "LABORCHESTRA_CLAUDE": str(claude)})
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            lab.knob.wait_ready(60)
            yield url, lab, desktop, record
    finally:
        stop_server(process, log, workspace, url)


def invoke(lab, method, *args):
    return lab._run(lab._async._hub.invoke(method, *args))


def rpc(url, token, method, params=None, *, id=1, headers=None):
    request = urllib.request.Request(url + "/mcp", data=json.dumps({"jsonrpc": "2.0", "id": id, "method": method, **({"params": params} if params is not None else {})}).encode(),
                                     headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **({"Authorization": f"Bearer {token}"} if token else {}), **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def call(url, token, tool, **arguments):
    result = rpc(url, token, "tools/call", {"name": tool, "arguments": arguments})["result"]
    return result, result["content"][0]["text"]


def status_of(url, token, method="tools/list"):
    try:
        rpc(url, token, method)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    return 200, ""


def test_the_endpoint_wants_a_token_made_for_it_and_follows_the_mode(server):
    url, lab, _, _ = server
    invoke(lab, "set_mcp_mode", "off")
    token = invoke(lab, "create_mcp_token", "tester", "control")["token"]
    assert status_of(url, None)[0] == 401  # no token, also from this computer
    assert status_of(url, PASSPHRASE)[0] == 403  # the passphrase is not an MCP token
    code, body = status_of(url, token)
    assert code == 403 and "switched off" in body
    invoke(lab, "set_mcp_mode", "read_only")
    assert status_of(url, token)[0] == 200
    with pytest.raises(urllib.error.HTTPError) as e:  # a page of another origin cannot use it, whatever it has
        rpc(url, token, "tools/list", headers={"Origin": "https://evil.example"})
    assert e.value.code == 403
    info = invoke(lab, "get_mcp")
    assert info["mode"] == "read_only" and [t["label"] for t in info["tokens"]] == ["tester"] and "token" not in info["tokens"][0]
    invoke(lab, "revoke_token", info["tokens"][0]["id"])
    assert status_of(url, token)[0] == 401


def test_read_only_shows_and_allows_the_looking_tools_only(server):
    url, lab, _, _ = server
    invoke(lab, "set_mcp_mode", "control")
    token = invoke(lab, "create_mcp_token", "reader", "read_only")["token"]  # the token's mode is lower than the global one
    init = rpc(url, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})["result"]
    assert init["protocolVersion"] == "2025-06-18" and "tools" in init["capabilities"] and "read_only" in init["instructions"]
    names = {t["name"] for t in rpc(url, token, "tools/list")["result"]["tools"]}
    assert {"list_devices", "describe_device", "get_state", "wait_for", "get_problems", "get_logs"} <= names
    assert not names & {"call_action", "run_procedure", "start_recording", "abort_run"}
    result, text = call(url, token, "call_action", device="knob", action="set_value", args=[5])
    assert result["isError"] and "read-only" in text
    result, text = call(url, token, "get_state", device="knob", path="value")
    assert not result["isError"] and json.loads(text)["value"] == lab.knob.state["value"]
    assert rpc(url, token, "tools/call", {"name": "nonsense", "arguments": {}})["error"]["code"] == -32602
    assert rpc(url, token, "ping")["result"] == {}
    request = urllib.request.Request(url + "/mcp", data=b'{"jsonrpc":"2.0","method":"notifications/initialized"}', headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request) as response:
        assert response.status == 202  # a notification gets no answer


def test_control_acts_and_the_event_log_says_who(server):
    url, lab, _, _ = server
    invoke(lab, "set_mcp_mode", "control")
    token = invoke(lab, "create_mcp_token", "operator", "control")["token"]
    names = {t["name"] for t in rpc(url, token, "tools/list")["result"]["tools"]}
    assert {"call_action", "run_procedure", "start_recording", "take_snapshot", "add_note"} <= names
    result, text = call(url, token, "call_action", device="knob", action="set_value", args=[7.5])
    assert not result["isError"], text
    assert lab.knob.state["value"] == 7.5  # its effect is in the state when the call returns
    _, text = call(url, token, "describe_device", device="knob")
    assert "set_value" in text
    events = [e for e in lab.events(device="knob") if e["kind"] == "action"]
    assert events[-1]["by"] == "mcp:operator"
    result, text = call(url, token, "call_action", device="knob", action="no_such_action", args=[])
    assert result["isError"] and text  # the device's own error reaches the model as text
    result, text = call(url, token, "call_action", device="nobody", action="x")
    assert result["isError"] and "does not exist" in text
    _, text = call(url, token, "list_devices")
    assert [d["id"] for d in json.loads(text)["devices"]] == ["knob"]
    _, text = call(url, token, "get_problems")
    assert json.loads(text)["ok"] is True


def test_wait_for_and_a_procedure_run(server):
    url, lab, _, _ = server
    invoke(lab, "set_mcp_mode", "control")
    token = invoke(lab, "create_mcp_token", "waiter", "control")["token"]
    call(url, token, "call_action", device="knob", action="set_value", args=[1])
    _, text = call(url, token, "wait_for", device="knob", path="value", condition="equals", value=1)
    assert json.loads(text) == {"met": True, "value": 1}
    _, text = call(url, token, "wait_for", device="knob", path="value", condition="above", value=100, timeout_s=0.5)
    assert json.loads(text)["met"] is False
    result, text = call(url, token, "wait_for", device="knob", path="nothing.here", condition="not_null")
    assert result["isError"] and "nothing.here" in text  # a wrong path is an error at once, not a timeout
    _, text = call(url, token, "run_procedure", name="turn", params={"value": 9})
    run = json.loads(text)["run"]
    _, text = call(url, token, "wait_for_run", id=run["id"], timeout_s=60)
    done = json.loads(text)
    assert done["status"] == "finished" and done["result"] == {"value": 9} and done["caller"] == "mcp:waiter"
    assert lab.knob.state["value"] == 9
    result, text = call(url, token, "start_recording", name="from_mcp", tags={"who": "claude"})
    assert not result["isError"], text
    result, text = call(url, token, "stop_recording")
    assert json.loads(text)["name"] == "from_mcp"
    _, text = call(url, token, "get_logs", level="INFO", limit=5)
    assert json.loads(text)["cursor"] > 0


def run_bridge(url, token, messages, env=None):
    process = subprocess.run([sys.executable, "-m", "laborchestra.cli", "mcp", "serve", "--url", url, *(["--token", token] if token else [])],
                             input="".join(json.dumps(m) + "\n" for m in messages), capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})
    return process, [json.loads(line) for line in process.stdout.splitlines() if line.strip()]


def test_the_stdio_bridge_forwards_messages_and_explains_a_refusal(server):
    url, lab, _, _ = server
    invoke(lab, "set_mcp_mode", "control")
    token = invoke(lab, "create_mcp_token", "bridge", "control")["token"]
    process, out = run_bridge(url, token, [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_state", "arguments": {"device": "knob"}}},
    ])
    assert process.returncode == 0, process.stderr
    by_id = {m["id"]: m for m in out}
    assert set(by_id) == {1, 2, 3}  # the notification has no answer
    assert by_id[1]["result"]["serverInfo"]["name"] == "laborchestra" and len(by_id[2]["result"]["tools"]) > 10
    assert not by_id[3]["result"]["isError"]
    _, out = run_bridge(url, "lo_wrong", [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
    assert "token was not accepted" in out[0]["error"]["message"]
    invoke(lab, "set_mcp_mode", "off")
    _, out = run_bridge(url, token, [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
    assert "switched off" in out[0]["error"]["message"]
    _, out = run_bridge("http://127.0.0.1:1", token, [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
    assert "Cannot reach LabOrchestra" in out[0]["error"]["message"]
    process, _ = run_bridge(url, None, [], env={"LABORCHESTRA_MCP_TOKEN": ""})
    assert process.returncode == 2 and "token is needed" in process.stderr
    invoke(lab, "set_mcp_mode", "control")


def test_the_installers_write_what_the_clients_read(server, tmp_path):
    url, _, _, _ = server
    config = tmp_path / "claude_desktop_config.json"
    config.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}, "theme": "dark"}))
    cli = [sys.executable, "-m", "laborchestra.cli", "mcp", "install", "--url", url, "--token", "lo_secret"]
    done = subprocess.run([*cli, "--client", "claude-desktop", "--desktop-config", str(config)], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    written = json.loads(config.read_text())
    assert written["theme"] == "dark" and "other" in written["mcpServers"]  # what was there stays
    entry = written["mcpServers"]["laborchestra"]
    assert entry["command"] == sys.executable and entry["args"][-2:] == ["--url", url] and entry["env"] == {"LABORCHESTRA_MCP_TOKEN": "lo_secret"}
    done = subprocess.run([*cli, "--client", "claude-desktop", "--bridge", "uvx", "--desktop-config", str(config)], capture_output=True, text=True)
    assert json.loads(config.read_text())["mcpServers"]["laborchestra"]["command"] == "uvx"
    config.write_text("{not json")
    done = subprocess.run([*cli, "--client", "claude-desktop", "--desktop-config", str(config)], capture_output=True, text=True)
    assert done.returncode != 0 and "not valid JSON" in done.stderr and config.read_text() == "{not json"  # a broken file is left alone
    project = tmp_path / "project"
    project.mkdir()
    done = subprocess.run([sys.executable, "-m", "laborchestra.cli", "mcp", "install", "--url", url, "--client", "project", "--project", str(project)], capture_output=True, text=True)
    mcp_json = json.loads((project / ".mcp.json").read_text())["mcpServers"]["laborchestra"]
    assert done.returncode == 0 and mcp_json == {"type": "http", "url": url + "/mcp", "headers": {"Authorization": "Bearer ${LABORCHESTRA_MCP_TOKEN}"}}  # no token in the file
    record = tmp_path / "claude.log"
    claude = tmp_path / ("claude.cmd" if os.name == "nt" else "claude")
    claude.write_text(f'@echo %* >> "{record}"\r\n' if os.name == "nt" else f'#!/bin/sh\necho "$@" >> "{record}"\n')
    claude.chmod(claude.stat().st_mode | stat.S_IEXEC)
    done = subprocess.run([*cli, "--client", "claude-code", "--claude", str(claude)], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    lines = record.read_text().splitlines()
    assert lines[0].startswith("mcp remove laborchestra") and f"mcp add --transport http --scope user laborchestra {url}/mcp --header Authorization: Bearer lo_secret" in lines[1]
    assert "lo_secret" not in done.stdout  # the token is not printed
    done = subprocess.run([*cli, "--client", "claude-code", "--claude", str(tmp_path / "missing")], capture_output=True, text=True)
    assert done.returncode == 1 and "claude" in done.stderr.lower()


def test_the_server_sets_up_an_ai_client_on_its_own_computer(server):
    url, lab, desktop, record = server
    invoke(lab, "set_mcp_mode", "off")
    done = invoke(lab, "install_mcp", "claude-desktop", "read_only")
    assert done["mode"] == "read_only"  # off becomes the mode that was asked for
    entry = json.loads(desktop.read_text())["mcpServers"]["laborchestra"]
    token = entry["env"]["LABORCHESTRA_MCP_TOKEN"]
    assert status_of(url, token)[0] == 200  # the token that was written works
    labels = [t["label"] for t in invoke(lab, "get_mcp")["tokens"]]
    invoke(lab, "install_mcp", "claude-desktop", "read_only")
    assert [t["label"] for t in invoke(lab, "get_mcp")["tokens"]].count("Claude Desktop on the server computer") == 1  # again: the old token is replaced
    assert status_of(url, token)[0] == 401
    invoke(lab, "install_mcp", "claude-code", "control")
    assert "mcp add --transport http --scope user laborchestra" in record.read_text()
    with pytest.raises(laborchestra.RemoteError, match="claude-code or claude-desktop"):
        invoke(lab, "install_mcp", "nonsense", "read_only")
    invoke(lab, "set_mcp_mode", "control")
