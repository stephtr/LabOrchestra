"""
Laser-Status parallel an zwei Stellen:
  - Slack: eine gepinnte Nachricht, die ueberschrieben wird (wie bisher)
  - Webseite im Labornetz: erst nachdem das Werbevideo (WERBEVIDEO) im Browser bis zum Ende gelaufen ist,
    danach FREISCHALTUNG_S lang offen und aktualisiert sich selbst. Der Server prueft die Laufzeit selbst
    (Start/Ende gegen die Videolaenge), Ueberspringen im Browser reicht nicht.
Faellt eines aus (Slack weg, .env fehlt, Port belegt), laeuft das andere weiter.

Das Skript ist komplett unabhaengig von der Laborratte und den Laborskripten. Solange ein Steuerskript laeuft, spricht es
den Laser nie an, ein Skript mit Dauerkontakt (Detuning, LIAD ...) wird also nicht gestoert.

  Antwortet ein Laser nicht auf Ping     -> "aus oder nicht erreichbar", das schlaegt alles andere
  Laeuft ein Skript aus ALLE_AN_SKRIPTE  -> alle Laser "an" (laut Skript, nicht gemessen)
  Laeuft ein Skript des Lasers           -> dieser Laser "an" (laut Skript, nicht gemessen)
  NKT, Ping ok, kein Skript              -> Emission direkt lesen
  Innolas, GUI laeuft, kein Skript       -> GET_LASER_STATE und GET_SHUTTER_STATE ueber die SpitLight-Fernsteuerung
  Innolas mit "gui", Ping ok, kein Skript   -> dieselben zwei Befehle ueber das Netz an die GUI auf dem anderen Rechner
  Verdi, GUI laeuft                      -> Stand aus dem Eintrag "verdi_gui" in ZUSTAND_DATEI, den verdi_gui.py schreibt; COM-Port bleibt unberuehrt
  Verdi, kein Skript                     -> ?L, ?P und ?S ueber den COM-Port; der Port ist nur fuer diese Abfrage offen
  Sonst                                  -> "unbekannt"

Die direkten Abfragen laufen je in einem eigenen kurzen Prozess mit Timeout, lesen nur und trennen sofort wieder.
lib/Innolas.py wird bewusst nicht benutzt: Ihr __exit__ schaltet die Pumpe aus und schliesst den Shutter.

Einbau:    als Geraet im Laborserver, startet und stoppt mit ihm: server\\Devices\\LaserStatus.py, eingetragen wie particleName.
           Webseite: http://<Laborserver>:WEB_PORT/  (Windows-Firewall: eingehend TCP WEB_PORT fuer den Server erlauben)
Von Hand:  python LaserStatus.py                 Statusschleife + Webseite, bis Strg+C
           python LaserStatus.py --prozesse      zeigt die erkannten Skripte (zum Eintragen der Namen unten)
           python LaserStatus.py --einmal        ein Durchlauf, schreibt nur auf die Konsole
           python LaserStatus.py --nkt-lesen 192.168.0.221   liest nur die Emission dieses NKT
           python LaserStatus.py --innolas-lesen             liest nur den Zustand des Innolas an diesem Rechner
           python LaserStatus.py --innolas-lesen 192.168.0.12:1027   liest nur den Zustand des zweiten Innolas
           python LaserStatus.py --verdi-lesen COM11         liest nur Laser, Leistung und Shutter des Verdi
Pakete:    im Python des Servers: psutil slack_sdk python-decouple; in dem Python, das die Abfragen startet: pyserial.
           Webserver: Standardbibliothek.
.env:      SLACK_TOKEN (wie Laborratte), SLACK_CHANNEL_LASER, fuer den Uni-Webspace LASER_WEB_TOKEN (wie PUSH_TOKEN
           in _intern/config.php); Datei ueber LASER_ENV waehlbar, Standard .env.local im Server-Ordner
Bot-Rechte: chat:write, pins:write; der Bot muss im Kanal sein.
Video:     WERBEVIDEO (mp4, H.264/AAC spielt in jedem Browser). Laenge wird aus der Datei gelesen, sonst WERBUNG_DAUER_S.
"""
import argparse
import html
import http.cookies
import http.server
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

# Vom Laborserver gesetzt (wie bei particleName); von Hand gestartet gibt es sie nicht.
argv: any
is_running: bool
get_device_state: callable
send_status_update: callable

state = {"laser": [], "stand": ""}        # sichtbar ueber experiment["laserStatus"].get_state()


def get_settings():
    return state


def load_settings(settings):
    pass                                  # nichts zu laden: Der Stand wird jede Minute neu ermittelt

