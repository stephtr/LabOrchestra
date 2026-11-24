import random

from laborchestra import Device, action


class Counter(Device):
    """Keeps `count` across restarts, forgets `scratch`."""

    state = {"count": 0, "scratch": 0, "channels": [1, 2], "tree": {"items": [{"value": 1}], "flag": False}}
    persist = ["count", "channels"]

    @action
    def scramble(self, seed: int, steps: int):
        """Random changes anywhere in `tree`, to check that patches keep everyone in sync."""
        rng = random.Random(seed)
        tree = self.state["tree"]
        for _ in range(steps):
            choice = rng.randrange(7)
            if choice == 0:
                tree[f"key_{rng.randrange(4)}"] = rng.choice([1, 2.5, "x", None, True, {"inner": rng.randrange(9)}, [1, 2]])
            elif choice == 1 and tree.get("items"):
                tree["items"][rng.randrange(len(tree["items"]))]["value"] = rng.random()
            elif choice == 2:
                tree.setdefault("items", []).append({"value": rng.randrange(9)})
            elif choice == 3 and tree.get("items"):
                tree["items"].pop()
            elif choice == 4:
                tree.pop(f"key_{rng.randrange(4)}", None)
            elif choice == 5:
                tree["flag"] = not tree["flag"]
            else:
                tree["items"] = [{"value": rng.randrange(9)} for _ in range(rng.randrange(4))]

    @action
    def increment(self):
        self.state["count"] += 1
        self.state["scratch"] += 1
        self.state["channels"][0] += 10
