"""
generate_pages.py
-----------------
Genereaza paginile statice care depind de date si trebuie sa fie indexabile
de motoarele de cautare fara JavaScript:

  - pret-energie-maine.html          -> preturile PZU de maine (sau de azi, pana la publicare)
  - furnizori/index.html             -> comparatie intre ofertele cu pret dinamic
  - furnizori/<slug>.html            -> cate o pagina pentru fiecare oferta
  - sitemap.xml

Ruleaza zilnic dupa fetch_prices.py (vezi .github/workflows/fetch-prices.yml),
ca cifrele de pe pagini sa fie mereu cele curente. Citeste doar fisierele din
data/ -- nu face cereri in retea.
"""

import html
import json
import logging
from datetime import date, datetime
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("generate_pages")

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
SITE = "https://pzuro.ro"
CONSUM_REFERINTA = 250  # kWh/luna, o gospodarie obisnuita

LUNI = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august",
        "septembrie", "octombrie", "noiembrie", "decembrie"]
ZILE = ["luni", "marți", "miercuri", "joi", "vineri", "sâmbătă", "duminică"]

# Aceleasi ponderi ca PROFILE_WEIGHTS din js/calc.js -- un test verifica
# automat ca raman identice (test/generate_pages_test.py).
PROFILE_WEIGHTS = {
    "uniform": [1] * 24,
    "seara": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.2, 1.2, 1.2, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 1, 2, 2, 2, 2, 2, 1],
    "noapte": [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 0.8, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 1.5, 1.5],
    "zi": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0.6],
}

e = html.escape


# ---------- calcule (aceleasi formule ca in js/calc.js) ----------

def fmt(x: float | None, d: int = 3) -> str:
    if x is None:
        return "—"
    s = f"{x:.{d}f}"
    if s == "-" + f"{0:.{d}f}":
        s = s[1:]
    return s.replace(".", ",")


def profile_avg(hourly: list, profil: str) -> float | None:
    w = PROFILE_WEIGHTS.get(profil, PROFILE_WEIGHTS["uniform"])
    s = ws = 0.0
    for h in range(24):
        if hourly[h] is None:
            continue
        s += hourly[h] * w[h]
        ws += w[h]
    return s / ws if ws else None


def regulated_total(tarife: dict, operator_id: str) -> float:
    c = tarife["comune"]
    op = next(o for o in tarife["operatori"] if o["id"] == operator_id)
    return (c["transport_tl"] + c["servicii_sistem"] + c["certificate_verzi"] + c["cogenerare"]
            + c["acciza"] + c["cfd"] + op["distributie_jt"])


def regulated_national(tarife: dict) -> float:
    vals = [regulated_total(tarife, o["id"]) for o in tarife["operatori"]]
    return sum(vals) / len(vals)


def marja(f: dict) -> float | None:
    if f["componenta_furnizare"] is None:
        return None
    return f["componenta_furnizare"] + (f.get("dezechilibru_estimat") or 0)


def final_price(pzu: float, reglementate: float, componenta: float, tva: float) -> float:
    return (pzu + reglementate + componenta) * (1 + tva)


def best_windows(intervals: list, duration_min: int):
    """Cea mai ieftina / scumpa fereastra continua de duration_min minute."""
    if not intervals:
        return None
    k = max(1, round(duration_min / 15))
    best = worst = None
    run_start, s = 0, 0.0
    for i, iv in enumerate(intervals):
        if i > 0 and iv["start"] != intervals[i - 1]["end"]:
            run_start, s = i, 0.0
        s += iv["price_ron_kwh"]
        if i - run_start + 1 > k:
            s -= intervals[i - k]["price_ron_kwh"]
        if i - run_start + 1 < k:
            continue
        w = {"start": intervals[i - k + 1]["start"], "end": iv["end"], "avg": s / k}
        if best is None or w["avg"] < best["avg"]:
            best = w
        if worst is None or w["avg"] > worst["avg"]:
            worst = w
    return {"best": best, "worst": worst} if best else None