# ---------------- Einstellungen ----------------
# Teile des Skriptnamens, Gross-/Kleinschreibung egal. adresse=None: nicht im LAN, kein Ping.
ALLE_AN_SKRIPTE = []            # laeuft eines davon, laeuft alles
LASER = [
    {"name": "NKTn: 1550 nm D LB4 ", "typ": "nkt", "adresse": "192.168.0.220", "skripte": ["LIAD","nkt locking"]},
    {"name": "NKTo: 1550 nm D LB4", "typ": "nkt", "adresse": "192.168.0.221", "skripte": ["old nkt locking"]},
    {"name": "InnoLas: 532 nm + 1064 nm D LB3 R LB6", "typ": "innolas", "adresse": None, "skripte": ["LIAD"], "programm": "SpitlightGUI.exe"},
    # adresse = der Laser selbst (Ping), gui = Rechner:Port der SpitlightGUI, die ihn steuert
    {"name": "InnoLas 2: 532 nm + 1064 nm D LB3 R LB6", "typ": "innolas", "adresse": "192.168.12.223", "gui": "192.168.0.12:1027", "skripte": []},
    {"name": "Verdi: 532 nm D LB6 ", "typ": "verdi", "adresse": None, "skripte": [], "com": "COM18"},
]
TAKT_S = 60                               # so oft pruefen
LEBENSZEICHEN_S = 60                      # Slack-Nachricht spaetestens nach dieser Zeit neu schreiben, so bleibt der Stand aktuell
PING_TIMEOUT_MS = 1000
PING_VERSUCHE = 3                         # erst so viele Fehlschlaege in Folge gelten als "nicht erreichbar"
ZUSTAND_DATEI = "laser_status.json"       # Text oder Path; Stand fuer andere Programme, merkt sich auch die Slack-Nachricht
# Webseite
WEB_HOST = "0.0.0.0"                      # alle Netzwerkkarten; "127.0.0.1" = nur dieser Rechner
WEB_PORT = 8080                           # None = lokale Seite aus (z.B. wenn nur der Uni-Webspace genutzt wird)
WERBEVIDEO = r"C:\Users\Cavity\Desktop\werbung.mp4"   # Text oder Path; nur fuer die lokale Seite (Port 8080)
WERBUNG_DAUER_S = None                    # None = aus der mp4 lesen; sonst feste Mindestdauer in s
FREISCHALTUNG_S = 15 * 60                 # so lange bleibt die Statusseite nach dem Video offen
OHNE_WERBUNG_IPS = ["192.168.0.90"]       # diese Rechner sehen den Status ohne Video: .90 = E-Ink-Anzeige an der Tuer
SEITE_AKTUALISIEREN_S = 10                # Statusseite holt sich so oft den neuen Stand

# Uni-Webspace: Stand jeden Takt per HTTPS hinschicken (Schluessel LASER_WEB_TOKEN aus der .env.local).
WEBSPACE_PUSH_URL = " https://laserstatus.univie.ac.at/push/"                    # HIER deinen Hostnamen: "https://<hostname>.univie.ac.at/push/"; "" = aus
WEBSPACE_TIMEOUT_S = 10

# NKT-Abfrage. Eigener Host-Port (die Steuerskripte nutzen 10001), damit ein Steuerskript seinen Port frei vorfindet.
CONTROL_PFAD = r"C:\Users\Cavity\Projekte\cavity-tools\Control"   # Ordner mit lib/NKTP_DLL.py
NKT_HOST_IP = "192.168.0.1"
NKT_HOST_PORT = 10011
NKT_PORT = 10001
NKT_GERAET, NKT_REG_EMISSION = 128, 0x30   # wie set_emission in lib/NKT.py
NKT_TIMEOUT_S = 10                        # haengt die Abfrage laenger, wird ihr Prozess beendet

# Innolas-Abfrage: Es werden nur die beiden festen Lesebefehle aus _KIND gesendet
INNOLAS_PORT = 1025
INNOLAS_ADRESSE = ("127.0.0.1", INNOLAS_PORT)   # Innolas ohne "gui" im LASER-Block: die GUI auf diesem Rechner
INNOLAS_TIMEOUT_S = 2
# Anfang des Werts von LASER_STATE -> Lampchen. Alles andere bleibt "unbekannt" und wird im Klartext angezeigt.
# Beobachtet: READY.PcOnShutterOff (Lampe aus), EMISSION.PcOnShutterOn (Lampe an).
INNOLAS_AUS = ("READY","MAINS_ON")
INNOLAS_AN = ("EMISSION",)

# Verdi-Abfrage: Es werden nur die festen Anfragen ?L, ?P und ?S aus _KIND gesendet
VERDI_BAUD = 19200
VERDI_TIMEOUT_S = 1                       # je Antwort
VERDI_LASER = {0: "aus", 1: "an", 2: "fehler"}
VERDI_DATEI_MAX_ALTER_S = 30              # aelter: GUI laeuft nicht mehr, also selbst abfragen

SYMBOL = {"an": ":large_green_circle:", "aus": ":black_circle:", "unbekannt": ":white_circle:", "weg": ":red_circle:",
          "fehler": ":red_circle:"}
WORT = {"an": "on", "aus": "off", "unbekannt": "unknown", "weg": "off or unreachable", "fehler": "fault"}


def log(text):
    print(f"{datetime.now():%H:%M:%S} {text}")     # im Server nimmt print genau einen Text, ohne flush=


# ---------------- Beobachten, ohne die Laser anzufassen ----------------
def laufende_skripte():
    """Dateinamen aller laufenden .py-Skripte, ausser diesem hier."""
    import psutil
    gefunden = set()
    for p in psutil.process_iter(["pid", "cmdline"]):
        if p.info["pid"] == os.getpid():
            continue
        for arg in p.info["cmdline"] or []:
            if arg.lower().endswith(".py"):
                gefunden.add(Path(arg.replace("\\", "/")).name)
                break
    return sorted(gefunden)


def laufende_programme():
    import psutil
    return {(p.info["name"] or "").lower() for p in psutil.process_iter(["name"])}


