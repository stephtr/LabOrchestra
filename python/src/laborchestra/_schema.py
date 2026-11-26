"""Derive the public description of a device (options, actions, state) and enforce conventions."""

from __future__ import annotations

import inspect
import json
import re
import types
import typing
from typing import Any, Callable

from .errors import SchemaError

_SNAKE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
RESERVED = frozenset({"state", "persist", "id", "lab", "log", "running", "lock", "widget", "profiles", "units", "kind", "channel_names"})
MISSING = object()


def check_name(name: Any, what: str) -> None:
    if not isinstance(name, str) or not _SNAKE.match(name):
        raise SchemaError(f"{what} '{name}' must be snake_case (lowercase letters, digits, underscores)")


def _from_annotation(annotation: Any) -> str | None:
    if isinstance(annotation, str):
        parts = [p for p in annotation.replace(" ", "").split("|") if p != "None"]
        return parts[0] if len(parts) == 1 and parts[0] in ("bool", "int", "float", "str") else None
    if typing.get_origin(annotation) in (typing.Union, types.UnionType):
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _from_annotation(args[0]) if len(args) == 1 else None
    return annotation.__name__ if annotation in (bool, int, float, str) else None


def base_type(annotation: Any = MISSING, default: Any = MISSING) -> str:
    if annotation is not MISSING and annotation is not inspect.Parameter.empty:
        if found := _from_annotation(annotation):
            return found
    if default is not MISSING and default is not inspect.Parameter.empty:
        for python_type, name in ((bool, "bool"), (int, "int"), (float, "float"), (str, "str")):
            if isinstance(default, python_type):
                return name
    return "json"


def _json_default(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return None


def config_options(cls: type, base: type) -> list[dict]:
    """Options are class attributes: annotated without default = required, with default = optional."""
    annotations: dict[str, Any] = {}
    defaults: dict[str, Any] = {}
    for klass in reversed(cls.__mro__):
        if klass is object or klass is base:
            continue
        annotations.update(inspect.get_annotations(klass))
        for name, value in vars(klass).items():
            if name.startswith("_") or name in RESERVED:
                continue
            if callable(value) or isinstance(value, (property, classmethod, staticmethod)):
                continue
            defaults[name] = value
    options = []
    for name in {**annotations, **defaults}:
        if name.startswith("_") or name in RESERVED:
            continue
        default = defaults.get(name, MISSING)
        check_name(name, "Option")
        options.append(
            {
                "name": name,
                "type": base_type(annotations.get(name, MISSING), default),
                "default": None if default is MISSING else _json_default(default),
                "required": default is MISSING,
            }
        )
    # a device with channels can name them (the framework puts the names into the state, see Device.channel_names): no driver has to say so
    state = getattr(cls, "state", None)
    if isinstance(state, dict) and "channels" in state and getattr(cls, "kind", "device") != "service" and not any(o["name"] == "channel_names" for o in options):
        options.append({"name": "channel_names", "type": "json", "default": _json_default(list(getattr(cls, "channel_names", []) or [])), "required": False})
    return options


def action_methods(cls: type) -> dict[str, Callable]:
    found = {}
    for name in dir(cls):
        if name.startswith("_"):
            continue
        value = inspect.getattr_static(cls, name)
        if inspect.isfunction(value) and getattr(value, "__lab_action__", False):
            check_name(name, "Action")
            found[name] = value
    return found


def _parameters(fn: Callable) -> list[inspect.Parameter]:
    params = list(inspect.signature(fn).parameters.values())[1:]  # without self
    for p in params:
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD, p.KEYWORD_ONLY):
            raise SchemaError(f"Action '{fn.__name__}': parameter '{p.name}' must be a plain positional parameter")
        check_name(p.name, f"Parameter of action '{fn.__name__}'")
    return params


def action_schema(name: str, fn: Callable) -> dict:
    params = [
        {
            "name": p.name,
            "type": base_type(p.annotation, p.default),
            "default": None if p.default is p.empty else _json_default(p.default),
            "required": p.default is p.empty,
        }
        for p in _parameters(fn)
    ]
    return {"name": name, "doc": inspect.getdoc(fn), "params": params}


def validate_state(value: Any, path: str = "state") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            check_name(key, f"Key in {path}")
            validate_state(item, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            validate_state(item, f"{path}[{i}]")


def coerce(value: Any, type_name: str, what: str, allow_none: bool = False) -> Any:
    if value is None:
        if allow_none or type_name == "json":
            return None
        raise TypeError(f"{what} must be {type_name}, got None")
    ok = isinstance(value, bool) if type_name == "bool" else not isinstance(value, bool)
    if type_name == "float" and isinstance(value, (int, float)) and ok:
        return float(value)
    if type_name == "int" and ok:
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
    if type_name == "bool" and isinstance(value, bool):
        return value
    if type_name == "str" and isinstance(value, str):
        return value
    if type_name == "json":
        return value
    raise TypeError(f"{what} must be {type_name}, got {type(value).__name__}")


def coerce_arguments(fn: Callable, args: list) -> list:
    params = _parameters(fn)
    if len(args) > len(params):
        raise TypeError(f"{fn.__name__}() takes {len(params)} argument(s), got {len(args)}")
    result = []
    for i, p in enumerate(params):
        if i < len(args):
            result.append(
                coerce(args[i], base_type(p.annotation, p.default), f"Parameter '{p.name}'", p.default is None)
            )
        elif p.default is p.empty:
            raise TypeError(f"{fn.__name__}() is missing the argument '{p.name}'")
    return result
