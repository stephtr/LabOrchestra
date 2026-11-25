from pfeiffer_turbo import TM700
import threading
import time
import json
import os
import re
import urllib.request
import urllib.parse
import urllib.error


state = {
    "channels": [
        {
            "name": "Turbo 2 (COM7)",
            "status": "initializing",
            "isRunning": False,
            "actualSpeed": 0,
            "targetSpeed": 0,
            "current": 0.0,
            "power": 0,
            "voltage": 0.0,
            "operatingHours": 0,
            "errorCode": "000000",
            "standby": False
        },
        {
            "name": "Turbo 1 (COM8)",
            "status": "initializing",
            "isRunning": False,
            "actualSpeed": 0,
            "targetSpeed": 0,
            "current": 0.0,
            "power": 0,
            "voltage": 0.0,
            "operatingHours": 0,
            "errorCode": "000000",
            "standby": False
        }
    ]
}

pumps = [None, None]
global_pump_lock = threading.Lock()
error_counts = [0, 0]
read_counters = [0, 0]

PUMP_CONFIGS = [
    {"com_port": "COM7", "address": 1},
    {"com_port": "COM8", "address": 1}
]


# ── Slack-Fernsteuerung: Konfiguration ─────────────────────────────────────────
# Token und Channel-ID kommen aus .env.local. Gesucht wird im Arbeitsverzeichnis der App
# und in allen Ordnern darüber. Liegt die Datei woanders, hier den absoluten Pfad eintragen:
ENV_FILE = ""   # z.B. r"C:\Users\florian\LabApp\.env.local"

# Akzeptierte Schlüsselnamen in .env.local (der erste gefundene gewinnt)
TOKEN_KEYS = ("SLACK_BOT_TOKEN", "SLACK_TOKEN", "BOT_TOKEN")
CHANNEL_KEYS = ("SLACK_CHANNEL_ID", "SLACK_CHANNEL", "CHANNEL_ID")


def _find_env_file(name=".env.local"):
    if ENV_FILE:
        return ENV_FILE if os.path.isfile(ENV_FILE) else None
    starts = [os.getcwd()]
    if "__file__" in globals():                      # nur gesetzt, wenn C# es übergibt
        starts.insert(0, os.path.dirname(os.path.abspath(__file__)))
    for d in starts:
        while True:
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
    return None


def _read_env_file(path):
    env = {}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip()
            if key.startswith("export "):
                key = key[7:].strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            else:
                val = val.split(" #", 1)[0].strip()   # Kommentar am Zeilenende
            env[key] = val
    return env


def _first(env, keys):
    for k in keys:
        if env.get(k):
            return env[k]
    return ""


try:
    ENV_PATH = _find_env_file()
    _ENV = _read_env_file(ENV_PATH) if ENV_PATH else {}
except Exception as e:                                # kaputte .env.local darf die Pumpen nicht blockieren
    print(f"Slack: .env.local nicht lesbar: {e}")
    ENV_PATH, _ENV = None, {}

SLACK_BOT_TOKEN = _first(_ENV, TOKEN_KEYS) or _first(os.environ, TOKEN_KEYS)
SLACK_CHANNEL_ID = _first(_ENV, CHANNEL_KEYS) or _first(os.environ, CHANNEL_KEYS)
SLACK_POLL_S = 3.0                 # 20 Requests/min, internes App-Limit (Tier 3) liegt bei 50+/min
WATCH_TIMEOUT_S = 60 * 60          # max. Wartezeit auf "steht" / "Solldrehzahl erreicht"

# Per Slack steuerbare Pumpen: COM7 = Kanal 0 (klein), COM8 = Kanal 1 (groß)
SLACK_PUMP_ALIASES = {
    "small turbopump": 0,
    "small turbo": 0,
    "turbo 2": 0,
    "com7": 0,
    "large turbopump": 1,
    "large turbo": 1,
    "turbo 1": 1,
    "com8": 1,
}
# "bot status druck" beantwortet dieses Skript mit dem Text aus pressure.py
DRUCK_WOERTER = {"druck", "pressure", "vakuum"}
CMD_RE = re.compile(r"^\s*bot\s+(start|stop|status)(?:\s+(.+?))?\s*[.!]?\s*$", re.IGNORECASE)