# Laeuft im eigenen Prozess (python -c), braucht also keinen Dateipfad und nur die Standardbibliothek plus lib/NKTP_DLL.py.
# Nur Lesen: registerRead beim NKT, die zwei festen GET-Befehle beim Innolas. lib/NKT.py und lib/Innolas.py werden nicht benutzt.
_KIND = r"""
import json, socket, sys, time


def nkt(adresse, cfg):
    sys.path.insert(0, cfg["control"])
    import lib.NKTP_DLL as d
    name = "LaserStatus"
    d.pointToPointPortAdd(name, d.pointToPointPortData(cfg["host_ip"], cfg["host_port"], adresse, cfg["port"], 1, 100))
    try:
        d.openPorts(name, 0, 0)
        for versuch in range(3):
            code, wert = d.registerReadU8(name, cfg["geraet"], cfg["register"], -1)
            if code == 0:
                print(json.dumps({"emission": int(wert)}))
                return
            time.sleep(0.2)
        print(json.dumps({"fehler": "register error %s" % code}))
    finally:
        d.closePorts(name)
        d.pointToPointPortDel(name)


def _innolas_zeile(s, puffer, erwartet, frist):
    # Die GUI schickt auch von sich aus Messwerte (z. B. MEASURED_OSCILLATOR_AMPLITUDE=...). Die werden uebersprungen,
    # bis die Antwort auf die eigene Anfrage kommt. Rueckgabe: Zeile, Rest des Puffers. Zeile leer = keine Antwort in der Frist.
    ende = time.time() + frist
    while True:
        while b"\n" in puffer:
            zeile, puffer = puffer.split(b"\n", 1)
            text = zeile.decode("ascii", "replace").strip()
            if text.startswith(erwartet) or text.startswith("REMOTE_IF_"):
                return text, puffer
        rest = ende - time.time()
        if rest <= 0:
            return "", puffer
        s.settimeout(rest)
        try:
            neu = s.recv(1024)
        except socket.timeout:
            return "", puffer
        if not neu:
            return "", puffer
        puffer += neu


def innolas(cfg, adresse=None):
    if adresse:
        rechner, _, port = adresse.partition(":")
        ziel = (rechner, int(port or cfg["innolas"][1]))
    else:
        ziel = tuple(cfg["innolas"])
    frist = cfg["innolas_timeout"]
    antworten, puffer = [], b""
    with socket.create_connection(ziel, timeout=frist) as s:
        for befehl, erwartet in ((b"GET_LASER_STATE\n", "LASER_STATE="), (b"GET_SHUTTER_STATE\n", "SHUTTER_STATE=")):
            s.sendall(befehl)
            zeile, puffer = _innolas_zeile(s, puffer, erwartet, frist)
            antworten.append(zeile)
    print(json.dumps({"laser": antworten[0], "shutter": antworten[1]}))


def verdi(com, cfg):
    import serial
    werte = {}
    with serial.Serial(com, cfg["verdi_baud"], bytesize=8, parity="N", stopbits=1, timeout=cfg["verdi_timeout"]) as s:
        for frage in ("L", "P", "S"):
            s.reset_input_buffer()
            s.write(b"?" + frage.encode("ascii") + b"\r\n")
            antwort = s.readline().decode("ascii", "replace").strip()
            if not antwort:                      # manche Firmware schickt zuerst eine Leerzeile
                antwort = s.readline().decode("ascii", "replace").strip()
            werte[frage] = antwort.replace("VERDI>", "").replace("?" + frage, "").strip()
    print(json.dumps(werte))


if __name__ == "__main__":
    cfg = json.loads(sys.argv[1])
    if sys.argv[2] == "nkt":
        nkt(sys.argv[3], cfg)
    elif sys.argv[2] == "verdi":
        verdi(sys.argv[3], cfg)
    else:
        innolas(cfg, sys.argv[3] if len(sys.argv) > 3 else None)
"""


def _kind_cfg():
    return {"control": CONTROL_PFAD, "host_ip": NKT_HOST_IP, "host_port": NKT_HOST_PORT, "port": NKT_PORT, "geraet": NKT_GERAET,
            "register": NKT_REG_EMISSION, "innolas": list(INNOLAS_ADRESSE), "innolas_timeout": INNOLAS_TIMEOUT_S,
            "verdi_baud": VERDI_BAUD, "verdi_timeout": VERDI_TIMEOUT_S}


def _kind_direkt(funktion, *argumente):
    """Fuer --nkt-lesen und --innolas-lesen: dieselben Lesefunktionen im aktuellen Prozess."""
    ns = {"__name__": "kind"}
    exec(_KIND, ns)
    ns[funktion](*argumente, _kind_cfg())


def nkt_lesen(adresse):
    _kind_direkt("nkt", adresse)


def innolas_lesen(adresse=None):
    ns = {"__name__": "kind"}
    exec(_KIND, ns)
    ns["innolas"](_kind_cfg(), adresse)


def verdi_lesen(com):
    _kind_direkt("verdi", com)


def _python_finden():
    """Im C#-Server ist sys.executable der Server selbst und darf nie gestartet werden."""
    kandidaten = []
    if Path(sys.executable or "").stem.lower().startswith("python"):
        kandidaten.append(Path(sys.executable))
    for basis in dict.fromkeys(p for p in (sys.prefix, sys.base_prefix, sys.exec_prefix) if p):
        kandidaten += [Path(basis) / "python.exe", Path(basis) / "bin" / "python3"]
    for name in ("python", "python3"):
        gefunden = shutil.which(name)
        if gefunden and "windowsapps" not in gefunden.lower():
            kandidaten.append(Path(gefunden))
    gefunden = next((str(k) for k in kandidaten if k.is_file()), None)
    if gefunden is None:
        raise OSError("kein python.exe gefunden")
    return gefunden


def _kindprozess(argumente, timeout):
    """Eigener Prozess mit Timeout: Ein Haenger kann das Skript nicht blockieren. Rueckgabe (Antwort, Fehlertext)."""
    extra = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    try:
        r = subprocess.run([_python_finden(), "-c", _KIND, json.dumps(_kind_cfg()), *argumente], capture_output=True, text=True,
                           timeout=timeout, cwd=CONTROL_PFAD if os.path.isdir(CONTROL_PFAD) else None, **extra)
    except subprocess.TimeoutExpired:
        return None, f"query aborted after {timeout} s"
    except OSError as e:
        return None, f"could not start query: {e}"
    try:
        return json.loads(r.stdout.strip().splitlines()[-1]), ""
    except (IndexError, ValueError):
        letzte = (r.stderr or "").strip().splitlines()
        return None, "query failed: " + (letzte[-1][:120] if letzte else f"Exit {r.returncode}")


