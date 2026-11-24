import json


class LabOrchestraError(Exception):
    """Base class of all errors raised by this package."""


class AuthError(LabOrchestraError):
    """The server rejected the token."""


class ConnectionLost(LabOrchestraError):
    """The connection was lost while a call was pending."""


class SchemaError(LabOrchestraError):
    """A device does not follow the conventions (names, types)."""


class RemoteError(LabOrchestraError):
    """An error that happened on the other side of a call.

    ``type`` and ``traceback`` come from the remote exception, if the other side sent them.
    """

    def __init__(self, message: str, type: str | None = None, traceback: str | None = None):
        super().__init__(message)
        self.message = message
        self.type = type
        self.traceback = traceback

    @classmethod
    def parse(cls, text: str) -> "RemoteError":
        start = text.find("{")
        if start >= 0:
            try:
                data = json.loads(text[start:])
                return cls(str(data.get("message", text)), data.get("type"), data.get("traceback"))
            except (ValueError, AttributeError):
                pass
        return cls(text)

    def __str__(self) -> str:
        return f"{self.type}: {self.message}" if self.type else self.message
