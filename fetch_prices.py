"""
fetch_prices.py
----------------
Pipeline zilnic pzuro.app: preia preturile PZU (Piata pentru Ziua Urmatoare)
pentru zona de licitare Romania de pe ENTSO-E Transparency Platform,
le converteste din EUR/MWh in lei/kWh si scrie:

  - data/prices.json   -> starea curenta (azi + maine), folosita de portal
  - data/history.json  -> istoric zilnic (medie/min/max), ultimele ~60 de zile

Rulat zilnic prin GitHub Actions (vezi .github/workflows/fetch-prices.yml).

EDGE CASES tratate explicit (vezi comentarii inline mai jos):
  1. Ora de iarna/vara -> o zi poate avea 92, 96 sau 100 de intervale de 15 min,
     NU presupunem niciodata exact 96.
  2. Preturile de maine pot sa nu fie inca publicate cand ruleaza job-ul
     (OPCOM publica in jurul orei 13:00 iarna / 14:00 vara, ora Romaniei,
     care corespunde aceluiasi moment UTC fix -> de-aia cron-ul e in UTC,
     vezi workflow-ul YAML). Tratam absenta gratios, nu crapam pipeline-ul.
  3. Curs valutar EUR->RON poate sa nu fie disponibil -> fallback pe o
     valoare implicita, cu flag clar in output ca sa nu inducem in eroare.
  4. Preturi negative (surplus solar/eolian) -> nu sunt tratate ca eroare,
     sunt marcate explicit (is_negative) pentru afisare distincta in UI.
"""

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
from entsoe import EntsoePandasClient
from entsoe.exceptions import NoMatchingDataError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("fetch_prices")

TZ = "Europe/Bucharest"
ZONE = "RO"  # entsoe-py mapeaza intern la EIC 10YRO-TEL------P
DEFAULT_EUR_RON_RATE = 5.08  # fallback folosit doar daca BNR e indisponibil
HISTORY_MAX_DAYS = 60

DATA_DIR = Path(__file__).parent / "data"
PRICES_FILE = DATA_DIR / "prices.json"
HISTORY_FILE = DATA_DIR / "history.json"
ARCHIVE_DIR = DATA_DIR / "archive"


def get_eur_ron_rate() -> tuple[float, str]:
    """Curs EUR->RON de la BNR (sursa oficiala). Fallback pe o valoare fixa
    daca feed-ul nu raspunde, cu sursa marcata explicit in output -- nu
    vrem sa lasam impresia gresita ca avem mereu curs live."""
    try:
        resp = requests.get("https://www.bnr.ro/nbrfxrates.xml", timeout=10)
        resp.raise_for_status()
        # Format simplu: <Rate currency="EUR">4.9760</Rate> in feed-ul zilnic BNR
        import re

        match = re.search(r'currency="EUR"[^>]*>([\d.]+)<', resp.text)
        if match:
            return float(match.group(1)), "bnr.ro"
        log.warning("Nu am gasit cursul EUR in raspunsul BNR, folosesc fallback.")
    except Exception as exc:  # noqa: BLE001 - vrem fallback pe orice eroare de retea/parsare
        log.warning("Curs BNR indisponibil (%s), folosesc fallback.", exc)
    return DEFAULT_EUR_RON_RATE, "fallback"


def fetch_day_ahead(client: EntsoePandasClient, day: pd.Timestamp) -> pd.Series | None:
    """Preia seria de preturi PZU (EUR/MWh) pentru o zi calendaristica intreaga,
    in ora locala Romaniei. Returneaza None (nu ridica exceptie) daca ziua
    respectiva inca nu a fost publicata -- caz normal pentru "maine" daca
    job-ul ruleaza prea devreme."""
    start = pd.Timestamp(day.date(), tz=TZ)
    # IMPORTANT: pd.DateOffset(days=1), NU timedelta(days=1) -- DateOffset
    # avanseaza la miezul noptii zilei calendaristice URMATOARE (in ora locala
    # Romaniei), indiferent de schimbarea orei. timedelta(days=1) avanseaza
    # cu exact 24h absolute si "cade" la 01:00 in loc de 00:00 in zilele cu
    # schimbare de ora, dand o fereastra de interogare gresita.
    end = start + pd.DateOffset(days=1)
    try:
        series = client.query_day_ahead_prices(ZONE, start=start, end=end)
        return series
    except NoMatchingDataError:
        # caz normal: ziua inca nu a fost publicata (de obicei "maine")
        log.info("Fara date PZU publicate pentru %s (normal pentru 'maine').", day.date())
        return None
    except Exception as exc:  # noqa: BLE001
        # caz ANORMAL: ENTSO-E picat, timeout, eroare de retea etc.
        # IMPORTANT: prindem aici, nu lasam exceptia sa scape -- daca fetch-ul
        # pentru "maine" pica dur, nu trebuie sa distruga un fetch reusit
        # pentru "azi" facut inainte. Fiecare zi e independenta.
        log.error("Eroare neasteptata la preluarea datelor pentru %s: %s", day.date(), exc)
        return None


