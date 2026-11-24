# LabOrchestra

Lab-instrument control framework: a .NET server hosts devices (C# and Python), a Next.js web client shows them. Goal: one orchestration layer with a shared UI **and** Python scripting access.

The project is being **rewritten and open-sourced**. This file records the current architecture and the planned changes agreed so far. Items under "Planned" are not yet implemented; those marked *(proposed)* are not yet confirmed by the author. Re-verify against the code before relying on either section.

## Current architecture

The old code is in `legacy/` (paths below such as `server/...` and `client/...` refer to `legacy/server/...` and `legacy/client/...`). It also lives on the `legacy` branch, and is deleted from `next` at the cutover.

- `server/` – ASP.NET Core (.NET 9), SignalR (JSON + MessagePack), pythonnet.
  - `Program.cs` – initializes embedded Python (hard-coded `python313` paths), maps hubs `/hub/control`, `/hub/streaming`, `/api/ping`, proxies the client via SpaYarp.
  - `DeviceManager.cs` – registers all devices in its constructor (hard-coded IDs, ports, IPs; hardware devices fall back to `Demo*` in a try/catch). Handles `Action` (fire-and-forget, state pushed in batches of <= 50 ms), `Request`, snapshots, recording, `settings.json`.
  - `Devices/PythonDevice.cs` – runs a `.py` file in a pythonnet scope. Module-level `state` dict; every top-level function is an action (matched case-insensitively); optional `main`, `get_settings`, `load_settings`, `on_save_snapshot`. Injected globals: `send_status_update`, `action`, `request`, `get_device_state`, `print`, `is_running`, `argv`.
  - `Devices/*.cs` – C# devices (Picoscope 4000a/5000a, oscilloscope with streaming, Innolas, MainDevice, constants). `Devices/*.py` – Python devices; most hardware drivers have a `Demo*` counterpart.
  - `Hubs/` – `ControlHub` (`Action`, `Request`, `GetFullState`), `StreamingHub`, both behind `ProtectedHub` / `AccessControlService` (local connections bypass auth).
- `client/` – Next.js, React, Tailwind. `lib/controlHub.tsx` merges `PartialStateUpdate` per device; `useControl(deviceId)` exposes actions. One component per device in `components/`, custom split layout (`components/gridview/gridStack.tsx`, not the gridstack library), WebGL oscilloscope chart.
- Data flow: UI -> `action`/`request` (SignalR) -> `DeviceManager` -> device -> batched `PartialStateUpdate` back; high-rate data over the streaming hub.

## Goals of the rewrite

1. Proper device management (add/remove at runtime, lifecycle, config-driven).
2. Widget drag and drop (saved dashboard layouts).
3. Extensibility / plugin system:
   - add devices written in **Python**,
   - control LabOrchestra from **Python scripts**,
   - control it from Claude via **MCP**.
4. Performance: oscilloscopes can produce ~200 MB/s; live FFT must work.

## Planned decisions

### Language and transport
- **Web frontend stays.** Server stays **C#** on **.NET 11** (same end of support as 10 LTS) (vendor SDKs such as Picoscope are easy to call, `AssemblyLoadContext` allows loading device plugins, more lab contributors know it). Rust was considered and rejected: no stable ABI for plugins, no hard real-time need.
- **Keep SignalR with MessagePack.** The author has their own Python `MessagePackHubProtocol` that works, which removes the main objection to SignalR. Keep separate hubs/connections for control (low rate) and streaming, so large frames never delay control messages.
- **Python: own asyncio SignalR client** in the `laborchestra` package (`websockets` + `msgpack`), not `signalrcore`: 1.1.0 ignores handler return values, so the server cannot get results from workers, and it runs handlers in the receive loop.
- Spike 1 (macOS, Python 3.15, .NET 9, localhost, idle machine, 5000 calls each): a ~50-line prototype handles results, errors, unknown methods, 1 MB `bin` both ways, concurrent calls and reconnect after a server abort. Latency server->Python->server p50 0.10 / p99 0.14 / max 1.5 ms; Python->server->Python p50 0.10 / p99 0.13 ms. Untyped MessagePack results arrive as the smallest integer type (`42` -> `Byte`), so the server must convert using the schema. CI runners: Linux p50 0.19 / p99 0.26 ms, Windows 0.40 / 0.51 ms, macOS 0.20 / 3.6 ms. Not yet tested: TLS, auth, server restart, load.
- Browser: `bin` arrives as `Uint8Array` (spike 3), but **not 4-byte aligned** in general, so a `Float32Array` view needs a copy or padding (legacy uses a padding field). Prefer copying over relying on message layout.

### Streaming pipeline (200 MB/s)
- Raw data never goes to the browser or to scripts. Only **decimated data** is sent (min/max envelopes, averaged FFT spectra, ~30-60 fps, a few hundred KB/s per view). Python scripts also only need decimated data, FFTs and recordings on disk, so no raw-data side channel.
- Hot path stays inside the server: acquire -> write raw stream to disk -> FFT (FFTW/MKL via P/Invoke, or the existing ffts library) -> reduce for display. Use pooled buffers, `Span`, SIMD, native memory; avoid allocations in the loop.
- **FFT library: pffft**, called directly through P/Invoke, behind a small interface. Spike 4 (float, real, one thread, 8192 points): pffft / ffts fork (linkotec) / legacy ffts: Windows 1198 / 1159 / 1135 MS/s, Linux 789 / 662 / -; Mac (M-series) pffft 1443, ffts 1168 (NEON intrinsics, unofficial build flags) or 331 (plain C). All have ~1.6e-7 relative error. Accord is 15-20x slower. **The ranking depends on the CPU:** on a second Windows CI machine the ffts fork was slightly ahead of pffft (669 vs 641 MS/s at 8192), and RustFFT (AVX) was ahead including windowing (746 vs 626 MS/s); on Linux and macOS pffft beat RustFFT (1552 vs 1338, 829 vs 529). All are fast enough; decide again with numbers from the lab PC if it ever matters. Windowing stays in C# (`TensorPrimitives`, ~8% of the FFT time). Build without `-ffast-math` (no speed difference measured on ARM64, NaN-safe).
- **No extra copies:** ring buffers and FFT buffers in native memory (`NativeMemory.AlignedAlloc`, pffft needs SIMD alignment; pass pointers). Windowing writes from the ring buffer directly into the FFT input (`TensorPrimitives.Multiply`), replacing the copy (handle the wrap-around as two segments). Measured at 8192 (ARM64): 6.3 us vs. 7.2 us with separate copies.
- Clients subscribe per stream with their own parameters (decimation, FFT size, averaging); keep and extend `StreamingContexts`.
- **Backpressure fix.** Today `DeviceManager.SendStreamData` calls `SendAsync` without awaiting, so a slow client causes unbounded queuing. Replace with:
  - one **latest-frame-wins slot per client and stream** (e.g. `Channel<T>` with capacity 1 and `BoundedChannelFullMode.DropOldest`) and a per-client sender loop that **awaits** `SendAsync`; never use `Clients.All` for streams;
  - **ack-based credit window** (1-2 frames in flight, client acks after rendering), because send completion only reflects the TCP buffer, not browser rendering speed;
  - count dropped frames and measure RTT per client for a status display.

### Python devices: out-of-process, no pythonnet
- **Remove pythonnet.** Reasons: single shared interpreter/`sys.path`/GIL, no real per-device venvs, a crash in a driver kills the server, no clean reload, fragile `libpython` path discovery.
- Each Python device runs as a **separate worker process** using an installed interpreter (user can choose the version or path), connects to the server over the same protocol as scripts, registers its device and schema, answers actions and pushes state. The server supervises it (heartbeat, restart with backoff, stdout/stderr forwarded to logs/UI). Workers may also run on another machine.
- **Per-device venvs, managed with `uv`** (bundle the binary or download on first run). Default: one venv per device package; simple devices may opt into a shared one.
- **Stopping workers:** the server holds each worker's stdin open; a watcher thread in the worker treats EOF as "stop" (or server gone), allows a grace period for cleanup, then exits. The server kills the process after a timeout. Spike 2 (macOS): clean stop ~50 ms; a blocking driver is ended after the grace period; crashes are detected; after `kill -9` of the server, all workers exit by themselves **except one holding the GIL**. For that case: Job Object (Windows), `PR_SET_PDEATHSIG` (Linux), and on every platform the next server start kills leftover workers by recorded PID + start time before reopening hardware. CI (Windows, Linux): Job Object and `PR_SET_PDEATHSIG` both leave no worker behind; on macOS only the startup cleanup helps. `PDEATHSIG` fires when the spawning *thread* ends, so spawn from a thread that lives as long as the server.
- A device is a **Python package** with an entry point:
  ```toml
  [project.entry-points."laborchestra.devices"]
  elliptec = "laborchestra_elliptec:Elliptec"
  ```
  Config example (`devices.json`): `package`, `python` (version or interpreter path), `args`.
- Cost accepted: ~0.1 ms per server<->worker call (measured in spike 1, idle localhost); a device-to-device call is two of these, so ~0.2 ms. Mitigate by subscribing to other devices' state (local cache, reads need no round trip), putting tight loops into one device, and using C# plugins for anything needing sub-ms latency.
- **No benchmark needed for streaming:** the author already runs oscilloscopes streaming FFTs to browser clients over the current SignalR setup, and it works well. Still verify the slow-client case (memory flat, skip counter) when implementing the latest-frame slots.

### One Python package: `laborchestra`
Replaces everything `PythonDevice` injects today. Three roles in one package:
- `laborchestra.Device` + `@action` for device authors (SDK),
- `laborchestra.connect(url)` for control scripts (async API with a sync wrapper),
- `python -m laborchestra.worker <device>` runner (lifecycle, logging, reconnect).

Mapping of today's injected names:

| Today | Planned |
|---|---|
| module-level `state` dict | `state` dict on the class, with change tracking (assignments, also nested, publish updates); a typed state class (dataclass/pydantic) is optional |
| `send_status_update(partial)` | automatic on change, or `self.update(partial)` |
| `action` / `request` / `get_device_state` | `lab.device("x").action(...)`, `await ...request(...)`, `.state` (locally cached, pushed) |
| `print` | standard `logging`, forwarded by the worker |
| `is_running` | stop event / async cancellation |
| `argv` | class attributes: annotated without default = required, with default = option; typing optional, checked and used for forms/pickers when present; secrets resolved by the framework before the device sees them |
| every top-level function is an action (case-insensitive) | explicit `@action` with type hints -> real schema; names follow the naming rule (see Conventions) |
| `main()` | `run(self)`, plain (runs in its own thread, `while self.running`) or `async` (cancelled on stop) |
| `get_settings` / `load_settings` / `on_save_snapshot` | `persist = ["key", ...]` for saved state keys; hooks only for special cases; `on_save_snapshot` optional |

- Exceptions must reach callers as structured errors (a script sees a real Python exception with the device's message), instead of today's wrapped `InvalidOperationException`.
- **Simple devices stay simple.** Ordinary Python must be enough: no required imports of config, secret, reference or profile types, no mandatory typing, no `try/except` for survival (an error in `run` is logged, shown, and the device restarts with backoff). Types, profiles and checks are optional upgrades that need no rewrite. Test case: `ParticleName.py` in about 45 lines.
- Port a couple of devices as API proof before fixing the design: Elliptec, and `PolarizationLock` (exercises cross-device calls).

### Device management and config
- Replace the `DeviceManager` constructor with a **declarative config** (`devices.json`): driver, args, optional demo fallback. The same registry enables runtime add/remove.
- Device **lifecycle states**: connecting, ready, error, reconnecting.
- Typed **schema for state, actions and parameters** (Python `typing.Annotated`, C# attributes) as the single source for auto-generated UI, validation, docs and record/replay.
- Fix unsynchronized access to `UpdateQueue` / `UpdateTimer` in `DeviceManager` (concurrent hub calls).

### Device widgets (client)
Layered, so a Python-only device author gets a UI without touching JavaScript:
1. **Auto-generated default widget** from the device's typed schema (state fields, actions, parameters -> inputs, sliders, buttons, readouts). Covers most simple devices. Also the path for the roadmap item "create basic UI controls from within Python devices".
2. **Optional custom widget shipped by the device package**: a prebuilt ES module (`widget.js`) inside the Python wheel / C# plugin. The server serves it (e.g. `/plugins/<package>/widget.js`); the client loads it at runtime with dynamic `import()` (Vite: `/* @vite-ignore */`). The host provides `react`, `react-dom` and the LabOrchestra widget SDK via an **import map**, so there is a single React instance and widget bundles stay small. Module Federation was considered; import maps are simpler.
3. **Built-in widgets** for core devices stay bundled with the client.
- Widget SDK for authors: `useDevice(id)` (state + actions), `useStream(...)`, `useSettings(...)`, theme tokens. Provide a template (Vite library build with `react`/SDK as externals); hot reload by pointing the plugin at its dev server.
- A package declares its widgets in its manifest/entry points: widget id, device profile (or device class) it binds to, default and min size, and a JSON schema for per-instance props.
- **Trust model:** a runtime-loaded widget runs with full page privileges (including the access token). That equals the trust already given by installing the device package (its Python code runs on the server), so no sandbox by default. An iframe + `postMessage` sandbox is the fallback if untrusted widgets ever matter; it costs styling, theming and WebGL integration.
- **Client build: switch from Next.js to a static Vite build** served by the C# server (static files + SPA fallback; no Node at runtime). **Verified: no SSR dependence** (only Next-specific usage: `next/font/google` Inter + `metadata` in `app/layout.tsx`, `next dev --turbo`; `app/page.tsx` is `'use client'`; `app/devices/page.tsx` is an empty stub; `localStorage` only in effects/handlers; the one render-time `window` access, in `gridStack.tsx`, is guarded). Migration: replace font (e.g. `@fontsource/inter`) and title in `index.html`; add a router for the 2 routes; keep the `@/` alias; move to Tailwind 4 and replace HeroUI; drop `eslint-config-next`; replace SpaYarp (`AddSpaYarp`/`UseSpaYarp` in `Program.cs`) with a Vite dev proxy for `/hub` and `/api` plus `UseStaticFiles` + SPA fallback in production. Check `lib/connection.ts` for URL assumptions (not reviewed). Plugins are separate ES modules loaded at runtime, so the static host build does not limit extensibility. The server exposes a plugin-discovery endpoint (installed manifests) and serves plugin files.
- **No dev/production distinction for plugins:** same loading path and validation everywhere. Any plugin can point its widget at a bundle or a dev server on a running server.
- **Plugin HMR:** a plugin entry can set `widgetDevUrl` (the plugin's own Vite dev server, CORS enabled). Step 1: host listens for the Vite update event, re-imports with a cache-buster and remounts the widget (cheap, little lost since state lives on the server). Step 2: real React Fast Refresh, which needs the Fast Refresh runtime loaded by the plugin dev server and a single shared React: the host serves shim modules (e.g. `/_lo/react.js` re-exporting the host's React and the SDK), the import map points to the same URLs, and the plugin template's Vite preset aliases `react`/SDK to them when served from the dev server. Authors get this via a shared Vite config preset.
- **Styling of runtime widgets: Tailwind 4, compiled on the server.** The host's build cannot know widget classes. The server collects candidate words from each compiled widget (dynamic names like `bg-${c}-500` are not found, standard Tailwind rule) and runs the Tailwind compiler (plain JS, `compile().build()`) in **Jint** (embedded .NET JS engine). One shared, cached stylesheet for all widgets with the host theme; the browser loads no compiler. Host classes are scanned too and everything is one stylesheet: with separate sheets a widget's `p-2` could override the host's `md:p-4`. Tested (spike 3, all platforms): output identical to Node for sample classes; first build 1-2 s, then 13-55 ms; save to visible 120-200 ms; ~3 MB of DLLs. Not a documented use of the API: pin the version and test. No Tailwind plugins per widget; widgets may ship own CSS.
- **UI library: drop HeroUI, use own components (shadcn/ui style: headless primitives + Tailwind, source in this repo)**. The SDK exports a small set (`Button`, `NumberInput`, `Slider`, ...); widgets use only those, never the underlying library.
- C# device plugins loaded via `AssemblyLoadContext`.

### Device management UI (client)
- Device list with lifecycle status (connecting/ready/error/reconnecting), logs from the worker, restart, remove.
- Add device from a **catalog** of installed packages (entry points) and installable ones; the config form is generated from the device's **config JSON schema** (e.g. pydantic -> JSON schema for Python, attributes for C#).
- Keep three things separate: **config** (connection args such as port/IP; edited in the management UI, changes restart the device), **settings** (runtime values persisted via `get_settings`/`load_settings`, edited in the device's widget or a settings panel), **state** (live values, never persisted as config).
- All of it persists **server-side** (`devices.json` + settings), not in browser storage, so every client sees the same devices.

### Layouts: drag and drop and multiple views (client)
- Multiple named **views**; each view is a grid of **widget instances**: `{ id, type, device, position: {x, y, w, h}, props }`. Props validated against the widget's props schema. Several instances per device are allowed.
- Stored **server-side** as versioned JSON (shared across clients and phones); browser storage only for per-client convenience like the last-selected view. **Views are global; there is no user concept** (access control stays a passphrase).
- Edit mode toggle: drag, resize, add from a widget picker (grouped by device), remove. The existing `GridStack` is only a custom resizable split, so a grid library (gridstack.js or react-grid-layout) has to be chosen. Handle a missing device gracefully (placeholder widget, not a crash). Consider separate layouts per breakpoint for phone use.

### Device conventions: profiles *(proposed)*
- A **profile** (`PressureSensor`, `FrequencyGenerator`, `RotationStage`, `LinearStage`, `Polarimeter`, `Oscilloscope`) is a versioned contract: typed state, required actions, optional capabilities (the UI hides what a driver lacks). Drivers may add extra fields and actions. Consumers and widgets bind to profiles, not drivers.
- Multi-channel devices need per-channel profiles: an Elliptec bus mixes rotation, linear and slider channels.
- **Every API is written once, in code; JSON Schema is never hand-written.** The worker exports it from type hints at registration, for UI, MCP and validation. One-off devices need no profile: the class is the definition.
- Profiles are written once too, as Python classes (or C# interfaces where the implementation is C#-only). Other languages get generated bindings only when needed.
- Validation is always on: invalid arguments -> error to the caller; invalid state update -> rejected, logged, device marked degraded. Streams are not validated per frame.
- Ship a conformance test and a simulator per profile.

### Units
- **Fixed unit per profile field** (pressure: mbar), stored as metadata: `Annotated[float, Unit("mbar")]`. Wire and recordings always use it; drivers convert on input.
- Conversion is display-only (UI preference) plus an optional Python helper, so it can be added later.
- Invalid reading = `None` plus a status enum, never `0`.

### Naming
- **snake_case on the wire and in Python, recordings, MCP and TypeScript device state.** One name everywhere, no conversion in Python or JS. C# members stay PascalCase (language convention, analyzers) and are converted automatically in one place, when the device schema is built: `JsonNamingPolicy.SnakeCaseLower` (`GetFFT` -> `get_fft`). JSON can use the policy directly; SignalR MessagePack needs a custom resolver/formatter. Every name on the wire is validated as snake_case at registration, for all languages; violations and collisions are rejected.
- Device IDs: snake_case, valid Python identifiers (`tweezer_polarization`). Acronyms are words: `dop`, `get_fft`.
- Actions verb first (`set_`, `start_`, `stop_`); booleans `is_`/`has_`; `target_x`/`actual_x`; no units in names. Matching is exact.

### Errors and logging
- Structured logging throughout (C# `Microsoft.Extensions.Logging`, Python `logging`), tagged with device/procedure, forwarded to the server, rotating files, live log view with filters in the UI.
- Action errors return type, message, traceback, device and action to the caller. Today `DeviceManager.Action` discards the result of `HandleActionAsync`, so async failures go unnoticed.
- Background-loop errors set device health (degraded/error), are logged and shown in the UI. Worker crash -> logged, restarted with backoff. No bare `except: pass` / empty `catch`.
- Communication errors trigger reconnect. Errors during a recording are written to its metadata. A failure in a recording must never lose already written data.
- Demo fallback must be explicit, never silent: today any constructor exception switches to fake data.

### Procedures (measurement orchestration)
- Replace hard-coded `DetuningScanControl.py` and the detuning-scan UI with **procedures**: Python functions with typed parameters, run in a worker, same `laborchestra` API as scripts. *(API proposed)*
  ```python
  @procedure
  async def detuning_scan(lab, detunings: list[float], duration_s: float = 60):
      for detuning in lab.progress(detunings):
          await lab.cavity_detuning.set_frequency(0, detuning)
          async with lab.recording(tags={"detuning": detuning}):
              await lab.sleep(duration_s)
  ```
- UI from the type hints: parameter form, progress, logs, pause, abort. Abort runs `finally`/context managers, so devices return to a safe state; the server stops an orphaned recording if the worker dies.
- Recording is a core service with context-manager semantics and structured tags, replacing filename suffixes (`SCAN_{i}_pre`) and polling of `main`.
- Procedures declare the devices they use and reserve them against other procedures. Manual UI input stays allowed at all times.
- **Record every state change as a timestamped event** (including the caller: UI, procedure, MCP), plus a full state at start and end. Today `Record` samples states every 500 ms through `on_save_snapshot`, so short changes are missed, and devices returning `None` or a subset (e.g. `PolarizationLock`) are not fully recorded.
- Store procedure name, source hash, parameters and device configs in the recording metadata.
- **Triggers:** an event bus (`recording.finished`, `recording.discarded`, `snapshot.saved`, `device.error`, ...) starts procedures. Post-recording scripts use `@on("recording.finished")`, get paths and metadata, run in their own process after files are closed, and never block or fail the recording. Candidates: `ParticleName.py`, `PressureUploader.py`.
- Procedures live in a folder under version control; also runnable from Jupyter via `laborchestra.connect`.

### MCP server
- Goal: Claude can read state, perform actions, and write and run measurement scripts.
- *(proposed)* Hosted in the C# server at `/mcp` (Streamable HTTP, official C# SDK), same schemas and code path as the UI.
- Few generic tools instead of one per action: `list_devices`, `describe_device`, `get_state`, `call_action`, `wait_for`, `get_plot` (image/decimated data), `list/read/write_procedure`, `run/abort_procedure`, `get_logs`, `list/get_recordings`.
- Safety: ranges enforced by the server for every caller; actions can be marked `requires_confirmation`; MCP modes off / read-only / control, set in the UI; audit log by caller; abort in the UI.
- **Scripts bypass action-level checks unless limits are enforced server-side, and running them is code execution on the lab PC.** No approval step in LabOrchestra: connecting the MCP server in Claude already takes a deliberate user action. `/mcp` must always require a token, including locally (today local connections bypass auth).

### Authentication
- **No localhost bypass** (cross-site WebSockets, local reverse proxies). Check `Origin`. Local convenience: one-time login link opened at startup (Jupyter style); token file readable only by the OS account for local scripts.
- Tokens: managed workers/procedures get a random in-memory token per spawn via environment variable; remote workers and MCP get revocable tokens created in the UI (stored hashed); browsers/scripts use the passphrase. Remote workers should use TLS.
- Roles, no users: `device:<id>` (may register/publish only that ID; may call other devices), `client`, `mcp` (off/read-only/control). Identity = caller in the event log. Tokens do not sandbox drivers.
- ASP.NET Core `AuthenticationHandler` + `[Authorize(Policy)]` on hubs, separate `DeviceHub`. Filter `access_token` from request logs.
- Fix: `ProtectedHub` checks only after connecting, and `StreamingHub` registers the client before that check; `signalR.tsx` lacks `onreconnecting`, so no full-state refetch after an automatic reconnect; `connection.ts` hard-codes `https://localhost:5095` (use relative URLs).

### Packaging and workspace *(proposed)*
- **No Node at runtime.** Client is static JS inside the server distribution. Server: self-contained `dotnet publish` per platform (no .NET install needed), as a folder; no trimming or NativeAOT (plugins are loaded dynamically). Bundle `uv`, `esbuild` (standalone binary) and the matching `laborchestra` wheel. Protocol version is checked on connect.
- **Widgets:** server watches files, compiles `.tsx` with the bundled esbuild (React/SDK external, resolved by the host import map) and tells clients over SignalR to re-import and remount. Build errors are shown in the widget. Replaces `widgetDevUrl`/Vite dev server/Fast Refresh above as the default. Widgets needing npm packages are built by their author and shipped as a bundle; only those authors need Node.
- **Workspace folder**, default `Documents/LabOrchestra`, selectable with `--workspace`, meant to be a git repo:
  ```
  devices.json    views/    devices/    procedures/    widgets/    plugins/    templates/
  ```
- Outside the workspace (OS app-data folder): venvs, caches, logs, tokens and secrets. Documents is often synced by OneDrive/iCloud. Recordings go to their own configured directory.
- **Single-file devices/procedures** with inline dependencies (PEP 723, supported by uv), no package needed; an adjacent `my_sensor.tsx` becomes its widget.
- **Reload on change:** widgets immediately; procedures on next run (fresh process; no source change during a run); devices show "changed" with a restart button, auto-restart opt-in per device, since a restart may touch hardware.
- C# plugins: prebuilt DLLs in `plugins/`, server restart to update.

### Workspace config files
- JSON, because the UI writes them (rewriting YAML loses comments); a `description` field replaces comments. The server watches them, so manual edits and `git pull` reach all clients.
- `devices.json`: all devices in one file. Secrets only by reference (`{"secret": "slack_token"}`), values in app data.
- `views/<id>.json`: one file per view (filename = ID, URL `/views/<id>`), with `version`, `title`, `order` and `widgets`. Written by the layout editor.

### Python environments
- The selected Python is only the base interpreter and is never modified. Per environment: `uv venv --python <selected>` in app data, then the bundled `laborchestra` wheel plus the device's dependencies. Reused until dependencies, Python or LabOrchestra version change.
- `laborchestra` version per environment: see Updates and compatibility.
- Minimum Python 3.11 *(proposed)*. The UI lists compatible interpreters (`uv python list`); uv may download one after confirmation. 32-bit interpreters are possible for 32-bit vendor DLLs.
- Keep the dependencies of `laborchestra` few, so they can be bundled for offline PCs.
- Own scripts/Jupyter: `pip install laborchestra`. Remote workers: `uvx --from laborchestra==<version> laborchestra-worker ...`; the UI shows the exact command, token supplied separately.
- On request, create an editing venv (in app data) and set its path in the workspace's `.vscode/settings.json`.

### Scaffolding ("New..." buttons)
- **New device:** profile or blank + connection type (serial, VISA, TCP, none) + name + Python version. Creates `devices/<name>.py`, venv and editor settings, adds it to `devices.json`, starts it, opens the editor. Runs at once on simulated values, clearly marked as simulated in the UI.
- **New procedure:** blank, parameter scan (device and parameter picked from dropdowns), post-recording analysis.
- **Add custom widget** (`<name>.tsx` from the device's schema), **Duplicate**, **Open in editor**, **Show in folder**. The last two work only on the server PC; elsewhere show the path. No in-browser editor at first.
- One implementation and template set for UI, CLI (`laborchestra new device`) and MCP. Built-in templates tested in CI; user templates in `templates/`. Never overwrite files. Requires `client`, or `mcp` in control mode.
- Start with: blank device, one profile, blank procedure, scan procedure.

### AI-assisted development *(proposed)*
- **Code is written by a coding agent in the workspace folder (Claude Code); MCP is for the running system** (state, actions, reload, logs, plots). MCP file tools exist for clients without file access (e.g. Claude Desktop), limited to workspace source folders.
- Claude Code connects to `/mcp` over HTTP through a scaffolded `.mcp.json` (token from an environment variable), so editing and control share one conversation. Build this first; Claude Desktop later via a stdio bridge. Do not expose `/mcp` to the internet (needed for claude.ai connectors).
- Conversations are not shared between clients: anything that should outlast one goes into files, run records or notes.
- **Docs, one source** shipped with the server: short `AGENTS.md` (imported by `CLAUDE.md`) and skills (write device/procedure/widget) scaffolded into the workspace, plus the same guides through MCP `get_docs(topic)`. Examples are tested in CI. Workspace files only hold lab-specific notes and pointers, so updates do not overwrite user edits.
- **Generated Python stubs** (and TS types) for the configured devices, so type checkers catch wrong names. Regenerated when the schema changes.
- **Feedback is pulled:** `reload(target)` waits until ready or failed and returns status, traceback, schema violations and new logs. `get_logs(source, level, since_cursor)`, `get_problems()` (everything currently failing: devices, procedures, env installs, esbuild, widgets), `wait_for_run(run_id, timeout)`.
- Every run and action has an ID that tags its logs. Output is size-limited, repeated errors are collapsed, secrets redacted.
- Widgets: esbuild errors from the server; runtime errors via React error boundary + `window.onerror`, reported by the browser to the server.
- CLI `laborchestra check <file>` validates without hardware or a running server (imports in the venv, so no hardware access at import); suitable as a Claude Code hook. New devices start simulated; switching to real hardware is a user action.
- "Copy for AI" button on every error in the UI. Log text from devices is data, not instructions.

### Later: lab notebook and sensor website *(future; design the core for it)*
- **Lab notebook (AI-assisted).** Timeline of automatic entries (recordings, runs, errors, config changes) and human/AI notes. AI drafts and summarizes; AI entries are marked, originals are kept.
- **Sensor website.** Read-only, hosted separately; LabOrchestra pushes outward (generalizing `PressureUploader.py`), never accepts inbound access. Explicit allowlist of fields; includes staleness, history, optional alerts. Only an upload token on the site.
- **Needed in the core now:** stable unique IDs for recordings, runs, devices and notes; timestamped events with caller, stored persistently (SQLite) rather than only in recordings; a low-rate history store for numeric state fields with downsampling; units in the schema; a minimal `add_note`/`get_notes` linked to IDs.

### Recording format
- `<name>.yaml`: format version, start time, software/driver versions, procedure, tags, **full initial state**; completed with end time and final state (written atomically). `<name>/<device>_C1.npy`: channel data as today. `<name>/events.json`: JSON array, one object per line and device update, `{"t": 12.31, "device": "pressure", "by": "device", "set": {"channels.1.pressure": 3.2e-7}}`.
- The array is streamed: `[` first, then each object with the comma *before* it (`,\n{...}`), `]` on close. After a crash, dropping an incomplete last line and appending `]` repairs it; the server does this on startup and `load_recording` tolerates it. Change-only, so device health changes must be events too (otherwise "constant" and "dead" look alike). Size (estimate): about 100 B per update, i.e. ~1 MB/h for a 3 Hz polarimeter. Optional per-field max rate (default 1 Hz for continuous readings *(proposed)*) and deadband; discrete changes and settings are always recorded. Values rounded to the field's declared precision.
- `t` is relative to the start (monotonic clock). Store each channel's first-sample time so events can be mapped to samples.
- `laborchestra.load_recording(path)` gives `rec.series("pressure.channels.1.pressure")`, `rec.state_at(t)` and memory-mapped channels, and reads the legacy format.

### Updates and compatibility *(proposed)*
- **Nothing updates by itself.** The server may check and notify (can be disabled); installing is a user action, blocked while recording or running a procedure. Server versions are installed side by side; config is backed up first; rollback = start the previous version with its backup.
- **Protocol version is separate from package versions.** Server supports the current and previous protocol major, so drivers pinned to an older `laborchestra` keep running in their own venv. The server installs its bundled `laborchestra` if the driver's requirement allows it, otherwise the newest allowed version with a supported protocol (replaces "always its own version").
- **Environments are immutable:** every change builds a new venv from a lockfile, starts the device from it, and keeps the previous one for rollback.
- **Preflight** before a server update: resolve all environments, check plugin and protocol compatibility, list what would break.
- **Driver packages** are pinned in `devices.json` with a lockfile per environment; updated one at a time from the UI (changelog, rollback). Single-file devices are the user's own and never modified.
- Semver: additive within a major, deprecation warnings in the UI for at least one minor release before removal. Applies to SDKs (Python, C#, widget), protocol and profiles.
- C# plugins run in-process: wrong SDK major -> refuse to load with a clear error. Widgets declare their SDK major; a React major upgrade is an SDK major.
- Workspace files carry `version` and are migrated with a backup; an older server refuses newer files. Drivers may define `migrate_config(old, from_version)`; a failed migration leaves the device in error with its old config intact.

### Problems in current Python devices (fix while porting)
- All helpers are remote actions, e.g. raw serial `send` in `PfeifferPressureSensor.py`; its `request` shadows the injected one.
- `RS_SMA100B.py` lacks `set_on`, which `DemoRFGen.py` has. `PolarizationLock` relies on Elliptec's state shape; `SmaractLock` and `DetuningScanControl` hard-code device IDs.
- Hardware opened at import; no reconnect; `Elliptec.main` ignores `is_running`; `except: pass` hides errors; no thread safety between actions and `main`.
- Client merges state shallowly, so `channels` arrays are always resent whole.
- `PressureUploader` rejects `selectedChannel = 0` as missing.

## License
- Server and client **GPL-3.0** (AGPL considered: little benefit since the software runs next to the hardware, and many companies ban it; separately hosted parts may become AGPL), SDKs and templates **Apache-2.0**, CLA from the first external contribution (automated bot, short explanatory text). Plugin exception: code using the public SDKs may have any license, and proprietary vendor libraries may be linked. Trademark/name policy for forks.
- **Vendor SDKs are not shipped**; the user installs them (e.g. PicoSDK). The plugin loads them at runtime (`NativeLibrary` resolver, searching the standard install folders) and reports a missing SDK as a clear device error with a download link. The C# API files in `server/Devices/Picoscope/` have a permissive license (Pico Technology) and stay, with their LICENSE.md.

## To do

- [ ] Proper exception management and logging: server, client, device workers, procedures
- [ ] Naming rule and unit metadata
- [ ] Profiles with schema export from code
- [ ] Procedures, recording service, event triggers; port the detuning scan
- [ ] MCP server
- [ ] Updates, rollback, compatibility policy
- [ ] Authentication: tokens, roles, no localhost bypass
- [ ] Packaging, workspace folder, file watching, esbuild widgets
- [ ] Scaffolding for devices, procedures, widgets
- [ ] AI docs, generated stubs, error/log feedback tools

## Before open-sourcing (checklist)

- [ ] `server/.env` **is tracked in git** (history: 13ca498, cef83eb, 5d52adc). The author confirms it never held real keys. Replace it with `.env.example`.
- [ ] Remove lab-specific values from code: `C:\Users\Cavity\...` Python path, `glaser.exp.univie.ac.at` CORS origins, `pressure.cavity.at`, device serials, COM ports, IPs. Move to config.
- [ ] Check redistribution rights for `server/ffts-dlls/` binaries; otherwise fetch at build time.
- [ ] Add a top-level LICENSE.
- [ ] Fix the README: it says Blazor and .NET 8, actual stack is Next.js and .NET 9 (also Python >= 3.13 requirement will change with per-device interpreters).

## Order of work

See [REWRITE.md](REWRITE.md) for phases, exit criteria and open decisions.
