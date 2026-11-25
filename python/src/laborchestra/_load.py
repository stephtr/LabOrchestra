"""Loading a Python file of the workspace (a device, a procedure) as a module."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

from .errors import SchemaError


def load_file(path: str | Path, module_name: str) -> ModuleType:
    """Runs the file as a module and returns it.

    The source is compiled each time, and no bytecode cache is read or written: Python decides whether a cached copy is still good by the
    modification time of the file in whole seconds and its size, so a file that is saved twice within a second, with a change that keeps
    its length, would run as it was before. A device file is small and loaded once per start: the cache would buy nothing.
    """
    file = Path(path).resolve()
    spec = importlib.util.spec_from_file_location(module_name, file)
    if spec is None or spec.loader is None:
        raise SchemaError(f"Cannot load {path}")
    sys.path.insert(0, str(file.parent))  # the file may import a helper next to it
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    code = compile(file.read_bytes(), str(file), "exec")  # bytes: the encoding line of the file is honoured
    exec(code, module.__dict__)
    return module
