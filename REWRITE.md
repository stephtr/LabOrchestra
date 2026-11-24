# Rewrite plan

How and in which order to build what [CLAUDE.md](CLAUDE.md) describes. CLAUDE.md holds the design, this file the sequence. Each phase ends in something that runs; do not start the next one before its exit criteria hold.

## Strategy

- **Rebuild the framework, port the domain code.** New: device contract, transport, workers, auth, recording, client shell. Port: oscilloscope pipeline, Picoscope bindings, WebGL chart, device protocol code, UI components.
- **The old version keeps running the lab until phase 6.** It runs from a separate clone on the `legacy` branch, only fix bugs there. Build in this repo on a `next` branch, merge to `main` when it is usable. Cut over once; no hybrid.
- **Vertical slice first:** one demo device through every layer, before any layer gets broad.
- **Tests from the start** (there are none today). Simulated devices make everything except the real drivers testable without hardware.

## Target layout

```
server/LabOrchestra.Server      host, hubs, registry, recording, MCP
server/LabOrchestra.Sdk         public C# device API (plugins reference only this)
server/LabOrchestra.Picoscope   oscilloscope plugin
server/LabOrchestra.Tests
python/laborchestra             SDK, client, worker, CLI, profiles
drivers/                        single-file drivers of the lab (one package per driver once they are shared)
client/                         Vite app + widget SDK
templates/  docs/  examples/workspace/
```

## Phase 0: preparation and spikes

- [x] Push branch `legacy` and tag `legacy-v0`
- [ ] **Save the lab PC's local code first:** the running UI shows turbo pump widgets (COM7, COM8) and an "X" voltage control that are in no branch on GitHub. Commit and push them to `legacy`
- [ ] Then switch the lab PC's clone to `legacy` **before** the rewrite reaches `main`
- [ ] Replace `server/.env` by `.env.example`; full secret scan (e.g. gitleaks)
- [ ] License files, plugin exception, CLA text + bot, name policy (after ownership is settled)
- [ ] ffts redistribution check
- [x] .NET 11 with `global.json` (.NET 9 reached end of support in November 2026)
- [ ] Capture reference data from legacy: a recording, a snapshot, FFT output for a known input, a screenshot of each UI part
- [x] Author's Python `MessagePackHubProtocol` (`server/SignalRMessagePackHubProtocol.py`, reference for the own client)
- [x] CI on Windows, macOS and Linux (spikes; code in `spikes/`)

Spikes (throwaway code, 1-2 days each):

| Spike | Passes if | Otherwise |
|---|---|---|
| ✅ Python SignalR client (passed on Windows, Linux, macOS with own client) | server calls a Python method and gets result or error back (client results), binary stays `bin`, reconnect works | extend own client; correlation IDs over plain messages |
| ✅ Worker supervision (passed; macOS needs startup cleanup for GIL-holding orphans) | spawn via uv, stop cleanly, no orphan when the server is killed, on Windows too (Job Object) | heartbeat-based self-exit in the worker |
| ✅ Runtime widget (passed on all three) | esbuild-compiled `.tsx` loads through the import map, shares React and the SDK components with the host, styled by the server-compiled Tailwind CSS | compile CSS in the browser (313 KB compiler) |
| ✅ FFT library (pffft, see CLAUDE.md) | one cross-platform library, permissive license, at 200 MB/s (legacy uses ffts on Windows only, Accord elsewhere) | (rejected alternative: keep ffts on Windows, Accord elsewhere; speeds are similar) |

**Exit:** all four answered; results written into CLAUDE.md.

## Phase 1: walking skeleton

- [x] Device contract v0: state, `@action`, schema export from type hints, naming validation
- [x] `laborchestra` package: `Device`, worker, `connect()`
- [x] Server: registry, `ControlHub`, `DeviceHub`, worker token, passphrase login
- [x] Vite client: connection with resync, one auto-generated widget
- [x] End-to-end test: start server, demo pressure sensor, change state, read it from browser and script

**Exit:** killing the worker shows an error and recovers by itself; a script and the browser see the same state. *(Met locally on macOS, see `python/tests/test_integration.py` and `client/e2e/e2e.mjs`; CI on all three systems in `.github/workflows/ci.yml`.)*

Known gaps of the skeleton, all belonging to phase 2: whole-state updates instead of patches; `persist` is declared in the schema but not yet stored; worker logs go to the server console only (not to the UI or to scripts); no uv environments (a configured interpreter is used); no leftover-worker cleanup at start and no Job Object on Windows; no TLS; the first-start passphrase file is only created, not yet shown to scripts; the generic widget shows the state as a tree only.

