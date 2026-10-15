// js/app.js
// Interfata pzuro.app: citeste datele (prices/history/stats/furnizori), randeaza
// tab-urile si leaga controalele. Logica pura de calcul (testata) e in js/calc.js,
// incarcat inaintea acestui fisier -- aici doar o folosim.
(function () {
  "use strict";

  const CYAN = "#0F8A93", AMBER = "#D9722C", VIOLET = "#7B5EEA", INKSOFT = "#5B5F6B", INK = "#1E2128";
  const {
    fmt, isVisiblyNegative, hourlyAverages, profileAvg, solarAvgFromHourly, finalPrice, regulatedTotal,
    isCompleteDay, bestWindows, inferDurationMinutes, parseConsumptionCsv, matchIntervalsToArchive, toCsv,
  } = window.PzuroCalc;

  const $ = (id) => document.getElementById(id);

  let pricesData = null, historyData = null, statsData = null, cfg = null;
  let activeDay = "today";
  let mainChart = null, historyChart = null;
  let csvMatchResult = null;

  // ---------- preferinte salvate local (doar in browserul vizitatorului) ----------
  // try/catch peste tot: in modul privat sau cu cookie-urile blocate,
  // localStorage poate arunca exceptii -- pagina trebuie sa mearga oricum
  const store = {
    get(k, def) {
      try { const v = localStorage.getItem("pzuro." + k); return v === null ? def : JSON.parse(v); }
      catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem("pzuro." + k, JSON.stringify(v)); } catch (e) { /* ignorat */ }
    },
  };
  let priceMode = store.get("priceMode", "piata");

  // descarca un fisier text generat in browser; BOM UTF-8 la inceput ca Excel
  // sa citeasca diacriticele corect la dublu-click
  function downloadTextFile(filename, text, mime) {
    const blob = new Blob(["﻿" + text], { type: (mime || "text/csv") + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function timeLabel(iso) {
    return new Date(iso).toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bucharest" });
  }

  function dayLabel(key) { return key === "tomorrow" ? "mâine" : "azi"; }

  function colorFor(interval, min, max) {
    if (isVisiblyNegative(interval.price_ron_kwh)) return VIOLET;
    const range = max - min || 1;
    const pos = (interval.price_ron_kwh - min) / range;
    if (pos < 0.33) return CYAN;
    if (pos > 0.66) return AMBER;
    return INKSOFT;
  }

  // ---------- furnizori si tarife (din data/furnizori.json) ----------
  function furnizorById(id) { return cfg.furnizori.find((f) => f.id === id); }

  // ce adaugam peste PZU pentru un furnizor: componenta de furnizare plus
  // dezechilibrul estimat, acolo unde furnizorul il factureaza separat
  function marjaOficiala(f) {
    if (!f || f.componenta_furnizare === null) return null;
    return Math.round((f.componenta_furnizare + (f.dezechilibru_estimat || 0)) * 1e5) / 1e5;
  }

  function operatorForJudet(judet) {
    return cfg.tarife.operatori.find((o) => o.judete.indexOf(judet) >= 0) || null;
  }

  function regulatedForJudet(judet) {
    if (judet === "medie") {
      const vals = cfg.tarife.operatori.map((o) => regulatedTotal(cfg.tarife, o.id));
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const op = operatorForJudet(judet);
    return op ? regulatedTotal(cfg.tarife, op.id) : null;
  }

  const num = (id) => parseFloat($(id).value) || 0;

  // pretul afisat: de piata sau final estimat, dupa modul ales in antet.
  // Tarifele si componenta de furnizare sunt fixe pe kWh, deci ordinea
  // intervalelor (ieftin/scump) ramane aceeasi in ambele moduri.
  function disp(p) {
    if (priceMode !== "final") return p;
    return finalPrice(p, num("reglementate"), num("marja"), cfg ? cfg.tva : 0.21);
  }

  function renderPriceNote() {
    const note = $("priceNote");
    if (priceMode === "final") {
      const f = furnizorById($("furnizor").value);
      const j = $("judet").value;
      const zona = j === "medie" ? "media națională a tarifelor" : j === "manual" ? "tarifele introduse de tine" : "județul " + j;
      note.innerHTML = `Preț final estimat, cu taxe și TVA: ${f ? f.oferta : "furnizorul ales"}, ${zona}. <a href="#calculator" id="noteCalcLink" style="color:#9FD6DA;">Schimbă în Calculator</a>`;
      $("noteCalcLink").addEventListener("click", (e) => { e.preventDefault(); selectTab("calc"); $("panel-calc").scrollIntoView({ behavior: "smooth" }); });
    } else {
      note.innerHTML = "Preț de piață PZU, fără tarife reglementate, componenta de furnizare și TVA.";
    }
    $("modePiata").setAttribute("aria-pressed", priceMode === "piata" ? "true" : "false");
    $("modeFinal").setAttribute("aria-pressed", priceMode === "final" ? "true" : "false");
  }

  // ---------- antet: pretul curent + banda de 96 de bare (mereu ziua de azi) ----------
  function currentInterval(day) {
    const now = new Date();
    return day.intervals.find((iv) => now >= new Date(iv.start) && now < new Date(iv.end)) || null;
  }

  function renderHeader() {
    const day = pricesData.today;
    if (!day) { $("nowPillText").textContent = "Date indisponibile"; return; }
    const current = currentInterval(day) || day.intervals[0];
    $("nowPrice").innerHTML = fmt(disp(current.price_ron_kwh)) + " <small>lei/kWh</small>";
    $("nowPillText").textContent = isVisiblyNegative(current.price_ron_kwh) ? "Preț de piață negativ în acest interval" : "Preț PZU în timp real";

    const strip = $("pulseStrip");
    strip.innerHTML = "";
    const maxAbs = Math.max(...day.intervals.map((i) => Math.abs(i.price_ron_kwh)), 0.01);
    day.intervals.forEach((iv) => {
      const bar = document.createElement("div");
      bar.className = "bar" + (iv === current ? " now" : "");
      bar.style.height = Math.max(8, Math.round((Math.abs(iv.price_ron_kwh) / maxAbs) * 44)) + "px";
      bar.style.background = colorFor(iv, day.min_ron_kwh, day.max_ron_kwh);
      bar.title = timeLabel(iv.start) + " — " + fmt(disp(iv.price_ron_kwh)) + " lei/kWh";
      strip.appendChild(bar);
    });
    renderFreshness();
    renderPriceNote();
  }

  function renderFreshness() {
    const el = $("freshness");
    if (!pricesData.generated_at) { el.textContent = ""; return; }
    const ageH = (Date.now() - new Date(pricesData.generated_at).getTime()) / 36e5;
    const label = ageH < 1 ? "Actualizat acum câteva minute"
      : ageH < 24 ? `Actualizat acum ${Math.round(ageH)} h`
      : `Actualizat acum ${Math.round(ageH / 24)} zile`;
    // peste ~30h: cron-ul zilnic (2 incercari/zi) a ratat de doua ori la rand;
    // peste ~72h: probabil sursa ENTSO-E are o problema prelungita
    if (ageH > 72) {
      el.textContent = `⚠ ${label}. Datele au mai mult de 3 zile: sursa ENTSO-E nu răspunde momentan.`;
      el.style.color = "#D9722C";
    } else if (ageH > 30) {
      el.textContent = `⚠ ${label}. Este posibil ca datele să nu fie la zi.`;
      el.style.color = "#E8A66B";
    } else {
      el.textContent = label;
      el.style.color = "#AEB3BD";
    }
  }

  // ---------- selectorul global Azi / Mâine ----------
  function tomorrowReady() {
    const t = pricesData.tomorrow;
    return !!(pricesData.tomorrow_published && t && (t.interval_count ?? (t.intervals ? t.intervals.length : 0)) >= 80);
  }

  function setActiveDay(key) {
    activeDay = key;
    $("btnToday").setAttribute("aria-pressed", key === "today" ? "true" : "false");
    $("btnTomorrow").setAttribute("aria-pressed", key === "tomorrow" ? "true" : "false");
    renderDayDependent();
  }

  function renderDayDependent() {
    safeRender(renderVerdict);
    safeRender(renderMainChart);
    safeRender(renderTopHours);
    safeRender(renderWindow);
  }

  // ---------- rezumatul zilei (deasupra tab-urilor) ----------
  function renderVerdict() {
    const day = pricesData[activeDay] || pricesData.today;
    const card = $("verdictCard");
    if (!day || !day.cheapest_intervals || !day.cheapest_intervals.length) { card.style.display = "none"; return; }

    const labelZi = day === pricesData.tomorrow ? "Mâine" : "Azi";
    const cheap = day.cheapest_intervals[0];
    const pricy = day.priciest_intervals[0];
    const spread = day.max_ron_kwh - day.min_ron_kwh;
    const cheapTime = timeLabel(cheap.start);
    const pricyTime = timeLabel(pricy.start);
    const cheapNeg = isVisiblyNegative(cheap.price_ron_kwh);

    // textul urmeaza mood-ul: cand diferentele sunt mici NU recomandam o ora
    // anume, altfel mesajul s-ar contrazice
    let mood, moodLabel, headline, sub;
    if (spread > 0.8) {
      mood = "good"; moodLabel = "Diferențe mari de preț";
      if (cheapNeg) {
        headline = `La ${cheapTime} prețul de piață coboară sub zero.`;
        sub = `Cel mai bun moment pentru consumatorii mari (boiler, mașină de spălat, încărcarea mașinii). Evită, dacă poți, intervalul de la ${pricyTime}.`;
      } else {
        headline = "Unele intervale sunt mult mai ieftine decât restul zilei.";
        sub = `Programează consumatorii mari (boiler, mașină de spălat, încărcarea mașinii) în jurul orei ${cheapTime} și evită, dacă poți, intervalul de la ${pricyTime}.`;
      }
    } else if (spread > 0.3) {
      mood = ""; moodLabel = "Diferențe moderate";
      headline = "Câteva intervale sunt mai ieftine, dar diferența e mică.";
      sub = `Dacă îți e la îndemână, mută consumul mare în jurul orei ${cheapTime}. Economia va fi modestă.`;
    } else {
      mood = "bad"; moodLabel = "Preț aproape constant";
      headline = "Prețul este relativ constant pe parcursul zilei.";
      sub = "Ora la care consumi nu influențează semnificativ costul.";
    }

    card.className = "card verdict " + mood;
    card.innerHTML = `
      <div class="verdict-inner">
        <div class="verdict-top">
          <span class="verdict-mood"><span class="dot"></span>${moodLabel}</span>
          <span class="verdict-day">${labelZi}</span>
        </div>
        <div class="verdict-headline">${headline}</div>
        <div class="verdict-prices">
          <div class="${cheapNeg ? "vp vp-cheap vp-neg" : "vp vp-cheap"}">
            <span class="vp-tag">${cheapNeg ? "preț negativ" : "cel mai ieftin"}</span>
            <span class="vp-time">${cheapTime}</span>
            <span class="vp-price">${fmt(disp(cheap.price_ron_kwh))} lei/kWh</span>
          </div>
          <div class="vp vp-pricy">
            <span class="vp-tag">cel mai scump</span>
            <span class="vp-time">${pricyTime}</span>
            <span class="vp-price">${fmt(disp(pricy.price_ron_kwh))} lei/kWh</span>
          </div>
        </div>
        <div class="verdict-sub">${sub}</div>
        <a href="#ore" class="verdict-cta" id="verdictWindowLink">Când pornesc un aparat? →</a>
      </div>`;
    card.style.display = "block";
    $("verdictWindowLink").addEventListener("click", (e) => {
      e.preventDefault();
      selectTab("ore");
      $("panel-ore").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ---------- tab 1: graficul ----------
  // linie verticala "acum" peste bara intervalului curent (doar pentru azi)
  const nowLinePlugin = {
    id: "nowLine",
    afterDatasetsDraw(chart) {
      const idx = chart.$nowIdx;
      if (idx === null || idx === undefined) return;
      const bar = chart.getDatasetMeta(0).data[idx];
      if (!bar) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(bar.x, chartArea.top);
      ctx.lineTo(bar.x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = INK;
      ctx.font = "600 10px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("acum", bar.x, chartArea.top - 4);
      ctx.restore();
    },
  };

  function nowIndexFor(day) {
    if (day !== pricesData.today) return null;
    const cur = currentInterval(day);
    return cur ? day.intervals.indexOf(cur) : null;
  }

  function renderMainChart() {
    const day = pricesData[activeDay];
    const statsEl = $("dayStats");
    const warn = $("dayWarning");
    const wrap = document.querySelector("#panel-grafic .chart-wrap");
    if (!day) {
      statsEl.innerHTML = "";
      warn.hidden = true;
      wrap.innerHTML = '<div class="empty-state">Prețurile pentru mâine nu au fost publicate încă. De regulă apar după ora 14:00.</div>';
      if (mainChart) { mainChart.destroy(); mainChart = null; }
      return;
    }
    if (!$("mainChart")) wrap.innerHTML = '<canvas id="mainChart" role="img" aria-label="Grafic preț PZU"></canvas>';

    statsEl.innerHTML = `
      <div class="stat"><div class="v">${fmt(disp(day.avg_ron_kwh))}</div><div class="k">medie (lei/kWh)</div></div>
      <div class="stat"><div class="v">${fmt(disp(day.min_ron_kwh))}</div><div class="k">minim</div></div>
      <div class="stat"><div class="v">${fmt(disp(day.max_ron_kwh))}</div><div class="k">maxim</div></div>`;

    if (!isCompleteDay(day)) {
      const lipsa = (day.expected_interval_count || 96) - day.intervals.length;
      warn.textContent = `Pentru această zi lipsesc ${lipsa} intervale de la sursa ENTSO-E. Media, minimul și maximul sunt calculate doar pe intervalele disponibile.`;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    $("mainChartTableHead").textContent = priceMode === "final" ? "Preț final estimat (lei/kWh)" : "Preț de piață (lei/kWh)";
    $("mainChartTableBody").innerHTML = day.intervals.map((iv) =>
      `<tr><td>${timeLabel(iv.start)}</td><td>${fmt(disp(iv.price_ron_kwh))}</td></tr>`).join("");

    if (typeof Chart === "undefined") {
      // Chart.js nu s-a incarcat (ad-blocker, retea, CDN picat) -- statisticile raman corecte
      wrap.innerHTML = '<div class="empty-state">Graficul nu s-a putut încărca. Verifică conexiunea sau dezactivează ad-blockerul. Valorile de mai sus sunt corecte.</div>';
      return;
    }

    const minIv = day.intervals.reduce((a, b) => (b.price_ron_kwh < a.price_ron_kwh ? b : a));
    const maxIv = day.intervals.reduce((a, b) => (b.price_ron_kwh > a.price_ron_kwh ? b : a));
    $("mainChart").setAttribute("aria-label",
      `Grafic preț ${priceMode === "final" ? "final estimat" : "PZU"}, ${day.intervals.length} intervale de 15 minute. Medie ${fmt(disp(day.avg_ron_kwh))} lei/kWh, minim ${fmt(disp(minIv.price_ron_kwh))} la ${timeLabel(minIv.start)}, maxim ${fmt(disp(maxIv.price_ron_kwh))} la ${timeLabel(maxIv.start)}.`);

    if (mainChart) mainChart.destroy();
    mainChart = new Chart($("mainChart"), {
      type: "bar",
      data: {
        labels: day.intervals.map((iv) => timeLabel(iv.start)),
        datasets: [{
          data: day.intervals.map((iv) => disp(iv.price_ron_kwh)),
          backgroundColor: day.intervals.map((iv) => colorFor(iv, day.min_ron_kwh, day.max_ron_kwh)),
          borderRadius: 2, barPercentage: 1, categoryPercentage: 0.9,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 14 } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) + " lei/kWh" } } },
        scales: {
          x: { ticks: { autoSkip: true, maxTicksLimit: 8, font: { family: "IBM Plex Mono", size: 10 } }, grid: { display: false } },
          y: { ticks: { font: { family: "IBM Plex Mono", size: 10 } }, grid: { color: "#E3DFD4" } },
        },
      },
      plugins: [nowLinePlugin],
    });
    mainChart.$nowIdx = nowIndexFor(day);
    mainChart.draw();
  }

  // ---------- tab 2: ore ieftine ----------
  function renderHourList(elId, list, kind) {
    const el = $(elId);
    el.innerHTML = "";
    if (!list || !list.length) { el.innerHTML = '<div class="empty-state">Nu există date.</div>'; return; }
    const maxAbs = Math.max(...list.map((i) => Math.abs(i.price_ron_kwh)), 0.01);
    list.forEach((iv) => {
      const row = document.createElement("div");
      row.className = "hour-row";
      const pct = Math.max(6, Math.round((Math.abs(iv.price_ron_kwh) / maxAbs) * 100));
      const color = isVisiblyNegative(iv.price_ron_kwh) ? VIOLET : kind === "cheap" ? CYAN : AMBER;
      row.innerHTML = `<time>${timeLabel(iv.start)}</time>
        <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="val">${fmt(disp(iv.price_ron_kwh))}</div>`;
      el.appendChild(row);
    });
  }

  function renderTopHours() {
    const day = pricesData[activeDay];
    $("oreTitle").textContent = `Cele mai ieftine și cele mai scumpe intervale de ${dayLabel(activeDay)}`;
    if (!day) {
      ["cheapList", "pricyList"].forEach((id) => { $(id).innerHTML = '<div class="empty-state">Prețurile pentru mâine nu au fost publicate încă.</div>'; });
      return;
    }
    renderHourList("cheapList", day.cheapest_intervals, "cheap");
    renderHourList("pricyList", day.priciest_intervals, "pricy");
  }

  // ---------- fereastra cea mai ieftina pentru un aparat ----------
  const APARATE = [
    { id: "rufe", nume: "Mașină de spălat rufe", min: 120, kwh: 1 },
    { id: "vase", nume: "Mașină de spălat vase", min: 120, kwh: 1.1 },
    { id: "boiler", nume: "Boiler", min: 180, kwh: 6 },
    { id: "ev", nume: "Mașină electrică", min: 240, kwh: 28 },
    { id: "custom", nume: "Altceva", min: null, kwh: null },
  ];
  let aparatId = store.get("aparat", "rufe");

  function renderApplianceChips() {
    const box = $("applianceChips");
    box.innerHTML = APARATE.map((a) =>
      `<button type="button" data-id="${a.id}" aria-pressed="${a.id === aparatId}">${a.nume}${a.min ? ` · ${a.min / 60} h` : ""}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      aparatId = b.dataset.id;
      store.set("aparat", aparatId);
      renderApplianceChips();
      renderWindow();
    }));
    $("customAparat").hidden = aparatId !== "custom";
  }

  function renderWindow() {
    const out = $("windowResult");
    const a = APARATE.find((x) => x.id === aparatId) || APARATE[0];
    const durMin = a.id === "custom" ? Math.round(num("customOre") * 60) : a.min;
    const kwh = a.id === "custom" ? num("customKwh") : a.kwh;
    if (!durMin || durMin < 15) { out.innerHTML = '<div class="empty-state">Alege durata de funcționare.</div>'; return; }

    const day = pricesData[activeDay];
    if (!day) { out.innerHTML = '<div class="empty-state">Prețurile pentru mâine nu au fost publicate încă. De regulă apar după ora 14:00.</div>'; return; }

    // pentru azi: doar ferestre care incep azi, de acum incolo (intervalul
    // curent inclus); daca preturile de maine sunt publicate, fereastra poate
    // continua peste miezul noptii
    let intervals = day.intervals, notBefore = null;
    const endOfDay = new Date(day.intervals[day.intervals.length - 1].end).getTime();
    if (activeDay === "today") {
      notBefore = Date.now() - 15 * 60000;
      if (tomorrowReady()) intervals = day.intervals.concat(pricesData.tomorrow.intervals);
    }
    const r = bestWindows(intervals, durMin, notBefore, endOfDay);
    if (!r) {
      out.innerHTML = `<div class="empty-state">Nu mai rămâne azi o fereastră de ${durMin / 60} h. ${tomorrowReady() ? "Treci pe <b>Mâine</b>." : "Prețurile de mâine apar după ora 14:00."}</div>`;
      return;
    }
    const tva = cfg ? cfg.tva : 0.21;
    // tarifele si componenta sunt fixe pe kWh, deci economia vine doar din diferenta de pret PZU (+ TVA)
    const economie = kwh * (r.worst.avg - r.best.avg) * (1 + tva);
    const crossesMidnight = new Date(r.best.end).getTime() > endOfDay;
    out.innerHTML = `
      <div class="win-best">
        <span class="vp-tag">Cel mai ieftin moment de pornire</span>
        <span class="win-time">${timeLabel(r.best.start)} – ${timeLabel(r.best.end)}${crossesMidnight ? " <small>(se termină a doua zi)</small>" : ""}</span>
        <span class="vp-price">preț mediu ${fmt(disp(r.best.avg))} lei/kWh</span>
      </div>
      <dl class="breakdown win-breakdown">
        <dt>Cea mai scumpă fereastră</dt><dd>${timeLabel(r.worst.start)} – ${timeLabel(r.worst.end)} · ${fmt(disp(r.worst.avg))} lei/kWh</dd>
        ${kwh > 0 ? `<dt>Economie față de cea mai scumpă fereastră (~${fmt(kwh, kwh < 10 ? 1 : 0)} kWh, cu TVA)</dt><dd>${fmt(Math.max(economie, 0), 2)} lei</dd>` : ""}
      </dl>
      <p class="disclaimer">Consumul aparatului e o estimare tipică${a.id === "custom" ? "" : "; îl poți ajusta la „Altceva”"}. Economia nu depinde de furnizor sau de tarifele reglementate, care sunt aceleași în orice interval.</p>`;
  }

  // ---------- tab 3: calculator ----------
  function hourlyForBasis() {
    const basis = $("perioada").value;
    if (basis === "stats30" && statsData) return { hourly: statsData.hourly_avg_ron_kwh, label: `prețurilor din ultimele ${statsData.window_days} de zile (${fmtDate(statsData.from)} – ${fmtDate(statsData.to)})` };
    const key = basis === "tomorrow" && pricesData.tomorrow ? "tomorrow" : "today";
    const day = pricesData[key];
    if (!day) return null;
    return { hourly: hourlyAverages(day.intervals), label: `prețurilor de ${dayLabel(key)}` };
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  // costul dinamic pentru o marja data -- refolosit de comparatorul de furnizori
  function computeDinamicCost(marjaValue, reglementate, basis, useCsv, profil) {
    const tva = cfg.tva;
    if (useCsv) {
      if (!csvMatchResult || csvMatchResult.matchedKwh <= 0) return null;
      const consum = csvMatchResult.matchedKwh;
      // cost exact: suma (kWh_interval x pret_PZU_interval), plus reglementate+marja pe kWh, TVA la final
      const costDinamic = (csvMatchResult.costPzuRaw + consum * (reglementate + marjaValue)) * (1 + tva);
      return { consum, pzuAvg: csvMatchResult.costPzuRaw / consum, pretDinamicTotal: costDinamic / consum, costDinamic };
    }
    const consum = num("consum");
    const pzuAvg = profileAvg(basis.hourly, profil);
    const pretDinamicTotal = finalPrice(pzuAvg, reglementate, marjaValue, tva);
    return { consum, pzuAvg, pretDinamicTotal, costDinamic: pretDinamicTotal * consum };
  }

  function renderFurnizorComparison(ctx) {
    const container = $("furnizorComparisonTable");
    const { basis, reglementate, useCsv, profil, tarifFix, isProsumator, exportKwh, rataExport } = ctx;
    let venitExportDinamic = 0, venitExportFix = 0;
    if (isProsumator && exportKwh > 0 && basis) {
      venitExportDinamic = exportKwh * Math.max(solarAvgFromHourly(basis.hourly) || 0, 0);
      venitExportFix = exportKwh * rataExport;
    }
    const selectat = $("furnizor").value;
    const rows = [];
    let consumRef = null;
    for (const f of cfg.furnizori) {
      const m = marjaOficiala(f);
      if (m === null) continue;
      const r = computeDinamicCost(m, reglementate, basis, useCsv, profil);
      if (!r) continue;
      consumRef = r.consum;
      const label = f.slug ? `<a href="/furnizori/${f.slug}.html" style="color:var(--ink);">${f.oferta}</a>` : f.oferta;
      rows.push({ id: f.id, label, pret: r.pretDinamicTotal, cost: r.costDinamic - venitExportDinamic });
    }
    if (!rows.length) {
      container.innerHTML = '<p class="empty-state">Încarcă fișierul CSV pentru a vedea comparația.</p>';
      return;
    }
    rows.push({ id: "fix", label: `Contract fix (${fmt(tarifFix, 2)} lei/kWh)`, pret: tarifFix, cost: tarifFix * consumRef - venitExportFix });
    rows.sort((a, b) => a.cost - b.cost);
    const min = rows[0].cost;
    container.innerHTML = `
      <div class="data-table-wrap" style="max-height:none;">
      <table class="data-table">
        <thead><tr><th>Ofertă</th><th>Preț final (lei/kWh)</th><th>Cost${isProsumator && exportKwh > 0 ? " net" : ""} lunar (lei)</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr style="${r.cost === min ? "font-weight:600;" : ""}">
            <td>${r.label}${r.id === selectat ? " (selectat)" : ""}${r.cost === min ? " · cel mai avantajos" : ""}</td>
            <td>${fmt(r.pret, 3)}</td>
            <td>${fmt(r.cost, 2)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  }

  function runCalculator() {
    if (!cfg) return;
    const resultEl = $("calcResult");
    const basis = hourlyForBasis();
    const useCsv = $("useCsv").checked;
    if (!basis && !useCsv) { resultEl.className = "result"; resultEl.innerHTML = '<div class="empty-state">Datele nu sunt disponibile momentan.</div>'; return; }
    const reglementate = num("reglementate");
    const marja = num("marja");
    const tarifFix = num("tarifFix");
    const isProsumator = $("prosumator").checked;
    const exportKwh = isProsumator ? num("export") : 0;
    const rataExport = num("rataExport");
    const profil = $("profil").value;

    renderFurnizorComparison({ basis, reglementate, useCsv, profil, tarifFix, isProsumator, exportKwh, rataExport });

    const r = computeDinamicCost(marja, reglementate, basis, useCsv, profil);
    if (!r) {
      resultEl.className = "result";
      resultEl.innerHTML = '<div class="empty-state">Încarcă fișierul CSV pentru a vedea rezultatul.</div>';
      return;
    }
    const { consum, pzuAvg, pretDinamicTotal, costDinamic } = r;
    const costFix = tarifFix * consum;
    const PROFIL_LABEL = { uniform: "un consum uniform pe parcursul zilei", noapte: "un consum mai ales noaptea", seara: "un consum mai ales seara", zi: "un consum mai ales ziua" };
    const modeLabel = useCsv ? `pe baza consumului real (${fmt(consum, 1)} kWh)` : `pentru ${PROFIL_LABEL[profil] || "profilul ales"}, pe baza ${basis.label}`;

    let breakdownExtra = "", netFix = costFix, netDinamic = costDinamic, headlineDiff, headlineLabel = modeLabel;
    if (isProsumator && exportKwh > 0 && basis) {
      const exportPzuAvg = solarAvgFromHourly(basis.hourly) || 0;
      const venitExportFix = exportKwh * rataExport;
      const venitExportDinamic = exportKwh * Math.max(exportPzuAvg, 0);
      netFix = costFix - venitExportFix;
      netDinamic = costDinamic - venitExportDinamic;
      breakdownExtra = `
        <dt>Preț PZU mediu 10:00–16:00 (orele de producție solară)</dt><dd>${fmt(exportPzuAvg)} lei/kWh</dd>
        <dt>Venit din export, preț actual</dt><dd>${fmt(venitExportFix, 2)} lei</dd>
        <dt>Venit din export, preț PZU</dt><dd>${fmt(venitExportDinamic, 2)} lei</dd>`;
      headlineDiff = netFix - netDinamic;
      headlineLabel += ", net (consum minus export)";
    } else {
      headlineDiff = costFix - costDinamic;
    }

    const win = headlineDiff >= 0;
    resultEl.className = "result " + (win ? "win" : "lose");
    resultEl.innerHTML = `
      <div class="headline">${win ? "Economie estimată:" : "Cost suplimentar estimat:"} ${fmt(Math.abs(headlineDiff), 2)} lei${useCsv ? "" : "/lună"}</div>
      <div class="sub">Față de un contract fix la ${fmt(tarifFix, 2)} lei/kWh, ${headlineLabel}.</div>
      <dl class="breakdown">
        <dt>Preț PZU mediu, ${useCsv ? "ponderat cu consumul real" : "ponderat cu profilul ales"}</dt><dd>${fmt(pzuAvg)} lei/kWh</dd>
        <dt>Preț final estimat, contract dinamic</dt><dd>${fmt(pretDinamicTotal, 3)} lei/kWh</dd>
        <dt>Cost consum, contract dinamic</dt><dd>${fmt(costDinamic, 2)} lei</dd>
        <dt>Cost consum, contract fix</dt><dd>${fmt(costFix, 2)} lei</dd>
        ${breakdownExtra}
        ${isProsumator && exportKwh > 0 ? `<dt><b>Cost net, contract dinamic</b></dt><dd><b>${fmt(netDinamic, 2)} lei</b></dd><dt><b>Cost net, contract fix</b></dt><dd><b>${fmt(netFix, 2)} lei</b></dd>` : ""}
      </dl>`;
  }

  // ---------- calculator: campuri, furnizori, judete, persistenta ----------
  // marja si reglementate NU sunt in lista: le salvam doar daca vizitatorul le-a
  // modificat de mana (vezi saveFields) -- altfel, cand actualizam valorile
  // oficiale in data/furnizori.json, cine a mai vizitat site-ul ar ramane
  // blocat pe valorile vechi salvate in browser
  const SAVED_FIELDS = ["furnizor", "judet", "consum", "profil", "perioada", "tarifFix", "export", "rataExport", "customOre", "customKwh"];

  function buildCalculatorOptions() {
    $("furnizor").innerHTML = cfg.furnizori.map((f) => `<option value="${f.id}">${f.oferta}</option>`).join("");
    const judete = cfg.tarife.operatori.flatMap((o) => o.judete).sort((a, b) => a.localeCompare(b, "ro"));
    $("judet").innerHTML = '<option value="medie">Nu știu (media națională)</option>' +
      judete.map((j) => `<option value="${j}">${j}</option>`).join("") +
      '<option value="manual">Altă valoare (introdusă manual)</option>';
    if (!pricesData.tomorrow) $("perioada").querySelector('option[value="tomorrow"]').disabled = true;
    if (!statsData) {
      $("perioada").querySelector('option[value="stats30"]').disabled = true;
      $("perioada").value = "today";
    }
  }

  function updateFurnizorUi() {
    const f = furnizorById($("furnizor").value);
    const oficial = marjaOficiala(f);
    const nota = $("furnizorNota");
    nota.textContent = f && f.nota ? f.nota : "";
    nota.hidden = !(f && f.nota);
    nota.style.color = oficial === null ? "var(--amber)" : "var(--ink-soft)";
    $("marjaConfirmataTag").hidden = !(oficial !== null && Math.abs(num("marja") - oficial) < 1e-9);
    $("furnizorLinkWrap").hidden = !(f && f.slug);
    if (f && f.slug) {
      $("furnizorLink").href = `/furnizori/${f.slug}.html`;
      $("furnizorLink").textContent = `Ce include ${f.oferta} și cât a costat în ultima lună →`;
    }
  }

  function updateJudetUi() {
    const j = $("judet").value;
    const op = operatorForJudet(j);
    $("judetInfo").textContent = j === "manual"
      ? "Folosește suma tarifelor reglementate de pe factura ta, fără TVA."
      : `${op ? "Operator de distribuție: " + op.nume + ". " : "Media celor patru operatori de distribuție. "}Tarife ANRE în vigoare (${cfg.tarife.verificat.split("-").reverse().join(".")}).`;
  }

  function onFurnizorChange() {
    const oficial = marjaOficiala(furnizorById($("furnizor").value));
    if (oficial !== null) $("marja").value = oficial;
    updateFurnizorUi();
  }

  function onJudetChange() {
    const v = regulatedForJudet($("judet").value);
    if (v !== null) $("reglementate").value = Math.round(v * 1e5) / 1e5;
    updateJudetUi();
  }

  function restoreFields() {
    // ?furnizor=eon (link din paginile de furnizor) are prioritate fata de ce era salvat
    const qs = new URLSearchParams(location.search);
    for (const id of SAVED_FIELDS) {
      const v = store.get("f." + id, null);
      if (v === null) continue;
      const el = $(id);
      if (el.tagName === "SELECT" && !el.querySelector(`option[value="${v}"]:not([disabled])`)) continue;
      el.value = v;
    }
    $("prosumator").checked = store.get("f.prosumator", false);
    const qf = qs.get("furnizor");
    if (qf && furnizorById(qf)) $("furnizor").value = qf;
    const savedMarja = store.get("f.marja", null);
    if (savedMarja !== null && !qf) $("marja").value = savedMarja;
    else onFurnizorChange();
    const savedReg = store.get("f.reglementate", null);
    if ($("judet").value === "manual" && savedReg !== null) $("reglementate").value = savedReg;
    else onJudetChange();
    toggleProsumator();
    updateFurnizorUi();
    updateJudetUi();
  }

  function saveFields() {
    SAVED_FIELDS.forEach((id) => store.set("f." + id, $(id).value));
    store.set("f.prosumator", $("prosumator").checked);
    const oficial = marjaOficiala(furnizorById($("furnizor").value));
    store.set("f.marja", oficial !== null && Math.abs(num("marja") - oficial) < 1e-9 ? null : $("marja").value);
    store.set("f.reglementate", $("judet").value === "manual" ? $("reglementate").value : null);
  }

  function toggleProsumator() {
    const on = $("prosumator").checked;
    $("prosumatorFields").style.display = on ? "grid" : "none";
    $("prosumatorLink").style.display = on ? "block" : "none";
  }

  function wireCalculator() {
    $("furnizor").addEventListener("change", () => { onFurnizorChange(); onCalcInput(); });
    $("judet").addEventListener("change", () => { onJudetChange(); onCalcInput(); });
    $("reglementate").addEventListener("input", () => {
      if (Math.abs(num("reglementate") - (regulatedForJudet($("judet").value) ?? -1)) > 1e-6) { $("judet").value = "manual"; updateJudetUi(); }
    });
    $("marja").addEventListener("input", updateFurnizorUi);
    $("prosumator").addEventListener("change", () => { toggleProsumator(); onCalcInput(); });
    $("useCsv").addEventListener("change", (e) => {
      $("profilFields").style.display = e.target.checked ? "none" : "grid";
      $("perioadaField").style.display = e.target.checked ? "none" : "block";
      $("csvFields").style.display = e.target.checked ? "block" : "none";
      if (!e.target.checked) csvMatchResult = null;
      runCalculator();
    });
    ["consum", "profil", "perioada", "reglementate", "marja", "tarifFix", "export", "rataExport"].forEach((id) => {
      $(id).addEventListener("input", onCalcInput);
    });
    ["customOre", "customKwh"].forEach((id) => $(id).addEventListener("input", () => { saveFields(); renderWindow(); }));
    $("csvFile").addEventListener("change", onCsvFile);
  }

  // orice modificare in calculator: recalculam, salvam, iar in modul "pret final"
  // reafisam si restul paginii (graficul depinde de tarife si furnizor)
  function onCalcInput() {
    saveFields();
    runCalculator();
    if (priceMode === "final") renderModeDependent();
  }

  async function matchCsvToArchive(rows) {
    const sorted = [...rows].sort((a, b) => a.date - b.date);
    const durationMin = inferDurationMinutes(sorted.map((r) => r.date));
    const dayFmtIntl = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" });
    const dayFmt = (date) => dayFmtIntl.format(date);
    const neededDates = [...new Set(sorted.map((r) => dayFmt(r.date)))];
    const archives = {};
    await Promise.all(neededDates.map(async (d) => {
      try {
        const res = await fetch(`data/archive/${d}.json`);
        if (!res.ok) throw new Error("missing");
        archives[d] = await res.json();
      } catch (e) { /* lipsa e tratata mai jos, in missingDates */ }
    }));
    return matchIntervalsToArchive(sorted, archives, dayFmt, durationMin);
  }

  async function onCsvFile(e) {
    const file = e.target.files[0];
    const statusEl = $("csvStatus");
    if (!file) return;
    statusEl.textContent = "Se procesează…";
    try {
      const parsed = parseConsumptionCsv(await file.text());
      if (!parsed.rows.length) {
        statusEl.textContent = parsed.error || "Fișierul nu conține rânduri valide.";
        csvMatchResult = null;
        runCalculator();
        return;
      }
      csvMatchResult = await matchCsvToArchive(parsed.rows);
      const r = csvMatchResult;
      let msg = `${parsed.rows.length} rânduri citite din coloana „${parsed.info.kwhColumn}”; ${fmt(r.matchedKwh, 2)} kWh au prețuri PZU disponibile.`;
      if (parsed.info.skipped) msg += ` ${parsed.info.skipped} rânduri nu au putut fi citite și au fost ignorate.`;
      if (r.missingDates.length) {
        msg += ` ⚠ Pentru ${r.missingDates.length} zile nu avem încă prețuri (${r.missingDates.slice(0, 3).join(", ")}${r.missingDates.length > 3 ? "…" : ""}), așa că ${fmt(r.excludedKwh, 2)} kWh au fost excluși din calcul.`;
      }
      statusEl.textContent = msg;
    } catch (err) {
      statusEl.textContent = "Fișierul nu a putut fi citit: " + err.message;
      csvMatchResult = null;
      console.error(err);
    }
    runCalculator();
  }

  // ---------- tab 4: istoric ----------
  function renderHistoryChart() {
    if (!historyData || !historyData.length) return;
    const last30 = historyData.slice(-30);
    $("historyTableBody").innerHTML = last30.map((h) =>
      `<tr><td>${fmtDate(h.date)}${h.complete === false ? ' <span class="muted">(zi incompletă)</span>' : ""}</td><td>${fmt(disp(h.avg_ron_kwh))}</td><td>${fmt(disp(h.min_ron_kwh))}</td><td>${fmt(disp(h.max_ron_kwh))}</td></tr>`).join("");

    if (typeof Chart === "undefined") {
      document.querySelector("#panel-istoric .chart-wrap").innerHTML = '<div class="empty-state">Graficul nu s-a putut încărca. Verifică conexiunea sau dezactivează ad-blockerul.</div>';
      return;
    }
    const histMin = last30.reduce((a, b) => (b.min_ron_kwh < a.min_ron_kwh ? b : a));
    const histMax = last30.reduce((a, b) => (b.max_ron_kwh > a.max_ron_kwh ? b : a));
    $("historyChart").setAttribute("aria-label",
      `Grafic istoric preț, ${last30.length} zile, de la ${last30[0].date} la ${last30[last30.length - 1].date}. Minim ${fmt(disp(histMin.min_ron_kwh))} lei/kWh pe ${histMin.date}, maxim ${fmt(disp(histMax.max_ron_kwh))} lei/kWh pe ${histMax.date}.`);
    if (historyChart) historyChart.destroy();
    historyChart = new Chart($("historyChart"), {
      type: "line",
      data: {
        labels: last30.map((h) => h.date.slice(8, 10) + "." + h.date.slice(5, 7)),
        datasets: [
          { label: "medie", data: last30.map((h) => disp(h.avg_ron_kwh)), borderColor: CYAN, backgroundColor: "transparent", tension: 0.25, pointRadius: 0 },
          { label: "maxim", data: last30.map((h) => disp(h.max_ron_kwh)), borderColor: "transparent", backgroundColor: "rgba(217,114,44,.12)", fill: "+1", tension: 0.25, pointRadius: 0 },
          { label: "minim", data: last30.map((h) => disp(h.min_ron_kwh)), borderColor: "transparent", backgroundColor: "rgba(15,138,147,.10)", fill: false, tension: 0.25, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)} lei/kWh` } } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: { family: "IBM Plex Mono", size: 10 } }, grid: { display: false } },
          y: { ticks: { font: { family: "IBM Plex Mono", size: 10 } }, grid: { color: "#E3DFD4" } },
        },
      },
    });
  }

  // ---------- cardurile catre paginile de continut: cate o cifra din datele zilei ----------
  function renderExplore() {
    const t = pricesData.tomorrow;
    $("exploreMaine").textContent = tomorrowReady()
      ? `Mâine: medie ${fmt(t.avg_ron_kwh)} lei/kWh, minim la ${timeLabel(t.cheapest_intervals[0].start)}`
      : "Apar zilnic după ora 14:00";
    if (statsData) {
      const prices = cfg.furnizori.filter((f) => marjaOficiala(f) !== null).map((f) => ({
        f, p: finalPrice(profileAvg(statsData.hourly_avg_ron_kwh, "uniform"), regulatedForJudet("medie"), marjaOficiala(f), cfg.tva),
      })).sort((a, b) => a.p - b.p);
      if (prices.length) $("exploreFurnizori").textContent = `Cea mai mică: ${prices[0].f.nume}, ${fmt(prices[0].p)} lei/kWh`;
    }
  }

  // ---------- tab-uri ----------
  const TAB_IDS = ["grafic", "ore", "calc", "istoric"];
  const TAB_HASH = { grafic: "grafic", ore: "ore", calc: "calculator", istoric: "istoric" };

  function selectTab(id, focusButton) {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const selected = b.id === "tabbtn-" + id;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + id));
    // Azi/Mâine conteaza doar pentru grafic si ore; calculatorul are propria perioada
    $("dayBar").hidden = !(id === "grafic" || id === "ore");
    if (focusButton) $("tabbtn-" + id).focus();
    if (history.replaceState) history.replaceState(null, "", location.pathname + location.search + "#" + TAB_HASH[id]);
  }

  function wireTabs() {
    TAB_IDS.forEach((id) => $("tabbtn-" + id).addEventListener("click", () => selectTab(id)));
    // tastatura (pattern ARIA "tabs, automatic activation"): sageti + Home/End
    document.querySelector(".tabs").addEventListener("keydown", (e) => {
      const currentIdx = TAB_IDS.findIndex((id) => $("tabbtn-" + id) === document.activeElement);
      if (currentIdx === -1) return;
      let nextIdx = null;
      if (e.key === "ArrowRight") nextIdx = (currentIdx + 1) % TAB_IDS.length;
      else if (e.key === "ArrowLeft") nextIdx = (currentIdx - 1 + TAB_IDS.length) % TAB_IDS.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = TAB_IDS.length - 1;
      if (nextIdx === null) return;
      e.preventDefault();
      selectTab(TAB_IDS[nextIdx], true);
    });
  }

  function wireExports() {
    $("exportMainCsv").addEventListener("click", () => {
      const day = pricesData[activeDay];
      if (!day) return;
      const csv = toCsv(["Ora", "Preț de piață (lei/kWh)"], day.intervals.map((iv) => [timeLabel(iv.start), fmt(iv.price_ron_kwh)]));
      downloadTextFile(`pzuro-preturi-${day.date}.csv`, csv);
    });
    $("exportHistoryCsv").addEventListener("click", () => {
      if (!historyData || !historyData.length) return;
      const last30 = historyData.slice(-30);
      const csv = toCsv(
        ["Data", "Medie (lei/kWh)", "Minim (lei/kWh)", "Maxim (lei/kWh)", "Zi completă"],
        last30.map((h) => [h.date, fmt(h.avg_ron_kwh), fmt(h.min_ron_kwh), fmt(h.max_ron_kwh), h.complete === false ? "nu" : "da"])
      );
      downloadTextFile(`pzuro-istoric-${last30[0].date}_${last30[last30.length - 1].date}.csv`, csv);
    });
  }

  function renderModeDependent() {
    safeRender(renderHeader);
    renderDayDependent();
    safeRender(renderHistoryChart);
  }

  function wireModeAndDay() {
    $("modePiata").addEventListener("click", () => { priceMode = "piata"; store.set("priceMode", priceMode); renderModeDependent(); });
    $("modeFinal").addEventListener("click", () => { priceMode = "final"; store.set("priceMode", priceMode); renderModeDependent(); });
    $("btnToday").addEventListener("click", () => setActiveDay("today"));
    $("btnTomorrow").addEventListener("click", () => setActiveDay("tomorrow"));
  }

  // prices.json eticheteaza "today"/"tomorrow" relativ la momentul rularii
  // pipeline-ului (~14:15), nu la data reala. Intre miezul noptii si prima
  // rulare a zilei, "today" e de fapt ieri, iar "tomorrow" e azi -- corectam
  // o singura data, inainte de orice randare.
  function normalizeDayLabels() {
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" }).format(new Date());
    if (pricesData.today && pricesData.today.date !== todayStr && pricesData.tomorrow && pricesData.tomorrow.date === todayStr) {
      pricesData.today = pricesData.tomorrow;
      pricesData.tomorrow = null;
      pricesData.tomorrow_published = false;
    }
    // daca nici "tomorrow" nu e azi, ambele zile sunt vechi -- avertismentul
    // de prospetime (renderFreshness) semnaleaza asta
  }

  // fiecare sectiune e independenta: daca una pica (ex. Chart.js lipsa),
  // restul paginii trebuie sa ramana functional
  function safeRender(fn) {
    try { fn(); } catch (e) { console.error("Secțiune indisponibilă (" + fn.name + "):", e); }
  }

  async function fetchJson(url, optional) {
    const res = await fetch(url);
    if (!res.ok) {
      if (optional) return null;
      throw new Error(url + ": HTTP " + res.status);
    }
    return res.json();
  }

  async function init() {
    try {
      [pricesData, historyData, statsData, cfg] = await Promise.all([
        fetchJson("data/prices.json"), fetchJson("data/history.json"),
        fetchJson("data/stats.json", true).catch(() => null), fetchJson("data/furnizori.json"),
      ]);
    } catch (e) {
      $("nowPillText").textContent = "Datele nu au putut fi încărcate";
      console.error(e);
      return;
    }
    normalizeDayLabels();
    if (!tomorrowReady()) $("btnTomorrow").disabled = true;
    // dupa publicarea preturilor de maine (~14:00), planificarea e despre ziua de maine
    activeDay = tomorrowReady() ? "tomorrow" : "today";

    buildCalculatorOptions();
    restoreFields();
    wireCalculator();
    renderApplianceChips();

    $("btnToday").setAttribute("aria-pressed", activeDay === "today" ? "true" : "false");
    $("btnTomorrow").setAttribute("aria-pressed", activeDay === "tomorrow" ? "true" : "false");
    safeRender(renderHeader);
    renderDayDependent();
    safeRender(runCalculator);
    safeRender(renderHistoryChart);
    safeRender(renderExplore);

    // reimprospatam pretul curent si linia "acum" la fiecare minut
    setInterval(() => {
      safeRender(renderHeader);
      if (mainChart && pricesData[activeDay] === pricesData.today) {
        mainChart.$nowIdx = nowIndexFor(pricesData.today);
        mainChart.draw();
      }
    }, 60000);
  }

  // ---------- pornire ----------
  wireTabs();
  wireExports();
  wireModeAndDay();
  const initialTab = Object.keys(TAB_HASH).find((k) => "#" + TAB_HASH[k] === location.hash);
  if (initialTab) selectTab(initialTab);
  init();

  // service worker (PWA/offline): neblocant, esueaza tacit pe browsere fara suport.
  // reg.update() forteaza verificarea imediata a unui sw.js nou; reload-ul la
  // controllerchange aduce update-ul in tab-ul deja deschis -- dar DOAR daca
  // pagina era deja controlata de un SW mai vechi (la prima vizita, clients.claim()
  // declanseaza si el controllerchange, fara nimic de reimprospatat).
  if ("serviceWorker" in navigator) {
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        reg.update().catch(() => {});
      }).catch((e) => console.error("Inregistrare service worker esuata:", e));
    });
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate || !hadControllerAtLoad) return;
      reloadedForUpdate = true;
      window.location.reload();
    });
  }
})();
