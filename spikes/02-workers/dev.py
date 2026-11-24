# /// script
# requires-python = ">=3.11"
# dependencies = ["pyserial"]
# ///
import os, sys, threading, time, re
import serial
mode = sys.argv[1]
if sys.platform == "linux" and os.environ.get("USE_PDEATHSIG"):
    import ctypes
    ctypes.CDLL(None).prctl(1, 9)   # PR_SET_PDEATHSIG, SIGKILL
stop = threading.Event()
def watch():   # EOF on stdin = parent gone or asks to stop. os.read: no buffer lock that could break interpreter shutdown
    while os.read(0, 4096): pass
    stop.set(); time.sleep(2); os._exit(3)
threading.Thread(target=watch, daemon=True).start()
print("ready", os.getpid(), serial.__version__, flush=True)
if mode == "normal": stop.wait(); print("cleanup done", flush=True)
elif mode == "blocked":
    while True: time.sleep(1000)
elif mode == "gil": re.match(r"(a+)+$", "a" * 60 + "b")
elif mode == "crash": time.sleep(.3); os._exit(134)