def hhmm(iso: str) -> str:
    return iso[11:16]


def data_lunga(iso_date: str) -> str:
    d = date.fromisoformat(iso_date)
    return f"{ZILE[d.weekday()]}, {d.day} {LUNI[d.month - 1]} {d.year}"


def data_scurta(iso_date: str) -> str:
    d = date.fromisoformat(iso_date)
    return f"{d.day} {LUNI[d.month - 1]} {d.year}"


# ---------- sablon HTML comun ----------

STYLE = """
  :root{
    --paper:#F7F4EE; --ink:#1E2128; --ink-soft:#5B5F6B;
    --cyan:#0F8A93; --cyan-soft:#E3F2F1; --amber:#D9722C; --amber-soft:#FBEADC; --violet:#7B5EEA; --line:#E3DFD4;
    --font-display:'Space Grotesk',sans-serif; --font-body:'IBM Plex Sans',sans-serif; --font-mono:'IBM Plex Mono',monospace;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);line-height:1.6;}
  .wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px;}
  header.top{background:var(--ink);color:var(--paper);padding:18px 20px;}
  header.top .wrap{padding:0;margin:0 auto;display:flex;align-items:baseline;gap:10px;}
  .mark{font-family:var(--font-display);font-weight:700;font-size:1.25rem;text-decoration:none;color:var(--paper);}
  .mark span{color:var(--cyan);}
  .tag{font-size:.78rem;color:#AEB3BD;}
  header.top .wrap{flex-wrap:wrap;}
  .site-nav{margin-left:auto;display:flex;gap:2px;flex-wrap:wrap;}
  .site-nav a{color:#D8DBE0;text-decoration:none;font-size:.8rem;font-weight:500;padding:5px 10px;border-radius:999px;}
  .site-nav a:hover{background:rgba(255,255,255,.08);color:#fff;}
  .site-nav a[aria-current="page"]{background:rgba(255,255,255,.12);color:#fff;}
  @media(max-width:560px){ .site-nav{margin-left:-10px;width:100%;} }
  h1{font-family:var(--font-display);font-weight:600;font-size:1.85rem;line-height:1.25;margin:0 0 6px;}
  .meta{font-size:.82rem;color:var(--ink-soft);margin-bottom:28px;}
  h2{font-family:var(--font-display);font-weight:600;font-size:1.3rem;margin:36px 0 12px;}
  p{margin:0 0 16px;}
  ul{margin:0 0 16px;padding-left:22px;}
  li{margin-bottom:6px;}
  a{color:var(--cyan);}
  .callout{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:20px 0;font-size:.92rem;}
  .callout dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0;}
  .callout dt{color:var(--ink-soft);}
  .callout dd{margin:0;}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0;}
  .stat{flex:1;min-width:140px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;}
  .stat .v{font-family:var(--font-mono);font-size:1.35rem;font-weight:500;}
  .stat .k{font-size:.78rem;color:var(--ink-soft);}
  .stat.good{background:var(--cyan-soft);border-color:transparent;}
  .stat.bad{background:var(--amber-soft);border-color:transparent;}
  .table-wrap{overflow-x:auto;margin:0 0 16px;}
  table{width:100%;border-collapse:collapse;font-size:.88rem;background:#fff;border-radius:12px;}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);}
  th{color:var(--ink-soft);font-weight:500;font-size:.8rem;}
  td.n{font-family:var(--font-mono);text-align:right;white-space:nowrap;}
  th.n{text-align:right;}
  tr.hl td{font-weight:600;background:var(--cyan-soft);}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle;}
  .small{font-size:.8rem;color:var(--ink-soft);}
  .cta{background:var(--ink);color:var(--paper);border-radius:14px;padding:28px 24px;margin:40px 0 0;text-align:center;}
  .cta h3{font-family:var(--font-display);margin:0 0 8px;font-size:1.2rem;}
  .cta p{color:#C9CCD3;margin:0 0 18px;font-size:.9rem;}
  .cta a{display:inline-block;background:var(--cyan);color:#fff;text-decoration:none;font-weight:500;padding:11px 22px;border-radius:999px;font-size:.92rem;}
  footer{margin-top:48px;font-size:.78rem;color:var(--ink-soft);text-align:center;}
"""


