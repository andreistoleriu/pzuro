# pzuro.app — Faza 1: Pipeline + Portal v1

Portal static care arata preturile PZU (Piata pentru Ziua Urmatoare) pentru
Romania si ajuta utilizatorii cu contracte dinamice (E.ON Dinamic Pro, ENGIE
Elec Flexibil, PPC pret dinamic) sa decida cand sa consume energie.

## Structura

```
pzuro/
  fetch_prices.py          # pipeline-ul de date: ENTSO-E -> data/prices.json + data/history.json
  generate_sample_data.py  # genereaza date FICTIVE pentru testare locala, fara token ENTSO-E
  requirements.txt
  index.html                # portalul (HTML + CSS + JS, Chart.js prin CDN, fara framework)
  data/
    prices.json             # azi + maine, regenerat zilnic
    history.json             # ultimele ~60 de zile (medie/min/max), folosit de tab-ul Istoric
  .github/workflows/fetch-prices.yml   # cron zilnic care ruleaza fetch_prices.py si comite rezultatul
```

## Pas 1 — Token ENTSO-E (5 minute)

1. Mergi pe https://transparency.entsoe.eu/ → Register → confirma email.
2. Dupa logare, in contul tau cere acces API ("Restful API access") — vine de obicei automat.
3. Token-ul apare in setarile contului ("Web Api Security Token").

## Pas 2 — Repo GitHub

```bash
gh repo create pzuro --public --source=. --remote=origin
git add .
git commit -m "init: pipeline + portal v1"
git push -u origin main
```

(Sau manual: creeaza repo-ul "pzuro" pe github.com, apoi `git remote add origin ...` + push.)

## Pas 3 — Adauga secretul

In repo: **Settings → Secrets and variables → Actions → New repository secret**
Nume: `ENTSOE_TOKEN`, valoare: token-ul de la Pasul 1.

## Pas 4 — Testeaza pipeline-ul

- Local, fara token (date fictive, doar pentru a vedea portalul functionand):
  ```bash
  pip install -r requirements.txt  # nu e nevoie de entsoe-py/requests pentru asta
  python generate_sample_data.py
  python -m http.server 8000
  # deschide http://localhost:8000
  ```
- Pe GitHub, cu date reale: tab **Actions → Fetch PZU prices → Run workflow** (buton manual,
  `workflow_dispatch`). Verifica apoi ca `data/prices.json` s-a actualizat cu un commit nou.

## Pas 5 — Deploy

**Vercel**: Import Project → selecteaza repo-ul `pzuro` → Framework Preset: "Other" →
Deploy. Domeniu gratuit `*.vercel.app`.

**GitHub Pages** (alternativa, zero config extra): Settings → Pages → Source: `main` / `/ (root)`.

Important: pentru ambele, `index.html` face `fetch("data/prices.json")` cu cale relativa,
deci trebuie ca `index.html` si `data/` sa fie in aceeasi locatie de hosting (sunt deja, in
acelasi repo).

## Note despre pipeline (fetch_prices.py)

- **Ora de iarna/vara**: cron-ul ruleaza in UTC la o ora fixa (11:15 si 12:15 UTC), care
  corespunde automat la 13:15 / 14:15 ora Romaniei, indiferent de sezon — nu necesita
  ajustare manuala de doua ori pe an. Fereastra de interogare a fiecarei zile foloseste
  `pd.DateOffset(days=1)` (nu `timedelta`), ca sa respecte miezul noptii local si nu o
  durata fixa de 24h — altfel zilele de schimbare a orei (92 sau 100 de intervale de 15
  min, in loc de 96) ar fi calculate gresit.
- **Curs EUR→RON**: preluat de la BNR (`bnr.ro/nbrfxrates.xml`); daca feed-ul e indisponibil,
  se foloseste o valoare implicita si campul `eur_ron_rate_source` din `prices.json` arata
  clar care a fost folosita ("bnr.ro" sau "fallback").
- **Preturi negative**: nu sunt tratate ca eroare; fiecare interval are `is_negative` pentru
  stilizare distincta in UI (violet, nu rosu/verde).
- **"Maine" indisponibil**: daca OPCOM nu a publicat inca, scriptul nu crapa — pastreaza
  `tomorrow: null` si `tomorrow_published: false`, iar portalul dezactiveaza automat
  butonul "Maine".
- **Esec total** (ambele zile indisponibile, ex. ENTSO-E e cazut): scriptul NU suprascrie
  `prices.json` cu date goale — pastreaza ultima versiune buna si returneaza exit code 1,
  ca job-ul sa apara ca failed in Actions.

## Limitari cunoscute ale v1 (de adresat in Faza 3)

- Calculatorul de factura foloseste o **medie ponderata pe profil** (uniform / noapte / seara),
  nu consumul orar real al utilizatorului — e o estimare, nu o factura exacta. Componentele
  reglementate difera pe operator de distributie si sunt editabile manual in formular.
- Formula exacta per furnizor (cu plafoane pentru preturi negative, taxe specifice etc.) nu
  e implementata inca — momentan toti furnizorii folosesc aceeasi formula simplificata.
