import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("pilot_accounts", Path(__file__).resolve().parents[1] / "pilot-accounts.py")
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)


def make_db(path, accounts, keys=(), spend=()):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE accounts (account_id TEXT PRIMARY KEY, owner_address TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, utm_json TEXT);
        CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT);
        CREATE TABLE api_key_spend (key_id TEXT, day INTEGER, spent_atomic INTEGER);
    """)
    db.executemany("INSERT INTO accounts VALUES (?,?,?,?)", accounts)
    db.executemany("INSERT INTO api_keys VALUES (?,?,?)", keys)
    db.executemany("INSERT INTO api_key_spend VALUES (?,?,?)", spend)
    db.commit()
    db.close()


class PilotAccountsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "web.db"

    def test_counts_pilot_accounts_per_campaign_without_identifiers(self):
        pilot_utm = lambda c: json.dumps({"utm_source": "github", "utm_medium": "pilot", "utm_campaign": c})
        make_db(self.path, [
            ("wallet:0xaaa", "0xaaa", 1_800_000_000, pilot_utm("proj-a")),
            ("wallet:0xbbb", "0xbbb", 1_800_086_400, pilot_utm("proj-a")),
            ("wallet:0xccc", "0xccc", 1_800_000_100, pilot_utm("proj-b")),
            ("wallet:0xddd", "0xddd", 1_800_000_200, json.dumps({"utm_medium": "social"})),
            ("wallet:0xeee", "0xeee", 1_800_000_300, None),
            ("wallet:0xfff", "0xfff", 1_800_000_400, "not json"),
        ], keys=[("k1", "wallet:0xaaa", "secret name"), ("k2", "wallet:0xccc", "x")],
            spend=[("k1", 1, 7000), ("k2", 1, 0)])
        report = pilot.pilot_report(self.path)
        self.assertTrue(report["ok"])
        self.assertEqual((report["accounts_total"], report["accounts_with_utm"], report["pilot_accounts"]), (6, 4, 3))
        a, b = report["campaigns"]
        self.assertEqual((a["utm_campaign"], a["accounts"], a["with_key"], a["with_spend"]), ("proj-a", 2, 1, 1))
        self.assertEqual((b["utm_campaign"], b["accounts"], b["with_key"], b["with_spend"]), ("proj-b", 1, 1, 0))
        self.assertEqual(a["last_account_at"], "2027-01-16")
        text = json.dumps(report) + pilot.render_text(report)
        for private in ("0xaaa", "wallet:", "k1", "secret name"):
            self.assertNotIn(private, text)

    def test_opened_read_only_and_reports_missing_pieces(self):
        make_db(self.path, [("wallet:0x1", "0x1", 1, json.dumps({"utm_medium": "pilot"}))])
        before = self.path.read_bytes()
        pilot.pilot_report(self.path)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(pilot.pilot_report(Path(self.tmp.name) / "missing.db")["error"], "web.db not found")
        old = Path(self.tmp.name) / "old.db"
        db = sqlite3.connect(old)
        db.execute("CREATE TABLE accounts (account_id TEXT, owner_address TEXT, created_at INTEGER)")
        db.close()
        self.assertIn("utm_json", pilot.pilot_report(old)["error"])

    def test_another_medium_and_no_attribution_at_all(self):
        make_db(self.path, [("wallet:0x1", "0x1", 1, json.dumps({"utm_medium": "social", "utm_campaign": "c"})),
                            ("wallet:0x2", "0x2", 2, None)])
        self.assertEqual(pilot.pilot_report(self.path)["pilot_accounts"], 0)
        self.assertEqual(pilot.pilot_report(self.path, "social")["pilot_accounts"], 1)


if __name__ == "__main__":
    unittest.main()