NAV_LINKS = [
    ("pret-energie-maine.html", "Prețul de mâine"),
    ("furnizori/", "Oferte furnizori"),
    ("ce-este-contract-pret-dinamic.html", "Ghid"),
]


def nav_html(current_path: str) -> str:
    """Meniul din antet, acelasi pe toate paginile; marcheaza sectiunea curenta."""
    items = []
    for href, label in NAV_LINKS:
        current = href == current_path or (href == "furnizori/" and current_path.startswith("furnizori/"))
        items.append(f'<a href="/{href}"{" aria-current=\"page\"" if current else ""}>{label}</a>')
    return f'<nav class="site-nav" aria-label="Pagini pzuro">{"".join(items)}</nav>'


def page(path: str, title: str, description: str, tag: str, body: str, og_type: str = "article", jsonld: dict | None = None) -> str:
    url = f"{SITE}/{path}"
    ld = ""
    if jsonld:
        ld = f'<script type="application/ld+json">\n{json.dumps(jsonld, ensure_ascii=False, indent=2)}\n</script>\n'
    return f"""<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png" type="image/png">
<meta name="theme-color" content="#1E2128">
<title>{e(title)} — pzuro.app</title>
<meta name="description" content="{e(description)}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="{og_type}">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:image" content="{SITE}/og-image.png">
<meta property="og:locale" content="ro_RO">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{SITE}/og-image.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
{ld}<style>{STYLE}</style>
</head>
<body>
<!-- Pagina generata automat de generate_pages.py -- nu o edita de mana, modificarile se pierd la urmatoarea rulare. -->
<header class="top">
  <div class="wrap">
    <a class="mark" href="/">pzuro<span>.</span>app</a>
    <span class="tag">{e(tag)}</span>
    {nav_html(path)}
  </div>
</header>

<div class="wrap">
{body}
</div>

<footer>pzuro.app · Date: ENTSO-E, curs BNR · <a href="/furnizori/">Oferte furnizori</a> · <a href="/pret-energie-maine.html">Prețul de mâine</a> · <a href="/ce-este-contract-pret-dinamic.html">Ghid contracte dinamice</a><br>Informații cu caracter general, nu consultanță financiară. Verifică oferta furnizorului tău.</footer>
<script>window.va = window.va || function () {{ (window.vaq = window.vaq || []).push(arguments); }};</script>
<script defer src="/_vercel/insights/script.js"></script>
</body>
</html>
"""


# ---------- pagina "pretul energiei maine" ----------

def color_for(price: float, lo: float, hi: float) -> str:
    if price < 0:
        return "var(--violet)"
    pos = (price - lo) / ((hi - lo) or 1)
    return "var(--cyan)" if pos < 0.33 else "var(--amber)" if pos > 0.66 else "var(--ink-soft)"