def series_to_intervals(series: pd.Series, rate: float) -> list[dict]:
    """Transforma seria EUR/MWh intr-o lista de intervale lei/kWh.
    Numarul de intervale variaza natural (92/96/100) in zilele de schimbare
    a orei pentru ca folosim un index pandas tz-aware -- nu hardcodam 96."""
    intervals = []
    freq = series.index.freq or pd.tseries.frequencies.to_offset("15min")
    step = pd.Timedelta(freq)
    for ts, price_eur_mwh in series.items():
        price_ron_kwh = round(float(price_eur_mwh) * rate / 1000, 4)
        intervals.append(
            {
                "start": ts.isoformat(),
                "end": (ts + step).isoformat(),
                "price_eur_mwh": round(float(price_eur_mwh), 2),
                "price_ron_kwh": price_ron_kwh,
                "is_negative": price_ron_kwh < 0,
            }
        )
    return intervals


def build_day_payload(date_str: str, intervals: list[dict]) -> dict:
    prices = [i["price_ron_kwh"] for i in intervals]
    by_price = sorted(intervals, key=lambda i: i["price_ron_kwh"])
    return {
        "date": date_str,
        "intervals": intervals,
        "interval_count": len(intervals),
        "avg_ron_kwh": round(sum(prices) / len(prices), 4) if prices else None,
        "min_ron_kwh": min(prices) if prices else None,
        "max_ron_kwh": max(prices) if prices else None,
        "cheapest_intervals": by_price[:6],
        "priciest_intervals": by_price[-6:][::-1],
    }


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        log.warning("Fisier JSON corupt la %s, repornesc de la valoarea implicita.", path)
        return default


def archive_day(payload: dict | None):
    """Salveaza intervalele complete ale unei zile intr-un fisier propriu,
    o data si pentru totdeauna -- data/archive/{data}.json. Separat de
    history.json (care tine doar rezumatul zilnic, pentru tab-ul Istoric).

    De ce un fisier per zi, nu un singur fisier mare cumulativ:
    un singur JSON care creste zilnic ar deveni greu de gestionat in git
    (diff uriaș la fiecare commit) si ar creste nelimitat. Fisiere mici,
    imutabile, unul per zi, inseamna ca git vede doar "fisier nou adaugat"
    in fiecare zi, nu o modificare a unui fisier deja existent.

    O zi se arhiveaza o singura data -- daca fisierul exista deja, nu-l
    rescriem (preturile PZU publicate nu se mai schimba ulterior, deci
    nu exista motiv sa suprascriem)."""
    if payload is None:
        return
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    archive_file = ARCHIVE_DIR / f"{payload['date']}.json"
    if archive_file.exists():
        return
    archive_file.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    log.info("Arhivat %s", archive_file)


def update_history(today_payload: dict | None):
    """Adauga/actualizeaza intrarea de azi in istoricul rolant. History se
    pastreaza separat de prices.json pentru ca 'azi'/'maine' se rescriu zilnic,
    dar tab-ul de Istoric 30 zile are nevoie de date care nu se pierd."""
    if today_payload is None:
        return
    history = load_json(HISTORY_FILE, [])
    history = [h for h in history if h["date"] != today_payload["date"]]
    history.append(
        {
            "date": today_payload["date"],
            "avg_ron_kwh": today_payload["avg_ron_kwh"],
            "min_ron_kwh": today_payload["min_ron_kwh"],
            "max_ron_kwh": today_payload["max_ron_kwh"],
        }
    )
    history.sort(key=lambda h: h["date"])
    history = history[-HISTORY_MAX_DAYS:]
    HISTORY_FILE.write_text(json.dumps(history, indent=2, ensure_ascii=False))
    log.info("Istoric actualizat: %d zile salvate.", len(history))


def main():
    token = os.environ.get("ENTSOE_TOKEN")
    if not token:
        log.error("Variabila de mediu ENTSOE_TOKEN nu este setata. Vezi README.")
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    client = EntsoePandasClient(api_key=token)
    rate, rate_source = get_eur_ron_rate()
    log.info("Curs EUR->RON folosit: %.4f (sursa: %s)", rate, rate_source)

    now_ro = pd.Timestamp.now(tz=TZ)
    today = now_ro.normalize()
    tomorrow = today + pd.DateOffset(days=1)

    today_series = fetch_day_ahead(client, today)
    tomorrow_series = fetch_day_ahead(client, tomorrow)

    today_payload = (
        build_day_payload(today.date().isoformat(), series_to_intervals(today_series, rate))
        if today_series is not None
        else None
    )
    tomorrow_payload = (
        build_day_payload(tomorrow.date().isoformat(), series_to_intervals(tomorrow_series, rate))
        if tomorrow_series is not None
        else None
    )

    if today_payload is None and tomorrow_payload is None:
        # Nimic nou de scris -- nu suprascriem prices.json cu date goale,
        # pastram ultima versiune buna cunoscuta (fail-soft, nu fail-loud).
        log.error("Nicio zi disponibila de la ENTSO-E. Pastrez fisierul existent neschimbat.")
        sys.exit(1)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "eur_ron_rate": rate,
        "eur_ron_rate_source": rate_source,
        "today": today_payload,
        "tomorrow": tomorrow_payload,
        "tomorrow_published": tomorrow_payload is not None,
    }

    PRICES_FILE.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    log.info("Scris %s (azi: %s, maine publicat: %s)", PRICES_FILE, bool(today_payload), output["tomorrow_published"])

    update_history(today_payload)
    archive_day(today_payload)
    archive_day(tomorrow_payload)


if __name__ == "__main__":
    main()
