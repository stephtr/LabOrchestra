from laborchestra import Device, action


class Shaky(Device):
    state = {"calls": 0}

    @action
    def fine(self):
        self.state["calls"] += 1

    @action
    def break_down(self):
        raise OSError("the bus does not answer")

    @action
    def wrong_argument(self):
        raise ValueError("that is not a valid value")

    @action
    def stopped_on_purpose(self):
        raise InterruptedError("stopped")
