from laborchestra import Device


class Secretive(Device):
    """Receives a secret as an option and only reveals how long it is."""

    api_key: str
    state = {"key_length": 0}

    def connect(self):
        self.state["key_length"] = len(self.api_key)
        self.log.info("Got a key")
