"""Teste pentru generate_pages.py -- fara retea, pe date construite in test."""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import generate_pages as gp  # noqa: E402


def day_payload(date, prices):
    intervals = []
    for i, p in enumerate(prices):
        h, m = divmod(i * 15, 60)
        h2, m2 = divmod((i + 1) * 15, 60)
        intervals.append({
            "start": f"{date}T{h:02d}:{m:02d}:00+03:00",
            "end": f"{date}T{h2 % 24:02d}:{m2:02d}:00+03:00",
            "price_ron_kwh": p,
        })
    by_price = sorted(intervals, key=lambda i: i["price_ron_kwh"])
    return {
        "date": date, "intervals": intervals, "interval_count": len(intervals),
        "expected_interval_count": 96, "complete": len(intervals) == 96,
        "avg_ron_kwh": sum(prices) / len(prices), "min_ron_kwh": min(prices), "max_ron_kwh": max(prices),
        "cheapest_intervals": by_price[:6], "priciest_intervals": by_price[-6:][::-1],
    }


class ProfileWeightsSyncTest(unittest.TestCase):
    def test_same_weights_as_calc_js(self):
        js = (ROOT / "js" / "calc.js").read_text(encoding="utf-8")
        for name in ("seara", "noapte", "zi"):
            m = re.search(name + r": \[([^\]]+)\]", js)
            self.assertIsNotNone(m, name)
            js_vals = [float(x) for x in m.group(1).split(",")]
            self.assertEqual(js_vals, [float(x) for x in gp.PROFILE_WEIGHTS[name]], name)


class CalculeTest(unittest.TestCase):
    def test_fmt_virgula_si_fara_minus_zero(self):
        self.assertEqual(gp.fmt(0.4534), "0,453")
        self.assertEqual(gp.fmt(-0.00004), "0,000")
        self.assertEqual(gp.fmt(None), "—")

    def test_best_windows(self):
        d = day_payload("2026-06-01", [5] * 8 + [1] * 8 + [9] * 8 + [5] * 72)
        w = gp.best_windows(d["intervals"], 120)
        self.assertEqual(w["best"]["start"][11:16], "02:00")
        self.assertEqual(w["best"]["avg"], 1)
        self.assertEqual(w["worst"]["start"][11:16], "04:00")

    def test_data_lunga(self):
        self.assertEqual(gp.data_lunga("2026-10-16"), "vineri, 16 octombrie 2026")


class PaginiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = json.loads((ROOT / "data" / "furnizori.json").read_text(encoding="utf-8"))
        cls.stats = {"window_days": 30, "from": "2026-09-01", "to": "2026-09-30",
                     "hourly_avg_ron_kwh": [0.5] * 24}

    def test_maine_cand_e_publicat(self):
        prices = {"tomorrow_published": True, "today": day_payload("2026-10-15", [0.5] * 96),
                  "tomorrow": day_payload("2026-10-16", [0.4] * 40 + [0.1] * 16 + [0.9] * 40)}
        html = gp.build_maine_page(prices, self.cfg)
        self.assertIn("Prețul energiei electrice mâine, vineri, 16 octombrie 2026", html)
        self.assertIn("Prețul pe fiecare oră", html)

    def test_maine_inainte_de_publicare_arata_azi(self):
        prices = {"tomorrow_published": False, "today": day_payload("2026-10-15", [0.5] * 96), "tomorrow": None}
        html = gp.build_maine_page(prices, self.cfg)
        self.assertIn("nu au fost publicate încă", html)
        self.assertIn("joi, 15 octombrie 2026", html)

    def test_zi_incompleta_e_semnalata(self):
        prices = {"tomorrow_published": True, "today": None, "tomorrow": day_payload("2026-10-16", [0.5] * 92)}
        self.assertIn("lipsesc 4 intervale", gp.build_maine_page(prices, self.cfg))

    def test_pagina_furnizor_si_comparatie(self):
        eon = next(f for f in self.cfg["furnizori"] if f["id"] == "eon")
        html = gp.build_furnizor_page(eon, self.cfg, self.stats)
        self.assertIn("E.ON Dinamic Electric", html)
        self.assertIn('href="/?furnizor=eon#calculator"', html)
        # pretul final la consum uniform: (0,5 + media tarifelor + 0,39432) x 1,21
        expected = gp.final_price(0.5, gp.regulated_national(self.cfg["tarife"]), 0.39432, 0.21)
        self.assertIn(gp.fmt(expected), html)
        index = gp.build_furnizori_index(self.cfg, self.stats)
        self.assertIn("nepublicată", index)  # Electrica

    def test_sitemap_contine_paginile_generate(self):
        xml = gp.build_sitemap(self.cfg, "2026-10-15")
        self.assertIn("https://pzuro.ro/furnizori/engie-elec-flexibil.html", xml)
        self.assertIn("https://pzuro.ro/pret-energie-maine.html", xml)
        self.assertNotIn("None", xml)


if __name__ == "__main__":
    unittest.main()
