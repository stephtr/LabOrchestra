# Development

Design and decisions: [CLAUDE.md](CLAUDE.md). Plan: [REWRITE.md](REWRITE.md). The old code is in `legacy/`.

## Layout

| Folder | |
|---|---|
| `server/LabOrchestra.Server` | .NET 11 host: hubs, device registry, token authentication, worker supervisor |
| `python/` | the `laborchestra` package: `Device`, `@action`, worker runner, `connect()` for scripts |
| `client/` | Vite + React + Tailwind 4 web client |
| `workspace/` | example workspace: `devices.json` and a simulated device |
| `spikes/` | throwaway experiments of phase 0 |

## Run it

You need .NET 11, Node with pnpm, Python 3.11 or newer, and [uv](https://docs.astral.sh/uv/) (`brew install uv` or `pip install uv`). uv gives every device its own Python environment with the dependencies named in the header of its file; the `laborchestra` package is installed into each of them from `python/`.

```bash
(cd client && pnpm install && pnpm build)
dotnet run --project server/LabOrchestra.Server
```

The server prints a login link with the access token and serves `client/dist`. Without settings it uses the example workspace `workspace/` of the checkout (in an installation: `Documents/LabOrchestra`); name another one with `--workspace <folder>`. The page tells you which workspace it uses when it shows no devices.

If `uv` is not on the PATH, give its location: `LABORCHESTRA_UV=/path/to/uv`. Without uv you can name an interpreter that has the package installed (`pip install -e python`): `LABORCHESTRA_PYTHON=/path/to/python`, used by all devices as it is. For client development run `pnpm dev` in `client/` (it proxies `/hub` to the server).

The **Devices** page (`/devices`) adds, changes, restarts and removes devices and manages secrets: choose a Python file of the workspace, and the form for its options is generated from the file itself (the server loads it in its environment without starting it). The server writes `devices.json` and applies the change at once; files edited by hand are picked up as well. The same operations are available from scripts: `lab.add_device("vacuum_pressure", "devices/pfeiffer.py", config={"port": "COM4"})`, `lab.describe_device_file(...)`, `lab.update_device(...)`, `lab.remove_device(...)`.

A device file may start with a header (PEP 723) that names what it needs; devices with the same needs share an environment:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyserial"]
# ///
```

Environments are made once, in the data directory, and never changed afterwards: other dependencies make another environment. A Python that is not installed is not downloaded unless `uv_python_downloads` is set to `automatic`.

From a script (same machine):

```python
import laborchestra
lab = laborchestra.connect(token="...")      # or LABORCHESTRA_URL / LABORCHESTRA_TOKEN
lab.pressure.state["channels"][0]
lab.pressure.set_pressure(0, 1e-3)
```

`devices.json` is watched: added devices start, removed ones stop, changed ones restart; a broken file is reported in the server log and changes nothing. An option can refer to a stored secret: `"api_key": {"secret": "openai"}` (set with `lab.set_secret("openai", "...")`; the value never appears in the workspace, the logs or the state).

## Writing a device

See `drivers/` for real ones and `workspace/devices/demo_pressure.py` for the smallest. What to rely on:

- Class attributes are options (annotated without default: required). `state` is a dict; every change, also nested, is published. `persist = ["key"]` saves state keys.
- `connect()` opens hardware (raise to say why not), `run()` is the long loop (`while self.running:` and `self.sleep(s)` instead of `time.sleep`), `close()` releases hardware.
- `@action` methods run in parallel threads: protect hardware access with `with self.lock:`. **When an action returns, its effects are already in the state** the caller sees.
- `self.lab["other"].state`, `self.lab["other"].some_action(...)` (blocks until done), `.wait_ready()`, `.wait_for(lambda state: ...)` talk to other devices; the same works in scripts.
- Offer `simulate = False` so that the device can run without its instrument; say so in the state (`simulated`).

## C# devices, streams and the oscilloscope

A device that cannot afford a process boundary is written in C# against `server/LabOrchestra.Sdk` (see `server/Plugins/Demo/DemoCounter.cs`): options and state are classes with public properties, actions are methods marked `[Action]`, and the class is marked `[Driver("name")]`. Build it into the `plugins/` folder (the two plugins of this repository are built there by the server build) and use it with `{"driver": "name", "config": {...}}` in `devices.json`, or on the Devices page's API (`lab.add_device("osc", driver="simulated_oscilloscope")`). `lab.list_drivers()` and `lab.describe_driver(name)` say what is installed.

Streams (traces, spectra) come over their own connection and are never faster than the receiver:

```python
with lab.stream("osc", "display", {"x_min": 90e3, "x_max": 110e3}) as frames:
    for frame in frames:
        frame.meta["channels"], frame.array       # float32, one row per channel
```

A client tells the server `received` when a frame arrives (this sizes how many frames may be on their way: a client far away keeps its frame rate) and `ack` when it is done with it (at most two frames wait at a busy client). `lab.stream` does both.

`simulated_oscilloscope` needs no hardware: channel n shows a tone at (n+1) x `test_signal_frequency`, in real time. Recording it (`with lab.recording(...)`) writes `osc_C1.npy`, ... into the recording.

## Recordings

```python
with lab.recording("scan 1", tags={"detuning": 1.5}):   # also: lab.start_recording / stop_recording
    lab.cavity_detuning.set_frequency(0, 1500)
lab.snapshot("before the scan")

rec = laborchestra.load_recording("<recordings folder>/scan 1")     # pip install laborchestra[analysis]
t, p = rec.series("pressure.channels.1.pressure")
rec.state_at(12.5)["pressure"]
list(rec.changes(by="script"))
```

Files: `name.yaml` (header with tags, the state of all devices at the start and the end), `name/events.json` (JSON array, one event per line: every change of any device with its time and its cause: `device`, `ui`, `script`, `device:<id>`, `supervisor`), data streams of devices as `.npy`. A recording that the server did not get to finish (crash, power loss) is repaired when the server starts again and marked `interrupted: true`. Where changes are caused by an action, the caller of the action is named; if an action and the device's own loop change something within 50 ms, both are named.

Server settings, as command-line options or `LABORCHESTRA_*` environment variables: `urls`, `workspace`, `python`, `uv`, `uv_python_downloads`, `laborchestra_package`, `passphrase`, `data_dir`, `recordings_dir` (default: `recordings` in the data directory), `allowed_origins`, `client_dir`.

## Tests

```bash
(cd python && python -m pytest)        # unit tests and integration tests (builds and starts the server)
(cd client && pnpm e2e)                # browser test; needs `pnpm build`, a server build and Chrome/Chromium
```

## Protocol

SignalR with MessagePack, snake_case names. Two hubs:

- `/hub/devices` (workers, role `device`, token per started process): worker -> server `register(schema, state)`, `patch_state(patch, by)`, `update_state(state)` (whole state, after a rejected patch), `save_settings(values)`, `log(records)`; server -> worker `call(action, args, caller)` (returns the result), `get_state()`.
- `/hub/control` (browsers, scripts, devices talking to devices): `get_devices()`, `get_device(id)`, `action(device, action, args)`, `get_logs(source, level, since, limit)`, `subscribe_logs(source)`, `unsubscribe_logs(source)`, `restart_device(id)`, `get_recording()`, `list_recordings(limit)`, `start_recording(name, tags)`, `stop_recording()`, `abort_recording(discard)`, `snapshot(name, tags)`, and for role `client` only `list_secrets()`, `set_secret(name, value)`, `delete_secret(name)`; server -> client `device(id, info)` (status, schema, state, revision), `device_patch(id, revision, patch)`, `device_removed(id)`, `log(entry)`, `recording(status)`. Clients say who they are with `?client=ui` / `?client=script` in the hub address.

State patches: `{"set": {"channels.1.pressure": 3e-7}, "del": ["name"]}`; paths are dot separated, numeric parts index lists, a list that changes length is replaced as a whole. Every change of a device's state increases its `revision`; a client that sees a gap fetches the device again with `get_device`.

Errors cross the wire as JSON text `{type, message, traceback}`. SignalR needs every answer to a server-initiated call to carry a result (null is fine); a void completion is rejected.
