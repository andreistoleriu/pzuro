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

### Opțional — notificări Telegram

Daca vrei rezumat zilnic pe un canal Telegram (vezi `notify_telegram.py`), adauga si:
- `TELEGRAM_BOT_TOKEN` — token-ul botului, de la @BotFather
- `TELEGRAM_CHAT_ID` — ID-ul canalului/grupului unde se trimite mesajul

Fara aceste doua secrete, pipeline-ul functioneaza normal, doar fara notificari (script-ul iese curat, nu da eroare).

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

- Calculatorul de factura foloseste, implicit, o **medie ponderata pe profil** (uniform / noapte / seara) -- o estimare, nu o factura exacta. Daca utilizatorul incarca un fisier CSV cu consumul lui real (vezi mai jos), calculul devine exact, interval cu interval.
- Formula exacta per furnizor (cu plafoane pentru preturi negative, taxe specifice etc.) nu e implementata inca -- momentan toti furnizorii folosesc aceeasi formula simplificata.

## Arhiva istorica (data/archive/) si upload CSV

De la 18 iunie 2026, `fetch_prices.py` salveaza si intervalele complete (nu doar rezumatul zilnic) in `data/archive/{data}.json`, un fisier per zi, scris o singura data si niciodata suprascris. Asta alimenteaza un mod nou in Calculator: utilizatorul poate incarca un CSV cu consumul lui real (format `timestamp,kwh`, o linie per interval) si vede costul EXACT pe care l-ar fi avut pe dinamic, calculat interval cu interval, nu pe baza unui profil generic.

Limitare inerenta: arhiva incepe sa se construiasca de acum incolo, nu retroactiv -- zile de inainte de lansarea acestei functionalitati nu au date arhivate, si vor fi excluse automat din calcul (cu avertisment clar in interfata), nu inventate.

Nu exista un format standard de export intre distribuitori (E-Distributie, Delgaz Grid, Distributie Oltenia difera) -- utilizatorul trebuie sa reformateze manual exportul lui in formatul nostru simplu, documentat direct in interfata.
