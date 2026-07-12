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

  function profileWeightedAvg(day, profil) {
    if (profil === "uniform") return day.avg_ron_kwh;
    const cheapAvg = day.cheapest_intervals.reduce((s, i) => s + i.price_ron_kwh, 0) / day.cheapest_intervals.length;
    const pricyAvg = day.priciest_intervals.reduce((s, i) => s + i.price_ron_kwh, 0) / day.priciest_intervals.length;
    if (profil === "noapte") return day.avg_ron_kwh * 0.7 + cheapAvg * 0.3;
    if (profil === "seara") return day.avg_ron_kwh * 0.7 + pricyAvg * 0.3;
    return day.avg_ron_kwh;
  }

  // pretul mediu PZU in fereastra orara tipica de productie solara (10:00-16:00).
  // folosit pentru exportul prosumatorilor: panourile produc indiferent de pret,
  // si in aceasta piata orele de soare coincid de regula cu orele cele mai ieftine
  // -- de-aia NU folosim media zilei pentru export, ar fi optimist.
  function solarWindowAvg(day, startHour, endHour) {
    if (startHour === undefined) startHour = 10;
    if (endHour === undefined) endHour = 16;
    const inWindow = day.intervals.filter((iv) => {
      const h = new Date(iv.start).getHours();
      return h >= startHour && h < endHour;
    });
    if (!inWindow.length) return day.avg_ron_kwh;
    return inWindow.reduce((s, i) => s + i.price_ron_kwh, 0) / inWindow.length;
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

  // parser minimal, fara dependinta externa -- formatul e simplu si fix
  // (timestamp,kwh), definit chiar de noi, deci nu avem nevoie de o
  // librarie intreaga doar pentru asta.
  function parseSimpleCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (!lines.length) return [];
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const tsIdx = header.indexOf("timestamp");
    const kwhIdx = header.indexOf("kwh");
    const rows = [];
    if (tsIdx < 0 || kwhIdx < 0) return rows;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const parts = lines[i].split(",");
      if (parts.length <= Math.max(tsIdx, kwhIdx)) continue;
      const date = new Date(parts[tsIdx].trim().replace(" ", "T"));
      const kwh = parseFloat(parts[kwhIdx].trim());
      if (!isNaN(date.getTime()) && !isNaN(kwh)) rows.push({ date, kwh });
    }
    return rows;
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
    profileWeightedAvg,
    solarWindowAvg,
    inferDurationMinutes,
    parseSimpleCsv,
    overlapMinutes,
    matchIntervalsToArchive,
    toCsv,
  };
});
