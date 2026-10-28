import importlib.util
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "singit-health-alert.py"


def load_health_alert():
    spec = importlib.util.spec_from_file_location("singit_health_alert", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self, _cap=None):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_urlopen(sequence):
    """Returns the next (status, body) from `sequence`, as a FakeResponse or a raised HTTPError."""
    calls = iter(sequence)

    def _opener(request, timeout=None):
        status, body = next(calls)
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "err", {}, io.BytesIO(body))
        return FakeResponse(status, body)
    return _opener


class HttpCheckTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()

    def test_a_200_with_ok_true_passes(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, b'{"ok": true}')])):
            result = self.ha._http_check("ask", "https://x.test/health", timeout=5, require_ok=True)
        self.assertEqual(result, {"name": "ask", "ok": True, "message": "ok"})

    def test_a_5xx_is_a_failure(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(503, b"")])):
            result = self.ha._http_check("ask", "https://x.test/health", timeout=5, require_ok=True)
        self.assertFalse(result["ok"])
        self.assertIn("503", result["message"])

    def test_ok_false_is_a_failure_even_on_200(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, b'{"ok": false}')])):
            result = self.ha._http_check("ask", "https://x.test/health", timeout=5, require_ok=True)
        self.assertFalse(result["ok"])
        self.assertIn("ok=False", result["message"])

    def test_a_non_200_without_require_ok_still_fails(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(404, b"")])):
            result = self.ha._http_check("app", "https://x.test/app/", timeout=5, require_ok=False)
        self.assertFalse(result["ok"])

    def test_a_connection_error_is_a_failure(self):
        def _raise(request, timeout=None):
            raise TimeoutError
        with patch.object(self.ha.urllib.request, "urlopen", _raise):
            result = self.ha._http_check("app", "https://x.test/app/", timeout=5, require_ok=False)
        self.assertFalse(result["ok"])
        self.assertIn("unreachable", result["message"])

    def test_non_json_body_with_require_ok_is_a_failure(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, b"not json")])):
            result = self.ha._http_check("ask", "https://x.test/health", timeout=5, require_ok=True)
        self.assertFalse(result["ok"])


class RpcCheckTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()

    def test_a_clean_block_number_passes(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": "0x1"}).encode()
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, body)])):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertEqual(result["ok"], True)

    def test_a_quota_error_is_tagged_and_the_url_is_redacted(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1,
                           "error": {"code": -32005, "message": "limit exceeded"}}).encode()
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, body)])):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertFalse(result["ok"])
        self.assertIn("rpc_quota_or_error", result["message"])
        self.assertNotIn("SECRET-KEY", result["message"])
        self.assertIn("https://rpc.test", result["message"])

    def test_a_quota_message_without_a_known_code_is_still_tagged(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -1, "message": "quota exceeded"}}).encode()
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, body)])):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertFalse(result["ok"])
        self.assertIn("rpc_quota_or_error", result["message"])

    def test_http_429_is_a_quota_failure(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(429, b"")])):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertFalse(result["ok"])
        self.assertIn("rpc_quota_or_error", result["message"])
        self.assertNotIn("SECRET-KEY", result["message"])

    def test_a_timeout_never_leaks_the_url(self):
        def _raise(request, timeout=None):
            raise TimeoutError
        with patch.object(self.ha.urllib.request, "urlopen", _raise):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertFalse(result["ok"])
        self.assertNotIn("SECRET-KEY", result["message"])

    def test_http_403_with_an_empty_body_is_a_failure(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(403, b"{}")])):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertFalse(result["ok"])
        self.assertNotIn("SECRET-KEY", result["message"])

    def test_an_answer_without_a_block_number_is_a_failure(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen([(200, b"{}")])):
            result = self.ha.check_rpc("https://rpc.test/v2/SECRET-KEY", timeout=5)
        self.assertFalse(result["ok"])

    def test_redact_keeps_only_scheme_and_host(self):
        self.assertEqual(self.ha.redact("https://rpc.test/v2/SECRET-KEY?x=1"), "https://rpc.test")


class JournalCheckTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()

    def test_journalctl_unavailable_is_skipped_not_failed(self):
        with patch.object(self.ha.shutil, "which", return_value=None):
            result = self.ha.check_journal("my-unit", minutes=10, threshold=5)
        self.assertTrue(result["ok"])
        self.assertTrue(result.get("skipped"))

    def test_over_threshold_fails(self):
        completed = Mock(returncode=0, stdout="line one\nHTTP 503 oh no\nTraceback (most recent call last):\nmore 500\nand 502\n")
        with patch.object(self.ha.shutil, "which", return_value="/usr/bin/journalctl"), \
             patch.object(self.ha.subprocess, "run", return_value=completed):
            result = self.ha.check_journal("my-unit", minutes=10, threshold=2)
        self.assertFalse(result["ok"])

    def test_under_threshold_passes(self):
        completed = Mock(returncode=0, stdout="all quiet\n")
        with patch.object(self.ha.shutil, "which", return_value="/usr/bin/journalctl"), \
             patch.object(self.ha.subprocess, "run", return_value=completed):
            result = self.ha.check_journal("my-unit", minutes=10, threshold=2)
        self.assertTrue(result["ok"])


class TriageAndDedupeTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()

    def test_a_first_failure_alerts(self):
        results = [{"name": "ask", "ok": False, "message": "HTTP 503"}]
        to_alert, recovered, state = self.ha.triage(results, {}, now=1000, repeat_seconds=3600)
        self.assertEqual(to_alert, results)
        self.assertEqual(recovered, [])
        self.assertEqual(state["ask"], {"failing": True, "last_alert": 1000})

    def test_a_repeated_failure_inside_the_window_does_not_re_alert(self):
        results = [{"name": "ask", "ok": False, "message": "HTTP 503"}]
        state = {"ask": {"failing": True, "last_alert": 1000}}
        to_alert, recovered, next_state = self.ha.triage(results, state, now=1000 + 60, repeat_seconds=3600)
        self.assertEqual(to_alert, [])
        self.assertEqual(next_state["ask"]["last_alert"], 1000)  # unchanged

    def test_a_failure_past_the_repeat_window_re_alerts(self):
        results = [{"name": "ask", "ok": False, "message": "HTTP 503"}]
        state = {"ask": {"failing": True, "last_alert": 1000}}
        to_alert, recovered, next_state = self.ha.triage(results, state, now=1000 + 3700, repeat_seconds=3600)
        self.assertEqual(to_alert, results)
        self.assertEqual(next_state["ask"]["last_alert"], 1000 + 3700)

    def test_passing_after_failing_is_a_recovery(self):
        results = [{"name": "ask", "ok": True, "message": "ok"}]
        state = {"ask": {"failing": True, "last_alert": 1000}}
        to_alert, recovered, next_state = self.ha.triage(results, state, now=2000, repeat_seconds=3600)
        self.assertEqual(to_alert, [])
        self.assertEqual(recovered, results)
        self.assertEqual(next_state["ask"], {"failing": False, "last_alert": None})

    def test_passing_when_never_failing_is_not_a_recovery(self):
        results = [{"name": "ask", "ok": True, "message": "ok"}]
        to_alert, recovered, next_state = self.ha.triage(results, {}, now=2000, repeat_seconds=3600)
        self.assertEqual(recovered, [])

    def test_a_skipped_check_is_ignored_by_triage(self):
        results = [{"name": "journal:x", "ok": True, "skipped": True, "message": "journalctl unavailable; skipped"}]
        to_alert, recovered, next_state = self.ha.triage(results, {}, now=2000, repeat_seconds=3600)
        self.assertEqual((to_alert, recovered, next_state), ([], [], {}))

    def test_format_message_combines_alerts_and_recoveries(self):
        text = self.ha.format_message(
            [{"name": "ask", "message": "HTTP 503"}], [{"name": "app", "message": "ok"}])
        self.assertIn("ask: HTTP 503", text)
        self.assertIn("Recovered:", text)
        self.assertIn("app: ok", text)

    def test_format_message_is_empty_when_nothing_changed(self):
        self.assertEqual(self.ha.format_message([], []), "")


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()

    def test_telegram_is_used_when_configured(self):
        sent = {}

        def _capture(request, timeout=None):
            sent["url"] = request.full_url
            sent["body"] = json.loads(request.data)
            return FakeResponse(200, b"{}")
        with patch.object(self.ha.urllib.request, "urlopen", _capture):
            note = self.ha.deliver("hello", env={self.ha.TELEGRAM_TOKEN_ENV: "tok123",
                                                 self.ha.TELEGRAM_CHAT_ENV: "42"}, timeout=5)
        self.assertIsNone(note)
        self.assertIn("bottok123", sent["url"])
        self.assertEqual(sent["body"], {"chat_id": "42", "text": "hello"})

    def test_webhook_is_used_when_telegram_is_not_configured(self):
        sent = {}

        def _capture(request, timeout=None):
            sent["url"] = request.full_url
            sent["body"] = json.loads(request.data)
            return FakeResponse(200, b"{}")
        with patch.object(self.ha.urllib.request, "urlopen", _capture):
            note = self.ha.deliver("hello", env={self.ha.WEBHOOK_URL_ENV: "https://hooks.test/x"}, timeout=5)
        self.assertIsNone(note)
        self.assertEqual(sent["url"], "https://hooks.test/x")
        self.assertEqual(sent["body"], {"text": "hello"})

    def test_ntfy_gets_plain_text_with_a_title_and_priority(self):
        sent = []

        def _capture(request, timeout=None):
            sent.append((request.full_url, request.data.decode(), dict(request.header_items())))
            return FakeResponse(200, b"{}")
        env = {self.ha.NTFY_URL_ENV: "https://ntfy.test/singit-abc", self.ha.WEBHOOK_URL_ENV: "https://hooks.test/x"}
        with patch.object(self.ha.urllib.request, "urlopen", _capture):
            self.assertIsNone(self.ha.deliver("SingIt health alert:\n- ask: HTTP 502", env=env, timeout=5))
            self.assertIsNone(self.ha.deliver("Recovered:\n- ask: ok", env=env, timeout=5))
        (url, body, headers), (_, _, recovered) = sent
        self.assertEqual(url, "https://ntfy.test/singit-abc")  # ntfy wins over the generic webhook
        self.assertEqual(body, "SingIt health alert:\n- ask: HTTP 502")
        self.assertEqual((headers["Title"], headers["Priority"]), ("SingIt is down", "high"))
        self.assertNotIn("Authorization", headers)
        self.assertEqual((recovered["Title"], recovered["Priority"]), ("SingIt recovered", "default"))

    def test_ntfy_token_is_sent_as_bearer_and_failures_do_not_leak_it(self):
        seen = {}

        def _capture(request, timeout=None):
            seen.update(request.header_items())
            raise urllib.error.URLError("down")
        env = {self.ha.NTFY_URL_ENV: "https://ntfy.test/t", self.ha.NTFY_TOKEN_ENV: "tk_secret"}
        with patch.object(self.ha.urllib.request, "urlopen", _capture):
            note = self.ha.deliver("SingIt health alert:\n- x: y", env=env, timeout=5)
        self.assertEqual(seen["Authorization"], "Bearer tk_secret")
        self.assertNotIn("tk_secret", note)
        self.assertNotIn("ntfy.test", note)

    def test_telegram_wins_when_both_are_set(self):
        def _capture(request, timeout=None):
            self.assertIn("api.telegram.org", request.full_url)
            return FakeResponse(200, b"{}")
        with patch.object(self.ha.urllib.request, "urlopen", _capture):
            self.ha.deliver("hello", env={self.ha.TELEGRAM_TOKEN_ENV: "tok123", self.ha.TELEGRAM_CHAT_ENV: "42",
                                          self.ha.WEBHOOK_URL_ENV: "https://hooks.test/x"}, timeout=5)

    def test_no_channel_prints_to_stdout(self):
        captured = io.StringIO()
        with redirect_stdout(captured):
            note = self.ha.deliver("hello", env={}, timeout=5)
        self.assertIsNone(note)
        self.assertEqual(captured.getvalue().strip(), "hello")

    def test_a_delivery_failure_is_reported_without_raising_or_leaking_the_token(self):
        def _raise(request, timeout=None):
            raise OSError("boom")
        with patch.object(self.ha.urllib.request, "urlopen", _raise):
            note = self.ha.deliver("hello", env={self.ha.TELEGRAM_TOKEN_ENV: "tok123",
                                                 self.ha.TELEGRAM_CHAT_ENV: "42"}, timeout=5)
        self.assertIsNotNone(note)
        self.assertNotIn("tok123", note)


class MainTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = Path(self.tmp.name) / "state.json"

    def run_main(self, argv, *, env=None, now=1_000.0, price=False):
        # The Opus share check is its own test class below; the tests here feed only the ask/app/rpc responses.
        argv = argv if price else [*argv, "--no-opus-share"]
        captured = io.StringIO()
        with redirect_stdout(captured):
            code = self.ha.main(argv, env=env or {}, now=lambda: now)
        return code, captured.getvalue()

    def test_all_checks_passing_exits_zero(self):
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(200, b'{"ok": true}'), (200, b"<html>app</html>")])):
            code, out = self.run_main(["--state", str(self.state_path)])
        self.assertEqual(code, 0)

    def test_a_failing_check_exits_one_and_prints_the_alert(self):
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>")])):
            code, out = self.run_main(["--state", str(self.state_path)])
        self.assertEqual(code, 1)
        self.assertIn("ask:", out)

    def test_dry_run_sends_nothing_and_saves_no_state(self):
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>")])):
            code, out = self.run_main(["--state", str(self.state_path), "--dry-run"])
        self.assertEqual(code, 1)
        self.assertIn("[dry-run] would send", out)
        self.assertFalse(self.state_path.exists())

    def test_dedupe_across_two_runs_only_alerts_once(self):
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>")])):
            code1, out1 = self.run_main(["--state", str(self.state_path)])
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>")])):
            code2, out2 = self.run_main(["--state", str(self.state_path)])
        self.assertEqual((code1, code2), (1, 1))
        self.assertIn("ask:", out1)
        self.assertEqual(out2.strip(), "")  # same minute: the repeat window has not passed

    def test_recovery_after_a_failure_sends_one_message(self):
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>")])):
            self.run_main(["--state", str(self.state_path)])
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(200, b'{"ok": true}'), (200, b"<html>app</html>")])):
            code, out = self.run_main(["--state", str(self.state_path)])
        self.assertEqual(code, 0)
        self.assertIn("Recovered", out)
        self.assertIn("ask: ok", out)

    def test_an_undelivered_alert_is_retried_on_the_next_run(self):
        env = {"SINGIT_ALERT_WEBHOOK_URL": "https://hooks.test/SECRET"}
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>"), (500, b"")])):
            code1, out1 = self.run_main(["--state", str(self.state_path)], env=env)
        self.assertIn("could not deliver", out1)
        self.assertNotIn("SECRET", out1)
        sent = []
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(503, b""), (200, b"<html>app</html>")])), \
                patch.object(self.ha, "send_webhook", lambda url, message, timeout: sent.append(message)):
            self.run_main(["--state", str(self.state_path)], env=env)
        self.assertEqual(len(sent), 1)  # not suppressed by the failed first delivery

    def test_extra_urls_from_env_are_checked(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen(
                [(200, b'{"ok": true}'), (200, b"<html>app</html>"), (500, b"")])):
            code, out = self.run_main(["--state", str(self.state_path)],
                                      env={self.ha.EXTRA_URLS_ENV: "https://extra.test/status"})
        self.assertEqual(code, 1)
        self.assertIn("extra:https://extra.test/status", out)

    def test_rpc_quota_error_is_checked_and_redacted(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32029, "message": "quota exceeded"}}).encode()
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen(
                [(200, b'{"ok": true}'), (200, b"<html>app</html>"), (200, body)])):
            code, out = self.run_main(["--state", str(self.state_path), "--rpc-url", "https://rpc.test/KEY"])
        self.assertEqual(code, 1)
        self.assertIn("rpc_quota_or_error", out)
        self.assertNotIn("KEY", out)

    def test_cli_rpc_url_is_never_printed(self):
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen(
                [(200, b'{"ok": true}'), (200, b"<html>app</html>"), (200, b'{"jsonrpc": "2.0", "id": 1, "result": "0x1"}')])):
            code, out = self.run_main(["--state", str(self.state_path), "--rpc-url", "https://rpc.test/SUPER-SECRET"])
        self.assertNotIn("SUPER-SECRET", out)
        self.assertNotIn("SUPER-SECRET", self.state_path.read_text())


