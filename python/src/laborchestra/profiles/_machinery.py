"""Profiles: what every device of a kind (pressure sensor, polarimeter, ...) offers, written once as a Python class.

A profile lists the typed state fields (class annotations) and the actions (methods) that drivers of that kind have in common. A
driver says ``profiles = [PressureSensor]``; consumers (scripts, widgets, MCP) can then rely on the shape, whoever wrote the driver. Drivers
may add fields and actions of their own. JSON Schema is never written by hand: ``describe(profile)`` derives it from the class.
"""

from __future__ import annotations

import inspect
import types
import typing
from typing import Annotated, Any, Callable, Literal, get_args, get_origin

from .._schema import _parameters, action_methods, base_type, check_name
from ..errors import SchemaError


class Unit:
    """Metadata for ``Annotated[float, Unit("mbar")]``: the unit is fixed by the profile; drivers convert on input, so the wire and the
    recordings always have this unit."""

    def __init__(self, symbol: str):
        self.symbol = symbol

    def __repr__(self) -> str:
        return f"Unit({self.symbol!r})"


def optional(fn: Callable) -> Callable:
    """Marks an action of a profile as a capability: a driver may leave it out, but if it has it, it must fit."""
    fn.__lab_optional__ = True
    return fn


class Profile:
    """Base class of profiles. Subclass with ``name`` and ``version``; annotations are state fields, public methods are actions."""

    name: typing.ClassVar[str]
    version: typing.ClassVar[int] = 1
    #: The key of the state under which this profile's fields live; None: at the top. See ``at``.
    mount: typing.ClassVar[str | None] = None

    @classmethod
    def at(cls, key: str) -> "type[Profile]":
        """This profile with its state fields under ``key`` (``FrequencyGenerator.at("generator")``): for a device that is two things at
        once, e.g. an oscilloscope (``channels`` are its inputs) with a signal generator (``generator.channels`` are its outputs). The
        actions keep their names, so they must not clash with the other profile's."""
        check_name(key, "Mount of the profile " + cls.name)
        return type(cls.__name__, (cls,), {"name": cls.name, "version": cls.version, "mount": key, "__module__": cls.__module__})

    @classmethod
    def validate(cls, state: dict) -> list[str]:
        """Rules that types cannot say; override. Returns the problems found in a state that has the right types."""
        return []

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if "name" not in vars(cls):
            raise SchemaError(f"The profile {cls.__name__} needs a name (snake_case)")
        check_name(cls.name, "Profile")
        if not isinstance(cls.version, int) or cls.version < 1:
            raise SchemaError(f"The profile {cls.name} needs a version of 1 or more")
        fields = state_fields(cls)
        for field in fields:
            check_name(field, f"State field of the profile {cls.name}")
        _check_type_names(cls.name, fields)


# --- reading the declaration ---------------------------------------------------------------------------------------
def state_fields(profile: type[Profile]) -> dict[str, Any]:
    hints = typing.get_type_hints(profile, include_extras=True)
    return {k: v for k, v in hints.items() if get_origin(v) is not typing.ClassVar and k not in ("name", "version", "mount")}


def profile_actions(profile: type[Profile]) -> dict[str, Callable]:
    return {
        n: f
        for klass in reversed(profile.__mro__)
        if klass not in (Profile, object)
        for n, f in vars(klass).items()
        if inspect.isfunction(f) and not n.startswith("_") and n not in ("validate", "at")
    }


def _check_type_names(owner: str, fields: dict[str, Any]) -> None:
    def walk(annotation: Any, path: str) -> None:
        annotation, _ = _strip(annotation)
        if typing.is_typeddict(annotation):
            for key, sub in typing.get_type_hints(annotation, include_extras=True).items():
                check_name(key, f"Field {path}.{key} of the profile {owner}")
                walk(sub, f"{path}.{key}")
        elif get_origin(annotation) is list:
            walk(get_args(annotation)[0], f"{path}.*")
        elif get_origin(annotation) in (typing.Union, types.UnionType):
            for arg in get_args(annotation):
                walk(arg, path)

    for field, annotation in fields.items():
        walk(annotation, field)