def build_maine_page(prices: dict, cfg: dict) -> str:
    tomorrow = prices.get("tomorrow")
    ready = bool(prices.get("tomorrow_published") and tomorrow and tomorrow.get("interval_count", 0) >= 80)
    day = tomorrow if ready else prices.get("today")
    if not day:
        raise ValueError("prices.json nu contine nicio zi")

    intervals = day["intervals"]
    lo, hi = day["min_ron_kwh"], day["max_ron_kwh"]
    cheap, pricy = day["cheapest_intervals"][0], day["priciest_intervals"][0]
    w2 = best_windows(intervals, 120)
    w4 = best_windows(intervals, 240)
    zi = data_lunga(day["date"])
    # cu cat creste pretul final fata de pretul de piata, la media zilei, pentru
    # ofertele cu componenta publicata (la media tarifelor de distributie)
    reg = regulated_national(cfg["tarife"])
    adaos = [final_price(day["avg_ron_kwh"], reg, marja(f), cfg["tva"]) - day["avg_ron_kwh"]
             for f in cfg["furnizori"] if marja(f) is not None]

    # tabel pe ore: media celor 4 sferturi de ora + minim/maxim
    by_hour: dict[int, list[float]] = {}
    for iv in intervals:
        by_hour.setdefault(int(iv["start"][11:13]), []).append(iv["price_ron_kwh"])
    rows = []
    for h in sorted(by_hour):
        vals = by_hour[h]
        avg = sum(vals) / len(vals)
        rows.append(
            f'<tr><td><span class="dot" style="background:{color_for(avg, lo, hi)}"></span>{h:02d}:00 – {(h + 1) % 24:02d}:00</td>'
            f'<td class="n">{fmt(avg)}</td><td class="n">{fmt(min(vals))}</td><td class="n">{fmt(max(vals))}</td></tr>'
        )

    if ready:
        h1 = f"Prețul energiei electrice mâine, {zi}"
        intro = (f"Prețurile PZU pentru {zi} au fost publicate. Media zilei este {fmt(day['avg_ron_kwh'])} lei/kWh, "
                 f"cu cel mai mic preț la {hhmm(cheap['start'])} ({fmt(cheap['price_ron_kwh'])} lei/kWh) "
                 f"și cel mai mare la {hhmm(pricy['start'])} ({fmt(pricy['price_ron_kwh'])} lei/kWh).")
    else:
        h1 = "Prețul energiei electrice mâine"
        intro = (f"Prețurile pentru mâine nu au fost publicate încă; de regulă apar după ora 14:00. "
                 f"Până atunci, mai jos sunt prețurile de azi, {zi}: media zilei este {fmt(day['avg_ron_kwh'])} lei/kWh.")

    incomplet = ""
    if day.get("complete") is False:
        lipsa = day.get("expected_interval_count", 96) - len(intervals)
        incomplet = f'<p class="small">Pentru această zi lipsesc {lipsa} intervale de la sursa ENTSO-E; valorile sunt calculate pe intervalele disponibile.</p>'

    ferestre = ""
    if w2 and w4:
        ferestre = f"""
  <h2>Când merită să pornești aparatele</h2>
  <ul>
    <li><b>Mașina de spălat sau de vase (2 ore):</b> cel mai ieftin între {hhmm(w2['best']['start'])} și {hhmm(w2['best']['end'])}, preț mediu {fmt(w2['best']['avg'])} lei/kWh. Cel mai scump: {hhmm(w2['worst']['start'])}–{hhmm(w2['worst']['end'])}, {fmt(w2['worst']['avg'])} lei/kWh.</li>
    <li><b>Încărcarea mașinii electrice (4 ore):</b> cel mai ieftin între {hhmm(w4['best']['start'])} și {hhmm(w4['best']['end'])}, preț mediu {fmt(w4['best']['avg'])} lei/kWh.</li>
  </ul>"""

    body = f"""  <h1>{e(h1)}</h1>
  <p class="meta">Prețuri PZU (Piața pentru Ziua Următoare), pe intervale de 15 minute · actualizat {e(data_scurta(datetime.now().date().isoformat()))}</p>

  <p>{e(intro)}</p>
  {incomplet}
  <div class="stats">
    <div class="stat"><div class="v">{fmt(day['avg_ron_kwh'])}</div><div class="k">medie (lei/kWh)</div></div>
    <div class="stat good"><div class="v">{fmt(lo)}</div><div class="k">minim, la {hhmm(cheap['start'])}</div></div>
    <div class="stat bad"><div class="v">{fmt(hi)}</div><div class="k">maxim, la {hhmm(pricy['start'])}</div></div>
  </div>
  <p class="small">Sunt prețuri de piață, fără tarife reglementate, componenta de furnizare și TVA. Pe un contract dinamic, prețul final pe kWh este cu aproximativ {fmt(min(adaos), 2)}–{fmt(max(adaos), 2)} lei mai mare, în funcție de furnizor; îl poți estima exact în <a href="/#calculator">calculator</a>.</p>
{ferestre}
  <h2>Prețul pe fiecare oră</h2>
  <p class="small">Media celor patru intervale de 15 minute din fiecare oră, plus cel mai mic și cel mai mare preț din oră, în lei/kWh.</p>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Ora</th><th class="n">Medie</th><th class="n">Minim</th><th class="n">Maxim</th></tr></thead>
    <tbody>
    {"".join(rows)}
    </tbody>
  </table>
  </div>

  <div class="cta">
    <h3>Graficul complet și fereastra potrivită pentru aparatul tău</h3>
    <p>Pe pzuro.app vezi toate cele 96 de intervale, prețul final estimat pentru furnizorul tău și cel mai ieftin moment pentru fiecare aparat.</p>
    <a href="/#ore">Deschide pzuro.app →</a>
  </div>"""

    if ready:
        desc = (f"Prețul energiei electrice mâine, {data_scurta(day['date'])}: medie {fmt(day['avg_ron_kwh'])} lei/kWh, "
                f"minim {fmt(lo)} la {hhmm(cheap['start'])}, maxim {fmt(hi)} la {hhmm(pricy['start'])}. Prețuri PZU pe ore.")
    else:
        desc = "Prețul energiei electrice pe ore pentru ziua de mâine, din piața PZU. Prețurile apar zilnic după ora 14:00."
    return page("pret-energie-maine.html", "Prețul energiei electrice mâine, pe ore", desc, "prețuri PZU", body,
                og_type="website",
                jsonld={"@context": "https://schema.org", "@type": "WebPage", "name": h1, "description": desc,
                        "inLanguage": "ro", "dateModified": datetime.now().date().isoformat()})


