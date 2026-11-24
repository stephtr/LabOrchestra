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

Server settings, as command-line options or `LABORCHESTRA_*` environment variables: `urls`, `workspace`, `python`, `passphrase`, `data_dir`, `allowed_origins`, `client_dir`.

## Tests

```bash
(cd python && python -m pytest)        # unit tests and integration tests (builds and starts the server)
(cd client && pnpm e2e)                # browser test; needs `pnpm build`, a server build and Chrome/Chromium
```

## Protocol v0

SignalR with MessagePack, snake_case names. Two hubs:

- `/hub/devices` (workers, role `device`, token per started process): worker -> server `register(schema, state)`, `update_state(state)`; server -> worker `call(action, args)` (returns the result), `get_state()`.
- `/hub/control` (browsers, scripts, devices talking to devices): `get_devices()`, `action(device, action, args)`; server -> client `device(id, info)` after every change, `device_removed(id)`.

Errors cross the wire as JSON text `{type, message, traceback}`. SignalR needs every answer to a server-initiated call to carry a result (null is fine); a void completion is rejected.
