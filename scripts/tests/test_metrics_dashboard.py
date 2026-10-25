import datetime
import importlib.util
import io
import json
import os
import re
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "metrics-dashboard.py"
ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")
LAST = datetime.date(2026, 10, 17)


def load_dashboard():
    spec = importlib.util.spec_from_file_location("metrics_dashboard", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def report(day: datetime.date, n: int = 1, **over):
    """A report shaped like daily-metrics.py's, with figures that vary by `n`."""
    out = {
        "day": day.isoformat(),
        "new_accounts": {"base": n, "solana": 1},
        "signed_in_today": 10 * n,
        "active_spenders": 2 * n,
        "first_purchases": n,
        "repeat_buyers": 1,
        "purchases": {"data_tool": 3 * n, "chat": 2},
        "errors": {"ops_failed": 1},
        "usdc_volume": {"base": f"{n}.50", "solana": "0.25"},
        "chat_answers": 5 * n,
        "chat_cost_usd": "0.40",
        "topups_credited_usd": "12.00",
        "api_keys": {"active": n, "created": 1},
        "mcp": {"calls_total": 7 * n, "paid_calls": 2, "cost_usd": "0.010", "distinct_uids": 3,
                "latency_ms": {"p50": 120, "p95": 900},
                "by_tool": {"web_search": 4 * n, "get_price": 3 * n}, "by_status": {"ok": 6 * n, "error": n}},
        "revenue": {"margin": None, "margin_note": "allowance.db settlements lack a cost.",
                    "balance_lane": {"margin_usd": "0.45"}},
        # The dashboard must not read the detail block, which is where a raw address could ever sit.
        "detail": {"web": {"note": "0x" + "ab" * 20}},
    }
    out.update(over)
    return out


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "metrics"
        self.dir.mkdir()
        self.dash = load_dashboard()

    def write(self, day, data):
        (self.dir / f"{day.isoformat()}.json").write_text(json.dumps(data))

    def seed(self, days=5):
        for offset in range(days):
            day = LAST - datetime.timedelta(days=offset)
            self.write(day, report(day, n=days - offset))

    def html(self, days=30):
        window, reports, notes = self.dash.load_reports(self.dir, days)
        return self.dash.render(window, reports, notes, "2026-10-18 00:15 UTC")

    def test_renders_one_self_contained_page_from_fixture_files(self):
        self.seed()
        page = self.html(5)
        self.assertTrue(page.startswith("<!doctype html>"))
        for heading in ("Wallets", "Transactions and purchases", "Revenue", "Active API keys", "MCP calls"):
            self.assertIn(f"<h2>{heading}</h2>", page)
        self.assertIn("<svg", page)
        self.assertIn("2026-10-13 to 2026-10-17", page)
        # Self-contained: no script, no external reference of any kind.
        self.assertNotIn("<script", page.lower())
        self.assertNotIn("<link", page.lower())
        self.assertNotIn("<img", page.lower())
        self.assertNotIn("@import", page)
        self.assertIsNone(re.search(r"(?:src|href)=|url\(|https?://", page))

    def test_shows_the_values_and_the_mcp_breakdown(self):
        self.seed()
        page = self.html()
        self.assertIn("web_search", page)
        self.assertIn("get_price", page)
        self.assertIn("120 ms", page)
        self.assertIn("900 ms", page)
        self.assertIn("$0.45", page)  # the balance lane's margin
        # By tool over five days n = 5, 4, 3, 2, 1 -> web_search 4 * 15 = 60.
        self.assertRegex(page, r'<th scope="row">web_search</th><td class="num">60</td>')

    def test_contains_no_address_even_when_one_is_in_the_data(self):
        self.seed()
        self.write(LAST, report(LAST, mcp={"calls_total": 1, "by_tool": {"0x" + "cd" * 20: 1}, "by_status": {}}))
        page = self.html()
        self.assertIsNone(ADDRESS_RE.search(page))
        self.assertNotIn("ab" * 20, page)

    def test_nulls_and_missing_figures_are_dashes_never_zero(self):
        self.write(LAST, report(LAST, mcp=None, api_keys={"active": None, "created": None}, signed_in_today=None,
                                usdc_volume={"base": None, "solana": None}, purchases=None))
        page = self.html()
        window, reports, _ = self.dash.load_reports(self.dir, 30)
        by_label = {m.label: m for _, metrics in self.dash.SECTIONS for m in metrics}
        for label in ("Calls", "Keys with a billed call", "Signed in", "USDC volume, Base", "Purchases (all categories)",
                      "Latency p50", "Distinct users"):
            with self.subTest(label):
                self.assertIsNone(by_label[label].read(reports[LAST]))
                self.assertEqual(by_label[label].fmt(None), "—")
        self.assertIn("—", page)
        self.assertNotIn("0 ms", page)
        self.assertNotIn("$0.00", page)
        # A null MCP section prints dashes in the breakdown instead of an empty table of zeros.
        self.assertIn('<tr><td>—</td><td class="num">—</td></tr>', page)

    def test_a_partial_total_is_not_a_zero_total(self):
        self.assertIsNone(self.dash.total_of(None, None))
        self.assertEqual(self.dash.total_of(None, "2"), 2)
        self.assertIsNone(self.dash.count_total({}))
        self.assertIsNone(self.dash.number(True))
        self.assertIsNone(self.dash.number("abc"))
        self.assertIsNone(self.dash.number(float("nan")))

    def test_a_zero_that_was_recorded_is_still_a_zero(self):
        self.write(LAST, report(LAST, mcp={"calls_total": 0, "paid_calls": 0, "cost_usd": "0.00", "distinct_uids": 0,
                                           "latency_ms": {"p50": None, "p95": None}, "by_tool": {}, "by_status": {}}))
        by_label = {m.label: m for _, metrics in self.dash.SECTIONS for m in metrics}
        _, reports, _ = self.dash.load_reports(self.dir, 30)
        self.assertEqual(by_label["Calls"].fmt(by_label["Calls"].read(reports[LAST])), "0")
        self.assertEqual(by_label["Latency p50"].fmt(by_label["Latency p50"].read(reports[LAST])), "—")

    def test_a_missing_day_is_a_gap_not_a_zero(self):
        self.write(LAST, report(LAST, n=2))
        self.write(LAST - datetime.timedelta(days=3), report(LAST - datetime.timedelta(days=3), n=4))
        window, reports, _ = self.dash.load_reports(self.dir, 5)
        self.assertEqual(len(window), 5)
        self.assertEqual(len(reports), 2)
        calls = next(m for _, ms in self.dash.SECTIONS for m in ms if m.label == "Calls")
        self.assertEqual(calls.series(window, reports), [None, 28, None, None, 14])
        line = self.dash.sparkline(calls.series(window, reports))
        self.assertEqual(line.count("<circle"), 2)  # two isolated points, not a line down to zero
        self.assertNotIn("<polyline", line)
        self.assertIn("2 of 5 days", self.html(5))

    def test_window_is_the_last_n_days_ending_at_the_newest_file(self):
        self.seed(days=10)
        window, reports, _ = self.dash.load_reports(self.dir, 3)
        self.assertEqual(window, [LAST - datetime.timedelta(days=2), LAST - datetime.timedelta(days=1), LAST])
        self.assertEqual(sorted(reports), window)
        self.assertNotIn("2026-10-10", self.html(3))

    def test_unreadable_and_foreign_files_are_skipped_with_a_note(self):
        self.seed(days=2)
        (self.dir / "2026-10-01.json").write_text("{not json")
        (self.dir / "2026-10-02.json").write_text("[1, 2]")
        (self.dir / "notes.txt").write_text("ignore me")
        (self.dir / "dashboard.html").write_text("<html>")
        window, reports, notes = self.dash.load_reports(self.dir, 30)
        self.assertEqual(len(reports), 2)
        self.assertEqual(len(notes), 2)
        self.assertIn("skipped 2026-10-01.json", self.html())

    def test_an_empty_or_missing_directory_renders_a_notice(self):
        for directory in (self.dir, self.dir / "absent"):
            with self.subTest(str(directory)):
                window, reports, notes = self.dash.load_reports(directory, 30)
                page = self.dash.render(window, reports, notes)
                self.assertIn("No daily reports found", page)
                self.assertNotIn("<svg", page)

    def test_margin_is_a_dash_with_the_note_from_the_report(self):
        self.seed(days=2)
        page = self.html()
        self.assertIn("Margin: allowance.db settlements lack a cost.", page)
        margin = next(m for _, ms in self.dash.SECTIONS for m in ms if m.label == "Margin")
        _, reports, _ = self.dash.load_reports(self.dir, 30)
        self.assertIsNone(margin.read(reports[LAST]))

    def test_text_in_the_data_is_escaped(self):
        self.seed(days=1)
        self.write(LAST, report(LAST, mcp={"calls_total": 1, "by_tool": {"<b>x</b>": 1}, "by_status": {}}))
        page = self.html()
        self.assertNotIn("<b>x</b>", page)
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", page)

    def test_the_command_writes_a_private_file_and_creates_its_directory(self):
        self.seed()
        out = Path(self.tmp.name) / "nested" / "dashboard.html"
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = self.dash.main(["--dir", str(self.dir), "--days", "3", "--out", str(out)])
        self.assertEqual(code, 0)
        self.assertIn("(3 of 3 days)", buffer.getvalue())
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        page = out.read_text()
        self.assertIsNone(ADDRESS_RE.search(page))
        self.assertIn("2026-10-15 to 2026-10-17", page)

    def test_the_command_tightens_the_mode_of_an_older_wider_file(self):
        self.seed(days=1)
        out = Path(self.tmp.name) / "dashboard.html"
        out.write_text("old")
        os.chmod(out, 0o644)
        with redirect_stdout(io.StringIO()):
            self.dash.main(["--dir", str(self.dir), "--out", str(out)])
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)

    def test_days_must_be_positive(self):
        with self.assertRaises(SystemExit):
            self.dash.main(["--dir", str(self.dir), "--days", "0", "--out", str(Path(self.tmp.name) / "x.html")])

    def test_the_default_paths_live_under_the_operator_home_not_a_web_root(self):
        self.assertEqual(self.dash.DEFAULT_OUT, "~/.sign402/metrics/dashboard.html")
        self.assertEqual(self.dash.DEFAULT_DIR, "~/.sign402/metrics")
        source = SCRIPT.read_text()
        self.assertIn("never served", source)
        self.assertIn("# 15 0 * * *", source)


