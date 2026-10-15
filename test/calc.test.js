// Teste pentru logica pura din js/calc.js. Fortam fusul orar la UTC inainte
// de orice folosire de Date, ca testele sa dea acelasi rezultat indiferent
// de fusul orar al masinii/CI-ului care le ruleaza (getHours() e local-time).
process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fmt, isVisiblyNegative, hourlyAverages, profileAvg, solarAvgFromHourly, solarWindowAvg, finalPrice, regulatedTotal, isCompleteDay, bestWindows, inferDurationMinutes, parseNumber, parseConsumptionCsv, parseSimpleCsv, matchIntervalsToArchive, toCsv } = require("../js/calc.js");

test("fmt: rotunjeste si foloseste virgula zecimala", () => {
  assert.equal(fmt(0.4534, 3), "0,453");
  assert.equal(fmt(1.2, 2), "1,20");
});

test("fmt: null/undefined devine liniuta", () => {
  assert.equal(fmt(null), "—");
  assert.equal(fmt(undefined), "—");
});

test("fmt: nu afiseaza -0,000 pentru negative foarte mici", () => {
  assert.equal(fmt(-0.00004, 3), "0,000");
});

test("fmt: pastreaza semnul negativ cand chiar e negativ dupa rotunjire", () => {
  assert.equal(fmt(-0.5, 3), "-0,500");
});

test("isVisiblyNegative: prag pe rotunjirea la 3 zecimale", () => {
  assert.equal(isVisiblyNegative(-0.00004), false); // rotunjeste la 0.000
  assert.equal(isVisiblyNegative(-0.001), true);
  assert.equal(isVisiblyNegative(0.001), false);
});

test("solarWindowAvg: mediaza doar intervalele din fereastra orara", () => {
  const day = {
    avg_ron_kwh: 1,
    intervals: [
      { start: "2026-01-01T05:00:00Z", price_ron_kwh: 10 }, // in afara ferestrei
      { start: "2026-01-01T11:00:00Z", price_ron_kwh: 0.2 }, // in fereastra 10-16
      { start: "2026-01-01T13:00:00Z", price_ron_kwh: 0.4 }, // in fereastra 10-16
      { start: "2026-01-01T20:00:00Z", price_ron_kwh: 10 }, // in afara ferestrei
    ],
  };
  assert.ok(Math.abs(solarWindowAvg(day, 10, 16) - 0.3) < 1e-9);
});

test("solarWindowAvg: fallback pe media zilei daca fereastra e goala", () => {
  const day = { avg_ron_kwh: 0.42, intervals: [{ start: "2026-01-01T02:00:00Z", price_ron_kwh: 5 }] };
  assert.equal(solarWindowAvg(day, 10, 16), 0.42);
});

test("inferDurationMinutes: detecteaza intervalul de 15 minute", () => {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const dates = [0, 15, 30, 45, 60].map((m) => new Date(base + m * 60000));
  assert.equal(inferDurationMinutes(dates), 15);
});

test("inferDurationMinutes: fallback la 60 pentru mai putin de 2 citiri", () => {
  assert.equal(inferDurationMinutes([new Date()]), 60);
});

test("parseSimpleCsv: parseaza randuri valide", () => {
  const csv = "timestamp,kwh\n2026-06-01 00:00,0.32\n2026-06-01 01:00,0.41";
  const rows = parseSimpleCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kwh, 0.32);
  assert.equal(rows[1].kwh, 0.41);
});


test("parseSimpleCsv: ignora randuri invalide, pastreaza restul", () => {
  const csv = "timestamp,kwh\nnu-e-o-data,0.32\n2026-06-01 01:00,nu-e-un-numar\n2026-06-01 02:00,0.5";
  const rows = parseSimpleCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kwh, 0.5);
});

test("matchIntervalsToArchive: calculeaza costul PZU prin suprapunere interval", () => {
  const dayFmt = (d) => d.toISOString().slice(0, 10);
  const rows = [{ date: new Date("2026-06-01T00:00:00Z"), kwh: 1 }];
  const archives = {
    "2026-06-01": {
      intervals: [
        { start: "2026-06-01T00:00:00Z", end: "2026-06-01T00:30:00Z", price_ron_kwh: 0.5 },
        { start: "2026-06-01T00:30:00Z", end: "2026-06-01T01:00:00Z", price_ron_kwh: 0.9 },
      ],
    },
  };
  // randul CSV acopera 60 min (00:00-01:00), suprapus peste doua intervale
  // de 30 min fiecare -> jumatate din kwh la fiecare pret
  const result = matchIntervalsToArchive(rows, archives, dayFmt, 60);
  assert.equal(result.totalKwh, 1);
  assert.ok(Math.abs(result.matchedKwh - 1) < 1e-9);
  assert.ok(Math.abs(result.costPzuRaw - (0.5 * 0.5 + 0.5 * 0.9)) < 1e-9);
  assert.deepEqual(result.missingDates, []);
});