# ---------- paginile de furnizori ----------

def cost_rows(f: dict, cfg: dict, stats: dict) -> list[dict]:
    """Pretul final si costul lunar estimat, pe fiecare operator de distributie."""
    m = marja(f)
    tva = cfg["tva"]
    out = []
    for op in cfg["tarife"]["operatori"]:
        reg = regulated_total(cfg["tarife"], op["id"])
        uni = final_price(profile_avg(stats["hourly_avg_ron_kwh"], "uniform"), reg, m, tva)
        seara = final_price(profile_avg(stats["hourly_avg_ron_kwh"], "seara"), reg, m, tva)
        noapte = final_price(profile_avg(stats["hourly_avg_ron_kwh"], "noapte"), reg, m, tva)
        out.append({"op": op, "uniform": uni, "seara": seara, "noapte": noapte})
    return out


def national_price(f: dict, cfg: dict, stats: dict, profil: str = "uniform") -> float | None:
    m = marja(f)
    if m is None:
        return None
    return final_price(profile_avg(stats["hourly_avg_ron_kwh"], profil), regulated_national(cfg["tarife"]), m, cfg["tva"])


def perioada(stats: dict) -> str:
    return f"{data_scurta(stats['from'])} – {data_scurta(stats['to'])}"


def comparatie_tabel(cfg: dict, stats: dict, highlight: str | None = None) -> str:
    rows = []
    for f in cfg["furnizori"]:
        p = national_price(f, cfg, stats)
        rows.append((p if p is not None else 99, f, p))
    rows.sort(key=lambda r: r[0])
    trs = []
    for _, f, p in rows:
        name = f'<a href="/furnizori/{f["slug"]}.html">{e(f["oferta"])}</a>' if f.get("slug") else e(f["oferta"])
        cf = "nepublicată" if f["componenta_furnizare"] is None else fmt(f["componenta_furnizare"], 3) + (
            f" + {fmt(f['dezechilibru_estimat'], 2)} dezech." if f.get("dezechilibru_estimat") else "")
        cls = ' class="hl"' if f["id"] == highlight else ""
        trs.append(f'<tr{cls}><td>{name}</td><td class="n">{cf}</td><td class="n">{fmt(p)}</td>'
                   f'<td class="n">{fmt(p * CONSUM_REFERINTA, 0) if p else "—"}</td></tr>')
    return f"""<div class="table-wrap"><table>
    <thead><tr><th>Ofertă</th><th class="n">Componentă furnizare (lei/kWh)</th><th class="n">Preț final mediu (lei/kWh)</th><th class="n">Cost {CONSUM_REFERINTA} kWh/lună (lei)</th></tr></thead>
    <tbody>{"".join(trs)}</tbody>
  </table></div>"""