def _strip(annotation: Any) -> tuple[Any, list[Unit]]:
    """Annotated[T, Unit(..)] -> (T, [Unit(..)])."""
    units: list[Unit] = []
    while get_origin(annotation) is Annotated:
        args = get_args(annotation)
        units += [m for m in args[1:] if isinstance(m, Unit)]
        annotation = args[0]
    return annotation, units


# --- export (JSON, derived from the code) --------------------------------------------------------------------------
def _type_schema(annotation: Any) -> dict:
    annotation, units = _strip(annotation)
    out: dict[str, Any]
    origin = get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        args = [a for a in get_args(annotation) if a is not type(None)]
        out = _type_schema(args[0]) if len(args) == 1 else {"type": "json"}
        out["nullable"] = len(args) != len(get_args(annotation))
        if units:
            out["unit"] = units[0].symbol
        return out
    if origin is list:
        out = {"type": "list", "items": _type_schema(get_args(annotation)[0])}
    elif typing.is_typeddict(annotation):
        hints = typing.get_type_hints(annotation, include_extras=True)
        required = getattr(annotation, "__required_keys__", set(hints))
        out = {"type": "object", "fields": {k: {**_type_schema(v), "required": k in required} for k, v in hints.items()}}
    elif origin is Literal:
        out = {"type": "enum", "values": list(get_args(annotation))}
    elif annotation is Any:
        out = {"type": "json"}
    else:
        out = {"type": base_type(annotation)}
    if units:
        out["unit"] = units[0].symbol
    return out


def units(profile: type[Profile]) -> dict[str, str]:
    """The unit of every field that has one, by path; ``*`` stands for any list index (``channels.*.pressure``)."""
    found: dict[str, str] = {}

    def walk(annotation: Any, path: str) -> None:
        annotation, own = _strip(annotation)
        if own:
            found[path] = own[0].symbol
        if get_origin(annotation) in (typing.Union, types.UnionType):
            for arg in get_args(annotation):
                walk(arg, path)
        elif get_origin(annotation) is list:
            walk(get_args(annotation)[0], f"{path}.*")
        elif typing.is_typeddict(annotation):
            for key, sub in typing.get_type_hints(annotation, include_extras=True).items():
                walk(sub, f"{path}.{key}")

    for field, annotation in state_fields(profile).items():
        walk(annotation, f"{profile.mount}.{field}" if profile.mount else field)
    return found


def describe(profile: type[Profile]) -> dict:
    """The profile as JSON: name, version, state fields with types and units, actions with parameters. Derived from the class."""
    actions = []
    for name, fn in sorted(profile_actions(profile).items()):
        params = [
            {"name": p.name, "type": base_type(p.annotation, p.default), "required": p.default is p.empty}
            for p in _parameters(fn)
        ]
        actions.append({"name": name, "doc": inspect.getdoc(fn), "optional": bool(getattr(fn, "__lab_optional__", False)), "params": params})
    return {
        "name": profile.name,
        "version": profile.version,
        **({"at": profile.mount} if profile.mount else {}),
        "doc": inspect.getdoc(profile),
        "state": {k: _type_schema(v) for k, v in state_fields(profile).items()},
        "units": units(profile),
        "actions": actions,
    }


