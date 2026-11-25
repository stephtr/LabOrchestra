"""Views of the dashboard: one file per view in the workspace, stored by the server, shared by all clients."""

import json

import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError


def test_views_are_stored_in_files_shared_and_hot_reloaded(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "views").mkdir(parents=True)
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    (workspace / "views" / "old_one.json").write_text(json.dumps({"version": 1, "title": "Old", "root": None, "strip": []}))
    (workspace / "views" / "from_the_future.json").write_text(json.dumps({"version": 99}))  # refused, left alone
    (workspace / "views" / "Not Snake.json").write_text("{}")
    url = f"http://127.0.0.1:{free_port()}"
    server, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE, name="ui") as lab:
            def invoke(method, *args):
                return lab._run(lab._async._hub.invoke(method, *args))

            assert list(invoke("get_views")) == ["old_one"]

            invoke("save_view", "second", json.dumps({"version": 1, "title": "Second", "root": None, "strip": []}))
            stored = json.loads((workspace / "views" / "second.json").read_text())
            assert stored["title"] == "Second"
            assert sorted(invoke("get_views")) == ["old_one", "second"]

            for bad_id, text, message in [("Bad Id", "{}", "snake_case"), ("fine", json.dumps({"version": 99}), "version 99"), ("fine", "[1]", "JSON object")]:
                with pytest.raises(RemoteError, match=message):
                    invoke("save_view", bad_id, text)
            assert not (workspace / "views" / "fine.json").exists()

            # an edit in an editor (or a git pull) reaches the clients
            (workspace / "views" / "second.json").write_text(json.dumps({"version": 1, "title": "Edited by hand", "root": None, "strip": []}))
            wait_for(lambda: json.loads(invoke("get_views")["second"])["title"] == "Edited by hand", 10, "the edited view")

            invoke("delete_view", "second")
            assert not (workspace / "views" / "second.json").exists()
            with pytest.raises(RemoteError, match="no view"):
                invoke("delete_view", "second")
    finally:
        text = stop_server(server, log, workspace, url)
    assert "from_the_future.json was not loaded" in text and "format version 99" in text
