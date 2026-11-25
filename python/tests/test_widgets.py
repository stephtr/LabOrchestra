"""Runtime widgets: widgets/*.tsx of the workspace are built by the server (esbuild), served over the hub, and rebuilt when they change."""

import json
import shutil
import time

import pytest

import laborchestra
from helpers import PASSPHRASE, ROOT, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

ESBUILD = ROOT / "client" / "node_modules" / ".bin" / "esbuild"
pytestmark = pytest.mark.skipif(not ESBUILD.exists(), reason="esbuild is installed with the client (pnpm install in client/)")

WIDGET = """import { useDevice, Tile } from '@laborchestra/widget';
export const meta = { title: 'Mine', size: 'S' };
export default function Mine({ device }: { device: string }) {
  const d = useDevice(device);
  return <Tile label="mine" testId="mine"><span className="text-fuchsia-600 p-7">{String(d?.status)} VERSION</span></Tile>;
}
"""


@pytest.fixture()
def server(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "widgets").mkdir(parents=True)
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    client = tmp_path / "client"  # a built client: the page and the Tailwind compiler are all the server needs of it
    (client / "assets").mkdir(parents=True)
    (client / "_lo").mkdir()
    (client / "index.html").write_text("<div class='md:p-4 text-zinc-500'></div>")
    (client / "assets" / "app.js").write_text("const x = 'mt-9 flex'")
    compiler = ROOT / "client" / "dist" / "_lo" / "tailwind-compiler.js"
    if not compiler.exists():
        compiler = ROOT / "client" / "public" / "_lo" / "tailwind-compiler.js"
    shutil.copy(compiler, client / "_lo" / "tailwind-compiler.js")
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, env={"LABORCHESTRA_CLIENT_DIR": str(client)})
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            yield lab, workspace
    finally:
        stop_server(process, log, workspace, url)


def invoke(lab, method, *args):
    return lab._run(lab._async._hub.invoke(method, *args))


def widgets(lab):
    return {w["name"].removeprefix("ws:"): w for w in invoke(lab, "list_widgets")["widgets"] if w["name"].startswith("ws:")}


def test_a_widget_is_built_served_and_styled_and_a_changed_file_gives_a_new_version(server):
    lab, workspace = server
    (workspace / "widgets" / "mine.tsx").write_text(WIDGET.replace("VERSION", "one"))
    (workspace / "widgets" / "not_a_widget.txt").write_text("ignored")
    (workspace / "widgets" / "Bad Name.tsx").write_text("ignored")  # not a snake_case name
    wait_for(lambda: "mine" in widgets(lab), 30, "the widget to be built")
    assert set(widgets(lab)) == {"mine"} and widgets(lab)["mine"]["error"] is None
    served = invoke(lab, "get_widget", "ws:mine")
    code = served["code"]
    assert "one" in code and "import" in code
    assert "from \"react/jsx-runtime\"" in code and "from \"@laborchestra/widget\"" in code  # left for the host's import map
    assert "createElement" not in code and "useState" not in code and "ReactDOM" not in code  # React itself is not in the bundle
    css = invoke(lab, "get_widget_css")
    assert "text-fuchsia-600" in css.replace("\\", "") and "p-7" in css  # the widget's classes
    assert "mt-9" in css and "md:p-4" in css.replace("\\", "")  # and the host's, in the same sheet
    first_version = served["version"]

    (workspace / "widgets" / "mine.tsx").write_text(WIDGET.replace("VERSION", "two"))
    wait_for(lambda: widgets(lab)["mine"]["version"] != first_version, 30, "a new version")
    assert "two" in invoke(lab, "get_widget", "ws:mine")["code"]


