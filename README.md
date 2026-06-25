# pzuro.app — Romanian Day-Ahead Electricity Price Dashboard

A production data pipeline and consumer dashboard for the Romanian day-ahead electricity market (PZU — *Piața pentru Ziua Următoare*), built to help households on dynamic pricing contracts decide when to run high-consumption appliances.

**Live at [pzuro.app](https://pzuro.ro)**

---

## What it does

Romanian energy suppliers offer dynamic contracts where the price changes every 15 minutes, tracking the wholesale day-ahead market. Most customers on these contracts have no easy way to see tomorrow's prices or understand whether the contract is actually saving them money.

Pzuro pulls wholesale prices from the ENTSO-E Transparency Platform, converts them to RON/kWh using the live BNR exchange rate, and surfaces them in a dashboard optimized for non-technical users:

- **Daily verdict card** — cheapest and most expensive intervals, with a plain-language recommendation
- **15-minute price chart** — color-coded by price tier (cheap / mid / expensive / negative)
- **Top hours** — ranked best and worst intervals for the day
- **Cost calculator** — estimate your monthly bill under dynamic vs. fixed pricing, with optional CSV upload of your real consumption data for an exact match
- **30-day history** — daily average, min, and max prices
- **Telegram alerts** — daily summary pushed every morning before prices change

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   GitHub Actions (cron)                  │
│         11:15 UTC daily + 12:30 UTC fallback            │
│         + cron-job.org workflow_dispatch trigger        │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
                  fetch_prices.py
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ENTSO-E API       BNR API      Local validation
   (day-ahead     (EUR→RON      (≥80 intervals guard,
    prices)        rate)         DST handling)
          │
          ▼
   data/prices.json          data/archive/YYYY-MM-DD.json
   data/history.json         (one file per day, immutable)
          │
          ▼
   git commit + push
          │
          ▼
      Vercel CDN
   (auto-deploy on push,
    no-cache headers on
    data/*.json)
          │
     ┌────┴────┐
     ▼         ▼
 index.html  notify_telegram.py
 (static SPA) (daily digest to
              Telegram channel)
```

---

## Data pipeline details

**Source**: ENTSO-E Transparency Platform (`A44` document type, `10YRO-TEL------P` domain). Prices arrive in EUR/MWh for 15-minute intervals.

**Transformation**:
- EUR/MWh → RON/kWh using live BNR exchange rate (`bnr.ro/nbrfxrates.xml`), with a hardcoded fallback if BNR is unavailable
- DST-aware windowing via `pd.DateOffset` (not `timedelta`) — ensures correct interval count on clock-change days (92 or 100 intervals instead of 96)
- Negative prices preserved as-is with `is_negative` flag; displayed in violet in the UI, not filtered out

**Validation**:
- `MIN_VALID_INTERVALS = 80` guard: if ENTSO-E returns a partial response for tomorrow (common between 11:00–13:00 UTC before the day-ahead auction clears), the pipeline sets `tomorrow_published: false` and keeps the previous good file intact
- The frontend independently re-validates `interval_count >= 80` before trusting the published flag — defense in depth against stale cached responses
- On total failure (both days unavailable), the script exits with code 1 and does **not** overwrite the last good `prices.json`

**Scheduling**:
- Primary: GitHub Actions cron at `11:15 UTC` and `12:30 UTC` (UTC-fixed, covers both CET and CEST without manual adjustment)
- Fallback: [cron-job.org](https://cron-job.org) triggers `workflow_dispatch` via GitHub API — compensates for free-tier GitHub Actions scheduling drift

---

## Stack

| Layer | Technology |
|---|---|
| Data pipeline | Python, `entsoe-py`, `pandas`, `requests` |
| Exchange rate | BNR XML feed |
| Scheduling | GitHub Actions + cron-job.org |
| Storage | JSON files committed to Git |
| Hosting | Vercel (static + serverless) |
| Frontend | Vanilla HTML/CSS/JS, Chart.js |
| Notifications | Telegram Bot API |
| Domain | pzuro.app / pzuro.ro |

No database server. The entire state is in versioned JSON files, which doubles as a free audit trail and makes the historical archive trivially reproducible. The daily archive (~150KB/day) fits comfortably in Git for the near term; the natural next step when the repo grows is moving the archive to object storage (Vercel Blob or Cloudflare R2) while keeping the same JSON format — no server needed at this data volume.

---

## Key engineering decisions

**Why JSON files in Git instead of a database?**
The dataset is small (one JSON per day, ~150KB), write frequency is low (once or twice daily), and reads are high. A CDN-served static file outperforms any database query for this access pattern. Git also provides a full history of every price fetch for free. At ~2 years of daily files (~110MB), the archive will outgrow Git comfortably — the planned migration is to object storage (Vercel Blob or Cloudflare R2), keeping the same JSON format without introducing a database server.

**Why two separate scheduling systems?**
GitHub Actions free-tier cron has documented drift of up to several minutes and occasionally skips runs. Since the ENTSO-E day-ahead auction typically publishes between 12:45–13:30 CET, a missed or late run means users see no tomorrow prices. The cron-job.org trigger via `workflow_dispatch` adds a reliable external heartbeat.

**Why validate interval count on both sides?**
The pipeline guard prevents writing bad data. The frontend guard prevents displaying bad data from an older cached file. The two guards are independent so either one catching a partial response is sufficient.

---

## Running locally

```bash
git clone https://github.com/andreistoleriu/pzuro.git
cd pzuro
pip install -r requirements.txt

# Generate synthetic data (no ENTSO-E token needed)
python generate_sample_data.py

# Serve locally
python -m http.server 8000
# Open http://localhost:8000
```

To run the real pipeline, add your ENTSO-E API token ([register here](https://transparency.entsoe.eu/)) as `ENTSOE_TOKEN` in your environment or as a GitHub Actions secret.

---

## Project structure

```
pzuro/
├── fetch_prices.py              # main pipeline: ENTSO-E + BNR → prices.json
├── notify_telegram.py           # daily Telegram digest with duplicate guard
├── generate_sample_data.py      # synthetic data generator for local dev
├── index.html                   # single-page dashboard (no build step)
├── api/
│   └── now.js                   # Vercel serverless: current interval price
├── data/
│   ├── prices.json              # today + tomorrow, regenerated daily
│   ├── history.json             # ~60-day summary (avg/min/max per day)
│   └── archive/
│       └── YYYY-MM-DD.json      # full 15-min intervals per day (immutable)
├── .github/workflows/
│   └── fetch-prices.yml         # Actions cron + workflow_dispatch
└── vercel.json                  # cache-control: no-store for data/*.json
```