test("toCsv: implicit foloseste ; ca delimitator (compatibil Excel RO)", () => {
  const csv = toCsv(["Ora", "Preț"], [["00:00", "0.5"], ["00:15", "0.6"]]);
  assert.equal(csv, "Ora;Preț\r\n00:00;0.5\r\n00:15;0.6");
});

test("toCsv: NU escapeaza pretul cu virgula zecimala cand delimitatorul e ;", () => {
  const csv = toCsv(["Ora", "Preț"], [["00:00", "0,453"]]);
  assert.equal(csv, "Ora;Preț\r\n00:00;0,453");
});

test("toCsv: escapeaza celule ce contin chiar delimitatorul sau ghilimele", () => {
  const csv = toCsv(["A", "B"], [["are; punct-virgula", 'are "ghilimele"']]);
  assert.equal(csv, 'A;B\r\n"are; punct-virgula";"are ""ghilimele"""');
});

test("toCsv: accepta un delimitator custom (,)", () => {
  const csv = toCsv(["A", "B"], [["are, virgula", "simplu"]], ",");
  assert.equal(csv, 'A,B\r\n"are, virgula",simplu');
});

test("matchIntervalsToArchive: zilele nearhivate sunt excluse, nu inventate", () => {
  const dayFmt = (d) => d.toISOString().slice(0, 10);
  const rows = [{ date: new Date("2026-06-02T00:00:00Z"), kwh: 2 }];
  const result = matchIntervalsToArchive(rows, {}, dayFmt, 60);
  assert.equal(result.totalKwh, 2);
  assert.equal(result.matchedKwh, 0);
  assert.equal(result.excludedKwh, 2);
  assert.deepEqual(result.missingDates, ["2026-06-02"]);
});

// ---------- profil orar, pret final, tarife ----------

function iv(startIso, endIso, price) {
  return { start: startIso, end: endIso, price_ron_kwh: price };
}

test("hourlyAverages: mediaza pe ora locala din sirul ISO, nu pe fusul vizitatorului", () => {
  const ivs = [
    iv("2026-06-01T13:00:00+03:00", "2026-06-01T13:15:00+03:00", 0.2),
    iv("2026-06-01T13:15:00+03:00", "2026-06-01T13:30:00+03:00", 0.4),
    iv("2026-06-01T20:00:00+03:00", "2026-06-01T20:15:00+03:00", 1.5),
  ];
  const h = hourlyAverages(ivs);
  assert.ok(Math.abs(h[13] - 0.3) < 1e-9);
  assert.equal(h[20], 1.5);
  assert.equal(h[0], null);
});

test("profileAvg: uniform = media orelor; seara trage spre orele de seara", () => {
  const hourly = new Array(24).fill(0.5);
  for (let x = 18; x <= 22; x++) hourly[x] = 1.5;
  const uni = profileAvg(hourly, "uniform");
  assert.ok(Math.abs(uni - (19 * 0.5 + 5 * 1.5) / 24) < 1e-9);
  assert.ok(profileAvg(hourly, "seara") > uni);
  assert.ok(profileAvg(hourly, "noapte") < uni);
});

test("profileAvg: ignora orele fara date", () => {
  const hourly = new Array(24).fill(null);
  hourly[3] = 0.4;
  assert.equal(profileAvg(hourly, "seara"), 0.4);
});

test("solarAvgFromHourly: media orelor 10-15", () => {
  const hourly = new Array(24).fill(9);
  for (let x = 10; x < 16; x++) hourly[x] = 0.3;
  assert.ok(Math.abs(solarAvgFromHourly(hourly) - 0.3) < 1e-9);
});

test("finalPrice: PZU + reglementate + componenta, cu TVA", () => {
  assert.ok(Math.abs(finalPrice(0.5, 0.45, 0.2, 0.21) - 1.15 * 1.21) < 1e-9);
});

test("regulatedTotal: componente comune + distributie pe operator", () => {
  const tarife = {
    comune: { transport_tl: 0.1, servicii_sistem: 0.01, certificate_verzi: 0.07, cogenerare: 0.01, acciza: 0.01, cfd: 0 },
    operatori: [{ id: "x", distributie_jt: 0.3 }],
  };
  assert.ok(Math.abs(regulatedTotal(tarife, "x") - 0.5) < 1e-9);
  assert.equal(regulatedTotal(tarife, "lipsa"), null);
});

test("isCompleteDay: foloseste campul complete, altfel numarul de intervale", () => {
  assert.equal(isCompleteDay({ complete: false, interval_count: 96 }), false);
  assert.equal(isCompleteDay({ interval_count: 96 }), true);
  assert.equal(isCompleteDay({ interval_count: 100 }), true);
  assert.equal(isCompleteDay({ interval_count: 93 }), false);
});

// ---------- fereastra cea mai ieftina ----------

function series(startMs, prices) {
  return prices.map((p, i) =>
    iv(new Date(startMs + i * 900000).toISOString(), new Date(startMs + (i + 1) * 900000).toISOString(), p)
  );
}

