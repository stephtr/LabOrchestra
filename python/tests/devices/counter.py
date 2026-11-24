from laborchestra import Device, action


class Counter(Device):
    """Keeps `count` across restarts, forgets `scratch`."""

    state = {"count": 0, "scratch": 0, "channels": [1, 2]}
    persist = ["count", "channels"]

    @action
    def increment(self):
        self.state["count"] += 1
        self.state["scratch"] += 1
        self.state["channels"][0] += 10
