from laborchestra import Device, action


class Knob(Device):
    """A value that a procedure can turn."""

    state = {"value": 0.0}

    @action
    def set_value(self, value: float):
        self.state["value"] = value