def nkt_abfragen(adresse):
    """Rueckgabe (zustand, grund)."""
    antwort, fehler = _kindprozess(["nkt", adresse], NKT_TIMEOUT_S)
    if antwort is None:
        return "unbekannt", fehler
    if "emission" not in antwort:
        return "unbekannt", "query failed: " + str(antwort.get("fehler"))
    return ("an", "emission read") if antwort["emission"] else ("aus", "emission read")


def innolas_abfragen(adresse=None):
    """Rueckgabe (zustand, grund). Der gelesene Zustand steht immer im Klartext dabei."""
    antwort, fehler = _kindprozess(["innolas", *([adresse] if adresse else [])], 2 * INNOLAS_TIMEOUT_S + 8)
    if antwort is None:
        return "unbekannt", fehler
    laser, shutter = antwort.get("laser", ""), antwort.get("shutter", "")
    if not laser.startswith("LASER_STATE="):
        return "unbekannt", "remote interface reports: " + (laser or "no reply")
    wert = laser.split("=", 1)[1]
    grund = wert + (", Shutter " + shutter.split("=", 1)[1] if shutter.startswith("SHUTTER_STATE=") else "")
    if wert.startswith(INNOLAS_AN) and INNOLAS_AN:
        return "an", grund
    if wert.startswith(INNOLAS_AUS):
        return "aus", grund
    return "unbekannt", grund


def _verdi_auswerten(werte, zusatz=""):
    """Rueckgabe (zustand, grund). Leistung und Shutter stehen als Klartext dabei."""
    try:
        z = VERDI_LASER[int(float(werte.get("L", "")))]
    except (KeyError, TypeError, ValueError):
        return "unbekannt", f"unexpected reply to ?L: {werte.get('L')!r}"
    teile = []
    try:
        teile.append(f"{float(werte.get('P', '')):.2f} W")
    except (TypeError, ValueError):
        pass
    try:
        teile.append({0: "shutter closed", 1: "shutter open"}[int(float(werte.get("S", "")))])
    except (KeyError, TypeError, ValueError):
        pass
    if zusatz:
        teile.append(zusatz)
    return z, ", ".join(teile) or "laser state read"


def verdi_abfragen(com):
    antwort, fehler = _kindprozess(["verdi", com], 6 * VERDI_TIMEOUT_S + 8)
    if antwort is None:
        return "unbekannt", fehler
    return _verdi_auswerten(antwort)


def verdi_von_gui():
    """Frischer Stand von verdi_gui.py oder None. Kaputte oder alte Datei: None, dann wird selbst gefragt."""
    try:
        werte = zustand_laden()["verdi_gui"]
        if abs(time.time() - float(werte["t"])) > VERDI_DATEI_MAX_ALTER_S:
            return None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return _verdi_auswerten(werte, "via Verdi GUI")


