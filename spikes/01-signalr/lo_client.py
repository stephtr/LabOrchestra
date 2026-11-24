import asyncio, inspect, itertools, json, msgpack, websockets
class HubError(Exception): pass
def pack(m):
    d=msgpack.packb(m); n=len(d); p=bytearray()
    while True:
        b=n&0x7f; n>>=7
        p.append(b|(0x80 if n else 0))
        if not n: return bytes(p)+d
def unpack(raw):
    o=0
    while o<len(raw):
        n=s=0
        while True:
            b=raw[o]; o+=1; n|=(b&0x7f)<<s; s+=7
            if not b&0x80: break
        yield msgpack.unpackb(raw[o:o+n],strict_map_key=False); o+=n
class Hub:
    def __init__(s,url): s.url=url; s.h={}; s.p={}; s.ids=itertools.count(1); s.connects=0; s.ready=asyncio.Event()
    def on(s,f): s.h[f.__name__]=f; return f
    async def invoke(s,t,*a):
        await s.ready.wait(); i=str(next(s.ids)); s.p[i]=f=asyncio.get_running_loop().create_future()
        await s.ws.send(pack([1,{},i,t,list(a),[]])); return await f
    async def _call(s,ws,i,t,a):
        try:
            r=s.h[t](*a)
            if inspect.isawaitable(r): r=await r
            m=[3,{},i,2] if r is None else [3,{},i,3,r]
        except Exception as e: m=[3,{},i,1,f"{type(e).__name__}: {e}"]
        if i is not None: await ws.send(pack(m))
    async def _ping(s,ws):
        while True: await asyncio.sleep(10); await ws.send(pack([6]))
    async def run(s):
        while True:
            try:
                async with websockets.connect(s.url,max_size=None,compression=None) as ws:
                    await ws.send(json.dumps({"protocol":"messagepack","version":1})+"\x1e")
                    raw=await ws.recv(); raw=raw.encode() if isinstance(raw,str) else raw
                    hs,rest=raw.split(b"\x1e",1)
                    if json.loads(hs).get("error"): raise HubError(hs)
                    s.ws=ws; s.connects+=1; s.ready.set(); ping=asyncio.create_task(s._ping(ws)); tasks=set()
                    try:
                        for m in unpack(rest): s._msg(ws,m,tasks)
                        async for raw in ws:
                            for m in unpack(raw): s._msg(ws,m,tasks)
                    finally: ping.cancel()
            except (OSError,websockets.WebSocketException): pass
            s.ready.clear()
            for f in s.p.values(): f.done() or f.set_exception(HubError("connection lost"))
            s.p.clear(); await asyncio.sleep(.2)
    def _msg(s,ws,m,tasks):
        if m[0]==1:
            t=asyncio.create_task(s._call(ws,m[2],m[3],m[4])); tasks.add(t); t.add_done_callback(tasks.discard)
        elif m[0]==3 and (f:=s.p.pop(m[2],None)):
            f.set_exception(HubError(m[4])) if m[3]==1 else f.set_result(m[4] if m[3]==3 else None)
