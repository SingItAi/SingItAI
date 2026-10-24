import base64
import importlib.util
import io
import json
import os
import socket
import sqlite3
import ssl
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "singit-uptime.py"


def load_uptime():
    spec = importlib.util.spec_from_file_location("singit_uptime", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


NOW = 1_800_000_000  # a fixed instant; every window below is computed from it

ENTRY = {"scheme": "exact", "network": "eip155:8453", "payTo": "0x" + "1" * 40, "amount": "5000"}


def challenge(**overrides):
    data = {"x402Version": 2, "accepts": [dict(ENTRY)]}
    data.update(overrides)
    return data


def b64(data):
    return base64.b64encode(json.dumps(data).encode()).decode()


GOOD_402 = (402, {"payment-required": b64(challenge())}, b"{}")


class FakeOpener:
    """Stands in for the network: routes by URL to a canned (status, headers, body) or an exception."""

    def __init__(self, routes=None, default=None):
        self.routes = routes or {}
        self.default = default
        self.seen = []

    def __call__(self, request, timeout):
        self.seen.append((request, timeout))
        outcome = self.routes.get(request.full_url, self.default)
        if isinstance(outcome, BaseException):
            raise outcome
        if outcome is None:
            raise AssertionError(f"unexpected request {request.full_url}")
        return outcome


def healthy_routes(up):
    return {
        "https://ask.singitai.app/v1/responses": GOOD_402,
        "https://ask.singitai.app/v1/chat/completions": GOOD_402,
        "https://ask.singitai.app/openapi.json": (200, {}, json.dumps({"openapi": "3.1.0"}).encode()),
        "https://ask.singitai.app/health": (200, {}, json.dumps({"ok": True, "service": "singit-ask"}).encode()),
        "https://app.singitai.app/app/": (200, {}, b"<html></html>"),
        "https://app.singitai.app/mcp": (405, {"allow": "GET, POST"}, b"{}"),
    }


class ChallengeTests(unittest.TestCase):
    def setUp(self):
        self.up = load_uptime()

    def test_good_v2_header_challenge(self):
        self.assertTrue(self.up.validate_challenge({"PAYMENT-REQUIRED": b64(challenge())}, b"{}"))

    def test_header_lookup_is_case_insensitive(self):
        self.assertTrue(self.up.validate_challenge({"payment-required": b64(challenge())}, b"{}"))

    def test_missing_header_and_empty_body_is_invalid(self):
        self.assertFalse(self.up.validate_challenge({}, b"{}"))
        self.assertFalse(self.up.validate_challenge(None, b""))

    def test_garbage_header_is_invalid(self):
        self.assertFalse(self.up.validate_challenge({"PAYMENT-REQUIRED": "%%%not base64%%%"}, b"{}"))
        self.assertFalse(self.up.validate_challenge({"PAYMENT-REQUIRED": base64.b64encode(b"nope").decode()}, b"{}"))

    def test_empty_accepts_is_invalid(self):
        self.assertFalse(self.up.validate_challenge({"PAYMENT-REQUIRED": b64(challenge(accepts=[]))}, b"{}"))

    def test_missing_pay_to_is_invalid(self):
        entry = {k: v for k, v in ENTRY.items() if k != "payTo"}
        self.assertFalse(self.up.validate_challenge({"PAYMENT-REQUIRED": b64(challenge(accepts=[entry]))}, b"{}"))

    def test_one_bad_entry_among_good_ones_is_invalid(self):
        bad = {k: v for k, v in ENTRY.items() if k != "scheme"}
        self.assertFalse(self.up.validate_challenge(
            {"PAYMENT-REQUIRED": b64(challenge(accepts=[dict(ENTRY), bad]))}, b"{}"))

    def test_missing_amount_or_version_is_invalid(self):
        entry = {k: v for k, v in ENTRY.items() if k != "amount"}
        self.assertFalse(self.up.validate_challenge({"PAYMENT-REQUIRED": b64(challenge(accepts=[entry]))}, b"{}"))
        data = challenge()
        del data["x402Version"]
        self.assertFalse(self.up.validate_challenge({"PAYMENT-REQUIRED": b64(data)}, b"{}"))

    def test_v1_body_style_with_max_amount_required(self):
        entry = {k: v for k, v in ENTRY.items() if k != "amount"}
        entry["maxAmountRequired"] = "5000"
        body = json.dumps(challenge(x402Version=1, accepts=[entry])).encode()
        self.assertTrue(self.up.validate_challenge({}, body))

    def test_bad_body_style_is_invalid(self):
        self.assertFalse(self.up.validate_challenge({}, json.dumps(challenge(accepts=[])).encode()))
        self.assertFalse(self.up.validate_challenge({}, b"<html>pay up</html>"))


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.up = load_uptime()
        self.eps = {ep["name"]: ep for ep in self.up.DEFAULT_ENDPOINTS}

    def probe(self, name, outcome):
        return self.up.probe_endpoint(self.eps[name], FakeOpener(default=outcome))

    def test_default_endpoints_match_the_spec(self):
        self.assertEqual([(n, e["expect"]) for n, e in self.eps.items()],
                         [("ask-responses", 402), ("ask-chat", 402), ("ask-openapi", 200),
                          ("ask-health", 200), ("app-page", 200), ("app-mcp", 405)])

    def test_402_with_challenge_is_up(self):
        result = self.probe("ask-responses", GOOD_402)
        self.assertEqual((result["ok"], result["status"], result["error"]), (1, 402, None))

    def test_402_without_challenge_is_down_bad_challenge(self):
        result = self.probe("ask-chat", (402, {}, b"{}"))
        self.assertEqual((result["ok"], result["status"], result["error"]), (0, 402, "bad_challenge"))

    def test_200_where_402_expected_is_down(self):
        result = self.probe("ask-responses", (200, {}, b"{}"))
        self.assertEqual((result["ok"], result["status"], result["error"]), (0, 200, "http_status"))

    def test_405_is_up_for_mcp_and_200_is_down(self):
        self.assertEqual(self.probe("app-mcp", (405, {}, b"{}"))["ok"], 1)
        self.assertEqual(self.probe("app-mcp", (200, {}, b"{}"))["error"], "http_status")

    def test_redirect_is_http_status(self):
        result = self.probe("app-page", (302, {"location": "https://evil.example/"}, b""))
        self.assertEqual((result["ok"], result["error"]), (0, "http_status"))

    def test_json_body_checks(self):
        self.assertEqual(self.probe("ask-openapi", (200, {}, b'{"openapi":"3.1.0"}'))["ok"], 1)
        self.assertEqual(self.probe("ask-openapi", (200, {}, b'{"nope":1}'))["error"], "bad_body")
        self.assertEqual(self.probe("ask-openapi", (200, {}, b"<html>"))["error"], "bad_body")
        self.assertEqual(self.probe("ask-health", (200, {}, b'{"ok":true,"service":"singit-ask"}'))["ok"], 1)
        self.assertEqual(self.probe("ask-health", (200, {}, b'{"ok":false}'))["error"], "bad_body")

    def test_timeout_connection_and_tls_classes(self):
        timeout = self.probe("app-page", socket.timeout("secret timeout text"))
        self.assertEqual((timeout["ok"], timeout["status"], timeout["error"]), (0, None, "timeout"))
        url_timeout = self.probe("app-page", urllib.error.URLError(socket.timeout("x")))
        self.assertEqual(url_timeout["error"], "timeout")
        refused = self.probe("app-page", urllib.error.URLError(ConnectionRefusedError("secret host 10.0.0.1")))
        self.assertEqual(refused["error"], "connection")
        tls = self.probe("app-page", urllib.error.URLError(ssl.SSLError("secret cert detail")))
        self.assertEqual(tls["error"], "tls")
        for result in (timeout, url_timeout, refused, tls):
            self.assertNotIn("secret", json.dumps(result))

    def test_timeout_is_10_seconds(self):
        opener = FakeOpener(default=GOOD_402)
        self.up.probe_endpoint(self.eps["ask-chat"], opener)
        self.assertEqual(opener.seen[0][1], 10)

    def test_no_payment_header_and_only_get_is_ever_sent(self):
        opener = FakeOpener(routes=healthy_routes(True))
        results = self.up.probe_round(self.up.load_endpoints(None), opener)
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(len(opener.seen), 6)
        for request, _timeout in opener.seen:
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            names = {name.lower() for name in request.headers}
            self.assertFalse(names & {"payment-signature", "x-payment", "payment", "authorization", "cookie"})
            self.assertFalse(any(name.startswith(("payment", "x-payment")) for name in names))

    def test_real_opener_does_not_follow_redirects(self):
        self.assertIsNone(self.up._NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://x.example/"))


class EndpointConfigTests(unittest.TestCase):
    def setUp(self):
        self.up = load_uptime()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def write(self, data):
        path = self.root / "eps.json"
        path.write_text(json.dumps(data))
        return str(path)

    def test_custom_list_is_loaded(self):
        eps = self.up.load_endpoints(self.write([{"name": "x", "url": "https://x.example/h", "expect": 200}]))
        self.assertEqual(eps, [{"name": "x", "url": "https://x.example/h", "expect": 200, "kind": "plain"}])

    def test_bad_lists_are_refused(self):
        bad = [
            [{"name": "x", "url": "https://u:p@x.example/", "expect": 200}],  # credentials in URL
            [{"name": "x", "url": "ftp://x.example/", "expect": 200}],
            [{"name": "x", "url": "https://x.example/", "expect": 200, "headers": {"A": "b"}}],  # no custom headers
            [{"name": "bad name", "url": "https://x.example/", "expect": 200}],
            [{"name": "x", "url": "https://x.example/", "expect": 200}] * 2,
            [],
        ]
        for data in bad:
            with self.assertRaises(ValueError, msg=data):
                self.up.load_endpoints(self.write(data))

    def test_bad_endpoints_file_exits_2_without_probing(self):
        opener = FakeOpener()
        err = io.StringIO()
        from contextlib import redirect_stderr
        with redirect_stderr(err):
            code = self.up.main(["--endpoints", str(self.root / "missing.json"), "--db", str(self.root / "u.db")],
                                env={}, opener=opener)
        self.assertEqual(code, 2)
        self.assertEqual(opener.seen, [])


def query(path, sql):
    db = sqlite3.connect(path)
    try:
        return db.execute(sql).fetchall()
    finally:
        db.close()


class StoreTests(unittest.TestCase):
    query = staticmethod(query)

    def setUp(self):
        self.up = load_uptime()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.up.open_db(self.root / "uptime.db")
        self.addCleanup(self.db.close)

    def add(self, endpoint, ts, ok=True, latency=100, error=None, status=None):
        status = status if status is not None else (200 if ok else 500)
        self.db.execute("INSERT INTO probes(ts, endpoint, ok, status, latency_ms, error) VALUES (?,?,?,?,?,?)",
                        (ts, endpoint, 1 if ok else 0, status, latency, None if ok else (error or "http_status")))
        self.db.commit()

    def report(self, names=("a",), now=NOW):
        return self.up.build_report(self.db, list(names), now)

    def test_schema_matches_spec(self):
        columns = [row[1] for row in self.db.execute("PRAGMA table_info(probes)")]
        self.assertEqual(columns, ["ts", "endpoint", "ok", "status", "latency_ms", "error"])

    def test_availability_is_null_with_no_probes_never_100(self):
        report = self.report()
        ep = report["endpoints"][0]
        for window in ep["windows"].values():
            self.assertIsNone(window["availability_pct"])
            self.assertEqual(window["probes"], 0)
            self.assertFalse(window["covered"])
            self.assertIsNone(window["p50_latency_ms"])
            self.assertIsNone(window["p95_latency_ms"])
        self.assertEqual(ep["current"], "no_data")
        self.assertIsNone(ep["last_failure"])
        self.assertEqual(ep["consecutive_failures"], 0)
        self.assertEqual(report["overall"]["status"], "no_data")
        self.assertIsNone(report["overall"]["windows"]["30d"]["availability_pct"])

    def test_window_math_with_injected_now(self):
        # 24h: 4 probes (3 ok); 7d adds 2 more (both ok); 30d adds 4 more (1 ok); older than 30d is ignored.
        for ts, ok in [(NOW - 100, True), (NOW - 3600, True), (NOW - 7200, False), (NOW - 86400 + 1, True),
                       (NOW - 2 * 86400, True), (NOW - 6 * 86400, True),
                       (NOW - 10 * 86400, False), (NOW - 20 * 86400, False), (NOW - 29 * 86400, False),
                       (NOW - 29 * 86400 - 5, True), (NOW - 31 * 86400, False)]:
            self.add("a", ts, ok)
        windows = self.report()["endpoints"][0]["windows"]
        self.assertEqual((windows["24h"]["probes"], windows["24h"]["ok"]), (4, 3))
        self.assertEqual(windows["24h"]["availability_pct"], 75.0)
        self.assertEqual((windows["7d"]["probes"], windows["7d"]["ok"]), (6, 5))
        self.assertAlmostEqual(windows["7d"]["availability_pct"], 83.333, places=3)
        self.assertEqual((windows["30d"]["probes"], windows["30d"]["ok"]), (10, 6))
        self.assertEqual(windows["30d"]["availability_pct"], 60.0)

    def test_window_boundary_is_exclusive_at_the_start(self):
        self.add("a", NOW - 86400, True)       # exactly 24h old: outside
        self.add("a", NOW - 86400 + 1, False)  # inside
        self.assertEqual(self.report()["endpoints"][0]["windows"]["24h"]["probes"], 1)

    def test_covered_flags_short_history(self):
        self.add("a", NOW - 7200)  # two hours of data
        self.add("a", NOW - 60)
        windows = self.report()["endpoints"][0]["windows"]
        self.assertFalse(windows["24h"]["covered"])
        self.assertFalse(windows["30d"]["covered"])
        self.assertEqual(windows["30d"]["first_probe_ts"], self.up.iso(NOW - 7200))
        self.assertLess(windows["30d"]["coverage_pct"], 1)
        self.assertEqual(windows["24h"]["coverage_pct"], 8.3)

    def test_covered_true_when_history_reaches_the_window_start(self):
        self.add("a", NOW - 8 * 86400)
        self.add("a", NOW - 60)
        windows = self.report()["endpoints"][0]["windows"]
        self.assertTrue(windows["24h"]["covered"])
        self.assertTrue(windows["7d"]["covered"])
        self.assertFalse(windows["30d"]["covered"])
        self.assertEqual(windows["7d"]["coverage_pct"], 100.0)

    def test_p50_p95_nearest_rank_on_successes_only(self):
        for i, latency in enumerate(range(10, 210, 10)):  # 20 probes: 10..200 ms
            self.add("a", NOW - 100 - i, True, latency)
        self.add("a", NOW - 5, False, 9999)  # a failure's latency never counts
        window = self.report()["endpoints"][0]["windows"]["24h"]
        self.assertEqual(window["p50_latency_ms"], 100)
        self.assertEqual(window["p95_latency_ms"], 190)
        self.assertEqual(self.up.percentile([5], 95), 5)
        self.assertIsNone(self.up.percentile([], 50))

    def test_consecutive_failures_and_last_failure(self):
        self.add("a", NOW - 500, False, error="timeout")
        self.add("a", NOW - 400, True)
        self.add("a", NOW - 300, False, error="connection")
        self.add("a", NOW - 200, False, error="bad_challenge")
        self.add("a", NOW - 100, False, error="timeout")
        ep = self.report()["endpoints"][0]
        self.assertEqual(ep["consecutive_failures"], 3)
        self.assertEqual(ep["current"], "down")
        self.assertEqual(ep["last_failure"], {"ts": self.up.iso(NOW - 100), "error": "timeout"})
        self.add("a", NOW - 50, True)
        ep = self.report()["endpoints"][0]
        self.assertEqual((ep["consecutive_failures"], ep["current"]), (0, "up"))

    def test_overall_block(self):
        self.add("a", NOW - 10, True)
        self.add("b", NOW - 10, False)
        overall = self.report(("a", "b", "c"))["overall"]
        self.assertEqual(overall["status"], "down")
        self.assertEqual((overall["endpoints_up"], overall["endpoints_down"], overall["endpoints_no_data"]), (1, 1, 1))
        self.assertEqual(overall["windows"]["24h"]["availability_pct"], 50.0)
        self.assertFalse(overall["windows"]["24h"]["covered"])

    def test_prune(self):
        self.add("a", NOW - 40 * 86400)
        self.add("a", NOW - 10)
        self.assertEqual(self.up.prune(self.db, 30, NOW), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM probes").fetchone()[0], 1)

    def test_status_json_is_public_safe(self):
        self.add("a", NOW - 100, False, error="connection")
        self.add("a", NOW - 50, False, error="bad_challenge")
        self.add("b", NOW - 50, True)
        status = self.up.build_status(self.report(("a", "b")))
        text = json.dumps(status)
        for forbidden in ("connection", "bad_challenge", "error", "last_failure", "http", "latency", "@"):
            self.assertNotIn(forbidden, text)
        self.assertEqual(sorted(status), ["endpoints", "generated_at", "overall"])
        self.assertEqual([ep["status"] for ep in status["endpoints"]], ["down", "up"])
        self.assertEqual(status["endpoints"][0]["windows"]["24h"]["probes"], 2)
        self.assertEqual(status["generated_at"], self.up.iso(NOW))

    def test_html_escapes_values_and_follows_the_design_rules(self):
        self.add("<script>alert(1)</script>", NOW - 10, True)
        page = self.up.render_html(self.report(("<script>alert(1)</script>", "b&c")))
        self.assertNotIn("<script>alert(1)", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertIn("b&amp;c", page)
        self.assertNotIn("box-shadow", page)
        self.assertNotIn("gradient", page)
        self.assertNotIn("3ecf8e", page.lower())
        self.assertNotIn("bold", page)
        for token in ("#f4f2f0", "#0c0a08", "#6d6c6b", "#e5e7eb", "border-radius: 16px", "max-width: 1200px",
                      'font-feature-settings: "ss01"', "Inter"):
            self.assertIn(token, page)
        self.assertIn("Up", page)
        self.assertIn("No data", page)

    def test_record_and_prune_flags_via_main(self):
        path = self.root / "main.db"
        opener = FakeOpener(routes=healthy_routes(True))
        out = io.StringIO()
        with redirect_stdout(out):
            code = self.up.main(["--db", str(path), "--prune-days", "30"], env={}, opener=opener, now=NOW)
        self.assertEqual(code, 0)
        rows = self.query(path, "SELECT ts, endpoint, ok, status, error FROM probes")
        self.assertEqual(len(rows), 6)
        self.assertTrue(all(row[0] == NOW and row[2] == 1 and row[4] is None for row in rows))


class CliTests(unittest.TestCase):
    query = staticmethod(query)

    def setUp(self):
        self.up = load_uptime()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_probe_mode_exits_0_when_everything_is_down_and_records_classes_only(self):
        path = self.root / "u.db"
        opener = FakeOpener(default=socket.timeout("secret message"))
        out = io.StringIO()
        with redirect_stdout(out):
            code = self.up.main(["--db", str(path)], env={}, opener=opener, now=NOW)
        self.assertEqual(code, 0)
        rows = self.query(path, "SELECT ok, status, error FROM probes")
        self.assertEqual(rows, [(0, None, "timeout")] * 6)
        self.assertNotIn("secret", out.getvalue())

    def test_db_path_from_env_and_flag_and_default(self):
        env_path = self.root / "env.db"
        self.assertEqual(self.up.resolve_db_path(None, {"SINGIT_UPTIME_DB": str(env_path)}), env_path)
        self.assertEqual(self.up.resolve_db_path("/tmp/flag.db", {"SINGIT_UPTIME_DB": str(env_path)}),
                         Path("/tmp/flag.db"))
        self.assertEqual(self.up.resolve_db_path(None, {}), Path("~/.sign402/uptime.db").expanduser())
        opener = FakeOpener(routes=healthy_routes(True))
        with redirect_stdout(io.StringIO()):
            self.up.main([], env={"SINGIT_UPTIME_DB": str(env_path)}, opener=opener, now=NOW)
        self.assertTrue(env_path.is_file())

    def test_report_on_missing_db_prints_nulls_and_creates_nothing(self):
        path = self.root / "none.db"
        out = io.StringIO()
        with redirect_stdout(out):
            code = self.up.main(["--report", "--db", str(path)], env={}, now=NOW)
        self.assertEqual(code, 0)
        self.assertFalse(path.exists())
        report = json.loads(out.getvalue())
        self.assertEqual(len(report["endpoints"]), 6)
        self.assertIsNone(report["endpoints"][0]["windows"]["30d"]["availability_pct"])
        self.assertEqual(report["overall"]["status"], "no_data")

    def test_report_modes_never_probe_and_write_files(self):
        path = self.root / "u.db"
        with redirect_stdout(io.StringIO()):
            self.up.main(["--db", str(path)], env={}, opener=FakeOpener(routes=healthy_routes(True)), now=NOW)
        opener = FakeOpener()
        report_file, status_file, html_file = (self.root / n for n in ("r.json", "s.json", "p.html"))
        with redirect_stdout(io.StringIO()):
            code = self.up.main(["--db", str(path), "--report-file", str(report_file), "--status-json",
                                 str(status_file), "--html", str(html_file)], env={}, opener=opener, now=NOW + 60)
        self.assertEqual(code, 0)
        self.assertEqual(opener.seen, [])
        self.assertEqual(json.loads(report_file.read_text())["overall"]["status"], "up")
        self.assertEqual(json.loads(status_file.read_text())["endpoints"][0]["status"], "up")
        self.assertIn("<!doctype html>", html_file.read_text())

    def test_help_runs(self):
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(SystemExit) as raised:
            self.up.main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("--status-json", out.getvalue())


if __name__ == "__main__":
    unittest.main()
