"""LabOrchestra-Gerät `verdi`: Coherent Verdi (Laser, RS-232) und Verdi-Chiller (ThermoTek T255P, RS-232)
in einem Gerät – mit Einschaltsequenz und Sense-Upload der Kühlwassertemperatur ("Verdi Temperatur").
Ersetzt das Gerät `verdichiller` (Verdichiller.py) und die Tk-GUI verdi_gui.py.

DeviceManager.cs:
    RegisterDevice("verdi", new PythonDevice("Devices/Verdi.py", new { laserPort = "COM18", chillerPort = "COM19" }));

Aktionen (Oberfläche: Verdi-Knopf in der Seitenleiste):
    power_on          Chiller starten -> auf Kühlwasser warten -> Schlüsselschalter prüfen -> Verdi ein.
                      Der Shutter bleibt zu (wird vorher geschlossen, falls er offen war).
    power_off         Shutter zu, Verdi aus. Der Chiller läuft weiter. Bricht auch ein laufendes power_on ab.
    shutter_open / shutter_close
    set_power(watt)   0 … MAX_POWER_W
    chiller_start / chiller_standby   (Standby nur bei ausgeschaltetem Verdi)
    poll, connect, disconnect, reconnect

Verdi-Port: wie in verdi_gui.py nur pro Abfrage offen. Jeder gelesene Status landet als Eintrag "verdi_gui" in
laser_status.json, damit LaserStatus.py den Port in Ruhe lässt (beim Beenden/disconnect wird er entfernt).
Chiller-Port: dauerhaft offen; COM20 kann nur ein Programm öffnen.
Sense: SENSE_URL / SENSE_API_KEY aus .env / .env.local im Server-Ordner (wie SenseDevice).
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

import serial

try:
    import httpx  # wie SenseDevice/Laborratte: kommt sicher durch Cloudflare
except ImportError:
    httpx = None

argv: Any
is_running: bool
send_status_update: Callable[[], None]


def _arg(name, default):
    """Parameter aus RegisterDevice(..., new { laserPort = ..., ... }); fehlt er, gilt der Standard."""
    try:
        source = argv
    except NameError:
        return default
    if source is None:
        return default
    if isinstance(source, dict):
        return source.get(name, default) or default
    return getattr(source, name, None) or default


LASER_PORT = str(_arg("laserPort", "COM18"))
CHILLER_PORT = str(_arg("chillerPort", "COM20"))
MAX_POWER_W = float(_arg("maxPower", 10.0))     # höher lässt das Gerät nicht zu
STATUS_FILE = Path(str(_arg("statusFile", os.path.join(os.getcwd(), "laser_status.json"))))

LASER_BAUD = 19200
LASER_POLL = 5          # s
CHILLER_POLL = 30       # s – dazwischen ist das Tastenfeld am Chiller frei
UPLOAD_EVERY = 60       # s
READY_K = 1.0           # Kühlwasser so nah am Sollwert, bevor der Verdi angeht
READY_TIMEOUT = 600     # s
CHILLER_START_TIMEOUT = 60
LASER_ON_TIMEOUT = 20
SENSOR_ID = "Verdi Temperatur"
HTTP_TIMEOUT = 20

LASER = {0: "OFF", 1: "ON", 2: "FAULT"}
C_ERRORS = {"1": "Prüfsummenfehler", "2": "unbekannter Befehl", "3": "Qualifier außerhalb des Bereichs"}
C_MODES = {"0": "Auto-Start", "1": "Standby", "2": "läuft", "3": "Safety Default"}
C_ALARMS = ["Füllstand", "Übertemperatur", "Untertemperatur", "Sensor", "EEPROM", "Watchdog"]

state = {
    "connected": True,          # Gerät fragt Laser und Chiller ab (disconnect gibt die Ports frei)
    "busy": False,              # Einschaltsequenz läuft
    "step": None,
    "message": None,
    "messageError": False,
    "warning": None,
    "maxPower": MAX_POWER_W,
    "laser": {"reachable": False, "port": LASER_PORT, "status": None, "power": None, "setPower": None,
              "shutterOpen": None, "keyEnabled": None, "lastRead": None, "error": None},
    "chiller": {"reachable": False, "port": CHILLER_PORT, "mode": None, "running": None, "cooling": None,
                "temperature": None, "setpoint": None, "alarms": [], "lastRead": None, "error": None},
    "sense": {"ok": None, "lastUpload": None, "error": None},
}

_laser_lock = threading.RLock()
_chiller_lock = threading.RLock()
_sequence_lock = threading.Lock()
_abort = threading.Event()
_chiller_port = None
_enabled = True
_last_upload = 0.0
_last_log = {}


class _Aborted(Exception):
    pass


def _now_ms():
    return int(time.time() * 1000)


def _log(key, message):
    """Nur Änderungen ausgeben, damit die Konsole nicht vollläuft."""
    if _last_log.get(key) != message:
        _last_log[key] = message
        if message:
            print(f"Verdi: {message}")


def _message(text, error=False):
    state["message"], state["messageError"] = text, error
    send_status_update()


def _fail(text):
    """Fehler sichtbar im Popup melden und die Aktion abbrechen."""
    _message(text, error=True)
    raise Exception(text)


# ======================================================================================
# Verdi (Laser): Befehle wie in verdi_gui.py / PyCoherentVerdi
# ======================================================================================

def _laser_session(fn):
    """Port öffnen, fn(s) ausführen, Port schließen; bei kurz belegtem Port (LaserStatus) erneut versuchen."""
    with _laser_lock:
        for attempt in range(4):
            try:
                with serial.Serial(LASER_PORT, LASER_BAUD, bytesize=8, parity="N", stopbits=1, timeout=1) as s:
                    return fn(s)
            except serial.SerialException:
                if attempt == 3:
                    raise
                time.sleep(0.5)


def _line(s):
    line = s.readline().decode("ascii", "replace").strip()
    return line or s.readline().decode("ascii", "replace").strip()   # manche Firmware schickt zuerst eine Leerzeile


def _query(s, name):
    s.reset_input_buffer()
    s.write(f"?{name}\r\n".encode("ascii"))
    answer = _line(s).replace("VERDI>", "").replace(f"?{name}", "").strip()
    if not answer or "error" in answer.lower():
        raise RuntimeError(f"?{name}: {answer or 'keine Antwort'}")
    return float(answer)


def _command(s, text):
    s.reset_input_buffer()
    s.write(f"{text}\r\n".encode("ascii"))
    answer = _line(s)
    if "error" in answer.lower():
        raise RuntimeError(f"{text}: {answer}")


def _read_laser(s):
    return {name: _query(s, name) for name in ("L", "P", "SP", "S", "K")}


def _status_file(entry):
    """Nur den Eintrag "verdi_gui" ändern, alles andere gehört LaserStatus.py (wie in verdi_gui.py)."""
    for _ in range(3):
        try:
            data = json.loads(STATUS_FILE.read_text(encoding="utf-8")) if STATUS_FILE.exists() else {}
            if entry is None:
                if "verdi_gui" not in data:
                    return
                data.pop("verdi_gui", None)
            else:
                data["verdi_gui"] = entry
            tmp = STATUS_FILE.with_name(f".{STATUS_FILE.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, STATUS_FILE)
            return
        except ValueError:
            return            # Datei unlesbar: nichts schreiben, LaserStatus kümmert sich
        except OSError:
            time.sleep(0.1)   # unter Windows kurz gesperrt, wenn LaserStatus gerade schreibt


def _apply_laser(st):
    status = int(st["L"])
    state["laser"].update(
        reachable=True, error=None, lastRead=_now_ms(),
        status=LASER.get(status, str(status)),
        power=round(st["P"], 4), setPower=round(st["SP"], 4),
        shutterOpen=int(st["S"]) == 1, keyEnabled=int(st["K"]) == 1,
    )
    _status_file({"t": time.time(), "L": st["L"], "P": st["P"], "S": st["S"]})
    _update_warning()


def _poll_laser():
    try:
        st = _laser_session(_read_laser)
        _apply_laser(st)
        _log("laser", None)
        return st
    except Exception as error:
        state["laser"].update(reachable=False, error=f"Verdi ({LASER_PORT}): {error}")
        _log("laser", state["laser"]["error"])
        return None


# ======================================================================================
# Chiller: ThermoTek-Protokoll ("." + Code + Qualifier + Prüfsumme + CR)
# ======================================================================================

def _checksum(text):
    return f"{sum(text.encode('ascii')) & 0xFF:02X}"


def _chiller_close():
    global _chiller_port
    if _chiller_port is not None:
        try:
            _chiller_port.close()
        except Exception:
            pass
    _chiller_port = None


def _chiller_ask(cmd):
    global _chiller_port
    with _chiller_lock:
        if _chiller_port is None:
            _chiller_port = serial.Serial(CHILLER_PORT, 9600, bytesize=8, parity="N", stopbits=1,
                                          xonxoff=True, timeout=2, write_timeout=2)
        port = _chiller_port
        message = "." + cmd
        port.reset_input_buffer()
        port.write((message + _checksum(message) + "\r").encode("ascii"))
        raw = port.read_until(b"\r")
        time.sleep(0.5)  # der Chiller braucht Pausen zwischen Befehlen
    text = raw.replace(b"\x11", b"").replace(b"\x13", b"").decode("ascii", "replace").strip()
    if not text.startswith("#" + cmd[0]):
        raise IOError(f"keine oder unerwartete Antwort auf .{cmd}: {raw!r}")
    body, received = text[:-2], text[-2:]
    if _checksum(body) != received.upper():
        raise IOError(f"Prüfsumme falsch: {raw!r}")
    if body[2] != "0":
        raise IOError(f".{cmd}: {C_ERRORS.get(body[2], 'Fehler ' + body[2])}")
    return body[3:]


def _poll_chiller():
    global _last_upload
    try:
        with _chiller_lock:
            status = _chiller_ask("U")
            temperature = int(_chiller_ask("I")) / 100
            setpoint = int(_chiller_ask("H0")[1:].partition(",")[0]) / 10   # "0+200,150"
            alarms = _chiller_ask("J")
    except Exception as error:
        with _chiller_lock:
            _chiller_close()   # beim nächsten Mal neu öffnen (z. B. USB-Adapter neu eingesteckt)
        state["chiller"].update(reachable=False, error=f"Chiller ({CHILLER_PORT}): {error}")
        _log("chiller", state["chiller"]["error"])
        _update_warning()
        return None

    mode = C_MODES.get(status[0], status[0])
    state["chiller"].update(
        reachable=True, error=None, lastRead=_now_ms(), mode=mode,
        running=status[0] in ("0", "2"),              # Auto-Start regelt ebenfalls aktiv auf den Sollwert
        cooling=status[2] == "1", temperature=temperature, setpoint=setpoint,
        alarms=[name for name, flag in zip(C_ALARMS, alarms) if flag == "1"],
    )
    _log("chiller", None)
    _update_warning()
    if time.monotonic() - _last_upload >= UPLOAD_EVERY - 1:
        _last_upload = time.monotonic()
        _upload(temperature)
    return state["chiller"]


def _update_warning():
    laser, chiller = state["laser"], state["chiller"]
    warning = None
    if laser["status"] == "FAULT":
        warning = "Verdi meldet FAULT"
    elif laser["status"] == "ON" and chiller["reachable"] and not chiller["running"]:
        warning = "Verdi ist an, aber der Chiller läuft nicht!"
    elif laser["status"] == "ON" and chiller["alarms"]:
        warning = "Chiller-Alarm: " + ", ".join(chiller["alarms"])
    if warning != state["warning"]:
        state["warning"] = warning
        _log("warning", warning)


# ======================================================================================
# Sense-Upload (Format wie der Pico-Logger)
# ======================================================================================

def _load_env():
    values = {}
    for folder in (os.getcwd(), os.path.dirname(os.getcwd())):
        for filename in (".env", ".env.local"):
            path = os.path.join(folder, filename)
            if not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip().strip('"').strip("'")
        if values:
            break
    for key in ("SENSE_URL", "SENSE_API_KEY"):
        if not values.get(key) and os.environ.get(key):
            values[key] = os.environ[key]
    return values


def _clean_url(raw):
    raw = (raw or "").split(" #")[0].strip()
    match = re.search(r"https?://[^\s<>()\[\]|\"']+", raw)
    url = match.group(0) if match else (f"https://{raw.strip(chr(34) + chr(39) + '<>[]() ')}" if raw else "")
    return re.split(r"/api(?:/|$)", url)[0].rstrip("/")


_env = _load_env()
SENSE_URL = _clean_url(_env.get("SENSE_URL", ""))
SENSE_API_KEY = _env.get("SENSE_API_KEY", "")
if not SENSE_URL or not SENSE_API_KEY:
    print("Verdi: SENSE_URL/SENSE_API_KEY fehlen – Kühlwassertemperatur wird nicht hochgeladen")


def _upload(temperature):
    if not SENSE_URL or not SENSE_API_KEY:
        return
    payload = {"sensors": [{"id": SENSOR_ID, "value": round(temperature, 2), "unit": "°C"}]}
    headers = {"Authorization": f"Bearer {SENSE_API_KEY}", "Accept": "application/json"}
    url = SENSE_URL + "/api/uploadSensorData"
    try:
        if httpx is not None:
            response = httpx.post(url, headers=headers, json=payload, timeout=HTTP_TIMEOUT, follow_redirects=False)
            status, text = response.status_code, response.text
        else:
            headers.update({"Content-Type": "application/json", "User-Agent": "LabOrchestra-Sense/1.0"})
            request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                    status, text = response.status, response.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as error:
                status, text = error.code, error.read().decode("utf-8", "replace")
        if status < 300:
            state["sense"].update(ok=True, lastUpload=_now_ms(), error=None)
        else:
            state["sense"].update(ok=False, error=f"HTTP {status} {text[:120]}")
    except Exception as error:
        state["sense"].update(ok=False, error=f"nicht erreichbar ({error})")
    _log("sense", None if state["sense"]["ok"] else f"Sense: {state['sense']['error']}")


# ======================================================================================
# Einschaltsequenz
# ======================================================================================

def _step(text):
    state["step"] = text
    send_status_update()


def _wait(seconds):
    if _abort.wait(seconds):
        raise _Aborted()


def _sequence_on():
    _step("Verdi prüfen …")               # erst prüfen, ob der Laser überhaupt angehen kann
    st = _poll_laser()
    if st is None:
        raise Exception(state["laser"]["error"])
    if int(st["K"]) != 1:
        raise Exception("Schlüsselschalter am Verdi steht auf off")
    if int(st["L"]) == 2:
        raise Exception("Verdi meldet FAULT – erst am Netzteil quittieren")

    _step("Chiller starten …")
    chiller = _poll_chiller()
    if chiller is None:
        raise Exception(state["chiller"]["error"])
    if not chiller["running"]:
        if _chiller_ask("G1")[:1] != "1":
            raise Exception("Chiller bestätigt den Start nicht")
        deadline = time.monotonic() + CHILLER_START_TIMEOUT
        while True:
            _wait(3)
            chiller = _poll_chiller()
            if chiller and chiller["running"]:
                break
            if time.monotonic() > deadline:
                raise Exception(f"Chiller läuft nach {CHILLER_START_TIMEOUT} s nicht (Modus {state['chiller']['mode']})")
    if chiller["alarms"]:
        raise Exception("Chiller-Alarm: " + ", ".join(chiller["alarms"]))

    deadline = time.monotonic() + READY_TIMEOUT
    while True:
        delta = chiller["temperature"] - chiller["setpoint"]
        _step(f"Warte auf Kühlwasser: {chiller['temperature']:.2f} °C, Soll {chiller['setpoint']:.1f} °C "
              f"(ΔT {delta:+.2f} K)")
        if abs(delta) <= READY_K:
            break
        if time.monotonic() > deadline:
            raise Exception(f"Kühlwasser nach {READY_TIMEOUT // 60} min nicht am Sollwert (ΔT {delta:+.2f} K)")
        _wait(5)
        chiller = _poll_chiller() or chiller

    _step("Verdi einschalten …")
    with _laser_lock:                      # power_off wartet hier – kein Einschalten nach einem Abbruch
        if _abort.is_set():
            raise _Aborted()
        st = _laser_session(_read_laser)
        _apply_laser(st)
        if int(st["K"]) != 1:
            raise Exception("Schlüsselschalter am Verdi steht auf off")
        if int(st["L"]) == 2:
            raise Exception("Verdi meldet FAULT – erst am Netzteil quittieren")
        if int(st["S"]) == 1:
            _laser_session(lambda s: _command(s, "S:0"))   # nie mit offenem Shutter einschalten
        if int(st["L"]) != 1:
            _laser_session(lambda s: _command(s, "L:1"))

    deadline = time.monotonic() + LASER_ON_TIMEOUT
    while True:
        st = _poll_laser()
        if st is not None and int(st["L"]) == 1:
            break
        if time.monotonic() > deadline:
            raise Exception(f"Verdi bestätigt EIN nicht (Status {state['laser']['status']})")
        _wait(1)
    _message("Verdi ist an – Shutter ist zu.")
    print("Verdi: eingeschaltet (Chiller läuft, Shutter zu)")


def power_on():
    """Aktion: Chiller starten, auf Kühlwasser warten, Verdi einschalten. Läuft im Hintergrund."""
    if not _enabled:
        _fail("Verdi ist getrennt – erst verbinden")
    if not _sequence_lock.acquire(blocking=False):
        _fail("Einschalten läuft bereits")
    _abort.clear()
    state.update(busy=True, step=None, message=None, messageError=False)
    send_status_update()

    def run():
        try:
            _sequence_on()
        except _Aborted:
            _message("Einschalten abgebrochen.")
        except Exception as error:
            _message(f"Einschalten fehlgeschlagen: {error}", error=True)
            print(f"Verdi: Einschalten fehlgeschlagen: {error}")
        finally:
            state.update(busy=False, step=None)
            _sequence_lock.release()
            send_status_update()

    threading.Thread(target=run, name="verdi-power-on", daemon=True).start()


def power_off():
    """Aktion: Shutter zu, Verdi aus (Chiller läuft weiter). Bricht ein laufendes Einschalten ab."""
    _abort.set()
    try:
        with _laser_lock:
            st = _laser_session(_read_laser)
            if int(st["S"]) == 1:
                _laser_session(lambda s: _command(s, "S:0"))
            _laser_session(lambda s: _command(s, "L:0"))
    except Exception as error:
        _fail(f"Ausschalten fehlgeschlagen: {error}")
    st = _poll_laser()
    if st is not None and int(st["L"]) == 0:
        _message("Verdi ist aus. Der Chiller läuft weiter.")
        print("Verdi: ausgeschaltet")
    else:
        _fail(f"Verdi meldet nach dem Ausschalten {state['laser']['status']}")


def shutter_open():
    """Aktion: Shutter öffnen (nur bei eingeschaltetem Verdi)."""
    st = _poll_laser()
    if st is None:
        _fail(state["laser"]["error"])
    if int(st["L"]) != 1:
        _fail("Verdi ist nicht an – Shutter bleibt zu")
    _set_shutter(1)


def shutter_close():
    """Aktion: Shutter schließen."""
    _set_shutter(0)


def _set_shutter(value):
    def run(s):
        _command(s, f"S:{value}")
        reported = None
        for _ in range(5):                 # mechanischer Shutter: kurz nachfragen, bis er den neuen Zustand meldet
            reported = int(_query(s, "S"))
            if reported == value:
                break
            time.sleep(0.2)
        return reported
    try:
        reported = _laser_session(run)
    except Exception as error:
        _fail(f"Shutter: {error}")
    _poll_laser()
    if reported != value:
        _fail("Shutter meldet " + ("offen" if reported == 1 else "zu") + " – Interlock/Fehler prüfen")
    _message("Shutter offen." if value else "Shutter zu.")


def set_power(watt):
    """Aktion: Ausgangsleistung in W setzen (0 … MAX_POWER_W)."""
    watt = float(watt)
    if not 0 <= watt <= MAX_POWER_W:
        _fail(f"Leistung muss zwischen 0 und {MAX_POWER_W:g} W liegen")

    def run(s):
        _command(s, f"P:{watt:6.4f}")
        return _query(s, "SP")
    try:
        reported = _laser_session(run)
    except Exception as error:
        _fail(f"Leistung: {error}")
    _poll_laser()
    if abs(reported - watt) > 0.01:
        _fail(f"{watt:.3f} W gesetzt, Verdi meldet {reported:.3f} W")
    _message(f"Leistung {reported:.3f} W gesetzt.")


def chiller_start():
    """Aktion: Chiller starten (Run)."""
    try:
        echo = _chiller_ask("G1")
    except Exception as error:
        _fail(f"Chiller: {error}")
    if echo[:1] != "1":
        _fail("Chiller bestätigt den Start nicht")
    _poll_chiller()
    _message("Chiller läuft.")


def chiller_standby():
    """Aktion: Chiller auf Standby – nur bei ausgeschaltetem Verdi."""
    st = _poll_laser()
    if st is None:
        _fail("Verdi-Status unbekannt – Chiller bleibt an")
    if int(st["L"]) != 0:
        _fail("Erst den Verdi ausschalten – Chiller bleibt an")
    try:
        echo = _chiller_ask("G0")
    except Exception as error:
        _fail(f"Chiller: {error}")
    if echo[:1] != "0":
        _fail("Chiller bestätigt Standby nicht")
    _poll_chiller()
    _message("Chiller im Standby.")


# ======================================================================================
# Verbindung, Abfrage, Snapshot
# ======================================================================================

def poll():
    """Aktion: Laser und Chiller sofort abfragen."""
    if _enabled:
        _poll_laser()
        _poll_chiller()
    send_status_update()


def connect():
    """Aktion: Abfragen wieder aufnehmen."""
    global _enabled
    _enabled = True
    state["connected"] = True
    poll()


def disconnect():
    """Aktion: Ports freigeben (Chiller-Port schließen; LaserStatus fragt den Verdi wieder selbst)."""
    global _enabled
    _enabled = False
    _abort.set()
    with _chiller_lock:
        _chiller_close()
    _status_file(None)
    state["connected"] = False
    state["laser"]["reachable"] = state["chiller"]["reachable"] = False
    send_status_update()
    print("Verdi: getrennt")


def reconnect():
    """Aktion: Chiller-Port schließen und neu öffnen, alles neu abfragen."""
    with _chiller_lock:
        _chiller_close()
    connect()


def on_save_snapshot():
    laser, chiller = state["laser"], state["chiller"]
    return {
        "laser": laser["status"], "power": laser["power"], "setPower": laser["setPower"],
        "shutterOpen": laser["shutterOpen"],
        "chillerTemperature": chiller["temperature"], "chillerSetpoint": chiller["setpoint"],
        "chillerMode": chiller["mode"],
    }


def main():
    next_laser = next_chiller = 0.0
    while is_running:
        now = time.monotonic()
        if _enabled and now >= next_laser:
            next_laser = now + LASER_POLL
            _poll_laser()
            send_status_update()
        if _enabled and now >= next_chiller:
            next_chiller = now + CHILLER_POLL
            _poll_chiller()
            send_status_update()
        time.sleep(0.5)
    _abort.set()
    _status_file(None)
    with _chiller_lock:
        _chiller_close()
