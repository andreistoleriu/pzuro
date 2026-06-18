import json
import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from fetch_prices import build_day_payload, series_to_intervals, update_history, archive_day, PRICES_FILE, DATA_DIR  # noqa: E402

RATE = 5.08


def synthetic_day_series(day: date, seed: int) -> pd.Series:
    """Curba realista: ieftin noaptea si la solar de amiaza (uneori negativ),
    varf seara. Foloseste un index tz-aware Europe/Bucharest la 15 min,
    exact ca raspunsul real de la entsoe-py."""
    rng = random.Random(seed)
    start = pd.Timestamp(day, tz="Europe/Bucharest")
    idx = pd.date_range(start, start + pd.DateOffset(days=1), freq="15min", inclusive="left")
    values = []
    for ts in idx:
        h = ts.hour + ts.minute / 60
        base = 90 + 70 * math.sin((h - 14) / 24 * 2 * math.pi * -1) ** 1  # nu-i nevoie de precizie, doar forma
        # varf de seara 18-21, minim noapte 02-05, dip solar 11-15
        if 18 <= h <= 21:
            base = 260 + rng.uniform(-15, 25)
        elif 2 <= h <= 5:
            base = 60 + rng.uniform(-10, 10)
        elif 11 <= h <= 15:
            base = rng.uniform(-25, 40)  # uneori negativ, ca in document
        else:
            base = 120 + rng.uniform(-20, 20)
        values.append(base)
    return pd.Series(values, index=idx)


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today()
    tomorrow = today + timedelta(days=1)

    today_payload = build_day_payload(today.isoformat(), series_to_intervals(synthetic_day_series(today, 1), RATE))
    tomorrow_payload = build_day_payload(
        tomorrow.isoformat(), series_to_intervals(synthetic_day_series(tomorrow, 2), RATE)
    )

    output = {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "eur_ron_rate": RATE,
        "eur_ron_rate_source": "demo-mock",
        "today": today_payload,
        "tomorrow": tomorrow_payload,
        "tomorrow_published": True,
    }
    PRICES_FILE.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print("Scris", PRICES_FILE)
    archive_day(today_payload)
    archive_day(tomorrow_payload)

    # 35 de zile de istoric, pentru tab-ul "Istoric 30 zile"
    history = []
    for i in range(35, 0, -1):
        d = today - timedelta(days=i)
        payload = build_day_payload(d.isoformat(), series_to_intervals(synthetic_day_series(d, 100 + i), RATE))
        archive_day(payload)
        history.append(
            {
                "date": payload["date"],
                "avg_ron_kwh": payload["avg_ron_kwh"],
                "min_ron_kwh": payload["min_ron_kwh"],
                "max_ron_kwh": payload["max_ron_kwh"],
            }
        )
    (DATA_DIR / "history.json").write_text(json.dumps(history, indent=2, ensure_ascii=False))
    print("Scris", DATA_DIR / "history.json")

    # sanity check pe edge case-ul de schimbare a orei
    spring = date(2026, 3, 29)  # ultima duminica din martie -> trecere la ora de vara, 23h -> 92 intervale
    fall = date(2026, 10, 25)   # ultima duminica din octombrie -> trecere la ora de iarna, 25h -> 100 intervale
    n_spring = len(synthetic_day_series(spring, 999))
    n_fall = len(synthetic_day_series(fall, 998))
    print(f"Verificare DST {spring}: {n_spring} intervale (asteptat 92)")
    print(f"Verificare DST {fall}: {n_fall} intervale (asteptat 100)")
    assert n_spring == 92, "Bug DST nerezolvat pentru trecerea la ora de vara"
    assert n_fall == 100, "Bug DST nerezolvat pentru trecerea la ora de iarna"


if __name__ == "__main__":
    main()
