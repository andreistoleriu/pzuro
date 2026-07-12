"""Teste pentru logica pura din fetch_prices.py -- fara acces la retea/ENTSO-E,
doar functiile care transforma/agrega date deja primite. Ruleaza cu:
    python -m unittest discover -s test -p "*_test.py"
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fetch_prices  # noqa: E402


class SeriesToIntervalsTest(unittest.TestCase):
    def test_converts_eur_mwh_to_ron_kwh(self):
        index = pd.date_range("2026-06-01 00:00", periods=2, freq="15min", tz="Europe/Bucharest")
        series = pd.Series([100.0, 200.0], index=index)
        intervals = fetch_prices.series_to_intervals(series, rate=5.0)
        self.assertEqual(len(intervals), 2)
        # 100 EUR/MWh * 5 RON/EUR / 1000 = 0.5 RON/kWh
        self.assertAlmostEqual(intervals[0]["price_ron_kwh"], 0.5)
        self.assertAlmostEqual(intervals[1]["price_ron_kwh"], 1.0)
        self.assertFalse(intervals[0]["is_negative"])

    def test_flags_negative_prices(self):
        index = pd.date_range("2026-06-01 00:00", periods=1, freq="15min", tz="Europe/Bucharest")
        series = pd.Series([-10.0], index=index)
        intervals = fetch_prices.series_to_intervals(series, rate=5.0)
        self.assertTrue(intervals[0]["is_negative"])
        self.assertLess(intervals[0]["price_ron_kwh"], 0)

    def test_interval_end_respects_frequency(self):
        index = pd.date_range("2026-06-01 00:00", periods=1, freq="15min", tz="Europe/Bucharest")
        series = pd.Series([50.0], index=index)
        intervals = fetch_prices.series_to_intervals(series, rate=5.0)
        start = pd.Timestamp(intervals[0]["start"])
        end = pd.Timestamp(intervals[0]["end"])
        self.assertEqual((end - start).total_seconds(), 15 * 60)


class BuildDayPayloadTest(unittest.TestCase):
    def _interval(self, price):
        return {"start": "x", "end": "y", "price_eur_mwh": 0, "price_ron_kwh": price, "is_negative": price < 0}

    def test_computes_avg_min_max(self):
        intervals = [self._interval(p) for p in [0.1, 0.5, 0.9]]
        payload = fetch_prices.build_day_payload("2026-06-01", intervals)
        self.assertAlmostEqual(payload["avg_ron_kwh"], 0.5)
        self.assertEqual(payload["min_ron_kwh"], 0.1)
        self.assertEqual(payload["max_ron_kwh"], 0.9)
        self.assertEqual(payload["interval_count"], 3)

    def test_cheapest_and_priciest_are_sorted_correctly(self):
        prices = [0.9, 0.1, 0.5, 0.3, 0.7, 0.2, 0.8, 0.4]
        intervals = [self._interval(p) for p in prices]
        payload = fetch_prices.build_day_payload("2026-06-01", intervals)
        cheapest_prices = [i["price_ron_kwh"] for i in payload["cheapest_intervals"]]
        priciest_prices = [i["price_ron_kwh"] for i in payload["priciest_intervals"]]
        self.assertEqual(cheapest_prices, sorted(prices)[:6])
        self.assertEqual(priciest_prices, sorted(prices, reverse=True)[:6])

    def test_empty_intervals_do_not_crash(self):
        payload = fetch_prices.build_day_payload("2026-06-01", [])
        self.assertIsNone(payload["avg_ron_kwh"])
        self.assertIsNone(payload["min_ron_kwh"])
        self.assertIsNone(payload["max_ron_kwh"])


class UpdateHistoryTest(unittest.TestCase):
    def test_appends_and_replaces_same_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            history_file = Path(tmp) / "history.json"
            original = fetch_prices.HISTORY_FILE
            fetch_prices.HISTORY_FILE = history_file
            try:
                fetch_prices.update_history(
                    {"date": "2026-06-01", "avg_ron_kwh": 0.4, "min_ron_kwh": 0.1, "max_ron_kwh": 0.8}
                )
                fetch_prices.update_history(
                    {"date": "2026-06-02", "avg_ron_kwh": 0.5, "min_ron_kwh": 0.2, "max_ron_kwh": 0.9}
                )
                # re-scriere pentru aceeasi zi -- nu trebuie sa duplice intrarea
                fetch_prices.update_history(
                    {"date": "2026-06-01", "avg_ron_kwh": 0.45, "min_ron_kwh": 0.15, "max_ron_kwh": 0.85}
                )
                history = json.loads(history_file.read_text())
                self.assertEqual(len(history), 2)
                self.assertEqual(history[0]["date"], "2026-06-01")
                self.assertAlmostEqual(history[0]["avg_ron_kwh"], 0.45)
            finally:
                fetch_prices.HISTORY_FILE = original

    def test_keeps_only_last_n_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            history_file = Path(tmp) / "history.json"
            original = fetch_prices.HISTORY_FILE
            original_max = fetch_prices.HISTORY_MAX_DAYS
            fetch_prices.HISTORY_FILE = history_file
            fetch_prices.HISTORY_MAX_DAYS = 3
            try:
                for day in range(1, 6):
                    fetch_prices.update_history(
                        {"date": f"2026-06-0{day}", "avg_ron_kwh": 0.1 * day, "min_ron_kwh": 0, "max_ron_kwh": 1}
                    )
                history = json.loads(history_file.read_text())
                self.assertEqual(len(history), 3)
                self.assertEqual([h["date"] for h in history], ["2026-06-03", "2026-06-04", "2026-06-05"])
            finally:
                fetch_prices.HISTORY_FILE = original
                fetch_prices.HISTORY_MAX_DAYS = original_max

    def test_none_payload_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            history_file = Path(tmp) / "history.json"
            original = fetch_prices.HISTORY_FILE
            fetch_prices.HISTORY_FILE = history_file
            try:
                fetch_prices.update_history(None)
                self.assertFalse(history_file.exists())
            finally:
                fetch_prices.HISTORY_FILE = original


if __name__ == "__main__":
    unittest.main()
