"""'Open in editor' / 'Show in folder': programs are started on the server's computer, only for files of the workspace."""

import json
import sys
import time

import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the editor is a shell script here")


def test_a_file_of_the_workspace_is_opened_with_the_configured_editor_and_nothing_else_is(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "devices").mkdir(parents=True)
    (workspace / "devices" / "mine.py").write_text("# mine\n")
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    (tmp_path / "secret.txt").write_text("outside")
    record = tmp_path / "opened.txt"
    editor = tmp_path / "editor"
    editor.write_text(f'#!/bin/sh\necho "$@" > "{record}"\n')
    editor.chmod(0o755)
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, env={"LABORCHESTRA_EDITOR": str(editor)})
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            def invoke(*args):
                return lab._run(lab._async._hub.invoke("open_file", *args))

            opened = invoke("devices/mine.py", "editor")
            assert opened == str(workspace / "devices" / "mine.py")
            wait_for(lambda: record.exists() and record.read_text().strip(), 10, "the editor to be started")
            assert record.read_text().strip() == str(workspace / "devices" / "mine.py")
            for path, how, message in [
                ("../secret.txt", "editor", "not a file in the workspace"),  # nothing outside the workspace
                ("devices/missing.py", "editor", "not a file in the workspace"),
                ("devices/mine.py", "emacs", "must be 'editor' or 'folder'"),
            ]:
                with pytest.raises(RemoteError, match=message):
                    invoke(path, how)
    finally:
        stop_server(process, log, workspace, url)
