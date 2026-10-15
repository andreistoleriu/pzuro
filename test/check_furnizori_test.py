"""Teste offline pentru check_furnizori.py (fara retea)."""

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_furnizori as cf  # noqa: E402


class CheckFurnizoriTest(unittest.TestCase):
    def test_furnizor_fara_monitor_e_semnalat_doar_cand_e_vechi(self):
        f = {"oferta": "X", "verificat": "2026-10-01", "monitor": None, "sursa": "https://x"}
        self.assertEqual(cf.check_furnizor(f, date(2026, 10, 15)), [])
        self.assertEqual(len(cf.check_furnizor(f, date(2026, 12, 1))), 1)

    def test_parse_value(self):
        self.assertEqual(cf.parse_value("0,20000"), 0.2)
        self.assertEqual(cf.parse_value("0.149"), 0.149)

    def test_raport_fara_probleme(self):
        cfg = {"furnizori": [{"oferta": "X", "verificat": "2026-10-10", "monitor": None, "sursa": "https://x"}]}
        report, found = cf.build_report(cfg, date(2026, 10, 15))
        self.assertFalse(found)


if __name__ == "__main__":
    unittest.main()
