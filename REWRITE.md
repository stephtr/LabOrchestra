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
python/devices/                 one package per ported driver
client/                         Vite app + widget SDK
templates/  docs/  examples/workspace/
```

## Phase 0: preparation and spikes

- [x] Push branch `legacy` and tag `legacy-v0`
- [ ] Switch the lab PC's clone to `legacy` **before** the rewrite reaches `main`
- [ ] Replace `server/.env` by `.env.example`; full secret scan (e.g. gitleaks)
- [ ] License files, plugin exception, CLA text + bot, name policy (after ownership is settled)
- [ ] ffts redistribution check
- [ ] Move to .NET 10 LTS (.NET 9 reached end of support in November 2026)
- [ ] Capture reference data from legacy: a recording, a snapshot, FFT output for a known input, a screenshot of each UI part
- [x] Author's Python `MessagePackHubProtocol` (`server/SignalRMessagePackHubProtocol.py`, reference for the own client)
- [x] CI on Windows, macOS and Linux (spikes; code in `spikes/`)

Spikes (throwaway code, 1-2 days each):

| Spike | Passes if | Otherwise |
|---|---|---|
| ✅ Python SignalR client (passed on Windows, Linux, macOS with own client) | server calls a Python method and gets result or error back (client results), binary stays `bin`, reconnect works | extend own client; correlation IDs over plain messages |
| ✅ Worker supervision (passed; macOS needs startup cleanup for GIL-holding orphans) | spawn via uv, stop cleanly, no orphan when the server is killed, on Windows too (Job Object) | heartbeat-based self-exit in the worker |
| ✅ Runtime widget (passed on all three) | esbuild-compiled `.tsx` loads through the import map, shares React and the SDK components with the host, styled by the server-compiled Tailwind CSS | compile CSS in the browser (313 KB compiler) |
| FFT library | one cross-platform library, permissive license, at 200 MB/s (legacy uses ffts on Windows only, Accord elsewhere) | keep ffts on Windows |

**Exit:** all four answered; results written into CLAUDE.md.

## Phase 1: walking skeleton

- [ ] Device contract v0: state, `@action`, schema export from type hints, naming validation
- [ ] `laborchestra` package: `Device`, worker, `connect()`
- [ ] Server: registry, `ControlHub`, `DeviceHub`, worker token, passphrase login
- [ ] Vite client: connection with resync, one auto-generated widget
- [ ] End-to-end test: start server, demo pressure sensor, change state, read it from browser and script

**Exit:** killing the worker shows an error and recovers by itself; a script and the browser see the same state.

## Phase 2: core

- [ ] Workspace, `devices.json`, secrets, file watching
- [ ] Lifecycle (connecting/ready/degraded/error/reconnecting), supervisor, uv environments
- [ ] Structured errors and logging, end to end
- [ ] State updates as patches (no whole `channels` arrays); state change events with caller
- [ ] SQLite event log, history store, stable IDs
- [ ] Full authentication (roles, no localhost bypass, `Origin`)
- [ ] C# SDK and plugin loading
- [ ] Protocol version negotiation, config migrations, immutable environments with rollback
- [ ] Recording service (format in CLAUDE.md) and `load_recording`: snapshots, recordings, tags, change events, crash-safe

**Exit:** devices can be added, changed and removed at runtime; an interrupted recording (server killed) stays readable.

## Phase 3: devices and streaming (two independent tracks)

Track A, Python devices:
- [ ] Elliptec, then PolarizationLock (proof of the API); revise the contract, **then freeze it as v1**
- [ ] Pfeiffer, RS SMA100B, Smaract, SmaractLock, polarimeter
- [ ] Profiles extracted from at least two devices each where possible (real + simulator), conformance tests

Track B, oscilloscope:
- [ ] Split `OscilloscopeWithStreaming` (605 lines) into acquisition, FFT, recording writer, display reduction
- [ ] Port Picoscope plugins; replace NumSharp and Accord; configurable buffers (today 600 M floats, about 2.4 GB, per oscilloscope)
- [ ] `StreamingHub`: subscriptions, latest-frame slot, acks; display work must not hold the FFT lock
- [ ] FFT results match the legacy reference data

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