def build_furnizor_page(f: dict, cfg: dict, stats: dict) -> str:
    m = marja(f)
    rows = cost_rows(f, cfg, stats)
    nat = national_price(f, cfg, stats)
    nat_seara = national_price(f, cfg, stats, "seara")
    nat_noapte = national_price(f, cfg, stats, "noapte")
    verif = data_scurta(f["verificat"])
    sursa_txt = "oferta oficială a furnizorului" if f["sursa_oficiala"] else "surse publice secundare; verifică valoarea în oferta furnizorului"

    dezech = ""
    if f.get("dezechilibru_estimat"):
        dezech = f'<dt>Dezechilibru estimat</dt><dd>{fmt(f["dezechilibru_estimat"], 2)} lei/kWh, facturat separat; valoarea reală variază lunar</dd>'
    nota = f'<p>{e(f["nota"])}</p>' if f.get("nota") else ""

    tabel_op = "".join(
        f'<tr><td>{e(r["op"]["nume"])}<br><span class="small">{e(", ".join(r["op"]["judete"]))}</span></td>'
        f'<td class="n">{fmt(r["uniform"])}</td><td class="n">{fmt(r["uniform"] * CONSUM_REFERINTA, 0)}</td>'
        f'<td class="n">{fmt(r["seara"] * CONSUM_REFERINTA, 0)}</td><td class="n">{fmt(r["noapte"] * CONSUM_REFERINTA, 0)}</td></tr>'
        for r in rows
    )

    body = f"""  <h1>{e(f["oferta"])}: componenta de furnizare și costul estimat</h1>
  <p class="meta">Valori verificate pe {e(verif)} · prețuri PZU din ultimele {stats["window_days"]} de zile ({e(perioada(stats))})</p>

  <p>{e(f["oferta"])} este oferta cu preț dinamic a {e(f["nume"])} pentru clienții casnici cu contor inteligent. Prețul energiei urmează piața PZU la fiecare 15 minute, iar peste el se adaugă o componentă de furnizare fixă, tarifele reglementate și TVA.</p>

  <div class="callout"><dl>
    <dt>Componenta de furnizare</dt><dd><b>{fmt(f["componenta_furnizare"], 5).rstrip("0").rstrip(",")} lei/kWh</b>, fără TVA</dd>
    {dezech}
    <dt>Valabilitate ofertă</dt><dd>{e(f["valabilitate"] or "—")}</dd>
    <dt>Sursa</dt><dd><a href="{e(f["sursa"])}" rel="nofollow noopener">{e(sursa_txt)}</a></dd>
  </dl></div>
  {nota}

  <h2>Cât ar fi costat în ultimele {stats["window_days"]} de zile</h2>
  <p>La prețurile PZU din perioada {e(perioada(stats))}, cu toate taxele și TVA, prețul final mediu pe {e(f["oferta"])} ar fi fost de <b>{fmt(nat)} lei/kWh</b> la un consum uniform (media celor patru zone de distribuție). Pentru o gospodărie care consumă mai ales seara, ar fi fost {fmt(nat_seara)} lei/kWh; pentru una care consumă mai ales noaptea, {fmt(nat_noapte)} lei/kWh.</p>
  <p class="small">Costul lunar pentru {CONSUM_REFERINTA} kWh, pe zona de distribuție și pe profilul de consum (lei):</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Zona de distribuție</th><th class="n">Preț final (lei/kWh)</th><th class="n">Uniform</th><th class="n">Mai ales seara</th><th class="n">Mai ales noaptea</th></tr></thead>
    <tbody>{tabel_op}</tbody>
  </table></div>

  <h2>Cum se calculează prețul</h2>
  <p>Pentru fiecare interval de 15 minute: <code>(preț PZU + {fmt(m, 5).rstrip("0").rstrip(",")} + tarife reglementate) × 1,21</code>. Tarifele reglementate (transport, distribuție, servicii de sistem, certificate verzi, cogenerare, acciză) sunt stabilite de ANRE și diferă doar după zona de distribuție, nu după furnizor.</p>

  <h2>Comparație cu celelalte oferte dinamice</h2>
  <p class="small">Aceleași prețuri PZU și media tarifelor de distribuție; consum uniform.</p>
  {comparatie_tabel(cfg, stats, f["id"])}

  <h2>Pentru cine are sens</h2>
  <p>Un contract dinamic merită dacă poți muta o parte din consum în orele ieftine: mașina electrică încărcată la prânz sau noaptea, boilerul sau pompa de căldură programate, electrocasnicele pornite în afara vârfului de seară. Dacă nu îți poți muta consumul, un contract cu preț fix este de obicei mai sigur. Detalii în <a href="/ce-este-contract-pret-dinamic.html">ghidul despre contractele cu preț dinamic</a>.</p>

  <div class="cta">
    <h3>Calculează pentru consumul tău</h3>
    <p>Alege județul și profilul de consum sau încarcă fișierul cu consumul real de la distribuitor.</p>
    <a href="/?furnizor={e(f["id"])}#calculator">Deschide calculatorul →</a>
  </div>"""

    desc = (f"{f['oferta']}: componenta de furnizare {fmt(f['componenta_furnizare'], 3)} lei/kWh și prețul final estimat "
            f"de {fmt(nat)} lei/kWh pe ultimele {stats['window_days']} de zile, pe zone de distribuție.")
    return page(f"furnizori/{f['slug']}.html", f"{f['oferta']}: preț, componentă de furnizare, cost estimat", desc,
                "oferte furnizori", body,
                jsonld={"@context": "https://schema.org", "@type": "Article", "headline": f"{f['oferta']}: componenta de furnizare și costul estimat",
                        "description": desc, "inLanguage": "ro", "dateModified": datetime.now().date().isoformat(),
                        "author": {"@type": "Organization", "name": "pzuro.app"}})