## Phase 2: core

Done (CI green on all three systems; see `python/tests/test_integration.py`):

- [x] Workspace and `devices.json`, watched: devices are added, changed and removed at runtime without restarting the server; a broken file is reported and changes nothing
- [x] Secrets: `{"secret": "name"}` in a device's options, values in the data directory, never in the workspace, state or logs; setting a secret restarts the devices that use it
- [x] Restart a device on demand (`lab.pressure.restart()`)
- [x] Structured logging end to end: workers (also what they log before registering), server and supervisor, ring buffer per source plus daily files, live log view in the client, `lab.pressure.logs()` for scripts; action errors carry type, message and traceback
- [x] State patches (`{"set": {"channels.1.pressure": 3e-7}}`) with a revision per device; server, Python client and browser client apply them and resync on a gap (randomized test of 12 x 25 changes)
- [x] Persisted settings (`persist = [...]`): saved by the server, restored when a worker starts
- [x] Recording service: recordings and snapshots with tags, every change of every device as an event with time and cause (`device`, `ui`, `script`, `device:<id>`, `supervisor`), header with the states at start and end, crash-safe (a recording the server did not finish is repaired at the next start), `lab.recording(...)`, `load_recording` with `series`, `state_at`, `changes`
- [x] Authentication basics: no localhost bypass, token per started worker, `Origin` check (done in phase 1)

Open:

