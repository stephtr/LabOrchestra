from laborchestra import Device, action


class TestCounter(Device):
    """A counter that comes from an installed package."""

    __test__ = False  # not a pytest class

    step: int = 1

    state = {"count": 0}

    @action
    def increment(self):
        """Counts up by `step`."""
        self.state["count"] += self.step