def ping(adresse):
    """Nur ICMP, keine Verbindung zum Steuerport. Windows meldet auch bei "Zielhost nicht erreichbar" Exit 0, daher TTL."""
    if sys.platform == "win32":
        befehl, extra = ["ping", "-n", "1", "-w", str(PING_TIMEOUT_MS), adresse], {"creationflags": subprocess.CREATE_NO_WINDOW}
    else:
        befehl, extra = ["ping", "-c", "1", "-W", str(max(1, PING_TIMEOUT_MS // 1000)), adresse], {}
    try:
        r = subprocess.run(befehl, capture_output=True, timeout=PING_TIMEOUT_MS / 1000 + 5, **extra)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return b"TTL=" in r.stdout.upper()


def _treffer(muster, skripte):
    return [s for s in skripte if any(m.lower() in s.lower() for m in muster)]


def bewerten(skripte, erreichbar):
    """skripte: laufende Skriptnamen; erreichbar: {adresse: bool}. Rueckgabe: je Laser name, zustand, grund."""
    alle_an = _treffer(ALLE_AN_SKRIPTE, skripte)
    programme = None
    ergebnis = []
    for laser in LASER:
        adr = laser["adresse"]
        eigene = _treffer(laser["skripte"], skripte)
        if adr and not erreichbar.get(adr, True):
            z, grund = "weg", f"no ping reply, {adr}"
        elif eigene or alle_an:
            z, grund = "an", "per " + ", ".join(eigene or alle_an)
        elif laser.get("typ") == "nkt":
            jetzt = _treffer(laser["skripte"] + ALLE_AN_SKRIPTE, laufende_skripte())   # direkt vor der Abfrage noch einmal
            z, grund = ("an", "per " + ", ".join(jetzt)) if jetzt else nkt_abfragen(adr)
        elif laser.get("typ") == "verdi":
            jetzt = _treffer(laser["skripte"] + ALLE_AN_SKRIPTE, laufende_skripte())
            von_gui = verdi_von_gui()
            if jetzt:
                z, grund = "an", "per " + ", ".join(jetzt)
            else:
                z, grund = von_gui or verdi_abfragen(laser["com"])
        elif laser.get("typ") == "innolas":
            programme = laufende_programme() if programme is None else programme
            jetzt = _treffer(laser["skripte"] + ALLE_AN_SKRIPTE, laufende_skripte())
            if jetzt:
                z, grund = "an", "per " + ", ".join(jetzt)
            elif laser.get("gui"):
                z, grund = innolas_abfragen(laser["gui"])   # GUI auf einem anderen Rechner
            elif laser["programm"].lower() not in programme:
                z, grund = "unbekannt", laser["programm"] + " not running"
            else:
                z, grund = innolas_abfragen()
        elif adr:
            z, grund = "unbekannt", "no control script active, reachable on LAN"
        else:
            z, grund = "unbekannt", "no control script active, not on LAN"
        ergebnis.append({"name": laser["name"], "zustand": z, "grund": grund})
    return ergebnis


def nachricht(laser, stand):
    """Text der Slack-Nachricht (auch fuer --einmal)."""
    zeilen = [f"*Lasers* (as of {stand:%d.%m. %H:%M})"]
    zeilen += [f"{SYMBOL[x['zustand']]} *{x['name'].strip()}*: {WORT[x['zustand']]} ({x['grund']})" for x in laser]
    return "\n".join(zeilen)


# ---------------- Zustand und Slack ----------------
def zustand_laden():
    try:
        return json.loads(Path(ZUSTAND_DATEI).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def zustand_speichern(daten):
    fd, tmp = tempfile.mkstemp(dir=str(Path(ZUSTAND_DATEI).resolve().parent), prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(daten, f, indent=1, ensure_ascii=False)
        for versuch in range(3):              # unter Windows kurz gesperrt, wenn die Verdi-GUI gerade schreibt
            try:
                os.replace(tmp, Path(ZUSTAND_DATEI))
                break
            except PermissionError:
                if versuch == 2:
                    raise
                time.sleep(0.1)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def slack_schreiben(client, kanal, text, zustand):
    """Vorhandene Nachricht ueberschreiben, sonst einmal neu posten und pinnen."""
    from slack_sdk.errors import SlackApiError
    if zustand.get("slack_ts") and zustand.get("kanal") == kanal:
        try:
            client.chat_update(channel=kanal, ts=zustand["slack_ts"], text=text)
            return
        except SlackApiError as e:
            if e.response.get("error") != "message_not_found":
                raise
            log("Pinned message is gone, posting a new one")
    r = client.chat_postMessage(channel=kanal, text=text)
    zustand.update(slack_ts=r["ts"], kanal=kanal)
    try:
        client.pins_add(channel=kanal, timestamp=r["ts"])
    except SlackApiError as e:
        log(f"Pinning failed ({e.response.get('error')}): is pins:write missing?")


def slack_verbinden():
    """Rueckgabe (client, kanal) oder (None, None): Ohne Slack laeuft nur die Webseite."""
    try:
        from decouple import Config, RepositoryEnv
        from slack_sdk import WebClient
        env = Config(RepositoryEnv(os.environ.get("LASER_ENV", ".env.local")))
        return WebClient(token=env("SLACK_TOKEN")), env("SLACK_CHANNEL_LASER")
    except Exception as e:
        log(f"LaserStatus: Slack off ({e!r}), web page only")
        return None, None


def webspace_verbinden():
    """Rueckgabe (url, token) oder None, wenn WEBSPACE_PUSH_URL leer ist oder der Schluessel fehlt."""
    if not WEBSPACE_PUSH_URL:
        return None
    try:
        from decouple import Config, RepositoryEnv
        token = Config(RepositoryEnv(os.environ.get("LASER_ENV", ".env.local")))("LASER_WEB_TOKEN")
    except Exception as e:
        log(f"LaserStatus: Uni webspace off, LASER_WEB_TOKEN missing ({e!r})")
        return None
    return WEBSPACE_PUSH_URL, token


def webspace_senden(web, laser, stand):
    """Stand per POST an push/index.php auf dem Uni-Webspace."""
    import urllib.request
    url, token = web
    daten = json.dumps({"laser": laser, "stand": stand}).encode("utf-8")
    anfrage = urllib.request.Request(url, data=daten, method="POST", headers={
        "Content-Type": "application/json", "X-Laser-Token": token, "User-Agent": "LaserStatus"})
    with urllib.request.urlopen(anfrage, timeout=WEBSPACE_TIMEOUT_S) as r:
        if r.status >= 300:
            raise RuntimeError(f"webspace replied {r.status}")


class Pings:
    """Ein einzelner verlorener Ping soll keinen Alarm geben. Hat ein Geraet noch nie geantwortet, gilt es sofort als weg."""

    def __init__(self):
        self.fehler = {}
        self.gesehen = set()

    def pruefen(self):
        erreichbar = {}
        for laser in LASER:
            adr = laser["adresse"]
            if adr:
                if ping(adr):
                    self.fehler[adr] = 0
                    self.gesehen.add(adr)
                else:
                    self.fehler[adr] = self.fehler.get(adr, 0) + 1
                erreichbar[adr] = adr in self.gesehen and self.fehler[adr] < PING_VERSUCHE
        return erreichbar


def durchlauf(client, kanal, zustand, pings, jetzt=None, web=None):
    """Ein Takt: neuen Stand ermitteln, fuer die lokale Webseite bereitstellen, an den Uni-Webspace (web = (url, token)),
    nach Slack (nur bei Aenderung oder faelligem Lebenszeichen) und in ZUSTAND_DATEI.
    Faellt Slack oder der Webspace aus, laufen die anderen Wege trotzdem."""
    jetzt = jetzt or datetime.now()
    laser = bewerten(laufende_skripte(), pings.pruefen())
    geaendert = laser != zustand.get("laser")
    if geaendert:
        log("; ".join(f"{x['name']}: {x['zustand']} ({x['grund']})" for x in laser))
    zustand.update(laser=laser, stand=jetzt.strftime("%Y-%m-%d %H:%M:%S"))
    state.update(laser=laser, stand=zustand["stand"])            # Webseite und experiment["laserStatus"]
    if geaendert and callable(globals().get("send_status_update")):
        send_status_update()
    fehler = []
    if web is not None:
        try:
            webspace_senden(web, laser, zustand["stand"])
        except Exception as e:                    # Netz oder Webspace weg: beim naechsten Takt wieder versuchen
            fehler.append(f"webspace: {e!r}")
    if client is not None:
        faellig = jetzt.timestamp() - zustand.get("slack_t", 0) >= LEBENSZEICHEN_S
        if geaendert or faellig or not zustand.get("slack_ts"):
            try:
                slack_schreiben(client, kanal, nachricht(laser, jetzt), zustand)
                zustand["slack_t"] = jetzt.timestamp()
            except Exception as e:                # Netz oder Slack weg: beim naechsten Takt wieder versuchen
                fehler.append(f"Slack: {e!r}")
    gui = zustand_laden().get("verdi_gui")        # gehoert verdi_gui.py: nicht mit einem alten Stand ueberschreiben
    zustand.pop("verdi_gui", None)
    if gui is not None:
        zustand["verdi_gui"] = gui
    zustand_speichern(zustand)
    if fehler:
        raise RuntimeError(" | ".join(fehler))


# ---------------- Webseite mit Werbevideo davor ----------------
def mp4_dauer(pfad):
    """Laenge eines mp4/mov in s aus dem mvhd-Block, ohne Zusatzpakete. None, wenn nicht lesbar."""
    try:
        with open(pfad, "rb") as f:
            def boxen(ende):
                while f.tell() + 8 <= ende:
                    start = f.tell()
                    groesse, typ = struct.unpack(">I4s", f.read(8))
                    kopf = 8
                    if groesse == 1:
                        groesse, kopf = struct.unpack(">Q", f.read(8))[0], 16
                    elif groesse == 0:
                        groesse = ende - start
                    if groesse < kopf:
                        return
                    yield typ, start + kopf, start + groesse
                    f.seek(start + groesse)

            for typ, a, b in boxen(os.fstat(f.fileno()).st_size):
                if typ == b"moov":
                    f.seek(a)
                    for typ2, a2, _ in boxen(b):
                        if typ2 == b"mvhd":
                            f.seek(a2)
                            if f.read(4)[0] == 1:
                                f.read(16)
                                skala, dauer = struct.unpack(">IQ", f.read(12))
                            else:
                                f.read(8)
                                skala, dauer = struct.unpack(">II", f.read(8))
                            return dauer / skala if skala else None
    except (OSError, struct.error, IndexError):
        pass
    return None


def werbung_dauer():
    if WERBUNG_DAUER_S is not None:
        return float(WERBUNG_DAUER_S)
    return mp4_dauer(Path(WERBEVIDEO))


_SITZUNGEN = {}                           # sid -> {"start": t oder None, "bis": t, "angelegt": t}
_SITZUNGEN_LOCK = threading.Lock()

_STIL = """
:root { --bg:#f6f5f2; --karte:#ffffff; --text:#1b1b1a; --leise:#6b6a66; --rand:#e2e0da;
        --an:#2e9e3e; --aus:#3b3b3a; --weg:#c8371d; --unbekannt:#ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161615; --karte:#1f1f1e; --text:#ecebe7; --leise:#a3a29d; --rand:#34332f; --aus:#8d8c87; --unbekannt:#1f1f1e; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:760px; margin:0 auto; padding:28px 16px 48px; }
h1 { font-size:22px; margin:0 0 4px; }
.leise { color:var(--leise); font-size:14px; }
.karte { background:var(--karte); border:1px solid var(--rand); border-radius:10px; padding:16px; margin-top:16px; }
video { width:100%; border-radius:8px; background:#000; display:block; }
button { font:inherit; padding:10px 18px; border-radius:8px; border:1px solid var(--rand);
         background:var(--text); color:var(--bg); cursor:pointer; margin-top:12px; }
button:disabled { opacity:.45; cursor:default; }
.balken { height:6px; background:var(--rand); border-radius:3px; margin-top:12px; overflow:hidden; }
.balken > div { height:100%; width:0; background:var(--an); transition:width .25s linear; }
.zeile { display:grid; grid-template-columns:18px 1fr auto; gap:10px; align-items:start; padding:10px 0;
         border-top:1px solid var(--rand); }
.zeile:first-child { border-top:0; }
.punkt { width:14px; height:14px; border-radius:50%; margin-top:4px; border:1.5px solid var(--leise); }
.an { background:var(--an); border-color:var(--an); } .aus { background:var(--aus); border-color:var(--aus); }
.weg, .fehler { background:var(--weg); border-color:var(--weg); } .unbekannt { background:var(--unbekannt); }
.name { font-weight:600; } .wort { font-weight:600; white-space:nowrap; }
.warnung { background:#fff3cd; color:#5c4400; border-radius:8px; padding:10px 12px; margin-top:16px; display:none; }
"""

_SEITE_WERBUNG = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Laser status</title><style>{stil}</style></head>
<body><main>
<h1>Laser status</h1>
<div class="leise">A short message first. The status unlocks when the video has finished.</div>
<div class="karte">
  <video id="v" src="/video" playsinline preload="auto" disablepictureinpicture controlslist="nodownload noplaybackrate"></video>
  <div class="balken"><div id="b"></div></div>
  <button id="los">&#9654; Play</button> <span class="leise" id="rest"></span>
</div>
</main>
<script>
const v = document.getElementById("v"), los = document.getElementById("los");
const b = document.getElementById("b"), rest = document.getElementById("rest");
let weit = 0, gestartet = false;
v.addEventListener("contextmenu", e => e.preventDefault());
los.onclick = async () => {{
  if (!gestartet) {{ gestartet = true; await fetch("/start", {{method: "POST"}}); }}
  v.play(); los.disabled = true; los.textContent = "Playing ...";
}};
v.addEventListener("pause", () => {{ if (!v.ended) {{ los.disabled = false; los.textContent = "\\u25B6 Continue"; }} }});
v.addEventListener("ratechange", () => {{ if (v.playbackRate !== 1) v.playbackRate = 1; }});
v.addEventListener("timeupdate", () => {{
  if (v.currentTime > weit + 1) {{ v.currentTime = weit; return; }}     // kein Vorspulen
  weit = Math.max(weit, v.currentTime);
  if (v.duration) {{ b.style.width = (100 * weit / v.duration) + "%";
                     rest.textContent = Math.ceil(v.duration - weit) + " s"; }}
}});
v.addEventListener("ended", async () => {{
  rest.textContent = "Checking ...";
  const r = await fetch("/fertig", {{method: "POST"}});
  if (r.ok) location.href = "/status";
  else {{ rest.textContent = await r.text(); weit = 0; v.currentTime = 0; los.disabled = false; los.textContent = "\\u25B6 Play again"; }}
}});
v.addEventListener("error", () => {{ rest.textContent = "Video could not be loaded."; los.disabled = true; }});
</script></body></html>"""

_SEITE_STATUS = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Laser status</title><style>{stil}</style></head>
<body><main>
<h1>Laser status</h1>
<div class="leise" id="stand">loading ...</div>
<div class="warnung" id="alt"></div>
<div class="karte" id="liste"></div>
<div class="leise" style="margin-top:12px" id="frei"></div>
</main>
<script>
const WORT = {wort};
function zeile(x) {{
  const z = document.createElement("div"); z.className = "zeile";
  const p = document.createElement("div"); p.className = "punkt " + x.zustand;
  const t = document.createElement("div");
  const n = document.createElement("div"); n.className = "name"; n.textContent = x.name.trim();
  const g = document.createElement("div"); g.className = "leise"; g.textContent = x.grund;
  t.append(n, g);
  const w = document.createElement("div"); w.className = "wort"; w.textContent = WORT[x.zustand] || x.zustand;
  z.append(p, t, w); return z;
}}
async function holen() {{
  const r = await fetch("/status.json", {{cache: "no-store"}});
  if (r.status === 403) {{ location.href = "/"; return; }}
  const d = await r.json();
  document.getElementById("liste").replaceChildren(...d.laser.map(zeile));
  document.getElementById("stand").textContent = d.stand ? "As of " + d.stand : "No status yet";
  const alt = document.getElementById("alt");
  alt.style.display = d.alter_s > 3 * d.takt_s ? "block" : "none";
  alt.textContent = "This status is " + Math.round(d.alter_s / 60) + " min old. Is LaserStatus still running?";
  document.getElementById("frei").textContent = d.frei_s === null ? "" :
      "Unlocked for another " + Math.max(0, Math.ceil(d.frei_s / 60)) + " min.";
}}
holen(); setInterval(holen, {takt_ms});
</script></body></html>"""


class _Web(http.server.BaseHTTPRequestHandler):
    server_version = "LaserStatus"

    def log_message(self, *args):         # nichts nach stderr (im Server ohnehin nicht sichtbar)
        pass

    def _sid(self):
        c = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        sid = c["laser_sid"].value if "laser_sid" in c else None
        return sid if sid in _SITZUNGEN else None

    def _frei_s(self):
        """Restliche Freischaltung in s; None = ohne Werbung erlaubt (IP); <= 0 = gesperrt."""
        if self.client_address[0] in OHNE_WERBUNG_IPS:
            return None
        sid = self._sid()
        return (_SITZUNGEN[sid]["bis"] - time.time()) if sid else 0.0

    def _senden(self, code, inhalt, typ="text/html; charset=utf-8", kopf=()):
        daten = inhalt.encode("utf-8") if isinstance(inhalt, str) else inhalt
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(daten)))
        self.send_header("Cache-Control", "no-store")
        for k, v in kopf:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(daten)

    def _weiter(self, ziel):
        self.send_response(303)
        self.send_header("Location", ziel)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        pfad = self.path.split("?", 1)[0]
        frei = self._frei_s()
        offen = frei is None or frei > 0
        if pfad == "/":
            if offen:
                return self._weiter("/status")
            sid = self._sid()
            kopf = []
            if sid is None:
                sid = secrets.token_urlsafe(24)
                with _SITZUNGEN_LOCK:
                    jetzt = time.time()
                    for alt in [k for k, s in _SITZUNGEN.items() if jetzt - s["angelegt"] > 86400]:
                        del _SITZUNGEN[alt]
                    _SITZUNGEN[sid] = {"start": None, "bis": 0.0, "angelegt": jetzt}
                kopf.append(("Set-Cookie", f"laser_sid={sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400"))
            else:
                _SITZUNGEN[sid]["start"] = None   # neuer Anlauf: Video muss wieder ganz laufen
            return self._senden(200, _SEITE_WERBUNG.format(stil=_STIL), kopf=kopf)
        if pfad == "/video":
            return self._video()
        if pfad == "/status":
            if not offen:
                return self._weiter("/")
            return self._senden(200, _SEITE_STATUS.format(stil=_STIL, wort=json.dumps(WORT),
                                                          takt_ms=int(SEITE_AKTUALISIEREN_S * 1000)))
        if pfad == "/status.json":
            if not offen:
                return self._senden(403, "watch the video first", "text/plain; charset=utf-8")
            stand = dict(state)
            try:
                alter = time.time() - datetime.strptime(stand["stand"], "%Y-%m-%d %H:%M:%S").timestamp()
            except (KeyError, ValueError):
                alter = None
            return self._senden(200, json.dumps({"laser": stand.get("laser", []), "stand": stand.get("stand", ""),
                                                 "alter_s": alter, "takt_s": TAKT_S, "frei_s": frei}),
                                "application/json; charset=utf-8")
        return self._senden(404, "not found", "text/plain; charset=utf-8")

    do_HEAD = do_GET

    def do_POST(self):
        pfad = self.path.split("?", 1)[0]
        sid = self._sid()
        if sid is None:
            return self._senden(403, "no session, reload the page", "text/plain; charset=utf-8")
        s = _SITZUNGEN[sid]
        jetzt = time.time()
        if pfad == "/start":
            if s["start"] is None:
                s["start"] = jetzt
            return self._senden(204, b"", "text/plain")
        if pfad == "/fertig":
            dauer = werbung_dauer()
            if dauer is None:
                return self._senden(500, "video length unknown, set WERBUNG_DAUER_S", "text/plain; charset=utf-8")
            if s["start"] is None or jetzt - s["start"] < 0.97 * dauer - 1:
                s["start"] = None
                return self._senden(403, "The video has to run to the end. Please watch it again.",
                                    "text/plain; charset=utf-8")
            s["start"], s["bis"] = None, jetzt + FREISCHALTUNG_S
            return self._senden(204, b"", "text/plain")
        return self._senden(404, "not found", "text/plain; charset=utf-8")

    def _video(self):
        """Video mit Range-Anfragen (Browser springen in mp4-Dateien)."""
        try:
            groesse = Path(WERBEVIDEO).stat().st_size
        except OSError:
            return self._senden(404, "video missing", "text/plain; charset=utf-8")
        start, ende, code = 0, groesse - 1, 200
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].strip().partition("-")
            try:
                if a:
                    start, ende = int(a), (int(b) if b else groesse - 1)
                else:
                    start = max(0, groesse - int(b))
            except ValueError:
                start, ende = 0, groesse - 1
            ende = min(ende, groesse - 1)
            if start > ende:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{groesse}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        typ = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}.get(
            Path(WERBEVIDEO).suffix.lower(), "application/octet-stream")
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(ende - start + 1))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{ende}/{groesse}")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(Path(WERBEVIDEO), "rb") as f:
                f.seek(start)
                rest = ende - start + 1
                while rest > 0:
                    stueck = f.read(min(65536, rest))
                    if not stueck:
                        break
                    self.wfile.write(stueck)
                    rest -= len(stueck)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass                          # Browser hat abgebrochen (normal beim Springen)


