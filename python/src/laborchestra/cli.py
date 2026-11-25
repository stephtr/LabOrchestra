"""The ``laborchestra`` command: connects AI clients to a LabOrchestra server over MCP.

    laborchestra mcp serve   --url https://lab-pc:5095            a local MCP server (stdio) that forwards to the server's /mcp
    laborchestra mcp install --url https://lab-pc:5095 --token .. sets up Claude Code / Claude Desktop / a project file on this computer

The token is made on the Devices page of LabOrchestra (AI access) and can be given as ``--token`` or in ``LABORCHESTRA_MCP_TOKEN``.
Everything the AI may do is decided by the server (its mode and the token's); this program only carries messages.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import ssl
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

NAME = "laborchestra"
TOKEN_ENV = "LABORCHESTRA_MCP_TOKEN"


def mcp_url(url: str) -> str:
    url = url.rstrip("/")
    return url if url.endswith("/mcp") else url + "/mcp"


# --- serve: stdio <-> HTTP ----------------------------------------------------------------------------------------------
def _error(message_id, code: int, text: str) -> dict:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": text}}


def forward(url: str, token: str, line: str, context: ssl.SSLContext | None = None, timeout: float = 180.0) -> list[str]:
    """Sends one message to the server and returns the messages to write back (none for a notification)."""
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        return [json.dumps(_error(None, -32700, "Parse error"))]
    message_id = message.get("id") if isinstance(message, dict) else None
    request = urllib.request.Request(
        mcp_url(url),
        data=line.encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            body = response.read().decode()
            kind = response.headers.get("Content-Type", "")
            if response.status == 202 or not body.strip():
                return []
            if "text/event-stream" in kind:
                return [chunk[5:].strip() for chunk in body.splitlines() if chunk.startswith("data:") and chunk[5:].strip()]
            return [json.dumps(json.loads(body))]
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except (json.JSONDecodeError, AttributeError):
            pass
        why = {401: "The token was not accepted: make a new one on the Devices page of LabOrchestra (AI access).", 403: str(detail)}.get(e.code, f"HTTP {e.code}: {detail}")
        return [json.dumps(_error(message_id, -32000, why))] if message_id is not None else []
    except (urllib.error.URLError, OSError) as e:
        text = f"Cannot reach LabOrchestra at {url}: {getattr(e, 'reason', e)}"
        return [json.dumps(_error(message_id, -32000, text))] if message_id is not None else []


def serve(url: str, token: str, ca_file: str | None = None, stdin=None, stdout=None) -> int:
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    context = ssl.create_default_context(cafile=ca_file or os.environ.get("LABORCHESTRA_CA_FILE")) if url.startswith("https") else None
    lock = threading.Lock()
    workers: list[threading.Thread] = []

    def handle(line: str) -> None:
        for out in forward(url, token, line, context):
            with lock:
                stdout.write(out + "\n")
                stdout.flush()

    for line in stdin:
        if line.strip():
            worker = threading.Thread(target=handle, args=(line,), daemon=True)  # a long wait_for must not hold up the next message
            worker.start()
            workers.append(worker)
    for worker in workers:
        worker.join()
    return 0


# --- install ------------------------------------------------------------------------------------------------------------
def desktop_config_path() -> Path:
    if os.environ.get("LABORCHESTRA_CLAUDE_DESKTOP_CONFIG"):  # for tests and unusual installations
        return Path(os.environ["LABORCHESTRA_CLAUDE_DESKTOP_CONFIG"])
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Claude/claude_desktop_config.json"
    return Path.home() / ".config/Claude/claude_desktop_config.json"


def bridge_command(url: str, bridge: str) -> tuple[str, list[str]]:
    """The command that Claude Desktop starts (it only knows local programs): our bridge, from this Python or through uvx."""
    if bridge == "uvx":
        return "uvx", ["--from", "laborchestra", "laborchestra", "mcp", "serve", "--url", url]
    return sys.executable, ["-m", "laborchestra.cli", "mcp", "serve", "--url", url]


def install_desktop(url: str, token: str, bridge: str, path: Path | None = None, name: str = NAME) -> Path:
    path = path or desktop_config_path()
    config = {}
    if path.exists():
        try:
            config = json.loads(path.read_text("utf-8") or "{}")
        except json.JSONDecodeError as e:
            raise SystemExit(f"{path} is not valid JSON ({e}): fix or remove it, nothing was changed")
    command, args = bridge_command(url, bridge)
    config.setdefault("mcpServers", {})[name] = {"command": command, "args": args, "env": {TOKEN_ENV: token}}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2) + "\n", "utf-8")
    temporary.replace(path)
    return path


def install_claude_code(url: str, token: str, claude: str | None = None, name: str = NAME) -> str:
    """Registers the server for the user in Claude Code (HTTP, the token as a header); returns what ran."""
    claude = claude or os.environ.get("LABORCHESTRA_CLAUDE") or shutil.which("claude")
    if not claude:
        raise FileNotFoundError("Claude Code (`claude`) was not found on this computer")
    subprocess.run([claude, "mcp", "remove", name, "--scope", "user"], capture_output=True, text=True)  # a former registration, if any
    add = [claude, "mcp", "add", "--transport", "http", "--scope", "user", name, mcp_url(url), "--header", f"Authorization: Bearer {token}"]
    done = subprocess.run(add, capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"`claude mcp add` failed ({done.returncode})")
    return "claude mcp add --transport http --scope user {} {} --header 'Authorization: Bearer ***'".format(name, mcp_url(url))


def install_project(url: str, directory: Path, name: str = NAME) -> Path:
    """A `.mcp.json` for a project folder (Claude Code): the token stays in an environment variable, so the file can be committed."""
    path = directory / ".mcp.json"
    config = json.loads(path.read_text("utf-8")) if path.exists() else {}
    config.setdefault("mcpServers", {})[name] = {"type": "http", "url": mcp_url(url), "headers": {"Authorization": f"Bearer ${{{TOKEN_ENV}}}"}}
    path.write_text(json.dumps(config, indent=2) + "\n", "utf-8")
    return path


def install(args) -> int:
    token = args.token or os.environ.get(TOKEN_ENV)
    if not token and args.client != "project":
        print(f"A token is needed: --token or {TOKEN_ENV} (make one on the Devices page of LabOrchestra, AI access).", file=sys.stderr)
        return 2
    clients = ["claude-code", "claude-desktop"] if args.client == "all" else [args.client]
    failed = 0
    for client in clients:
        try:
            if client == "claude-code":
                print("Claude Code:", install_claude_code(args.url, token, args.claude))
                print("  Start a new Claude Code session; /mcp shows the connection.")
            elif client == "claude-desktop":
                path = install_desktop(args.url, token, args.bridge, Path(args.desktop_config) if args.desktop_config else None)
                print(f"Claude Desktop: written to {path}\n  Quit and start Claude Desktop again.")
            else:
                path = install_project(args.url, Path(args.project or "."))
                print(f"Project file written: {path}\n  Set {TOKEN_ENV} in the environment that starts Claude Code.")
        except (FileNotFoundError, RuntimeError, OSError) as e:
            failed += 1
            print(f"{client}: {e}", file=sys.stderr)
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="laborchestra", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    top = parser.add_subparsers(dest="command", required=True)
    mcp = top.add_parser("mcp", help="connect an AI client to LabOrchestra").add_subparsers(dest="action", required=True)
    for action, help_text in (("serve", "a local MCP server (stdio) that forwards to LabOrchestra"), ("install", "set up an AI client on this computer")):
        sub = mcp.add_parser(action, help=help_text)
        sub.add_argument("--url", required=True, help="the LabOrchestra server, e.g. https://lab-pc:5095")
        sub.add_argument("--token", help=f"an MCP token (or {TOKEN_ENV})")
    serve_parser = mcp.choices["serve"]
    serve_parser.add_argument("--ca-file", help="certificate of the lab's own CA (or LABORCHESTRA_CA_FILE)")
    install_parser = mcp.choices["install"]
    install_parser.add_argument("--client", choices=["claude-code", "claude-desktop", "all", "project"], default="all")
    install_parser.add_argument("--bridge", choices=["python", "uvx"], default="python", help="how Claude Desktop starts the bridge: with this Python, or through uvx")
    install_parser.add_argument("--project", help="folder for --client project (default: here)")
    install_parser.add_argument("--claude", help="path of the claude program (default: found on the PATH)")
    install_parser.add_argument("--desktop-config", help="claude_desktop_config.json (default: where Claude Desktop keeps it)")
    args = parser.parse_args(argv)
    if args.action == "serve":
        token = args.token or os.environ.get(TOKEN_ENV)
        if not token:
            print(f"A token is needed: --token or {TOKEN_ENV}", file=sys.stderr)
            return 2
        return serve(args.url, token, args.ca_file)
    return install(args)


if __name__ == "__main__":
    sys.exit(main())