def book(*offers):
    return json.dumps({"data": {"offers": list(offers)}}).encode()


def offer(discount, *, trusted=True, healthy=True, available=True, provider="capminal"):
    return {"discount_pct": discount, "trusted": trusted, "healthy": healthy, "available": available,
            "provider_id": provider}


class OpusShareTests(unittest.TestCase):
    def setUp(self):
        self.ha = load_health_alert()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = Path(self.tmp.name) / "state.json"
        self.sent = []

    def run_main(self, responses, *, now, env=None):
        """One run of the whole script: ask ok, app ok, then the order book `responses` (status, body)."""
        sequence = [(200, b'{"ok": true}'), (200, b"<html>app</html>"), *responses]
        captured = io.StringIO()
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen(sequence)), \
                patch.object(self.ha, "send_webhook", lambda url, message, timeout: self.sent.append(message)), \
                redirect_stdout(captured):
            code = self.ha.main(["--state", str(self.state_path)], now=lambda: now,
                                env={"SINGIT_ALERT_WEBHOOK_URL": "https://hooks.test/x", **(env or {})})
        return code, captured.getvalue()

    def test_cheapest_trusted_share_ignores_untrusted_unhealthy_unavailable_and_blocked(self):
        offers = book(offer(90, trusted=False), offer(90, healthy=False), offer(90, available=False),
                      offer(80, provider="Blocked"), offer(75, provider="capminal"), offer(70))
        self.assertEqual(self.ha.cheapest_trusted_share(json.loads(offers), {"blocked"}), 0.25)
        self.assertIsNone(self.ha.cheapest_trusted_share(json.loads(book(offer(75, trusted=False))), set()))
        for junk in ({}, [], None, {"data": {"offers": "x"}}, {"data": {"offers": [None, 3, {"discount_pct": "75"}]}}):
            self.assertIsNone(self.ha.cheapest_trusted_share(junk, set()))

    def test_share_at_or_below_the_limit_is_quiet(self):
        for discount in (75, 71):  # 0.25 and exactly the 0.29 limit
            with self.subTest(discount=discount):
                self.state_path.unlink(missing_ok=True)
                code, out = self.run_main([(200, book(offer(discount)))], now=1_000.0)
                self.assertEqual((code, self.sent, out.strip()), (0, [], ""))

    def test_share_above_the_limit_alerts_once_and_not_again_while_it_stays_high(self):
        code, _ = self.run_main([(200, book(offer(70)))], now=1_000.0)
        self.assertEqual(code, 0)  # a price alert is not an outage
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0].startswith("SingIt price alert:"))
        self.assertIn("0.30 of list", self.sent[0])
        # Hours later, still high (and even higher): no new message. The 60-minute repeat does not apply.
        self.run_main([(200, book(offer(70)))], now=1_000.0 + 3 * 3600)
        self.run_main([(200, book(offer(21)))], now=1_000.0 + 30 * 3600)
        self.assertEqual(len(self.sent), 1)

    def test_one_recovery_message_when_it_comes_back_and_a_new_alert_after_that(self):
        self.run_main([(200, book(offer(70)))], now=1_000.0)
        self.run_main([(200, book(offer(75)))], now=2_000.0)
        self.assertEqual(len(self.sent), 2)
        self.assertTrue(self.sent[1].startswith("Recovered:"))
        self.assertIn("0.25 of list", self.sent[1])
        self.run_main([(200, book(offer(75)))], now=3_000.0)  # still fine: silent
        self.assertEqual(len(self.sent), 2)
        self.run_main([(200, book(offer(50)))], now=4_000.0)
        self.assertEqual(len(self.sent), 3)
        self.assertTrue(self.sent[2].startswith("SingIt price alert:"))

    def test_an_unreadable_order_book_changes_nothing(self):
        self.run_main([(200, book(offer(70)))], now=1_000.0)
        for response in ((503, b""), (200, b"not json")):
            code, out = self.run_main([response], now=2_000.0)
            self.assertEqual(code, 0)
            self.assertIn("skip: opus-share", out)
        self.assertEqual(len(self.sent), 1)  # no recovery from a blip
        self.run_main([(200, book(offer(70)))], now=3_000.0)
        self.assertEqual(len(self.sent), 1)  # and the alert was not forgotten, so it does not repeat

    def test_no_qualifying_offer_is_an_alert_too(self):
        self.run_main([(200, book(offer(75, trusted=False)))], now=1_000.0)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("no trusted, healthy, available claude-opus-5.5 offer", self.sent[0])

    def test_an_undelivered_price_alert_is_retried(self):
        env = {"SINGIT_ALERT_WEBHOOK_URL": "https://hooks.test/SECRET"}
        sequence = [(200, b'{"ok": true}'), (200, b"<html>app</html>"), (200, book(offer(70))), (500, b"")]
        captured = io.StringIO()
        with patch.object(self.ha.urllib.request, "urlopen", fake_urlopen(sequence)), redirect_stdout(captured):
            self.ha.main(["--state", str(self.state_path)], env=env, now=lambda: 1_000.0)
        self.assertIn("could not deliver", captured.getvalue())
        self.run_main([(200, book(offer(70)))], now=2_000.0)
        self.assertEqual(len(self.sent), 1)

    def test_limit_model_url_and_blocked_providers_come_from_the_environment(self):
        seen = []

        def opener(request, timeout=None):
            seen.append(request.full_url)
            if "markets" in request.full_url:
                return FakeResponse(200, book(offer(75, provider="capminal"), offer(70, provider="venice")))
            return FakeResponse(200, b'{"ok": true}')
        env = {"SINGIT_ALERT_SURPLUS_URL": "https://surplus.test/", "SINGIT_ALERT_PRICE_MODEL": "claude-opus-9",
               "SINGIT_ALERT_SHARE_MAX": "0.2", "SINGIT_ALERT_BLOCKED_PROVIDERS": "Capminal, x"}
        with patch.object(self.ha.urllib.request, "urlopen", opener), \
                patch.object(self.ha, "send_webhook", lambda url, message, timeout: self.sent.append(message)), \
                redirect_stdout(io.StringIO()):
            self.ha.main(["--state", str(self.state_path)], now=lambda: 1_000.0,
                         env={"SINGIT_ALERT_WEBHOOK_URL": "https://hooks.test/x", **env})
        self.assertIn("https://surplus.test/api/markets/claude-opus-9", seen)
        self.assertEqual(len(self.sent), 1)  # capminal blocked, so the best is venice at 0.30, above 0.2
        self.assertIn("0.30 of list, above 0.20", self.sent[0])

    def test_it_can_be_switched_off(self):
        captured = io.StringIO()
        with patch.object(self.ha.urllib.request, "urlopen",
                          fake_urlopen([(200, b'{"ok": true}'), (200, b"<html>app</html>")])), redirect_stdout(captured):
            code = self.ha.main(["--state", str(self.state_path), "--no-opus-share"], env={}, now=lambda: 1_000.0)
        self.assertEqual(code, 0)

    def test_a_health_failure_and_a_price_alert_share_one_message_but_keep_their_headers(self):
        message = self.ha.format_message(
            [{"name": "ask", "message": "HTTP 503"},
             {"name": "opus-share", "message": "0.30 of list", "kind": "price"}], [])
        self.assertEqual(message.splitlines(), ["SingIt health alert:", "- ask: HTTP 503",
                                                "SingIt price alert:", "- opus-share: 0.30 of list"])

    def test_ntfy_titles_a_price_alert_as_one(self):
        with patch.object(self.ha.urllib.request, "urlopen") as opener:
            opener.return_value.__enter__.return_value.read.return_value = b""
            self.ha.send_ntfy("https://ntfy.test/t", "SingIt price alert:\n- opus-share: x", token=None, timeout=5)
        headers = {k.lower(): v for k, v in opener.call_args.args[0].header_items()}
        self.assertEqual(headers["title"], "SingIt price alert")
        self.assertEqual(headers["priority"], "high")


def tearDownModule():
    sys.modules.pop("singit_health_alert", None)


if __name__ == "__main__":
    unittest.main()
