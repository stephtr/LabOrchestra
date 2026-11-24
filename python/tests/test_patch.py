import copy
import random

import pytest

from laborchestra._patch import PatchError, apply_patch, diff


def test_minimal_patches():
    old = {"channels": [{"pressure": 1.0, "status": "ok"}, {"pressure": 2.0, "status": "ok"}], "name": "a", "x": 1}
    new = copy.deepcopy(old)
    new["channels"][1]["pressure"] = 3.0
    assert diff(old, new) == {"set": {"channels.1.pressure": 3.0}}
    new["name"] = "b"
    del new["x"]
    new["y"] = {"z": 1}
    assert diff(old, new) == {"set": {"channels.1.pressure": 3.0, "name": "b", "y": {"z": 1}}, "del": ["x"]}
    assert diff(old, old) == {}


def test_lists_that_change_length_are_replaced():
    assert diff({"a": [1, 2]}, {"a": [1, 2, 3]}) == {"set": {"a": [1, 2, 3]}}
    assert diff({"a": [1, 2, 3]}, {"a": []}) == {"set": {"a": []}}


def test_types_matter_and_nan_is_unchanged():
    assert diff({"a": 1}, {"a": 1.0}) == {"set": {"a": 1.0}}
    assert diff({"a": True}, {"a": 1}) == {"set": {"a": 1}}
    assert diff({"a": float("nan")}, {"a": float("nan")}) == {}


def test_bad_paths_are_errors():
    with pytest.raises(PatchError):
        apply_patch({"a": 1}, {"set": {"b.c": 1}})
    with pytest.raises(PatchError):
        apply_patch({"a": [1]}, {"set": {"a.5": 1}})
    with pytest.raises(PatchError):
        apply_patch({"a": [1]}, {"del": ["a.0"]})


def random_value(rng, depth=0):
    kind = rng.choice(["int", "float", "str", "bool", "none", "dict", "list"] if depth < 3 else ["int", "str"])
    if kind == "int":
        return rng.randint(-5, 5)
    if kind == "float":
        return rng.random()
    if kind == "str":
        return rng.choice(["a", "b", ""])
    if kind == "bool":
        return rng.random() < 0.5
    if kind == "none":
        return None
    if kind == "dict":
        return {f"key_{i}": random_value(rng, depth + 1) for i in range(rng.randint(0, 3))}
    return [random_value(rng, depth + 1) for _ in range(rng.randint(0, 3))]


def test_apply_diff_always_reproduces_the_new_state():
    rng = random.Random(7)
    for _ in range(2000):
        old = {f"key_{i}": random_value(rng) for i in range(rng.randint(0, 4))}
        new = {f"key_{i}": random_value(rng) for i in range(rng.randint(0, 4))}
        if rng.random() < 0.5:  # related states are the interesting ones
            new = copy.deepcopy(old)
            for _ in range(rng.randint(1, 3)):
                new[f"key_{rng.randint(0, 4)}"] = random_value(rng)
        state = copy.deepcopy(old)
        apply_patch(state, diff(old, new))
        assert state == new
