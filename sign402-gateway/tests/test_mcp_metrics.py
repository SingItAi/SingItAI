"""The `mcp_call` analytics event, emitted once per MCP tools/call (web_mcp.py, docs/analytics.md).

Offline, on the Fixture of test_web_mcp.py. The events table lives in the fixture's temporary web.db:
nothing here writes ~/.sign402/web.db.
"""
import hashlib
import json
import re
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from sign402_gateway import analytics
from tests.test_web_mcp import NOW, Fixture

SALT = "test-salt"
ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")


class McpCallEventTests(Fixture):
    def setUp(self):
        super().setUp()
        self.db = Path(self.tmp.name) / "web.db"
        env = patch.dict("os.environ", {"SIGN402_WEB_DB": str(self.db), "ANALYTICS_SALT": SALT}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        analytics._store, analytics._store_path = None, None
        analytics._salt_warned = False
        self.addCleanup(setattr, analytics, "_store", None)
        self.addCleanup(setattr, analytics, "_store_path", None)

    def events(self, name=None):
        db = sqlite3.connect(self.db)
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'events'").fetchone():
                return []
            rows = db.execute("SELECT name, uid, props_json FROM events ORDER BY id").fetchall()
        finally:
            db.close()
        return [(n, uid, json.loads(p)) for n, uid, p in rows if name in (None, n)]

    def only_call(self):
        calls = self.events("mcp_call")
        self.assertEqual(len(calls), 1, calls)
        return calls[0]

    def test_a_paid_success_records_cost_and_a_hashed_key_reference(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"ok": True, "data": {"results": [{"title": "SingIt"}]}, "costAtomic": 5_000,
                                 "txId": "0x" + "ab" * 32, "network": "base"})
        self.call_tool(made["key"], "web_search", {"query": "my private question about 0x" + "12" * 20})
        name, uid, props = self.only_call()
        print("example mcp_call props:", props)
        self.assertEqual(props["tool"], "web_search")
        self.assertEqual(props["status"], "ok")
        self.assertIs(props["paid"], True)
        self.assertEqual(props["cost_usd"], "0.005")
        self.assertNotIn("error_kind", props)
        self.assertNotIn("client", props)
        self.assertEqual(uid, analytics.hash_account_id(self.account, SALT))
        key_id = made["id"]  # the public key id (key_<hex>), not the secret
        self.assertEqual(props["key_ref"], hashlib.sha256((SALT + key_id).encode()).hexdigest()[:12])
        self.assertRegex(props["key_ref"], r"^[0-9a-f]{12}$")

    def test_a_free_success_is_not_paid_and_has_no_cost(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={"symbol": "BTC", "usd": 65000})
        self.call_tool(made["key"], "get_price", {"kind": "crypto", "symbol": "btc"})
        _, _, props = self.only_call()
        self.assertEqual((props["tool"], props["status"], props["paid"]), ("get_price", "ok", False))
        self.assertNotIn("cost_usd", props)

    def test_a_paid_data_tool_is_recorded_by_its_mcp_name(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"data": {"symbol": "ETH"}, "costAtomic": 3_000, "txId": "0xdef"})
        self.call_tool(made["key"], "get_token_price", {"symbol": "eth"})
        _, _, props = self.only_call()
        self.assertEqual((props["tool"], props["status"], props["cost_usd"]), ("get_token_price", "ok", "0.003"))

    def test_a_tool_error_is_recorded_as_an_error_with_a_short_kind(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (502, {"ok": False, "error": "upstream_error", "text": "Seller said: secret detail"})
        status, out, _ = self.call_tool(made["key"], "get_token_price", {"symbol": "eth"})
        self.assertTrue(out["result"]["isError"])
        _, _, props = self.only_call()
        # A paid tool that failed upstream: paid=True (it is a paid tool), but nothing was charged.
        self.assertEqual((props["status"], props["error_kind"], props["paid"]), ("error", "upstream", True))
        self.assertNotIn("cost_usd", props)
        self.assertNotIn("secret detail", json.dumps(props))

    def test_a_shop_refusal_is_refused(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (403, {"ok": False, "error": "not_enabled", "text": "Set up your allowance first."})
        self.call_tool(made["key"], "web_search", {"query": "singit"})
        _, _, props = self.only_call()
        self.assertEqual((props["status"], props["error_kind"]), ("refused", "limit"))
        self.assertNotIn("cost_usd", props)

    def test_a_missing_scope_is_refused_with_kind_scope(self):
        key, _row = self.store.add_api_key(self.account, "legacy", 1_000_000, 250_000, NOW, NOW + 86400,
                                           scopes="answers search")
        self.call_tool(key, "get_token_price", {"symbol": "eth"})
        _, _, props = self.only_call()
        self.assertEqual((props["tool"], props["status"], props["error_kind"]), ("get_token_price", "refused", "scope"))

    def test_an_unknown_tool_is_recorded_as_unknown_without_its_name(self):
        made = self.make_key()
        status, out, _ = self.call_tool(made["key"], "bitrefill_buy_0x" + "ab" * 20, {"to": "0x" + "cd" * 20})
        self.assertEqual(out["error"]["code"], -32602)
        _, _, props = self.only_call()
        self.assertEqual((props["tool"], props["status"], props["error_kind"]), ("unknown", "error", "bad_args"))
        self.assertNotIn("bitrefill", json.dumps(props))

    def test_bad_arguments_are_an_error_of_kind_bad_args(self):
        made = self.make_key()
        self.call_tool(made["key"], "get_price", {"kind": "crypto", "symbol": "!!!"})
        _, _, props = self.only_call()
        self.assertEqual((props["tool"], props["status"], props["error_kind"]), ("get_price", "error", "bad_args"))

    def test_the_per_minute_limit_is_rate_limited(self):
        made = self.make_key(dailyUsd=1)
        self.api.mcp.fetch_json = Mock(return_value={})
        for _ in range(61):
            self.call_tool(made["key"], "list_price_symbols")
        calls = self.events("mcp_call")
        self.assertEqual(len(calls), 61)
        self.assertEqual(calls[-1][2]["status"], "rate_limited")
        self.assertEqual({c[2]["status"] for c in calls[:-1]}, {"ok"})

    def test_latency_is_an_int_and_props_are_all_whitelisted_types(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={})
        self.call_tool(made["key"], "list_price_symbols")
        _, _, props = self.only_call()
        self.assertIs(type(props["latency_ms"]), int)
        self.assertGreaterEqual(props["latency_ms"], 0)
        # Every prop survived analytics.sanitize_props unchanged.
        self.assertEqual(analytics.sanitize_props(props), props)
        self.assertEqual(set(props), {"tool", "status", "latency_ms", "paid", "key_ref"})

    def test_no_secret_key_address_account_or_argument_is_stored(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"ok": True, "data": {"results": []}, "costAtomic": 5_000,
                                 "txId": "0x" + "ab" * 32, "network": "base"})
        self.call_tool(made["key"], "web_search", {"query": "very secret query https://example.test/x"})
        self.call_tool(made["key"], "get_token_price", {"symbol": "0x" + "12" * 20})
        db = sqlite3.connect(self.db)
        try:
            dump = json.dumps(db.execute("SELECT name, uid, props_json FROM events").fetchall())
        finally:
            db.close()
        for secret in (made["key"], made["key"][-12:], self.user.address, self.user.address.lower(), self.account,
                       "very secret query", "example.test", "ab" * 32, "12" * 20):
            self.assertNotIn(secret, dump)
        self.assertIsNone(ADDRESS_RE.search(dump))
        self.assertNotIn("sk_singit_", dump)

    def test_initialize_and_tools_list_and_ping_record_nothing(self):
        made = self.make_key()
        self.rpc(made["key"], "initialize", {"protocolVersion": "2025-03-26", "clientInfo": {"name": "cursor"}})
        self.rpc(made["key"], "tools/list")
        self.rpc(made["key"], "ping")
        self.assertEqual(self.events("mcp_call"), [])

    def test_a_failing_emit_does_not_break_the_call(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={"crypto": ["BTC"]})
        with patch.object(analytics, "emit", side_effect=RuntimeError("boom")):
            status, out, _ = self.call_tool(made["key"], "list_price_symbols")
        self.assertEqual(status, 200)
        self.assertEqual(out["result"]["structuredContent"], {"crypto": ["BTC"]})

    def test_a_failing_event_store_does_not_break_the_call(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={"crypto": ["BTC"]})
        with patch.object(analytics._EventStore, "append", side_effect=sqlite3.OperationalError("locked")):
            status, out, _ = self.call_tool(made["key"], "list_price_symbols")
        self.assertEqual((status, out["result"]["structuredContent"]), (200, {"crypto": ["BTC"]}))

    def test_a_failing_key_ref_still_lets_the_call_through(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={})
        with patch.object(analytics, "key_ref", side_effect=RuntimeError("boom")):
            status, out, _ = self.call_tool(made["key"], "list_price_symbols")
        self.assertEqual(status, 200)
        self.assertFalse(out["result"].get("isError"))

    def test_analytics_disabled_records_nothing(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={})
        with patch.dict("os.environ", {"SIGN402_ANALYTICS_DISABLED": "1"}):
            self.call_tool(made["key"], "list_price_symbols")
        self.assertEqual(self.events("mcp_call"), [])


class AnalyticsHelpersTests(unittest.TestCase):
    def test_key_ref_is_twelve_hex_of_the_salted_key_id(self):
        ref = analytics.key_ref("key_0123456789abcdef", SALT)
        self.assertEqual(ref, hashlib.sha256((SALT + "key_0123456789abcdef").encode()).hexdigest()[:12])
        self.assertEqual(len(ref), 12)

    def test_key_ref_survives_the_prop_filter_and_is_whitelisted(self):
        ref = analytics.key_ref("key_0123456789abcdef", SALT)
        self.assertEqual(analytics.sanitize_props({"key_ref": ref}), {"key_ref": ref})
        self.assertEqual(analytics.sanitize_props({"api_key": ref}), {})

    def test_mcp_call_is_a_known_event(self):
        self.assertIn("mcp_call", analytics.KNOWN_EVENTS)

    def test_sub_cent_costs_keep_their_digits(self):
        self.assertEqual(analytics.usdc_to_usd_precise(3_000), "0.003")
        self.assertEqual(analytics.usdc_to_usd_precise(1_000_000), "1.00")
        self.assertEqual(analytics.usdc_to_usd_precise(1_234_560), "1.23456")
        self.assertEqual(analytics.usdc_to_usd_precise(10_000), "0.01")


if __name__ == "__main__":
    unittest.main()
