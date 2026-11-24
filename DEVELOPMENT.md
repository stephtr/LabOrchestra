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

```bash
python -m venv python/.venv && python/.venv/bin/pip install -e "python[dev]"
(cd client && pnpm install && pnpm build)
LABORCHESTRA_PYTHON=$PWD/python/.venv/bin/python LABORCHESTRA_WORKSPACE=$PWD/workspace \
  dotnet run --project server/LabOrchestra.Server
```

The server prints a login link with the access token and serves `client/dist`. For client development run `pnpm dev` in `client/` (it proxies `/hub` to the server).

From a script (same machine):

```python
import laborchestra
lab = laborchestra.connect(token="...")      # or LABORCHESTRA_URL / LABORCHESTRA_TOKEN
lab.pressure.state["channels"][0]
lab.pressure.set_pressure(0, 1e-3)
```

`devices.json` is watched: added devices start, removed ones stop, changed ones restart; a broken file is reported in the server log and changes nothing. An option can refer to a stored secret: `"api_key": {"secret": "openai"}` (set with `lab.set_secret("openai", "...")`; the value never appears in the workspace, the logs or the state).

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

Server settings, as command-line options or `LABORCHESTRA_*` environment variables: `urls`, `workspace`, `python`, `passphrase`, `data_dir`, `recordings_dir` (default: `recordings` in the data directory), `allowed_origins`, `client_dir`.

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