def web_starten():
    """Webserver im eigenen Thread. Rueckgabe: Server oder None (dann laeuft nur die Statusschleife)."""
    if not WEB_PORT:
        log("LaserStatus: local web page off (WEB_PORT = None)")
        return None
    video = Path(WERBEVIDEO)
    if not video.is_file():
        log(f"LaserStatus: video {video.resolve()} missing - the status page stays locked")
    elif werbung_dauer() is None:
        log("LaserStatus: video length not readable - set WERBUNG_DAUER_S")
    try:
        server = http.server.ThreadingHTTPServer((WEB_HOST, WEB_PORT), _Web)
    except OSError as e:
        log(f"LaserStatus: web page not started ({e!r}) - is port {WEB_PORT} in use?")
        return None
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="LaserStatusWeb", daemon=True).start()
    dauer = werbung_dauer()
    log(f"LaserStatus: web page on http://{socket.gethostname()}:{WEB_PORT}/ "
        f"(video {dauer:.0f} s)" if dauer else f"LaserStatus: web page on http://{socket.gethostname()}:{WEB_PORT}/")
    return server


def _laeuft():
    return globals().get("is_running", True)   # von Hand gestartet: bis Strg+C


def main():
    """Einstieg des Laborservers, von Hand ueber cli()."""
    client, kanal = slack_verbinden()
    web = webspace_verbinden()
    zustand, pings = zustand_laden(), Pings()
    zustand.pop("slack_t", None)                  # nach einem Neustart sofort neu schreiben
    try:
        server = web_starten()
    except Exception as e:                    # Webseite kaputt: Slack und Statusschleife laufen trotzdem
        log(f"LaserStatus: web page not started: {e!r}")
        server = None
    log(f"LaserStatus: running, every {TAKT_S} s" + (f", Slack channel {kanal}" if client else "")
        + (f", Uni webspace {web[0]}" if web else ""))
    letzter_fehler = None
    try:
        while _laeuft():
            try:
                durchlauf(client, kanal, zustand, pings, web=web)
                letzter_fehler = None
            except Exception as e:                # Slack weg, Datei gesperrt ...: beim naechsten Takt wieder versuchen
                if repr(e) != letzter_fehler:     # gleichen Fehler nur einmal ausgeben
                    log(f"LaserStatus: {e!r}")
                    letzter_fehler = repr(e)
            for _ in range(TAKT_S):               # Stopp des Servers innerhalb einer Sekunde
                if not _laeuft():
                    return
                time.sleep(1)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


