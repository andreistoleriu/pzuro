// /api/now.js
// Endpoint pentru integrari externe (Home Assistant, alte automatizari):
// returneaza prețul PZU pentru intervalul de 15 minute curent, deja calculat
// corect -- fara ca cine consuma API-ul sa mai trebuiasca sa reimplementeze
// logica de "care e ziua reala" sau "care interval corespunde lui acum".
//
// De ce exista asta separat de data/prices.json:
// fisierul static prices.json eticheteaza "today"/"tomorrow" relativ la
// MOMENTUL CAND A RULAT pipeline-ul (o data pe zi), nu relativ la data
// calendaristica reala -- exact problema pe care am rezolvat-o in frontend
// (normalizeDayLabels). O automatizare Home Assistant n-ar trebui sa
// reimplementeze aceeasi logica in Jinja2 -- mai simplu sa o facem o data,
// aici, si toata lumea citeste direct rezultatul final.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");

  try {
    const host = req.headers.host;
    const protocol = host.includes("localhost") ? "http" : "https";
    const dataRes = await fetch(`${protocol}://${host}/data/prices.json`);
    if (!dataRes.ok) throw new Error("nu pot citi data/prices.json");
    const data = await dataRes.json();

    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" }).format(new Date());

    // aceeasi normalizare ca in frontend: daca "today" din fisier nu mai
    // corespunde cu data reala de azi, dar "tomorrow" da (pipeline-ul de azi
    // inca n-a rulat), folosim de fapt "tomorrow" ca zi curenta
    let day = data.today;
    if (day && day.date !== todayStr && data.tomorrow && data.tomorrow.date === todayStr) {
      day = data.tomorrow;
    }

    // verificare explicita: dupa normalizare, ziua rezolvata TREBUIE sa fie
    // chiar data de azi. Daca nu e (outage prelungit, pipeline-ul n-a rulat
    // de mai multe zile), nu servim date vechi ca si cum ar fi curente --
    // o automatizare n-are cum sa observe o eticheta gresita asa cum ar
    // observa un om un avertisment vizual pe site.
    if (!day || day.date !== todayStr || !day.intervals || !day.intervals.length) {
      res.status(503).json({
        error: "date_indisponibile_sau_vechi",
        message: "Nu exista date PZU valabile pentru data de azi (" + todayStr + ").",
        ultima_actualizare: data.generated_at || null,
      });
      return;
    }

    const now = new Date();
    const current =
      day.intervals.find((iv) => now >= new Date(iv.start) && now < new Date(iv.end)) ||
      day.intervals[day.intervals.length - 1];

    res.status(200).json({
      price_ron_kwh: current.price_ron_kwh,
      price_eur_mwh: current.price_eur_mwh,
      is_negative: current.is_negative,
      interval_start: current.start,
      interval_end: current.end,
      date: day.date,
      generated_at: data.generated_at,
    });
  } catch (err) {
    res.status(500).json({ error: "eroare_interna", message: String(err) });
  }
};
