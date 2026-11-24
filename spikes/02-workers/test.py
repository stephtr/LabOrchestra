import os, subprocess, sys, time, psutil
W = os.name == "nt"
os.chdir(os.path.dirname(os.path.abspath(__file__)))
py = os.path.abspath("w.venv/Scripts/python.exe" if W else "w.venv/bin/python")
t = time.time()
subprocess.run(["uv", "venv", "-q", "--clear", "w.venv"], check=True)
subprocess.run(["uv", "pip", "install", "-q", "--python", py, "-r", "dev.py"], check=True)
print(f"venv + deps: {time.time() - t:.2f} s")
sup = os.path.abspath("bin/Release/net9.0/sup" + (".exe" if W else ""))
out = subprocess.run([sup, py, "test"], capture_output=True, text=True, timeout=60).stdout; print(out)
assert "stop normal: exited by itself, code 0" in out and "cleanup done" in out
assert "stop blocked: exited by itself" in out and "stop gil: had to be killed" in out and "crash #2 detected" in out

def left():
    r = []
    for p in psutil.process_iter(["cmdline"]):
        c = p.info["cmdline"] or []
        if len(c) > 2 and c[-2] == "dev.py": r.append((c[-1], p))
    return r
def hold(extra):
    p = subprocess.Popen([sup, py, "hold", *extra], env={**os.environ, **({"USE_PDEATHSIG": "1"} if extra else {})})
    time.sleep(3); assert {m for m, _ in left()} == {"normal", "blocked", "gil"}, left()
    p.kill(); p.wait(); time.sleep(4); l = left(); names = sorted({m for m, _ in l})
    for _, q in l:
        try: q.kill()
        except psutil.NoSuchProcess: pass
    time.sleep(.5); return names
n = hold([]); print("server killed, stdin only, left over:", n); assert set(n) <= {"gil"}
n = hold(["job"]); print("server killed, with OS mechanism, left over:", n)
assert n == [] or sys.platform == "darwin"
print("OK")