class DailyMetricsRoundTripTests(unittest.TestCase):
    """The dashboard reads what daily-metrics.py really writes, not only hand-made fixtures."""

    def run_daily(self, directory, day, *extra):
        spec = importlib.util.spec_from_file_location("daily_metrics_rt", ROOT / "scripts" / "daily-metrics.py")
        dm = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = dm
        spec.loader.exec_module(dm)
        absent = Path(directory) / "absent"
        with redirect_stdout(io.StringIO()):
            code = dm.main(["--day", day.isoformat(), "--out", str(Path(directory) / "out"),
                            "--web-db", str(absent / "web.db"), "--allowance-db", str(absent / "a.db"),
                            "--solana-db", str(absent / "s.db"), "--user-wallet-db", str(absent / "u.db"),
                            "--bitrefill-orders-db", str(absent / "b.db"), *extra])
        return code

    def test_reports_with_every_store_missing_render_as_dashes(self):
        dash = load_dashboard()
        with tempfile.TemporaryDirectory() as tmp:
            for offset in range(3):
                self.assertEqual(self.run_daily(tmp, LAST - datetime.timedelta(days=offset)), 0)
            window, reports, notes = dash.load_reports(Path(tmp) / "out", 3)
            self.assertEqual((len(window), len(reports), notes), (3, 3, []))
            page = dash.render(window, reports, notes)
        self.assertIsNone(ADDRESS_RE.search(page))
        self.assertIn("—", page)
        self.assertNotIn("<script", page)
        # Nothing was recorded, so no figure may have been drawn as a zero.
        self.assertNotIn("$0.00", page)
        self.assertNotIn(">0<", page)
        self.assertIn("allowance.db", page)  # the margin note travels with the report


if __name__ == "__main__":
    unittest.main()