test("bestWindows: gaseste fereastra continua cea mai ieftina si cea mai scumpa", () => {
  const t0 = Date.UTC(2026, 5, 1);
  const s = series(t0, [5, 5, 1, 1, 1, 1, 5, 9, 9, 9, 9, 5]);
  const r = bestWindows(s, 60);
  assert.equal(r.best.start, s[2].start);
  assert.equal(r.best.end, s[5].end);
  assert.equal(r.best.avg, 1);
  assert.equal(r.worst.start, s[7].start);
  assert.equal(r.worst.avg, 9);
});

test("bestWindows: exclude ferestrele care incep in trecut", () => {
  const t0 = Date.UTC(2026, 5, 1);
  const s = series(t0, [1, 1, 1, 1, 5, 5, 5, 5, 3, 3, 3, 3]);
  const r = bestWindows(s, 60, t0 + 4 * 900000);
  assert.equal(r.best.start, s[8].start);
});

test("bestWindows: nu trece peste o gaura in date", () => {
  const t0 = Date.UTC(2026, 5, 1);
  const a = series(t0, [1, 1]);
  const b = series(t0 + 3 * 3600000, [1, 1]); // lipsesc intervale intre a si b
  assert.equal(bestWindows(a.concat(b), 60), null);
});

test("bestWindows: null daca nu exista nicio fereastra destul de lunga", () => {
  assert.equal(bestWindows(series(Date.UTC(2026, 5, 1), [1, 2]), 60), null);
});

// ---------- CSV tolerant ----------

test("parseNumber: virgula zecimala si separatori de mii", () => {
  assert.equal(parseNumber("0,32"), 0.32);
  assert.equal(parseNumber("0.32"), 0.32);
  assert.equal(parseNumber("1.234,5"), 1234.5);
  assert.equal(parseNumber("1,234.5"), 1234.5);
  assert.ok(isNaN(parseNumber("abc")));
});

test("parseConsumptionCsv: accepta data,consum (format simplu cu alt antet)", () => {
  const r = parseConsumptionCsv("data,consum\n2026-06-01 00:00,0.32");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kwh, 0.32);
});

test("parseConsumptionCsv: interpreteaza ora ca ora Romaniei", () => {
  const r = parseConsumptionCsv("timestamp,kwh\n2026-06-01 13:00,1");
  // vara: Romania = UTC+3
  assert.equal(r.rows[0].date.toISOString(), "2026-06-01T10:00:00.000Z");
  const w = parseConsumptionCsv("timestamp,kwh\n2026-01-15 13:00,1");
  // iarna: Romania = UTC+2
  assert.equal(w.rows[0].date.toISOString(), "2026-01-15T11:00:00.000Z");
});

test("parseConsumptionCsv: export tip distribuitor cu ; data/ora separate si virgula zecimala", () => {
  const csv = "Loc de consum;123456\n\nData;Ora;Consum activ (kWh);Energie injectata (kWh)\n01.06.2026;00:00 - 01:00;0,412;0,000\n01.06.2026;01:00 - 02:00;0,388;0,000";
  const r = parseConsumptionCsv(csv);
  assert.equal(r.error, null);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].kwh, 0.412);
  assert.equal(r.rows[1].date.toISOString(), "2026-05-31T22:00:00.000Z");
  assert.match(r.info.kwhColumn, /consum/);
});

test("parseConsumptionCsv: orele 1-24 sunt mutate cu o ora inapoi", () => {
  const csv = "Data;Ora;Consum kWh\n01.06.2026;1;0,5\n01.06.2026;24;0,7";
  const r = parseConsumptionCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].date.toISOString(), "2026-05-31T21:00:00.000Z"); // 00:00 ora RO
  assert.equal(r.rows[1].date.toISOString(), "2026-06-01T20:00:00.000Z"); // 23:00 ora RO
});

test("parseConsumptionCsv: converteste Wh in kWh", () => {
  const r = parseConsumptionCsv("Data si ora;Consum (Wh)\n2026-06-01 00:00;450");
  assert.equal(r.rows[0].kwh, 0.45);
});

test("parseConsumptionCsv: mesaj clar cand nu recunoaste coloanele", () => {
  const r = parseConsumptionCsv("a,b\n1,2");
  assert.equal(r.rows.length, 0);
  assert.ok(r.error);
});

test("bestWindows: startBeforeMs exclude ferestrele care ar incepe prea tarziu, dar permite terminarea dupa", () => {
  const t0 = Date.UTC(2026, 5, 1);
  // 8 intervale; cele mai ieftine sunt la final, dar startul e limitat la primele 6
  const s = series(t0, [5, 5, 5, 5, 3, 1, 1, 1]);
  const r = bestWindows(s, 60, null, t0 + 5 * 900000);
  assert.equal(r.best.start, s[4].start); // 3,1,1,1 -> incepe la indexul 4 si se termina dupa limita
  assert.equal(r.best.end, s[7].end);
});
