import ctypes
import os
import sys

from laborchestra import Device


class Stuck(Device):
    """Publishes its pid, then sits in a call that holds the GIL, like a driver that hangs: no thread of this process runs any more,
    so it cannot notice that the server is gone."""

    state = {"pid": 0}

    def connect(self):
        self.state["pid"] = os.getpid()

    def run(self):
        self.sleep(1.0)  # let the pid reach the server
        libc = ctypes.PyDLL("kernel32" if sys.platform == "win32" else None)  # PyDLL does not release the GIL
        libc.Sleep(600_000) if sys.platform == "win32" else libc.sleep(600)