def cli():
    ap = argparse.ArgumentParser(description="Laser-Status als gepinnte Slack-Nachricht und als Webseite (mit Werbevideo davor)")
    ap.add_argument("--prozesse", action="store_true", help="erkannte Skripte anzeigen")
    ap.add_argument("--einmal", action="store_true", help="ein Durchlauf, nur Konsole")
    ap.add_argument("--nkt-lesen", metavar="ADRESSE", help="nur die Emission dieses NKT lesen")
    ap.add_argument("--innolas-lesen", nargs="?", const="", metavar="ADRESSE", help="nur den Zustand eines Innolas lesen")
    ap.add_argument("--verdi-lesen", metavar="COM", help="nur Laser, Leistung und Shutter des Verdi lesen")
    args = ap.parse_args()
    if args.nkt_lesen:
        nkt_lesen(args.nkt_lesen)
    elif args.innolas_lesen is not None:
        innolas_lesen(args.innolas_lesen or None)
    elif args.verdi_lesen:
        verdi_lesen(args.verdi_lesen)
    elif args.prozesse:
        print("\n".join(laufende_skripte()) or "No .py scripts found.")
    elif args.einmal:
        pings = Pings()
        for _ in range(PING_VERSUCHE):
            erreichbar = pings.pruefen()
        print(nachricht(bewerten(laufende_skripte(), erreichbar), datetime.now()))
    else:
        try:
            main()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__" and "is_running" not in globals():
    cli()