def main():
    for channel in range(2):
        connect_pump(channel)
        time.sleep(1)

    # Slack-Poller erst nach dem Verbinden starten, damit kein Befehl ins Leere läuft
    threading.Thread(target=slack_loop, name="slack", daemon=True).start()

    while is_running:
        if pumps[0]:
            update_pump_state(0)
        time.sleep(0.1)
        if pumps[1]:
            update_pump_state(1)
        send_status_update()
        time.sleep(0.4)


def connect_pump(channel):
    global pumps
    config = PUMP_CONFIGS[channel]
    try:
        state["channels"][channel]["status"] = "connecting"
        send_status_update()
        with global_pump_lock:
            pumps[channel] = TM700.from_serial(config["com_port"], address=config["address"])
            time.sleep(0.2)
        state["channels"][channel]["status"] = "connected"
        send_status_update()
        print(f"Pump {channel} connected on {config['com_port']}")
    except Exception as e:
        state["channels"][channel]["status"] = f"error: {str(e)}"
        send_status_update()
        print(f"Pump {channel} connection error: {e}")


def safe_read_with_retry(pump, attr, retries=3):
    for attempt in range(retries):
        try:
            value = getattr(pump, attr)
            return value, True
        except Exception as e:
            if "Checksum" in str(e) and attempt < retries - 1:
                time.sleep(0.05)
                continue
            return None, False
    return None, False


def update_pump_state(channel):
    global error_counts, read_counters
    try:
        with global_pump_lock:
            pump = pumps[channel]
            ch = state["channels"][channel]

            speed, ok = safe_read_with_retry(pump, 'actual_spd')
            if not ok:
                error_counts[channel] += 1
                return
            time.sleep(0.05)

            current, ok = safe_read_with_retry(pump, 'drv_current')
            if not ok:
                error_counts[channel] += 1
                return
            time.sleep(0.05)

            power, ok = safe_read_with_retry(pump, 'drv_power')
            if not ok:
                error_counts[channel] += 1
                return
            time.sleep(0.05)

            is_pump_running, ok = safe_read_with_retry(pump, 'pumpg_statn')
            if not ok:
                error_counts[channel] += 1
                return
            time.sleep(0.05)

            read_counters[channel] += 1
            if read_counters[channel] % 10 == 0:
                voltage, _ = safe_read_with_retry(pump, 'drv_voltage')
                op_hours, _ = safe_read_with_retry(pump, 'op_hrs_pump')
                error_code, _ = safe_read_with_retry(pump, 'error_code')
                standby, _ = safe_read_with_retry(pump, 'standby')
                target_speed, _ = safe_read_with_retry(pump, 'set_rot_spd')

                if voltage is not None: ch["voltage"] = float(voltage)
                if op_hours is not None: ch["operatingHours"] = int(op_hours)
                if error_code is not None: ch["errorCode"] = str(error_code)
                if standby is not None: ch["standby"] = bool(standby)
                if target_speed is not None: ch["targetSpeed"] = int(target_speed)

            ch["isRunning"] = bool(is_pump_running)
            ch["actualSpeed"] = int(speed)
            ch["current"] = float(current)
            ch["power"] = int(power)

            if ch["errorCode"] != "000000":
                ch["status"] = f"error: {ch['errorCode']}"
            elif ch["isRunning"]:
                ch["status"] = "running"
            elif ch["standby"]:
                ch["status"] = "standby"
            else:
                ch["status"] = "stopped"

            error_counts[channel] = max(0, error_counts[channel] - 1)

    except Exception as e:
        error_counts[channel] += 1
        if error_counts[channel] % 10 == 1:
            print(f"Pump {channel} update error: {e}")


# ── Actions ────────────────────────────────────────────────────────────────────

def start_pump(channel):
    channel = int(channel)
    if channel < 0 or channel >= len(pumps):
        raise Exception("Invalid channel")
    if not pumps[channel]:
        raise Exception(f"Pump {channel} not connected")
    with global_pump_lock:
        pump = pumps[channel]
        pump.pumpg_statn = True
        time.sleep(0.15)
        state["channels"][channel]["isRunning"] = bool(pump.pumpg_statn)
    send_status_update()


def stop_pump(channel):
    channel = int(channel)
    if channel < 0 or channel >= len(pumps):
        raise Exception("Invalid channel")
    if not pumps[channel]:
        raise Exception(f"Pump {channel} not connected")
    with global_pump_lock:
        pump = pumps[channel]
        pump.pumpg_statn = False
        time.sleep(0.15)
        state["channels"][channel]["isRunning"] = bool(pump.pumpg_statn)
    send_status_update()


