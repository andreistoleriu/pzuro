// js/calc.js
// Logica pura de calcul folosita de index.html, extrasa intr-un fisier
// separat ca sa poata fi testata din Node (test/calc.test.js) fara sa
// depinda de un DOM sau de un bundler. UMD minimal: acelasi fisier
// functioneaza si ca <script> global in browser (window.PzuroCalc), si
// ca modul CommonJS in Node (require("./calc.js")).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PzuroCalc = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function fmt(n, d) {
    if (d === undefined) d = 3;
    if (n === null || n === undefined) return "—";
    // evitam afisarea "-0.000" pentru numere foarte mici negative care
    // rotunjesc matematic la zero -- e corect matematic, dar deruteaza
    // vizual (pare o eroare, nu un pret aproape de zero)
    const rounded = n.toFixed(d);
    const clean = rounded === "-" + (0).toFixed(d) ? (0).toFixed(d) : rounded;
    // separator zecimal cu virgula (standard roman), nu punct
    return clean.replace(".", ",");
  }

  // un pret e "vizibil negativ" doar daca ramane negativ DUPA rotunjirea
  // la 3 zecimale -- aceeasi rotunjire folosita de fmt() mai sus. Fara asta,
  // un pret de -0.00004 (care se afiseaza "0.000") tot ar aparea cu bara
  // mov de "pret negativ", desi textul de langa el arata zero -- contradictie
  // vizuala directa intre culoare si cifra.
  function isVisiblyNegative(priceRonKwh) {
    return parseFloat(priceRonKwh.toFixed(3)) < 0;
  }

  // ora locala (Romania) a unui interval, citita direct din sirul ISO: pipeline-ul
  // scrie "2026-09-15T13:00:00+03:00", deci ora din text e deja ora Romaniei.
  // NU folosim new Date(...).getHours() -- aia ar da ora din fusul orar al
  // vizitatorului, gresit pentru cineva care deschide site-ul din strainatate.
  function localHour(iso) {
    return parseInt(iso.slice(11, 13), 10);
  }

  // pretul mediu pe fiecare ora din zi (0-23), dintr-o lista de intervale de
  // 15 minute; null pentru orele fara date (zile incomplete)
  function hourlyAverages(intervals) {
    const sum = new Array(24).fill(0);
    const cnt = new Array(24).fill(0);
    for (const iv of intervals) {
      const h = localHour(iv.start);
      sum[h] += iv.price_ron_kwh;
      cnt[h]++;
    }
    return sum.map((s, h) => (cnt[h] ? s / cnt[h] : null));
  }

  // Ponderi orare ale consumului pentru fiecare profil (nu trebuie sa insumeze 1,
  // se normalizeaza la calcul). Sunt estimari tipice pentru o gospodarie, nu
  // masuratori -- pentru un rezultat exact exista modul cu fisier CSV.
  const PROFILE_WEIGHTS = {
    // 0-5, 6-8, 9-16, 17, 18-22, 23
    uniform: new Array(24).fill(1),
    seara: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.2, 1.2, 1.2, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 1, 2, 2, 2, 2, 2, 1],
    noapte: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 0.8, 0.8, 0.8, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 1.5, 1.5],
    zi: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0.6],
  };

  // media pretului ponderata cu profilul de consum; orele fara date (null)
  // sunt ignorate si ponderile ramase renormalizate
  function profileAvg(hourly, profil) {
    const w = PROFILE_WEIGHTS[profil] || PROFILE_WEIGHTS.uniform;
    let s = 0,
      ws = 0;
    for (let h = 0; h < 24; h++) {
      if (hourly[h] === null || hourly[h] === undefined) continue;
      s += hourly[h] * w[h];
      ws += w[h];
    }
    return ws ? s / ws : null;
  }

  // pretul mediu PZU in fereastra orara tipica de productie solara (10:00-16:00),
  // calculat dintr-un profil orar. Folosit pentru exportul prosumatorilor:
  // panourile produc indiferent de pret, iar orele de soare coincid de regula
  // cu orele cele mai ieftine -- media zilei ar fi prea optimista.
  function solarAvgFromHourly(hourly, startHour, endHour) {
    if (startHour === undefined) startHour = 10;
    if (endHour === undefined) endHour = 16;
    const vals = hourly.slice(startHour, endHour).filter((v) => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  function solarWindowAvg(day, startHour, endHour) {
    if (startHour === undefined) startHour = 10;
    if (endHour === undefined) endHour = 16;
    const inWindow = day.intervals.filter((iv) => {
      const h = localHour(iv.start);
      return h >= startHour && h < endHour;
    });
    if (!inWindow.length) return day.avg_ron_kwh;
    return inWindow.reduce((s, i) => s + i.price_ron_kwh, 0) / inWindow.length;
  }

  // pretul final estimat pe kWh: PZU + tarife reglementate + componenta de
  // furnizare, toate cu TVA. Tarifele si componenta sunt fixe pe kWh, deci
  // diferenta dintre doua intervale ramane doar diferenta de pret PZU (cu TVA).
  function finalPrice(pzu, reglementate, componenta, tva) {
    if (tva === undefined) tva = 0.21;
    return (pzu + reglementate + componenta) * (1 + tva);
  }

  // suma tarifelor reglementate (fara TVA) pentru un operator de distributie,
  // din structura "tarife" din data/furnizori.json
  function regulatedTotal(tarife, operatorId) {
    const op = tarife.operatori.find((o) => o.id === operatorId);
    if (!op) return null;
    const c = tarife.comune;
    return c.transport_tl + c.servicii_sistem + c.certificate_verzi + c.cogenerare + c.acciza + c.cfd + op.distributie_jt;
  }

  // o zi e completa daca are toate intervalele asteptate. Zilele noi au campul
  // "complete" scris de pipeline; pentru cele vechi, fara camp, acceptam doar
  // numerele posibile pentru o zi intreaga (92/96/100, dupa schimbarea orei).
  function isCompleteDay(day) {
    if (!day) return false;
    if (typeof day.complete === "boolean") return day.complete;
    const n = day.interval_count !== undefined ? day.interval_count : (day.intervals || []).length;
    return n === 92 || n === 96 || n === 100;
  }

  // Cea mai ieftina si cea mai scumpa fereastra continua de `durationMin`
  // minute (ex. un ciclu de masina de spalat de 2h). Intervalele trebuie sa fie
  // consecutive: o fereastra nu trece peste o gaura in date. `notBeforeMs`
  // exclude ferestrele care incep in trecut (pentru ziua de azi), iar
  // `startBeforeMs` pe cele care ar incepe prea tarziu (ex. abia maine) --
  // fereastra poate totusi sa se termine dupa acest moment.
  function bestWindows(intervals, durationMin, notBeforeMs, startBeforeMs) {
    if (!intervals.length) return null;
    const stepMs = new Date(intervals[0].end) - new Date(intervals[0].start);
    const k = Math.max(1, Math.round((durationMin * 60000) / stepMs));
    let best = null,
      worst = null;
    let runStart = 0,
      sum = 0;
    for (let i = 0; i < intervals.length; i++) {
      if (i > 0 && intervals[i].start !== intervals[i - 1].end) {
        // gaura in date: o luam de la capat
        runStart = i;
        sum = 0;
      }
      sum += intervals[i].price_ron_kwh;
      if (i - runStart + 1 > k) sum -= intervals[i - k].price_ron_kwh;
      if (i - runStart + 1 < k) continue;
      const first = intervals[i - k + 1];
      const firstMs = new Date(first.start).getTime();
      if (notBeforeMs !== undefined && notBeforeMs !== null && firstMs < notBeforeMs) continue;
      if (startBeforeMs !== undefined && startBeforeMs !== null && firstMs >= startBeforeMs) continue;
      const w = { start: first.start, end: intervals[i].end, avg: sum / k };
      if (!best || w.avg < best.avg) best = w;
      if (!worst || w.avg > worst.avg) worst = w;
    }
    return best ? { best, worst } : null;
  }

  // mediana intervalului dintre citiri consecutive -- mai robust decat
  // diferenta primelor doua randuri, in caz ca fisierul are un gap/lipsa
  function inferDurationMinutes(sortedDates) {
    if (sortedDates.length < 2) return 60; // presupunem citiri orare, implicit
    const gaps = [];
    for (let i = 1; i < sortedDates.length; i++) gaps.push((sortedDates[i] - sortedDates[i - 1]) / 60000);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  // offset-ul (in minute) al orei Romaniei fata de UTC intr-un anumit moment
  function roOffsetMinutes(utcMs) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Bucharest",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return Math.round((asUtc - utcMs) / 60000);
  }

  // data+ora citita din fisier e ora Romaniei (asa exporta distribuitorii),
  // indiferent de fusul orar al browserului care citeste fisierul
  function roLocalToDate(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const off = roOffsetMinutes(guess - 3 * 3600000);
    return new Date(guess - off * 60000);
  }

  const stripDiacritics = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

  // "0,32" / "0.32" / "1.234,5" / "1,234.5" -> numar
  function parseNumber(raw) {
    let s = String(raw).replace(/["'\s]/g, "");
    if (!s) return NaN;
    const lastComma = s.lastIndexOf(","),
      lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  }

  // data (+ ora optionala) in formatele uzuale: 2026-06-01, 01.06.2026,
  // 01/06/2026, 01-06-2026, urmate optional de HH:MM[:SS]
  function parseDateParts(raw) {
    const s = String(raw).replace(/"/g, "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
    m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
    if (m) return { y: +m[3], mo: +m[2], d: +m[1], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
    return null;
  }

  // ora dintr-o coloana separata: "13:00", "13:00-14:00", "13:00 - 13:15", "13"
  function parseTimeParts(raw) {
    const s = String(raw).replace(/"/g, "").trim();
    let m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) return { h: +m[1], mi: +m[2] };
    m = s.match(/^(\d{1,2})$/);
    if (m) return { h: +m[1], mi: 0 };
    return null;
  }

  function splitLine(line, delim) {
    const out = [];
    let cur = "",
      q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === delim && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  }

  // Parser tolerant pentru exporturile de consum ale distribuitorilor:
  // detecteaza separatorul (; , tab), randul de antet, coloanele de data/ora si
  // de consum, virgula zecimala si unitatea (Wh/kWh/MWh). Fara dependinte externe.
  // Intoarce { rows, error, info }.
  function parseConsumptionCsv(text) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { rows: [], error: "Fișierul este gol." };

    const scoreDelim = (d) => lines.slice(0, 10).reduce((n, l) => n + (l.split(d).length - 1), 0);
    const delim = [";", "\t", ","].map((d) => [d, scoreDelim(d)]).sort((a, b) => b[1] - a[1])[0][0];

    // antetul = primul rand (din primele 15) care contine litere si o coloana de consum recognoscibila
    const norm = (h) => stripDiacritics(h.toLowerCase()).replace(/\s+/g, " ").trim();
    const isEnergyCol = (h) => /kwh|\bwh\b|mwh|consum|energie|activa|valoare|cantitate|import/.test(h);
    const isTsCol = (h) => /timestamp|data ?(si|\/|_|-)? ?ora|datetime|date ?time|perioada|interval de timp/.test(h);
    const isDateCol = (h) => /^(data|date|ziua|zi|data citire|data masurare)$/.test(h) || /^data\b/.test(h);
    const isTimeCol = (h) => /^(ora|time|hour|interval|interval orar|ora citire)$/.test(h) || /^ora\b/.test(h);

    let headerIdx = -1,
      header = [];
    for (let i = 0; i < Math.min(15, lines.length); i++) {
      const cols = splitLine(lines[i], delim).map(norm);
      if (cols.some((c) => /[a-z]/.test(c)) && cols.some(isEnergyCol) && cols.some((c) => isTsCol(c) || isDateCol(c))) {
        headerIdx = i;
        header = cols;
        break;
      }
    }
    if (headerIdx < 0) {
      return { rows: [], error: "Nu am găsit coloanele de dată și de consum. Fișierul trebuie să aibă un rând de antet, de exemplu „Data;Ora;Consum (kWh)” sau „timestamp,kwh”." };
    }

    const tsIdx = header.findIndex(isTsCol);
    const dateIdx = tsIdx >= 0 ? tsIdx : header.findIndex(isDateCol);
    const timeIdx = tsIdx >= 0 ? -1 : header.findIndex((c, i) => i !== dateIdx && isTimeCol(c));
    // coloana de consum: preferam consum/import/kwh si evitam export/injectie/productie
    const candidates = header
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => i !== dateIdx && i !== timeIdx && isEnergyCol(c) && !/export|injectat|injectie|produs|productie|livrat/.test(c));
    if (!candidates.length) return { rows: [], error: "Nu am găsit o coloană cu consumul (kWh)." };
    const rank = ({ c }) => (/consum|import/.test(c) ? 2 : 0) + (/kwh/.test(c) ? 1 : 0);
    const kwhCol = candidates.sort((a, b) => rank(b) - rank(a))[0];
    const unitFactor = /mwh/.test(kwhCol.c) ? 1000 : /kwh/.test(kwhCol.c) ? 1 : /\bwh\b/.test(kwhCol.c) ? 0.001 : 1;

    // orele 1-24 (ora 24 = ultima ora a zilei) se muta cu o ora inapoi
    const dataLines = lines.slice(headerIdx + 1).map((l) => splitLine(l, delim));
    let hourShift = 0;
    if (timeIdx >= 0) {
      const hours = dataLines.map((p) => parseTimeParts(p[timeIdx] || "")).filter(Boolean).map((t) => t.h);
      if (hours.includes(24) && !hours.includes(0)) hourShift = -1;
    }

    const rows = [];
    let skipped = 0;
    for (const parts of dataLines) {
      const dp = parseDateParts(parts[dateIdx] || "");
      let h = dp ? dp.h : null,
        mi = dp ? dp.mi : null;
      if (dp && timeIdx >= 0) {
        const tp = parseTimeParts(parts[timeIdx] || "");
        if (tp) {
          h = tp.h + hourShift;
          mi = tp.mi;
        }
      }
      const kwh = parseNumber(parts[kwhCol.i] || "") * unitFactor;
      if (!dp || h === null || isNaN(kwh) || h < 0 || h > 23) {
        skipped++;
        continue;
      }
      rows.push({ date: roLocalToDate(dp.y, dp.mo, dp.d, h, mi), kwh });
    }
    return {
      rows,
      error: rows.length ? null : "Nu am putut citi niciun rând valid.",
      info: { delimiter: delim, kwhColumn: kwhCol.c, unitFactor, skipped },
    };
  }

  // compatibilitate: varianta veche intorcea direct lista de randuri
  function parseSimpleCsv(text) {
    return parseConsumptionCsv(text).rows;
  }

  // suprapunerea (in minute) dintre doua intervale [aStart,aEnd) si [bStart,bEnd)
  function overlapMinutes(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 60000;
  }

  // Partea de calcul pur din matchCsvToArchive (index.html): primeste randurile
  // CSV deja sortate si arhivele PZU deja incarcate (dayKey -> {intervals:[...]})
  // si calculeaza costul PZU exact prin suprapunerea fiecarui rand CSV cu
  // intervalele PZU de 15 minute pe care le acopera. Separata de fetch()-urile
  // catre data/archive/*.json ca sa poata fi testata fara retea/fisiere.
  function matchIntervalsToArchive(sortedRows, archives, dayFmt, durationMin) {
    const durationMs = durationMin * 60000;
    let totalKwh = 0,
      matchedKwh = 0,
      costPzuRaw = 0;
    const missingDates = [];
    const neededDates = [];
    const seen = new Set();
    for (const row of sortedRows) {
      const dayKey = dayFmt(row.date);
      if (!seen.has(dayKey)) {
        seen.add(dayKey);
        neededDates.push(dayKey);
      }
    }
    for (const row of sortedRows) {
      totalKwh += row.kwh;
      const dayKey = dayFmt(row.date);
      const archive = archives[dayKey];
      if (!archive) {
        if (missingDates.indexOf(dayKey) === -1) missingDates.push(dayKey);
        continue; // zi nearhivata -- exclusa, nu inventam date
      }
      const rowStart = row.date.getTime();
      const rowEnd = rowStart + durationMs;
      for (const iv of archive.intervals) {
        const ivStart = new Date(iv.start).getTime();
        const ivEnd = new Date(iv.end).getTime();
        const overlapMin = overlapMinutes(rowStart, rowEnd, ivStart, ivEnd);
        if (overlapMin <= 0) continue;
        const kwhSlice = row.kwh * (overlapMin / durationMin);
        costPzuRaw += kwhSlice * iv.price_ron_kwh;
        matchedKwh += kwhSlice;
      }
    }
    return { totalKwh, matchedKwh, excludedKwh: totalKwh - matchedKwh, costPzuRaw, missingDates, neededDates, durationMin };
  }

  // construieste text CSV dintr-un antet si un tabel de randuri -- separat
  // de partea de descarcare (Blob/anchor), care are nevoie de DOM si ramane
  // in index.html. Delimitator implicit ";" (nu ",") pentru ca preturile
  // folosesc deja virgula ca separator zecimal (fmt(), standard roman) --
  // Excel pe Windows cu regiunea Romania foloseste ";" ca separator de lista
  // exact din acest motiv, si deschide fisierul corect la dublu-click, fara
  // sa ceara import manual.
  function toCsv(headers, rows, delimiter) {
    if (delimiter === undefined) delimiter = ";";
    const needsQuote = new RegExp('["' + delimiter + "\\r\\n]");
    const escapeCell = (v) => {
      const s = String(v);
      return needsQuote.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [headers, ...rows].map((row) => row.map(escapeCell).join(delimiter)).join("\r\n");
  }

  return {
    fmt,
    isVisiblyNegative,
    localHour,
    hourlyAverages,
    PROFILE_WEIGHTS,
    profileAvg,
    solarAvgFromHourly,
    solarWindowAvg,
    finalPrice,
    regulatedTotal,
    isCompleteDay,
    bestWindows,
    inferDurationMinutes,
    parseNumber,
    parseConsumptionCsv,
    parseSimpleCsv,
    roLocalToDate,
    overlapMinutes,
    matchIntervalsToArchive,
    toCsv,
  };
});
