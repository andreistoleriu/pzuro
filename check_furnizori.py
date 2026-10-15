"""
check_furnizori.py
------------------
Verificare lunara a ofertelor cu pret dinamic din data/furnizori.json.

Pentru furnizorii cu bloc "monitor": descarca pagina cu ofertele, gaseste
linkul catre PDF-ul curent si il compara cu cel cunoscut ("sursa"). Daca s-a
schimbat, descarca PDF-ul si incearca sa citeasca valoarea componentei de
furnizare (cu pdftotext, din poppler-utils).

Nu actualizeaza nimic automat: o valoare citita gresit dintr-un PDF ar ajunge
direct in calculator. Scrie un raport Markdown (pentru un issue pe GitHub) si
iese cu codul 1 daca e ceva de verificat de mana.
"""

import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent
CONFIG = ROOT / "data" / "furnizori.json"
MAX_AGE_DAYS = 35  # peste atat, o valoare neverificata e semnalata
UA = "Mozilla/5.0 (compatible; pzuro-monitor/1.0; +https://pzuro.ro)"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def pdf_text(data: bytes) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        pdf = Path(tmp) / "oferta.pdf"
        pdf.write_bytes(data)
        out = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, check=True)
        return out.stdout.decode("utf-8", errors="replace")


def parse_value(raw: str) -> float:
    return float(raw.replace(",", "."))


def check_furnizor(f: dict, today: date) -> list[str]:
    """Intoarce lista de probleme gasite pentru un furnizor (goala = totul in regula)."""
    issues = []
    age = (today - date.fromisoformat(f["verificat"])).days
    mon = f.get("monitor")
    if not mon:
        if age > MAX_AGE_DAYS:
            issues.append(f"Valoarea nu a mai fost verificată de {age} zile și nu poate fi verificată automat. Verifică manual: {f['sursa']}")
        return issues

    try:
        page = fetch(mon["pagina"]).decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        return [f"Pagina cu oferte nu a putut fi descărcată ({exc}): {mon['pagina']}"]

    links = sorted(set(re.findall(mon["pdf_regex"], page)))
    if not links:
        return [f"Nu am găsit linkul către PDF-ul ofertei pe {mon['pagina']}. Poate s-a schimbat structura paginii."]
    current = links[-1]  # numele contin luna/anul -> ultimul in ordine e cel mai recent
    if current == f["sursa"]:
        if age > MAX_AGE_DAYS:
            issues.append(f"PDF-ul ofertei este același, dar valoarea nu a mai fost confirmată de {age} zile.")
        return issues

    msg = f"Ofertă nouă publicată: {current}"
    if mon.get("valoare_regex"):
        try:
            m = re.search(mon["valoare_regex"], pdf_text(fetch(current)))
            if m:
                val = parse_value(m.group(1))
                same = abs(val - (f["componenta_furnizare"] or -1)) < 1e-6
                msg += f" — componenta citită: {val} lei/kWh ({'neschimbată' if same else 'DIFERITĂ de ' + str(f['componenta_furnizare'])})"
            else:
                msg += " — valoarea nu a putut fi citită automat din PDF"
        except Exception as exc:  # noqa: BLE001
            msg += f" — PDF-ul nu a putut fi citit ({exc})"
    issues.append(msg + ". După verificare, actualizează `sursa`, `componenta_furnizare`, `valabilitate` și `verificat` în data/furnizori.json.")
    return issues


def build_report(cfg: dict, today: date) -> tuple[str, bool]:
    lines, found = [], False
    for f in cfg["furnizori"]:
        issues = check_furnizor(f, today)
        if issues:
            found = True
            lines.append(f"### {f['oferta']}")
            lines += [f"- {i}" for i in issues]
            lines.append("")
    if not found:
        return "Toate ofertele monitorizate sunt neschimbate.", False
    header = f"Verificarea automată din {today.isoformat()} a găsit oferte care trebuie verificate manual.\n\n"
    return header + "\n".join(lines), True


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # diacritice si pe console Windows
    cfg =json.loads(CONFIG.read_text(encoding="utf-8"))
    report, found = build_report(cfg, date.today())
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if out:
        out.write_text(report, encoding="utf-8")
    print(report)
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
