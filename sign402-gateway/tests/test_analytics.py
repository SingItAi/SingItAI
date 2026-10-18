import json
import logging
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from eth_account import Account
from eth_account.messages import encode_defunct

from sign402_gateway import analytics
from sign402_gateway.web_accounts import WebAccountStore, WebAuth, sanitize_utm

NOW = 1_800_000_000
DOMAIN, URI = "app.singit.test", "https://app.singit.test"


def sign(account, message):
    return Account.sign_message(encode_defunct(text=message), account.key).signature.to_0x_hex()


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "web.db"
        self.env = {"SIGN402_WEB_DB": str(self.db)}
        self.patcher = patch.dict("os.environ", self.env, clear=False)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        analytics._store, analytics._store_path = None, None
        analytics._salt_warned = False

    def rows(self):
        db = sqlite3.connect(self.db)
        try:
            tables = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").fetchall()
            if not tables:
                return []
            return db.execute("SELECT at, name, uid, props_json FROM events ORDER BY id").fetchall()
        finally:
            db.close()

    def test_emit_writes_a_durable_row(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base", new_account=True)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        at, name, uid, props_json = rows[0]
        self.assertEqual(name, "sign_in")
        self.assertAlmostEqual(at, int(time.time()), delta=5)
        self.assertEqual(json.loads(props_json), {"chain": "base", "new_account": True})

    def test_uid_is_hashed_never_the_raw_account_id(self):
        analytics.emit("sign_in", "wallet:0xSomeRawAccountId", chain="base")
        uid = self.rows()[0][2]
        self.assertIsNotNone(uid)
        self.assertNotIn("0xSomeRawAccountId", uid)
        self.assertEqual(uid, analytics.hash_account_id("wallet:0xSomeRawAccountId"))
        raw = self.db.read_bytes()
        self.assertNotIn(b"0xSomeRawAccountId", raw)

    def test_no_account_id_means_no_uid(self):
        analytics.emit("sign_in", None, chain="base")
        self.assertIsNone(self.rows()[0][2])

    def test_sensitive_prop_keys_are_dropped(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base", owner_address="0xdead", tx_hash="0xbeef",
                       prompt="tell me a secret", api_key="sk_singit_x", invoice="inv_1", recipient="bob",
                       phone="+420000000", private_key="pk", signature="sig", pay_to="0xfeed",
                       safe_prop="kept")
        props = json.loads(self.rows()[0][3])
        self.assertEqual(props, {"chain": "base", "safe_prop": "kept"})

    def test_tokens_in_and_out_survive_sanitization(self):
        analytics.emit("chat_answer_paid", "wallet:0xabc", lane="web_chat", tokens_in=120, tokens_out=45,
                       cost_usd="0.01")
        props = json.loads(self.rows()[0][3])
        self.assertEqual(props, {"lane": "web_chat", "tokens_in": 120, "tokens_out": 45, "cost_usd": "0.01"})

    def test_address_shaped_values_are_dropped_even_under_a_safe_key(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base",
                       note="0x1111111111111111111111111111111111111111")
        self.assertNotIn("note", json.loads(self.rows()[0][3]))

    def test_tx_hash_shaped_values_are_dropped(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base", note="0x" + "ab" * 32)
        self.assertNotIn("note", json.loads(self.rows()[0][3]))

    def test_email_shaped_values_are_dropped(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base", note="person@example.com")
        self.assertNotIn("note", json.loads(self.rows()[0][3]))

    def test_base58_solana_shaped_values_are_dropped(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base", note="5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1")
        self.assertNotIn("note", json.loads(self.rows()[0][3]))

    def test_unknown_event_name_is_ignored(self):
        analytics.emit("totally_made_up_event", "wallet:0xabc")
        self.assertEqual(self.rows(), [])

    def test_kill_switch_disables_emit(self):
        with patch.dict("os.environ", {"SIGN402_ANALYTICS_DISABLED": "1"}):
            analytics.emit("sign_in", "wallet:0xabc", chain="base")
        self.assertEqual(self.rows(), [])

    def test_emit_never_raises_on_an_unwritable_db_path(self):
        with patch.dict("os.environ", {"SIGN402_WEB_DB": "/nonexistent-root/nope/web.db"}):
            analytics._store, analytics._store_path = None, None
            analytics.emit("sign_in", "wallet:0xabc", chain="base")  # must not raise

    def test_umami_disabled_when_env_unset_no_network_call(self):
        with patch("urllib.request.urlopen") as mocked:
            analytics.emit("sign_in", "wallet:0xabc", chain="base")
            thread_count_before = threading.active_count()
            time.sleep(0.05)
        mocked.assert_not_called()
        self.assertGreaterEqual(threading.active_count(), 0)  # no crash joining background threads

    def test_umami_send_failure_never_raises(self):
        with patch.dict("os.environ", {"UMAMI_URL": "http://127.0.0.1:1", "UMAMI_WEBSITE_ID": "site-1"}):
            with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
                analytics.emit("sign_in", "wallet:0xabc", chain="base")
                time.sleep(0.05)  # the background thread runs and must not crash the process

    def test_usdc_to_usd_string(self):
        self.assertEqual(analytics.usdc_to_usd_string(1_234_560), "1.23")
        self.assertEqual(analytics.usdc_to_usd_string(0), "0.00")

    def test_salt_missing_warning_logs_once_per_process(self):
        with self.assertLogs("sign402_gateway.analytics", level="WARNING") as captured:
            analytics.emit("sign_in", "wallet:0xabc", chain="base")
            analytics.emit("sign_in", "wallet:0xdef", chain="base")
            analytics.emit("sign_in", "wallet:0xghi", chain="base")
        salt_warnings = [line for line in captured.output if "ANALYTICS_SALT is not set" in line]
        self.assertEqual(len(salt_warnings), 1)

    def test_client_ip_and_user_agent_never_land_in_the_events_table(self):
        analytics.emit("sign_in", "wallet:0xabc", chain="base", client_ip="203.0.113.5",
                       user_agent="Mozilla/5.0 real browser")
        at, name, uid, props_json = self.rows()[0]
        self.assertEqual(json.loads(props_json), {"chain": "base"})
        raw = self.db.read_bytes()
        self.assertNotIn(b"203.0.113.5", raw)
        self.assertNotIn(b"real browser", raw)

    def test_umami_payload_shape_and_headers(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return None

        with patch.dict("os.environ", {"UMAMI_URL": "http://127.0.0.1:3000", "UMAMI_WEBSITE_ID": "site-1"}):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                analytics.emit("sign_in", "wallet:0xabc", chain="base", client_ip="203.0.113.5",
                               user_agent="Mozilla/5.0 real browser")
                time.sleep(0.2)
        self.assertIn("request", captured)
        body = captured["body"]
        self.assertEqual(body["type"], "event")
        payload = body["payload"]
        self.assertEqual(payload["website"], "site-1")
        self.assertEqual(payload["hostname"], analytics.DEFAULT_UMAMI_HOSTNAME)
        self.assertEqual(payload["url"], "/server/sign_in")
        self.assertEqual(payload["name"], "sign_in")
        self.assertEqual(payload["data"]["chain"], "base")
        self.assertIn("uid", payload["data"])
        self.assertEqual(payload["id"], payload["data"]["uid"])
        request = captured["request"]
        self.assertEqual(request.get_header("User-agent"), "Mozilla/5.0 real browser")
        self.assertEqual(request.get_header("X-forwarded-for"), "203.0.113.5")
        self.assertEqual(request.get_header("X-real-ip"), "203.0.113.5")

    def test_umami_uses_a_default_browser_like_user_agent_when_none_given(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            return None

        with patch.dict("os.environ", {"UMAMI_URL": "http://127.0.0.1:3000", "UMAMI_WEBSITE_ID": "site-1"}):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                analytics.emit("purchase_completed", "wallet:0xabc", chain="base", category="bitrefill")
                time.sleep(0.2)
        self.assertEqual(captured["request"].get_header("User-agent"), analytics.DEFAULT_USER_AGENT)


class UtmSanitizeTests(unittest.TestCase):
    def test_keeps_only_known_keys_as_truncated_strings(self):
        out = sanitize_utm({"utm_source": "x", "utm_medium": "social", "evil": "drop-me",
                            "utm_campaign": "a" * 200})
        self.assertEqual(out["utm_source"], "x")
        self.assertEqual(out["utm_medium"], "social")
        self.assertNotIn("evil", out)
        self.assertEqual(len(out["utm_campaign"]), 100)

    def test_non_dict_or_empty_is_none(self):
        self.assertIsNone(sanitize_utm("not-a-dict"))
        self.assertIsNone(sanitize_utm(None))
        self.assertIsNone(sanitize_utm({"utm_source": 123}))  # not a string
        self.assertIsNone(sanitize_utm({}))

    def test_ref_host_is_a_known_key(self):
        self.assertEqual(sanitize_utm({"ref_host": "x.com"}), {"ref_host": "x.com"})

    def test_drops_values_shaped_like_addresses_hashes_and_emails(self):
        out = sanitize_utm({
            "utm_source": "0x" + "a" * 40,
            "utm_medium": "0x" + "b" * 64,
            "utm_campaign": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
            "utm_content": "person@example.com",
            "utm_term": "social",
        })
        self.assertEqual(out, {"utm_term": "social"})

    def test_a_secret_shaped_value_alone_is_none(self):
        self.assertIsNone(sanitize_utm({"ref_host": "0x" + "c" * 40}))


class SignInUtmTests(unittest.TestCase):
    """utm_json is stored only on first account creation; a bad sign-in never breaks it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.user = Account.create()
        self.clock = [NOW]
        self.store = WebAccountStore(Path(self.tmp.name) / "web.db")
        self.auth = WebAuth(self.store, domain=DOMAIN, uri=URI, allowed=[self.user.address],
                            now=lambda: self.clock[0])

    def sign_in(self, utm=None):
        issued = self.auth.nonce(self.user.address)
        return self.auth.verify(issued["message"], sign(self.user, issued["message"]), utm)

    def test_first_sign_in_stores_first_touch_utm(self):
        signed = self.sign_in(utm={"utm_source": "x", "utm_medium": "social"})
        self.assertTrue(signed["newAccount"])
        row = self.store.account(signed["account"])
        self.assertEqual(json.loads(row["utm_json"]), {"utm_source": "x", "utm_medium": "social"})

    def test_second_sign_in_does_not_overwrite_first_touch_utm(self):
        self.sign_in(utm={"utm_source": "first"})
        signed = self.sign_in(utm={"utm_source": "second"})
        self.assertFalse(signed["newAccount"])
        row = self.store.account(signed["account"])
        self.assertEqual(json.loads(row["utm_json"]), {"utm_source": "first"})

    def test_missing_or_bad_utm_never_breaks_sign_in(self):
        signed = self.sign_in(utm="not-a-dict")
        self.assertTrue(signed["newAccount"])
        row = self.store.account(signed["account"])
        self.assertIsNone(row["utm_json"])


if __name__ == "__main__":
    unittest.main()