def build_furnizori_index(cfg: dict, stats: dict) -> str:
    body = f"""  <h1>Oferte de energie cu preț dinamic: comparație</h1>
  <p class="meta">Actualizat zilnic · prețuri PZU din ultimele {stats["window_days"]} de zile ({e(perioada(stats))})</p>

  <p>Toate ofertele cu preț dinamic pentru clienții casnici au aceeași structură: prețul pieței PZU la fiecare 15 minute, plus o componentă de furnizare fixă stabilită de furnizor, plus tarifele reglementate și TVA. Diferența dintre oferte vine aproape în întregime din componenta de furnizare.</p>

  <h2>Comparație</h2>
  <p class="small">Preț final mediu la un consum uniform, cu toate taxele și TVA, la media tarifelor de distribuție din țară.</p>
  {comparatie_tabel(cfg, stats)}
  <p class="small">Valorile sunt preluate din ofertele publicate de furnizori și se schimbă periodic; data verificării apare pe pagina fiecărei oferte. Electrica nu a publicat componenta de furnizare, așa că nu poate fi comparată.</p>

  <h2>Ce să verifici înainte să semnezi</h2>
  <ul>
    <li>Ai contor inteligent integrat în sistemul de măsurare (SMI)? Fără el, oferta dinamică nu este disponibilă.</li>
    <li>Componenta de furnizare include dezechilibrele sau acestea se facturează separat?</li>
    <li>Cât durează contractul și cu cât timp înainte te anunță furnizorul dacă schimbă componenta?</li>
    <li>Poți muta o parte din consum în orele ieftine? De asta depinde dacă economisești.</li>
  </ul>

  <div class="cta">
    <h3>Compară pentru consumul tău</h3>
    <p>Calculatorul pzuro.app compară toate ofertele de mai sus pentru județul și profilul tău de consum.</p>
    <a href="/#calculator">Deschide calculatorul →</a>
  </div>"""
    desc = "Comparație între ofertele de energie electrică cu preț dinamic pentru casnici: componenta de furnizare, prețul final estimat și costul lunar, actualizate zilnic."
    return page("furnizori/", "Oferte de energie cu preț dinamic: comparație", desc, "oferte furnizori", body,
                jsonld={"@context": "https://schema.org", "@type": "WebPage", "name": "Oferte de energie cu preț dinamic: comparație",
                        "description": desc, "inLanguage": "ro", "dateModified": datetime.now().date().isoformat()})