def set_speed(channel, speed):
    channel = int(channel)
    speed = float(speed)
    if channel < 0 or channel >= len(pumps):
        raise Exception("Invalid channel")
    if not pumps[channel]:
        raise Exception(f"Pump {channel} not connected")
    if speed < 0 or speed > 1500:
        raise ValueError("Speed must be 0-1500 Hz")
    with global_pump_lock:
        pump = pumps[channel]
        pump.set_rot_spd = int(speed)
        time.sleep(0.15)
        state["channels"][channel]["targetSpeed"] = int(pump.set_rot_spd)
    send_status_update()


def set_standby(channel, enable):
    channel = int(channel)
    enable = bool(enable)
    if channel < 0 or channel >= len(pumps):
        raise Exception("Invalid channel")
    if not pumps[channel]:
        raise Exception(f"Pump {channel} not connected")
    with global_pump_lock:
        pump = pumps[channel]
        pump.standby = enable
        time.sleep(0.15)
        state["channels"][channel]["standby"] = bool(pump.standby)
    send_status_update()


def emergency_stop(channel):
    channel = int(channel)
    if channel < 0 or channel >= len(pumps):
        raise Exception("Invalid channel")
    if not pumps[channel]:
        raise Exception(f"Pump {channel} not connected")
    with global_pump_lock:
        pump = pumps[channel]
        pump.pumpg_statn = False
        time.sleep(0.1)
        pump.standby = False
        time.sleep(0.1)
    state["channels"][channel]["status"] = "emergency_stopped"
    state["channels"][channel]["isRunning"] = False
    send_status_update()


def get_details(channel):
    channel = int(channel)
    if channel < 0 or channel >= len(pumps):
        raise Exception("Invalid channel")
    if not pumps[channel]:
        raise Exception(f"Pump {channel} not connected")
    with global_pump_lock:
        pump = pumps[channel]
        return {
            "name": state["channels"][channel]["name"],
            "status": state["channels"][channel]["status"],
            "actualSpeed": int(pump.actual_spd),
            "targetSpeed": int(pump.set_rot_spd),
            "current": float(pump.drv_current),
            "power": int(pump.drv_power),
            "voltage": float(pump.drv_voltage),
            "operatingHours": int(pump.op_hrs_pump),
            "errorCode": str(pump.error_code),
            "standby": bool(pump.standby),
        }


# ── Slack-Fernsteuerung ────────────────────────────────────────────────────────
# Hinweis: die C#-Seite überschreibt print() mit Console.WriteLine(string),
# daher hier nur print(f"...") mit genau einem String-Argument.