# --- checking ---------------------------------------------------------------------------------------------------------
def check_value(value: Any, annotation: Any, path: str) -> list[str]:
    """Problems of a value against a type of a profile; extra keys in objects are fine (drivers may add fields)."""
    annotation, _ = _strip(annotation)
    origin = get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        if value is None and type(None) in get_args(annotation):
            return []
        attempts = [check_value(value, a, path) for a in get_args(annotation) if a is not type(None)]
        return [] if any(not a for a in attempts) else attempts[0]
    if annotation is Any:
        return []
    if origin is Literal:
        return [] if value in get_args(annotation) else [f"{path} is {value!r}, expected one of {list(get_args(annotation))}"]
    if origin is list:
        if not isinstance(value, list):
            return [f"{path} must be a list, got {type(value).__name__}"]
        return [p for i, item in enumerate(value) for p in check_value(item, get_args(annotation)[0], f"{path}[{i}]")]
    if typing.is_typeddict(annotation):
        if not isinstance(value, dict):
            return [f"{path} must be an object, got {type(value).__name__}"]
        hints = typing.get_type_hints(annotation, include_extras=True)
        required = getattr(annotation, "__required_keys__", set(hints))
        problems = [f"{path}.{k} is missing" for k in sorted(required) if k not in value]
        for key, sub in hints.items():
            if key in value:
                problems += check_value(value[key], sub, f"{path}.{key}")
        return problems
    kind = base_type(annotation)
    ok = {
        "bool": isinstance(value, bool),
        "int": isinstance(value, int) and not isinstance(value, bool),
        "float": isinstance(value, (int, float)) and not isinstance(value, bool),
        "str": isinstance(value, str),
        "json": True,
    }[kind]
    return [] if ok else [f"{path} must be {kind}, got {'None' if value is None else type(value).__name__}"]


def check_state(profile: type[Profile], state: dict) -> list[str]:
    """Problems of a device's state against the profile (empty when it conforms)."""
    prefix = f"{profile.mount}." if profile.mount else ""
    if profile.mount:
        if not isinstance(state.get(profile.mount), dict):
            return [f"{profile.mount} is missing"]
        state = state[profile.mount]
    problems = []
    for field, annotation in state_fields(profile).items():
        if field not in state:
            problems.append(f"{prefix}{field} is missing")
        else:
            problems += check_value(state[field], annotation, prefix + field)
    return problems if problems else profile.validate(state)


def _signatures_of_class(device_class: type) -> dict[str, list[tuple[str, str, bool]]]:
    return {
        name: [(p.name, base_type(p.annotation, p.default), p.default is p.empty) for p in _parameters(fn)]
        for name, fn in action_methods(device_class).items()
    }


def _signatures_of_schema(schema: dict) -> dict[str, list[tuple[str, str, bool]]]:
    return {a["name"]: [(p["name"], p["type"], bool(p["required"])) for p in a["params"]] for a in schema.get("actions", [])}


def _check_signatures(profile: type[Profile], have: dict[str, list[tuple[str, str, bool]]]) -> list[str]:
    problems = []
    for name, wanted in profile_actions(profile).items():
        is_optional = bool(getattr(wanted, "__lab_optional__", False))
        if name not in have:
            if not is_optional:
                problems.append(f"the action {name} is missing")
            continue
        mine = have[name]
        theirs = [(p.name, base_type(p.annotation, p.default)) for p in _parameters(wanted)]
        for i, (expected_name, expected_type) in enumerate(theirs):
            if i >= len(mine) or mine[i][0] != expected_name:
                problems.append(f"{name}: parameter {i + 1} must be called '{expected_name}'")
                break
            if mine[i][1] not in (expected_type, "json"):
                problems.append(f"{name}: '{expected_name}' must be {expected_type}")
        problems += [f"{name}: the extra parameter '{p[0]}' needs a default" for p in mine[len(theirs):] if p[2]]
    return problems


def check_actions(profile: type[Profile], device_class: type) -> list[str]:
    """Problems of a driver's actions against the profile: every required action there, with the profile's parameters first (same names
    and types); parameters the driver adds must have defaults."""
    return _check_signatures(profile, _signatures_of_class(device_class))


def check_schema(profile: type[Profile], schema: dict, state: dict | None = None) -> list[str]:
    """The same for a device that is not a Python class here (a C# driver): its schema as the server has it, and optionally its state."""
    return _check_signatures(profile, _signatures_of_schema(schema)) + (check_state(profile, state) if state is not None else [])


def check_driver(profile: type[Profile], device_class: type) -> list[str]:
    """What can be said about a driver without running it: its actions (the state is checked when it runs, see ``check_state``)."""
    return check_actions(profile, device_class)