# ---------- sitemap ----------

STATIC_PAGES = [
    ("", "daily", "1.0"),
    ("pret-energie-maine.html", "daily", "0.9"),
    ("furnizori/", "daily", "0.9"),
    ("ce-este-contract-pret-dinamic.html", "monthly", "0.8"),
    ("prosumator-contract-pret-dinamic.html", "monthly", "0.8"),
    ("home-assistant.html", "monthly", "0.7"),
]


def build_sitemap(cfg: dict, today: str) -> str:
    entries = list(STATIC_PAGES) + [(f"furnizori/{f['slug']}.html", "weekly", "0.8") for f in cfg["furnizori"] if f.get("slug")]
    urls = []
    for path, freq, prio in entries:
        lastmod = f"\n    <lastmod>{today}</lastmod>" if freq != "monthly" else ""
        urls.append(f"  <url>\n    <loc>{SITE}/{path}</loc>{lastmod}\n    <changefreq>{freq}</changefreq>\n    <priority>{prio}</priority>\n  </url>")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(urls) + "\n</urlset>\n"


def main():
    prices = json.loads((DATA_DIR / "prices.json").read_text(encoding="utf-8"))
    stats = json.loads((DATA_DIR / "stats.json").read_text(encoding="utf-8"))
    cfg = json.loads((DATA_DIR / "furnizori.json").read_text(encoding="utf-8"))

    (ROOT / "pret-energie-maine.html").write_text(build_maine_page(prices, cfg), encoding="utf-8")
    out_dir = ROOT / "furnizori"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "index.html").write_text(build_furnizori_index(cfg, stats), encoding="utf-8")
    for f in cfg["furnizori"]:
        if f.get("slug") and f["componenta_furnizare"] is not None:
            (out_dir / f"{f['slug']}.html").write_text(build_furnizor_page(f, cfg, stats), encoding="utf-8")
    (ROOT / "sitemap.xml").write_text(build_sitemap(cfg, datetime.now().date().isoformat()), encoding="utf-8")
    log.info("Pagini generate: pret-energie-maine.html, furnizori/ (%d oferte), sitemap.xml",
             sum(1 for f in cfg["furnizori"] if f.get("slug")))


if __name__ == "__main__":
    main()