def _slack_api(method, params, post=False):
    url = f"https://slack.com/api/{method}"
    headers = {"Authorization": f"Bearer {SLACK_BOT_TOKEN}"}
    if post:
        headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=json.dumps(params).encode(), headers=headers)
    else:
        req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 429:  # Rate limit: Retry-After respektieren
            time.sleep(int(e.headers.get("Retry-After", "5")))
        return {"ok": False, "error": f"http_{e.code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def slack_post(text, thread_ts=None):
    params = {"channel": SLACK_CHANNEL_ID, "text": text}
    if thread_ts:
        params["thread_ts"] = thread_ts
    r = _slack_api("chat.postMessage", params, post=True)
    if not r.get("ok"):
        print(f"Slack post failed: {r.get('error')}")


def _status_text(ch):
    c = state["channels"][ch]
    return (f"{c['name']}: {c['status']}, {c['actualSpeed']}/{c['targetSpeed']} Hz, "
            f"{c['power']} W, {c['current']:.2f} A, Fehlercode {c['errorCode']}")


def druck_status() -> str:
    """Fertigen Text aus pressure.py holen (state["summary"]) und auf hängende Daten prüfen."""
    try:
        st = get_device_state("pressure")
        text, ts = st["summary"], st["timestamp"]
    except KeyError:
        return "Druck: pressure.py liefert noch keinen summary – neue Version auf dem Server einspielen."
    except Exception as e:
        return f"Druck nicht lesbar ({e!r})."
    if not text or ts is None:
        return "Druck: noch keine Messwerte."
    alter = time.time() - float(ts)
    if alter > 30:
        text += f"\n⚠️ Letzte Messung vor {alter:.0f} s – Gauge/Kabel prüfen."
    return text


def handle_slack_command(text, user):
    """None, wenn die Nachricht kein Befehl ist; sonst (Antworttext, Watch oder None)."""
    m = CMD_RE.match(text or "")
    if not m:
        return None
    cmd, target = m.group(1).lower(), (m.group(2) or "").lower()

    if cmd == "status" and not target:          # "bot status": alle Pumpen + Druck
        return "\n".join([_status_text(c) for c in range(len(pumps))] + [druck_status()]), None
    if not target:                              # "bot start" / "bot stop" ohne Pumpe: ignorieren
        return None
    if cmd == "status" and target in DRUCK_WOERTER:
        return druck_status(), None

    ch = SLACK_PUMP_ALIASES.get(target)
    if ch is None:
        return (f"Unbekannte Pumpe '{target}'. Bekannt: {', '.join(sorted(SLACK_PUMP_ALIASES))} "
                f"(Druck: bot status druck)"), None

    name = state["channels"][ch]["name"]
    try:
        if cmd == "start":
            start_pump(ch)
            return f"{name}: Start gesendet, fährt hoch …", ("start", ch)
        if cmd == "stop":
            stop_pump(ch)
            return f"{name}: Stop gesendet, fährt herunter …", ("stop", ch)
        return _status_text(ch), None
    except Exception as e:
        return f"{name}: Fehler – {e}", None


def _check_watch(w):
    """Meldet im Thread, wenn die Pumpe steht bzw. Solldrehzahl erreicht. True = erledigt."""
    c = state["channels"][w["ch"]]
    if c["status"].startswith("error"):
        slack_post(f"{c['name']}: {c['status']} – bitte prüfen.", w["ts"])
        return True
    if w["kind"] == "stop" and c["actualSpeed"] == 0:
        slack_post(f"{c['name']}: steht (0 Hz).", w["ts"])
        return True
    if w["kind"] == "start" and c["targetSpeed"] > 0 and c["actualSpeed"] >= 0.98 * c["targetSpeed"]:
        slack_post(f"{c['name']}: Solldrehzahl erreicht ({c['actualSpeed']} Hz).", w["ts"])
        return True
    if time.time() - w["t0"] > WATCH_TIMEOUT_S:
        slack_post(f"{c['name']}: nach {WATCH_TIMEOUT_S // 60} min noch {c['actualSpeed']} Hz – bitte prüfen.", w["ts"])
        return True
    return False


def slack_loop():
    if not SLACK_BOT_TOKEN.startswith("xoxb-") or not SLACK_CHANNEL_ID:
        src = ENV_PATH or f".env.local nicht gefunden (gesucht ab {os.getcwd()})"
        print(f"Slack: Fernsteuerung deaktiviert – Bot-Token oder Channel-ID fehlt. "
              f"Quelle: {src}; Schlüssel darin: {', '.join(sorted(_ENV)) or '-'}")
        if SLACK_BOT_TOKEN.startswith("https://hooks.slack.com"):
            print("Slack: das ist eine Webhook-URL – gebraucht wird das Bot-Token (xoxb-...)")
        return
    print(f"Slack: Fernsteuerung aktiv (Konfiguration aus {ENV_PATH or 'Umgebungsvariablen'})")
    last_ts = f"{time.time():.6f}"   # nur Nachrichten ab jetzt – alte Befehle nach Neustart nicht nachspielen
    watches = {}
    last_err = None
    while is_running:
        try:
            r = _slack_api("conversations.history",
                           {"channel": SLACK_CHANNEL_ID, "oldest": last_ts, "limit": 50})
            if not r.get("ok"):
                if r.get("error") != last_err:   # jeden Fehler nur einmal loggen
                    print(f"Slack history error: {r.get('error')}")
                    last_err = r.get("error")
            else:
                last_err = None
                for msg in reversed(r.get("messages", [])):   # API liefert neueste zuerst
                    last_ts = max(last_ts, msg["ts"], key=float)
                    if msg.get("bot_id") or msg.get("subtype"):
                        continue
                    res = handle_slack_command(msg.get("text", ""), msg.get("user", ""))
                    if res is None:
                        continue
                    reply, watch = res
                    print(f"Slack: '{msg.get('text', '')}' von {msg.get('user')} -> {reply}")
                    slack_post(reply, msg["ts"])
                    if watch:
                        kind, ch = watch
                        watches[ch] = {"kind": kind, "ch": ch, "ts": msg["ts"], "t0": time.time()}

            for ch in [c for c, w in watches.items() if _check_watch(w)]:
                del watches[ch]
        except Exception as e:
            print(f"Slack loop error: {e}")
        time.sleep(SLACK_POLL_S)