- [x] uv environments per device: dependencies from the PEP 723 header of the device file, `laborchestra` installed into each (from `python/` in a checkout; a bundled wheel in a release is still to do), shared by devices with the same needs, immutable, a failed build leaves nothing behind; an interpreter named with `python` is used as it is; without uv the error says what to do
- [ ] Environment clean-up (unused environments), rollback to the previous environment of a device, choosing the Python version in the UI
- [x] Lifecycle states: `reconnecting` (the worker process lives, its connection dropped), `degraded` (three actions in a row failed for a reason on the device's side, or a state update was rejected; the device stays usable, one success ends it; wrong arguments and a move stopped on purpose do not count)
- [x] Workers do not outlive the server: Job Object (Windows), `PR_SET_PDEATHSIG` from one long-lived spawning thread (Linux), and on every platform the next start kills leftovers by recorded PID + start time before devices open their hardware (`WorkerGuard`; tested with a worker stuck in a GIL-holding call)
- [x] Management UI: Devices page with add / change / restart / remove, the option form generated from the device file (`--describe`), secrets panel; the same operations for scripts (`lab.add_device`, ...); logo (light/dark) and favicon
- [ ] Management UI, still open: catalog of installable device packages, "New device" scaffolding, choosing the Python version from a list of interpreters, editing `views`, environment clean-up; watching the device source files (shows "changed" with a restart button)
- [ ] SQLite event log (persistent, outside recordings), history store of slow numeric values, stable IDs
- [ ] Authentication: tokens for MCP and for remote workers (created and revoked in the UI), TLS
- [x] C# SDK and plugin loading: `LabOrchestra.Sdk`, `[Driver]`/`[Action]`, in-process host with schema, patches, actions, logs, restart; plugins in `plugins/` loaded in their own context; management API (`list_drivers`, `describe_driver`, `add_device(driver=...)`)
- [ ] Protocol version negotiation, config migrations, immutable environments with rollback
- [ ] Data streams of devices into recordings (`.npy`, comes with the oscilloscope in phase 3); recording controls in the client (phase 4)
- [ ] Client errors reported to the server (React error boundary, `window.onerror`)

Lessons (kept so they are not learned twice): hosted services stop in reverse order and the web server stops first, so something that the web server waits for (workers connected over WebSockets) must be told to stop when the shutdown begins (`ApplicationStopping`), not in `StopAsync`; SignalR rejects a void completion for a call that expects a result; a worker must not send anything before its first registration (a patch that overtakes `register` is rejected), found only on a slow CI machine and reproduced locally with CPU load; tests that wait for "some" warning or "some" status change are racy, wait for the specific effect.

**Exit:** devices can be added, changed and removed at runtime; an interrupted recording (server killed) stays readable.

## Phase 3: devices and streaming (two independent tracks)

Track A, Python devices:
- [x] Elliptec, polarimeter and PolarizationLock ported to `drivers/` (simulated in CI, closed-loop test); the API changes they led to are in CLAUDE.md (flush before the result, `lock`, `wait_for`, `simulate`)
- [x] Smaract (SmarAct MCS2; `stop` interrupts a move, found and fixed the one-call-at-a-time SignalR default) and Pfeiffer (streaming device) ported (Smaract CTL calls untested on hardware); RS SMA100B ported and the contract declared v1 (`docs/device-contract.md`). The lab's own locks (polarization, Smaract z) are not part of the public drivers
- [x] Pfeiffer, RS SMA100B, Smaract
- [ ] Profiles extracted from at least two devices each where possible (real + simulator), conformance tests

Track B, oscilloscope:
- [x] `OscilloscopeWithStreaming` split: `OscilloscopeBase` (rings, FFT, averaging, display, recording) + a driver that only acquires; simulated oscilloscope; 8 tests (tones where they belong, zoom, decimation, time trace, controls, FFT against a DFT, stop/start, continuous `.npy` channels, crash repair)
- [x] NumSharp and Accord replaced (`NpyWriter`, `ManagedRealFft`); buffers configurable (`ring_samples`, `recording_ring_samples`)
- [x] pffft through P/Invoke behind `IRealFft` (built from `native/pffft`, managed fallback, windowing straight from the ring into the FFT input). Throughput at 200 MB/s still to be measured (the load test)
- [x] Picoscope 4000a/5000a plugins (`server/Plugins/Picoscope`, `AcquireAsync`; PicoSDK installed by the user, loaded at runtime). Compiles and reports a missing SDK in CI; **not yet tried on hardware** (needs a unit in the lab: open, ranges, streaming at the FFT frequency, restart after a channel change, 5000a test signal)
- [x] `StreamHub`: per-client subscriptions, newest frame at send time, `received` and `ack` as two signals, window that follows the round trip time (a client 300 ms away keeps 30 fps; tested with delayed confirmations); display rendering holds no lock of the FFT (only a short copy of the spectrum)
- [ ] FFT results match the legacy reference data (needs a recording and a snapshot from the lab PC)
- [ ] The oscilloscope widget in the client (spectrum and trace from the `display` stream)

**Exit:** real hardware works; 200 MB/s recording for 10 minutes without gaps while a throttled client is connected and memory stays flat.

## Phase 4: client

- [ ] Port widgets: oscilloscope, pressure, RF generator, stage, polarimeter, locks, recording controls
- [ ] Device management: list, catalog, schema forms, logs, restart
- [ ] Views: grid, edit mode, picker, several views, phone layout
- [ ] Runtime widgets, widget SDK, error boundary, reload on change

**Exit:** today's hard-coded dashboard is reproduced as a view without code changes.

## Phase 5: procedures

- [ ] `@procedure`, generated form, progress, logs, pause/abort, reservations
- [ ] Event bus, `@on("recording.finished")`
- [ ] Port the detuning scan, ParticleName, PressureUploader

**Exit:** aborting or killing a scan leaves the recording closed and devices in a defined state.

## Phase 6: lab cutover

- [ ] Parity checklist from the legacy UI, checked on the lab PC
- [ ] Convert settings; check existing analysis scripts against new recordings
- [ ] Run a week of real measurements; rollback = start legacy
- [ ] Remove pythonnet, SpaYarp, Next.js and legacy code

**Exit:** nobody needed legacy for a week.

## Phase 7: public 0.1

- [ ] MCP server, `.mcp.json`, feedback tools, audit log
- [ ] Scaffolding, templates, CLI, `check`, generated stubs
- [ ] Docs: quick start, device, procedure, widget, deployment; AI docs from the same source
- [ ] Packaging per platform, signing, PyPI release
- [ ] Update check, side-by-side install, preflight, rollback; test an upgrade from the previous build in CI
- [ ] Remove lab-specific values; example workspace with simulators only

**Exit:** someone outside the group installs it on a clean PC and writes a device using only the docs.

## Later

Innolas driver, lab notebook, sensor website, Claude Desktop bridge, more templates, catalog of community devices.

## Rules

- A contract change after the phase 3 freeze needs a version bump.
- No feature outside the current phase; put ideas under Later.
- When a decision changes, update CLAUDE.md in the same commit.

## Open decisions

| Decision | Needed by | Proposal |
|---|---|---|
| Ownership | phase 0, before publishing | clarify with the university (license, CLA, commercial use); then add license files |
| Grid library | phase 4 | react-grid-layout; check React 19 support |
