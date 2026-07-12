// Teste pentru logica pura din js/calc.js. Fortam fusul orar la UTC inainte
// de orice folosire de Date, ca testele sa dea acelasi rezultat indiferent
// de fusul orar al masinii/CI-ului care le ruleaza (getHours() e local-time).
process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fmt, isVisiblyNegative, profileWeightedAvg, solarWindowAvg, inferDurationMinutes, parseSimpleCsv, matchIntervalsToArchive, toCsv } = require("../js/calc.js");

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

function makeDay(avg, cheapPrices, pricyPrices) {
  return {
    avg_ron_kwh: avg,
    cheapest_intervals: cheapPrices.map((p) => ({ price_ron_kwh: p })),
    priciest_intervals: pricyPrices.map((p) => ({ price_ron_kwh: p })),
  };
}

test("profileWeightedAvg: uniform foloseste media zilei", () => {
  const day = makeDay(0.5, [0.1, 0.1], [0.9, 0.9]);
  assert.equal(profileWeightedAvg(day, "uniform"), 0.5);
});

test("profileWeightedAvg: noapte trage media spre orele ieftine", () => {
  const day = makeDay(0.5, [0.1, 0.1], [0.9, 0.9]);
  const result = profileWeightedAvg(day, "noapte");
  assert.ok(result < 0.5, "media ponderata pe noapte trebuie sa fie sub media zilei");
  assert.ok(Math.abs(result - (0.5 * 0.7 + 0.1 * 0.3)) < 1e-9);
});

test("profileWeightedAvg: seara trage media spre orele scumpe", () => {
  const day = makeDay(0.5, [0.1, 0.1], [0.9, 0.9]);
  const result = profileWeightedAvg(day, "seara");
  assert.ok(result > 0.5, "media ponderata pe seara trebuie sa fie peste media zilei");
  assert.ok(Math.abs(result - (0.5 * 0.7 + 0.9 * 0.3)) < 1e-9);
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

test("parseSimpleCsv: header lipsa duce la lista goala", () => {
  const csv = "data,consum\n2026-06-01 00:00,0.32";
  assert.deepEqual(parseSimpleCsv(csv), []);
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
