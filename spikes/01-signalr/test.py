import asyncio, os, time, urllib.request
from lo_client import Hub, HubError

async def get(p):
    return await asyncio.to_thread(lambda: urllib.request.urlopen("http://127.0.0.1:5199" + p, timeout=90).read().decode())

async def main():
    h = Hub("ws://127.0.0.1:5199/hub"); kinds = []
    @h.on
    def add(a, b): return a + b
    @h.on
    def boom(a, b): raise ValueError("stage jammed")
    @h.on
    async def slow(a, b): await asyncio.sleep(.1); return a
    @h.on
    def echo_bytes(d): kinds.append(type(d)); return d
    t = asyncio.create_task(h.run())
    assert await asyncio.wait_for(h.invoke("Add", 1, 2), 30) == 3
    d = os.urandom(1_000_000); r = await h.invoke("Echo", d); assert type(r) is bytes and r == d
    try: await h.invoke("Fail"); assert False
    except HubError as e: assert "boom" in str(e)
    assert "42" in await get("/call/add")
    assert "stage jammed" in await get("/call/boom")
    assert "missing" in await get("/call/missing")
    assert "True" in await get("/bytes") and kinds == [bytes]
    print("parallel:", await get("/par"))
    print("server->py->server:", await get("/lat"))
    l = []
    for i in range(5500):
        s = time.perf_counter(); await h.invoke("Add", 1, 2)
        if i >= 500: l.append((time.perf_counter() - s) * 1e3)
    l.sort(); print(f"py->server->py: p50={l[2500]:.3f} p99={l[4950]:.3f} max={l[-1]:.3f} ms")
    await get("/kick"); await asyncio.sleep(1.5)
    assert h.connects == 2 and "42" in await get("/call/add")
    t.cancel(); print("OK")
asyncio.run(main())