def test_a_broken_widget_reports_the_error_and_the_others_still_work(server):
    lab, workspace = server
    (workspace / "widgets" / "good.tsx").write_text(WIDGET.replace("VERSION", "ok"))
    (workspace / "widgets" / "broken.tsx").write_text("export default function ( {")
    wait_for(lambda: {"good", "broken"} <= set(widgets(lab)), 30, "both widgets")
    assert widgets(lab)["good"]["error"] is None
    error = widgets(lab)["broken"]["error"]
    assert error and "broken.tsx" in error
    assert invoke(lab, "get_widget", "ws:broken")["code"] is None
    with pytest.raises(RemoteError, match="There is no widget 'ws:nothing'"):
        invoke(lab, "get_widget", "ws:nothing")
    (workspace / "widgets" / "broken.tsx").write_text(WIDGET.replace("VERSION", "fixed"))
    wait_for(lambda: widgets(lab)["broken"]["error"] is None, 30, "the fix")


def test_a_widget_can_be_a_folder_with_files_of_its_own(server):
    lab, workspace = server
    folder = workspace / "widgets" / "big_one"
    folder.mkdir()
    (folder / "index.tsx").write_text("import { label } from './label';\nexport default function W() { return <b>{label}</b>; }\n")
    (folder / "label.ts").write_text("export const label = 'from a second file';\n")
    wait_for(lambda: "big_one" in widgets(lab) and widgets(lab)["big_one"]["error"] is None, 30, "the folder widget")
    assert "from a second file" in invoke(lab, "get_widget", "ws:big_one")["code"]  # bundled together
    (folder / "label.ts").write_text("export const label = 'changed second file';\n")  # a change in any file rebuilds
    wait_for(lambda: "changed second file" in invoke(lab, "get_widget", "ws:big_one")["code"], 30, "the rebuild")


def test_without_esbuild_the_widgets_say_so_instead_of_failing_silently(tmp_path):
    build_server()
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    (workspace / "widgets").mkdir(parents=True)
    (workspace / "devices.json").write_text(json.dumps({"devices": {}}))
    (workspace / "widgets" / "mine.tsx").write_text(WIDGET)
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url, env={"LABORCHESTRA_ESBUILD": str(tmp_path / "no_such_esbuild")})
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            wait_for(lambda: invoke(lab, "list_widgets")["problem"], 30, "the problem")
            listing = invoke(lab, "list_widgets")
            assert "esbuild was not found" in listing["problem"]
            assert "esbuild was not found" in widgets(lab)["mine"]["error"]
    finally:
        stop_server(process, log, workspace, url)


def test_new_widget_from_every_template_builds_at_once_and_nothing_is_overwritten(server):
    lab, workspace = server
    templates = {t["id"]: t for t in invoke(lab, "list_widget_templates")}
    assert set(templates) == {"blank", "device_control"} and templates["blank"]["title"] == "Blank widget"
    for template in templates:
        made = invoke(lab, "scaffold_widget", template, f"my_{template}")
        assert made["widget"] == f"ws:my_{template}" and made["file"] == f"widgets/my_{template}.tsx"
        text = (workspace / made["file"]).read_text()
        assert "{{" not in text and f"export default function My{''.join(w.title() for w in template.split('_'))}(" in text
        wait_for(lambda: f"my_{template}" in widgets(lab), 30, "the new widget")
        assert widgets(lab)[f"my_{template}"]["error"] is None  # a template must build as it is
        assert "meta" in invoke(lab, "get_widget", f"ws:my_{template}")["code"]  # it exports what the picker needs
    assert (workspace / "widgets" / "laborchestra-widget.d.ts").read_text().startswith("// Types of the widget SDK")
    (workspace / "widgets" / "laborchestra-widget.d.ts").write_text("// my own\n")
    invoke(lab, "scaffold_widget", "blank", "another")
    assert (workspace / "widgets" / "laborchestra-widget.d.ts").read_text() == "// my own\n"  # not overwritten either
    for args, message in [(("blank", "Not Snake"), "snake_case"), (("nothing", "fine"), "no widget template"), (("blank", "my_blank"), "never overwritten")]:
        with pytest.raises(RemoteError, match=message):
            invoke(lab, "scaffold_widget", *args)
