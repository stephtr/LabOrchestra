"""Runs one procedure in this process (the server starts it): ``python -m laborchestra.procedure_runner file.py[:name]``.

Connects to the server like a script, reports progress and the outcome (``run_report``), and obeys the server's commands (pause, resume, abort).
``--describe`` prints the procedures of the file (parameters, devices) and stops."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import sys
import threading
import traceback
from typing import Any, Callable

from .errors import SchemaError
from .lab import AsyncLab
from .procedures import Run, coerce_params, describe, load

log = logging.getLogger("laborchestra.procedure")

MARKER = "LABORCHESTRA-PROCEDURES "
EXIT_OK, EXIT_FAILED, EXIT_CONFIG = 0, 1, 2


def _error_info(e: BaseException) -> dict:
    return {"type": type(e).__name__, "message": str(e), "traceback": "".join(traceback.format_exception(type(e), e, e.__traceback__))}


def _plain(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return json.loads(json.dumps(value, default=repr))


async def _run(fn: Callable, params: dict, run_id: str) -> int:
    url, token = os.environ.get("LABORCHESTRA_URL"), os.environ.get("LABORCHESTRA_TOKEN")
    lab = AsyncLab(url, token, name="procedure")
    await lab.connect(timeout=30)
    loop = asyncio.get_running_loop()
    outbox: asyncio.Queue = asyncio.Queue()

    def send(report: dict) -> None:
        outbox.put_nowait(report)

    run = Run(lab, run_id, fn.__name__, fn.__lab_procedure__["devices"], params, send)
    task: asyncio.Task | None = None
    abort_reason: list[str] = []

    def abort(reason: str) -> None:
        run._command("abort")
        abort_reason.append(reason)
        if task is not None and not task.done():
            task.cancel()

    def on_command(command: str) -> None:
        if command == "abort":
            abort("aborted by the user")
        else:
            run._command(command)

    lab._hub.on("run_command")(on_command)

    async def sender() -> None:  # in order, one at a time; a lost report must not stop the run
        while True:
            report = await outbox.get()
            if report is None:
                return
            try:
                await lab._hub.invoke("run_report", run_id, report)
            except Exception as e:
                log.debug("Could not report %s: %s", list(report), e)

    sending = asyncio.create_task(sender())
    if os.environ.get("LABORCHESTRA_WATCH_STDIN"):
        threading.Thread(target=lambda: (sys.stdin.read(), loop.call_soon_threadsafe(abort, "the server ended")), name="stdin-watch", daemon=True).start()
    final: dict
    code = EXIT_OK
    try:
        await lab._hub.invoke("run_attach", run_id)
        send({"state": "running"})
        task = asyncio.create_task(fn(run, **params))
        if abort_reason:  # an abort came before the task existed
            task.cancel()
        try:
            result = await task
            final = {"outcome": "finished", "result": _plain(result)}
        except asyncio.CancelledError:
            final = {"outcome": "aborted", "reason": abort_reason[0] if abort_reason else "cancelled"}
        except BaseException as e:  # noqa: BLE001 - whatever the procedure raised is the run's error
            log.error("The procedure failed: %s: %s", type(e).__name__, e, exc_info=True)
            final, code = {"outcome": "failed", "error": _error_info(e)}, EXIT_FAILED
    except Exception as e:
        final, code = {"outcome": "failed", "error": _error_info(e)}, EXIT_FAILED
    send({"final": final})
    outbox.put_nowait(None)
    with contextlib.suppress(asyncio.TimeoutError, Exception):
        await asyncio.wait_for(sending, 15)
    await lab._hub.close()
    return code


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="laborchestra-procedure", description="Run or describe one LabOrchestra procedure.")
    parser.add_argument("target", help="path/to/file.py[:procedure]")
    parser.add_argument("--describe", action="store_true", help="print the procedures of the file (parameters, devices) and stop")
    parser.add_argument("--run-id", default=os.environ.get("LABORCHESTRA_RUN_ID"))
    parser.add_argument("--params", default=os.environ.get("LABORCHESTRA_RUN_PARAMS", "{}"), help="the parameters as JSON")
    args = parser.parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=os.environ.get("LABORCHESTRA_LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s: %(message)s")
    try:
        found, name = load(args.target)
        if args.describe:
            print(MARKER + json.dumps([describe(f) for f in found]))
            sys.exit(EXIT_OK)
        if not found:
            raise SchemaError(f"{args.target} has no procedure (mark an async function with @procedure)")
        if name is None and len(found) > 1:
            raise SchemaError(f"{args.target} has several procedures ({', '.join(f.__name__ for f in found)}): name one as file.py:name")
        fn = next(f for f in found if name in (None, f.__name__))
        if not args.run_id:
            parser.error("--run-id (or LABORCHESTRA_RUN_ID) is required")
        params = coerce_params(fn, json.loads(args.params))
    except SystemExit:
        raise
    except Exception as e:
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(EXIT_CONFIG)
    sys.exit(asyncio.run(_run(fn, params, args.run_id)))


if __name__ == "__main__":
    main()
