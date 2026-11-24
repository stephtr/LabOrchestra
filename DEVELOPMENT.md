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

Server settings, as command-line options or `LABORCHESTRA_*` environment variables: `urls`, `workspace`, `python`, `passphrase`, `data_dir`, `allowed_origins`, `client_dir`.

## Tests

```bash
(cd python && python -m pytest)        # unit tests and integration tests (builds and starts the server)
(cd client && pnpm e2e)                # browser test; needs `pnpm build`, a server build and Chrome/Chromium
```

## Protocol

SignalR with MessagePack, snake_case names. Two hubs:

- `/hub/devices` (workers, role `device`, token per started process): worker -> server `register(schema, state)`, `patch_state(patch)`, `update_state(state)` (whole state, after a rejected patch), `save_settings(values)`, `log(records)`; server -> worker `call(action, args)` (returns the result), `get_state()`.
- `/hub/control` (browsers, scripts, devices talking to devices): `get_devices()`, `get_device(id)`, `action(device, action, args)`, `get_logs(source, level, since, limit)`, `subscribe_logs(source)`, `unsubscribe_logs(source)`, `restart_device(id)`, and for role `client` only `list_secrets()`, `set_secret(name, value)`, `delete_secret(name)`; server -> client `device(id, info)` (status, schema, state, revision), `device_patch(id, revision, patch)`, `device_removed(id)`, `log(entry)`.

State patches: `{"set": {"channels.1.pressure": 3e-7}, "del": ["name"]}`; paths are dot separated, numeric parts index lists, a list that changes length is replaced as a whole. Every change of a device's state increases its `revision`; a client that sees a gap fetches the device again with `get_device`.

Errors cross the wire as JSON text `{type, message, traceback}`. SignalR needs every answer to a server-initiated call to carry a result (null is fine); a void completion is rejected.
