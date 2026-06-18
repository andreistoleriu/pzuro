"""
notify_telegram.py
-------------------
Trimite un rezumat zilnic pe Telegram cu preturile PZU pentru ziua urmatoare,
imediat dupa ce fetch_prices.py le-a scris. Ruleaza ca pas SEPARAT in
workflow (nu in fetch_prices.py), ca responsabilitatile sa ramana clare:
fetch_prices.py aduce datele, notify_telegram.py le anunta.

De ce exista marker-ul last_notified.txt:
Workflow-ul are doua ferestre de rulare pe zi (principala + rezerva), ca
plasa de siguranta daca OPCOM publica cu intarziere. Daca prima rulare
prinde deja datele de maine si trimite notificarea, a doua rulare (de
rezerva) NU trebuie sa trimita aceeasi notificare a doua oara -- marker-ul
retine pentru ce zi am notificat deja, ca sa nu spamam canalul de doua ori.

Daca TELEGRAM_BOT_TOKEN sau TELEGRAM_CHAT_ID nu sunt setate (secrete
neconfigurate inca), scriptul iese curat, fara eroare -- notificarile sunt
o functionalitate optionala, absenta lor nu trebuie sa puna pipeline-ul pe
rosu in Actions.
"""

import json
import logging
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("notify_telegram")

DATA_DIR = Path(__file__).parent / "data"
PRICES_FILE = DATA_DIR / "prices.json"
MARKER_FILE = DATA_DIR / "last_notified.txt"


def negative_windows(intervals):
    """Grupeaza intervalele consecutive cu pret negativ in ferestre distincte
    -- o zi poate avea mai multe ferestre separate (ex. dimineata si
    dupa-amiaza), nu presupunem un singur bloc continuu."""
    windows = []
    start = None
    end = None
    for iv in intervals:
        if iv["is_negative"]:
            if start is None:
                start = iv["start"]
            end = iv["end"]
        elif start is not None:
            windows.append((start, end))
            start = None
    if start is not None:
        windows.append((start, end))
    return windows


def fmt_time(iso_str):
    return iso_str[11:16]


def fmt_interval(iv):
    return f"{fmt_time(iv['start'])} — {iv['price_ron_kwh']:.3f} lei/kWh"


def build_message(tomorrow: dict) -> str:
    cheap = tomorrow["cheapest_intervals"][:3]
    pricy = tomorrow["priciest_intervals"][:3]
    neg_windows = negative_windows(tomorrow["intervals"])

    lines = [f"📅 Prețuri PZU pentru {tomorrow['date']}", ""]
    lines.append(f"Medie: {tomorrow['avg_ron_kwh']:.3f} lei/kWh")
    lines.append("")
    lines.append("🟢 Cele mai ieftine ore:")
    lines += [f"  {fmt_interval(i)}" for i in cheap]
    lines.append("")
    lines.append("🔴 Cele mai scumpe ore:")
    lines += [f"  {fmt_interval(i)}" for i in pricy]

    if neg_windows:
        lines.append("")
        lines.append("⚡ Preț negativ (energie gratuită) între:")
        for start, end in neg_windows:
            lines.append(f"  {fmt_time(start)}–{fmt_time(end)}")

    lines.append("")
    lines.append("Detalii complete: https://pzuro.ro")
    return "\n".join(lines)


def send_telegram(token: str, chat_id: str, text: str):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(url, data=payload)
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status != 200:
            raise RuntimeError(f"Telegram a raspuns cu status {resp.status}")


def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        log.info("TELEGRAM_BOT_TOKEN sau TELEGRAM_CHAT_ID nu sunt setate -- notificari dezactivate.")
        return

    if not PRICES_FILE.exists():
        log.error("Nu gasesc %s -- ruleaza mai intai fetch_prices.py", PRICES_FILE)
        sys.exit(1)

    data = json.loads(PRICES_FILE.read_text())
    tomorrow = data.get("tomorrow")
    if not tomorrow:
        log.info("Preturile pentru maine nu sunt inca publicate, nimic de notificat.")
        return

    already_notified = MARKER_FILE.read_text().strip() if MARKER_FILE.exists() else ""
    if already_notified == tomorrow["date"]:
        log.info("Am notificat deja pentru %s, nu trimit a doua oara.", tomorrow["date"])
        return

    message = build_message(tomorrow)
    try:
        send_telegram(token, chat_id, message)
    except Exception as exc:  # noqa: BLE001
        log.error("Trimiterea pe Telegram a picat: %s", exc)
        sys.exit(1)

    MARKER_FILE.write_text(tomorrow["date"])
    log.info("Notificare trimisa pentru %s", tomorrow["date"])


if __name__ == "__main__":
    main()
