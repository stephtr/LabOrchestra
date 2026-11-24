# Device contract, version 1

What a Python device can rely on, and what the framework relies on in return. Five drivers (Elliptec, Thorlabs polarimeter, Pfeiffer
pressure controller, SmarAct, Rohde & Schwarz SMA100B) and the test devices in `python/tests/devices/` follow it. Additions within
version 1 are allowed; removing or changing something needs version 2 (see "Updates and compatibility" in CLAUDE.md).

## A device is a class
```python
from laborchestra import Device, action

class Generator(Device):
    address: str = ""          # option, optional (has a default)
    port: str                  # option, required (annotated, no default)
    simulate = False           # option; every driver has one
    state = {"channels": []}   # published on every change (also nested); keys are snake_case
    persist = ["name"]         # state keys that are saved and restored

    def connect(self): ...     # open hardware; raise to say why the device cannot start
    def run(self): ...         # optional loop: `while self.running:` / `self.sleep(s)`; async def is allowed
    def close(self): ...       # release hardware
    @action
    def set_power(self, channel: int, power: float): ...
```

## Rules
- **Names are snake_case** (state keys, options, actions); device IDs are valid Python identifiers. Verbs first (`set_`, `start_`, `stop_`),
  booleans `is_`/`has_`, units in the docstring, not in names.
- **Only methods marked `@action` are callable.** Their type hints become the schema; arguments are checked against it.
- **Actions run in parallel threads**, so that a `stop` can reach a device during a long move. Hardware access that must not overlap uses
  `with self.lock:` (an `RLock`). Keep the lock only for the access itself, never for the whole wait.
- **When an action returns, its effects are in the state the caller sees.** The worker sends pending changes before the result, also when
  the action fails. A caller of a blocking action (a move) gets the answer when the stage has arrived.
- **Statuses:** `ready`, `degraded` (three failed actions in a row, not counting wrong arguments (`ValueError`, `TypeError`, `LookupError`, ...) or `InterruptedError`; a success ends it), `reconnecting`, `error`, `stopped`. Raise `InterruptedError` for a move that was stopped on purpose.
- **Errors reach the caller** as an error with type, message and traceback; nothing is swallowed. Background errors are logged once (not at
  every poll) and shown in the state (`status`).
- **Invalid readings are `None` plus a status**, never 0 (`status`: `ok`, `error`, ...).
- **Simulation is an option** (`simulate`), never a silent fallback: the state says `simulated: True`; a missing port or address without
  `simulate` is an error that says what to set.
- **Hardware limits belong in the driver and are written down** in its docstring (polling rates, retries, timeouts).
- **Stopping:** `self.running` turns False and `self.sleep()` returns early; blocking reads use short timeouts so that stopping stays responsive.
- **Other devices:** `self.lab["pressure"].state` (cached, pushed), `self.lab.elliptec.set_position(...)` (blocks until done),
  `wait_ready()`, `wait_for(lambda state: ...)`.
- A single file with a PEP 723 header (`# /// script`) is a complete device; its dependencies get their own environment.

## Not part of version 1
Profiles (shared contracts per instrument kind), units as metadata, `requires_confirmation`, per-field recording rates. They are additive
and will come with the profiles work.
