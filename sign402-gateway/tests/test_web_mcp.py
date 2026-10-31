"""SingIt's remote MCP server (POST /mcp, web_mcp.py): a key's own /v1, reshaped as MCP tools.

Offline: a fake shop stands for the gateway for the web-api-level tests; the gateway-side "api-tool"
action runs for real (with its payer and x402 fetch mocked), as test_web_shop.py does for tool-buy.
"""
import json
import os
import re
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch

from eth_account import Account
from eth_account.messages import encode_defunct

from sign402_gateway import web_api as wa
from sign402_gateway import web_mcp as wm
from sign402_gateway.agent_allowance import AllowanceStore
from sign402_gateway.server import PAID_TOOLS
from sign402_gateway.web_accounts import WebAccountStore, WebAuth, account_id_for
from sign402_gateway.web_mcp import (
    ASK_URL, DEFAULT_ALLOWED_ORIGINS, FREE_TOOL_NAMES, OWN_TOOLS, allowed_origins_from_env, glama_json, server_card,
)
from tests.test_gateway_server import DummyServer
from tests.test_web_shop import ACCOUNT, OWNER, PAID, REQUIREMENTS, TOKEN, raw_request

NOW = 1_800_000_000
DOMAIN, URI = "app.singit.test", "https://app.singit.test"
PAID_TOOL_NAMES = {t["mcpStyleName"] for t in PAID_TOOLS.values()} - wm.MCP_HIDDEN_TOOLS


def sign(account, message):
    return Account.sign_message(encode_defunct(text=message), account.key).signature.to_0x_hex()


class Shop:
    def __init__(self, reply=(200, {"ok": True})):
        self.calls, self.reply = [], reply

    def __call__(self, action, account, body=None):
        self.calls.append((action, account, dict(body or {})))
        if action == "api-models":
            return 200, {"object": "list", "data": [{"id": "claude-opus-5.5", "object": "model"}]}
        return self.reply


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.user = Account.create()
        self.clock = [NOW]
        self.store = WebAccountStore(Path(self.tmp.name) / "web.db")
        self.auth = WebAuth(self.store, domain=DOMAIN, uri=URI, allowed=None, now=lambda: self.clock[0])
        self.shop = Shop()
        self.api = wa.WebApi(self.auth, Mock(), shop=self.shop, now=lambda: self.clock[0], public_origin=URI)
        issued = self.auth.nonce(self.user.address)
        self.session = self.auth.verify(issued["message"], sign(self.user, issued["message"]))
        self.account = account_id_for(self.user.address)

    def call(self, method, path, body=None):
        return self.api.handle(method, path, token=self.session["token"], csrf=self.session["csrfToken"],
                               body=body or {}, client="127.0.0.1", expected_account=None)

    def make_key(self, **terms):
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "my agent", **terms})
        _, made, _ = self.call("POST", "/api-keys", {"message": prepared["message"],
                                                   "signature": sign(self.user, prepared["message"])})
        return made

    def rpc(self, key, method, params=None, *, id_=1, origin=None, client_ip=None):
        body = {"jsonrpc": "2.0", "method": method}
        if id_ is not None:
            body["id"] = id_
        if params is not None:
            body["params"] = params
        return self.api.mcp.handle(authorization=f"Bearer {key}" if key else None, api_key=None, origin=origin,
                                   protocol_version="2025-06-18", body=body, client_ip=client_ip)

    def call_tool(self, key, name, arguments=None, **kw):
        return self.rpc(key, "tools/call", {"name": name, "arguments": arguments or {}}, **kw)


class InitializeAndListTests(Fixture):
    def test_initialize_echoes_the_version_and_names_the_server(self):
        key = self.make_key()["key"]
        status, out, _ = self.rpc(key, "initialize", {"protocolVersion": "2025-03-26"})
        self.assertEqual(status, 200)
        self.assertEqual(out["result"]["protocolVersion"], "2025-03-26")
        self.assertEqual(out["result"]["serverInfo"]["name"], "singit")
        self.assertEqual(out["result"]["capabilities"]["tools"], {"listChanged": False})
        # An unsupported version falls back to ours, not the client's.
        status, out, _ = self.rpc(key, "initialize", {"protocolVersion": "1999-01-01"})
        self.assertEqual(out["result"]["protocolVersion"], "2025-06-18")

    def test_tools_list_names_exactly_the_tools_this_key_can_use(self):
        key = self.make_key()["key"]
        status, out, _ = self.rpc(key, "tools/list")
        self.assertEqual(status, 200)
        tools = out["result"]["tools"]
        names = {t["name"] for t in tools}
        expected = {"get_price", "list_price_symbols", "list_models", "get_balance", "get_limits", "get_receipts",
                    "web_search", "read_page"} | PAID_TOOL_NAMES
        self.assertEqual(names, expected)
        for tool in tools:
            self.assertEqual(tool["inputSchema"]["type"], "object")
        self.assertFalse(any(re.search(r"bitrefill|withdraw|allowance|\bbuy\b", n, re.I) for n in names))

    def test_ping(self):
        key = self.make_key()["key"]
        status, out, _ = self.rpc(key, "ping")
        self.assertEqual((status, out["result"]), (200, {}))

    def test_every_tool_has_a_title_and_boolean_annotations_and_there_are_exactly_sixteen(self):
        key = self.make_key()["key"]
        status, out, _ = self.rpc(key, "tools/list")
        listed = out["result"]["tools"]
        self.assertEqual(len(listed), len(OWN_TOOLS) + len(PAID_TOOL_NAMES))
        self.assertEqual(len(listed), 16)
        for tool in listed:
            self.assertTrue(tool.get("title"), tool["name"])
            annotations = tool["annotations"]
            self.assertEqual(annotations["title"], tool["title"])
            for hint in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"):
                self.assertIsInstance(annotations[hint], bool, f"{tool['name']}.{hint}")
            self.assertTrue(annotations["readOnlyHint"])
            self.assertFalse(annotations["destructiveHint"])
            if tool["name"] in FREE_TOOL_NAMES:
                self.assertTrue(annotations["idempotentHint"], tool["name"])
                self.assertFalse(annotations["openWorldHint"], tool["name"])
            else:
                self.assertFalse(annotations["idempotentHint"], tool["name"])
                self.assertTrue(annotations["openWorldHint"], tool["name"])


BAD_KEY = "sk_singit_" + "x" * 43


class ToolCatalogueTests(Fixture):
    def test_every_description_says_when_to_use_and_never_the_old_brand(self):
        listed = self.rpc(None, "tools/list")[1]["result"]["tools"]
        for tool in listed:
            with self.subTest(tool=tool["name"]):
                self.assertNotIn("sign402", tool["description"].lower())
                self.assertGreater(len(tool["description"]), 60)
        paid = {t["name"] for t in listed} - FREE_TOOL_NAMES - {"web_search", "read_page"}
        self.assertEqual(paid - set(wm.PAID_TOOL_DESCRIPTIONS), set())  # every paid tool has an MCP description

    def test_networks_are_named_as_they_really_work(self):
        # Search and page reading are paid on Base or Solana; the market data tools refuse Solana (base_only).
        listed = {t["name"]: t["description"] for t in self.rpc(None, "tools/list")[1]["result"]["tools"]}
        for name in ("web_search", "read_page"):
            self.assertIn("Base or Solana", listed[name])
        for name in PAID_TOOL_NAMES:
            self.assertIn("Base accounts only", listed[name], name)
        self.assertNotIn("(Base USDC)", " ".join(listed.values()) + wm.INSTRUCTIONS + wm.SERVER_CARD_DESCRIPTION)

    def test_the_broken_demo_report_is_neither_listed_nor_callable(self):
        names = {t["name"] for t in self.rpc(None, "tools/list")[1]["result"]["tools"]}
        self.assertNotIn("get_sign402_report", names)
        key = self.make_key()["key"]
        status, out, _ = self.call_tool(key, "get_sign402_report")
        self.assertEqual(out["error"]["code"], -32602)
        self.assertEqual(self.shop.calls, [])

    def test_get_balance_needs_a_key_and_reads_only_that_keys_account(self):
        status, out, _ = self.call_tool(None, "get_balance")
        self.assertTrue(out["result"]["isError"])
        self.assertIn("needs your API key", out["result"]["content"][0]["text"])
        made = self.make_key()
        seen = []
        self.api.keys.proxy = Mock()
        self.api.keys._balance = lambda account: seen.append(account) or {"object": "balance", "availableUsd": 1.5}
        status, out, _ = self.call_tool(made["key"], "get_balance")
        self.assertFalse(out["result"].get("isError"))
        self.assertEqual(out["result"]["structuredContent"]["availableUsd"], 1.5)
        self.assertEqual(seen, [self.account])

    def test_get_balance_says_so_when_balances_are_off(self):
        self.api.keys.proxy = None
        status, out, _ = self.call_tool(self.make_key()["key"], "get_balance")
        self.assertTrue(out["result"]["isError"])
        self.assertIn("not available", out["result"]["content"][0]["text"])


class LimitsAndReceiptsTests(Fixture):
    """get_limits and get_receipts: the key's own limits and charges, read-only (plan item 4, 28.10.2026)."""

    def ledger_row(self, id_, kind="charge", key_id="K", amount=-1500, **extra):
        row = {"id": id_, "account_id": self.account, "at": NOW - id_, "kind": kind, "amount_atomic": amount,
               "balance_after": 4_000_000 - id_, "ref": f"ref-{id_}", "key_id": key_id, "model": "claude-opus-5.5",
               "cost_atomic": 1000, "input_tokens": 12, "output_tokens": 30, "tx_id": None, "network": None}
        row.update(extra)
        return row

    def test_both_tools_are_listed_read_only_and_idempotent_with_schemas(self):
        tools = {t["name"]: t for t in self.rpc(None, "tools/list")[1]["result"]["tools"]}
        for name in ("get_limits", "get_receipts"):
            annotations = tools[name]["annotations"]
            self.assertTrue(annotations["readOnlyHint"])
            self.assertFalse(annotations["destructiveHint"])
            self.assertTrue(annotations["idempotentHint"])
            self.assertFalse(annotations["openWorldHint"])
        self.assertEqual(tools["get_receipts"]["inputSchema"]["properties"]["limit"]["maximum"], 50)

    def test_both_need_a_key_and_touch_nothing_without_one(self):
        for name in ("get_limits", "get_receipts"):
            status, out, _ = self.call_tool(None, name)
            self.assertTrue(out["result"]["isError"])
            self.assertIn("needs your API key", out["result"]["content"][0]["text"])
        self.assertEqual(self.shop.calls, [])

    def test_get_limits_reports_the_keys_caps_and_what_is_left_today(self):
        made = self.make_key(dailyUsd=3, perRequestUsd=0.5)
        row = self.store.api_key(made["key"], NOW)
        self.store.record_key_spend(row["key_id"], NOW // 86400, 1_250_000, NOW)
        self.api.keys.proxy = None
        self.api.allowance.store.active_limiter.return_value = None
        status, out, _ = self.call_tool(made["key"], "get_limits")
        self.assertFalse(out["result"].get("isError"), out)
        data = out["result"]["structuredContent"]
        key = data["key"]
        self.assertEqual((key["id"], key["state"]), (row["key_id"], "active"))
        self.assertEqual((key["dailyCapUsd"], key["perRequestCapUsd"]), (3.0, 0.5))
        self.assertEqual((key["spentTodayUsd"], key["remainingTodayUsd"], key["answersToday"]), (1.25, 1.75, 1))
        self.assertEqual(key["resetsAt"], (NOW // 86400 + 1) * 86400)
        self.assertNotIn("balance", data)
        self.assertNotIn(made["key"], json.dumps(data), "the secret key is never echoed")

    def test_get_limits_includes_the_balance_and_never_changes_anything(self):
        made = self.make_key()
        self.api.keys.proxy = Mock()
        self.api.keys._balance = lambda account: {"availableUsd": 2.0, "heldUsd": 0.1, "autoTopup": False, "topupUsd": 9}
        self.api.allowance.store.active_limiter.return_value = None
        status, out, _ = self.call_tool(made["key"], "get_limits")
        data = out["result"]["structuredContent"]
        self.assertEqual(data["balance"], {"availableUsd": 2.0, "heldUsd": 0.1, "autoTopup": False})
        self.assertEqual(data["allowance"], {"configured": False, "chain": "base"})
        self.api.allowance.advance.assert_not_called()
        self.api.allowance.status.assert_not_called()

    def test_get_limits_shows_the_base_limiter_without_owner_agent_or_guardian_addresses(self):
        made = self.make_key()
        self.api.keys.proxy = None
        self.api.allowance.store.active_limiter.return_value = {"limiter": "0xLIMITER"}
        self.api.allowance._describe.return_value = {
            "limiter": "0x" + "ab" * 20, "owner": "0xOWNER", "agent": "0xAGENT", "guardian": "0xGUARD",
            "dailyCapAtomic": 5_000_000, "perPurchaseCapAtomic": 2_000_000, "expiry": NOW + 86400,
            "remainingTodayAtomic": 4_000_000, "allowanceAtomic": 0, "paused": True, "floatAtomic": 7, "ownerUsdcAtomic": 9,
            "state": "paused", "telegramText": "x"}
        status, out, _ = self.call_tool(made["key"], "get_limits")
        allowance = out["result"]["structuredContent"]["allowance"]
        self.assertEqual((allowance["state"], allowance["paused"], allowance["approvedUsd"]), ("paused", True, 0.0))
        self.assertEqual((allowance["dailyCapUsd"], allowance["perPurchaseCapUsd"], allowance["remainingTodayUsd"]), (5.0, 2.0, 4.0))
        text = json.dumps(allowance)
        for hidden in ("0xOWNER", "0xAGENT", "0xGUARD", "ownerUsdc", "float"):
            self.assertNotIn(hidden, text)

    def test_get_limits_survives_an_unreadable_allowance_and_a_solana_account(self):
        made = self.make_key()
        self.api.keys.proxy = None
        self.api.allowance.store.active_limiter.side_effect = RuntimeError("rpc down")
        status, out, _ = self.call_tool(made["key"], "get_limits")
        self.assertFalse(out["result"].get("isError"))
        self.assertEqual(out["result"]["structuredContent"]["allowance"]["available"], False)
        with patch.object(wm, "chain_of_account", return_value="solana"):
            status, out, _ = self.call_tool(made["key"], "get_limits")
        self.assertEqual(out["result"]["structuredContent"]["allowance"]["chain"], "solana")
        self.assertFalse(out["result"]["structuredContent"]["allowance"]["configured"])

    def test_get_receipts_lists_only_this_keys_charges_newest_first(self):
        made = self.make_key()
        key_id = self.store.api_key(made["key"], NOW)["key_id"]
        ledger = Mock(return_value=[self.ledger_row(5, key_id=key_id), self.ledger_row(4, key_id="OTHER"),
                                    self.ledger_row(3, kind="topup", amount=5_000_000, key_id=None, tx_id="0xtx", network="eip155:8453"),
                                    self.ledger_row(2, key_id=key_id, amount=-2500)])
        self.api.keys.proxy = Mock(balances=Mock(ledger=ledger))
        status, out, _ = self.call_tool(made["key"], "get_receipts")
        data = out["result"]["structuredContent"]
        self.assertEqual([r["id"] for r in data["data"]], [5, 2])
        self.assertEqual(data["data"][0], {"id": 5, "at": NOW - 5, "kind": "charge", "amountUsd": 0.0015,
                                            "model": "claude-opus-5.5", "reference": "ref-5", "inputTokens": 12,
                                            "outputTokens": 30, "balanceAfterUsd": (4_000_000 - 5) / 1e6})
        self.assertIsNone(data["next"])
        self.assertEqual(ledger.call_args.args[0], self.account, "only the key's own account is read")

    def test_get_receipts_topups_carry_the_transaction_and_pages_continue_with_before(self):
        made = self.make_key()
        rows = [self.ledger_row(9, kind="topup", amount=5_000_000, key_id=None, tx_id="0xabc", network="eip155:8453"),
                self.ledger_row(8, kind="topup", amount=1_000_000, key_id=None, tx_id="0xdef", network="eip155:8453")]
        ledger = Mock(return_value=rows)
        self.api.keys.proxy = Mock(balances=Mock(ledger=ledger))
        status, out, _ = self.call_tool(made["key"], "get_receipts", {"kind": "topup", "limit": 2})
        data = out["result"]["structuredContent"]
        self.assertEqual([(r["id"], r["transaction"], r["network"], r["amountUsd"]) for r in data["data"]],
                         [(9, "0xabc", "eip155:8453", 5.0), (8, "0xdef", "eip155:8453", 1.0)])
        self.assertEqual(data["next"], 8)
        ledger.reset_mock(); ledger.return_value = []
        self.call_tool(made["key"], "get_receipts", {"kind": "topup", "before": 8})
        self.assertEqual(ledger.call_args.kwargs["before"], 8)

    def test_get_receipts_validates_arguments_and_needs_balances(self):
        made = self.make_key()
        self.api.keys.proxy = Mock(balances=Mock(ledger=Mock(return_value=[])))
        for bad in ({"limit": 0}, {"limit": 51}, {"limit": "5"}, {"kind": "withdraw"}, {"before": 0}, {"before": "x"}):
            status, out, _ = self.call_tool(made["key"], "get_receipts", bad)
            self.assertEqual(out["error"]["code"], -32602, bad)
        self.api.keys.proxy = None
        status, out, _ = self.call_tool(made["key"], "get_receipts")
        self.assertTrue(out["result"]["isError"])
        self.assertIn("not available", out["result"]["content"][0]["text"])

    def test_get_receipts_stops_scanning_a_ledger_with_none_of_this_keys_rows(self):
        made = self.make_key()
        ledger = Mock(side_effect=lambda account, limit, before: [self.ledger_row(i, key_id="OTHER") for i in range(1000, 800, -1)])  # 200 rows each time
        self.api.keys.proxy = Mock(balances=Mock(ledger=ledger))
        status, out, _ = self.call_tool(made["key"], "get_receipts")
        data = out["result"]["structuredContent"]
        self.assertEqual(data["data"], [])
        self.assertLessEqual(ledger.call_count, 2)
        # older receipts may still exist: the page says where to continue instead of claiming the end (Codex)
        self.assertEqual(data["next"], 801)
        ledger.side_effect = lambda account, limit, before: [self.ledger_row(9, key_id="K")] if before == 801 else []
        status, out, _ = self.call_tool(made["key"], "get_receipts", {"before": 801})
        self.assertEqual(out["result"]["structuredContent"]["data"], [])


class KeylessTests(Fixture):
    def test_initialize_ping_and_tools_list_work_without_a_key(self):
        status, out, _ = self.rpc(None, "initialize", {"protocolVersion": "2025-06-18"})
        self.assertEqual(status, 200)
        self.assertEqual(out["result"]["serverInfo"]["name"], "singit")
        self.assertEqual(self.rpc(None, "ping")[:2], (200, {"jsonrpc": "2.0", "id": 1, "result": {}}))
        status, out, _ = self.rpc(None, "tools/list")
        self.assertEqual(status, 200)
        self.assertEqual(len(out["result"]["tools"]), 16)  # the full catalogue, paid tools included
        self.assertEqual(self.shop.calls, [])

    def test_free_tools_work_without_a_key_and_touch_no_account(self):
        fetched = []
        self.api.mcp.fetch_json = lambda url: fetched.append(url) or {"data": [{"id": "singit-ask"}], "ok": True}
        status, out, _ = self.call_tool(None, "get_price", {"kind": "crypto", "symbol": "ETH"})
        self.assertEqual(status, 200)
        self.assertFalse(out["result"].get("isError"))
        status, out, _ = self.call_tool(None, "list_price_symbols")
        self.assertFalse(out["result"].get("isError"))
        status, out, _ = self.call_tool(None, "list_models")
        self.assertFalse(out["result"].get("isError"))
        self.assertEqual(out["result"]["structuredContent"]["data"], [{"id": "singit-ask"}])
        self.assertTrue(fetched[0].endswith("/v1/prices/crypto/ETH"))
        self.assertTrue(fetched[-1].endswith("/v1/models"))
        self.assertEqual(self.shop.calls, [])  # the keyed model list asks the account's shop; keyless never does

    def test_a_paid_tool_without_a_key_asks_for_one_and_bills_nothing(self):
        search = Mock()
        self.api.keys._search = search
        for name, args in (("web_search", {"query": "x402"}), ("read_page", {"url": "https://example.com"}),
                           (sorted(PAID_TOOL_NAMES)[0], {})):
            with self.subTest(name=name):
                status, out, _ = self.call_tool(None, name, args)
                self.assertEqual(status, 200)
                self.assertTrue(out["result"]["isError"])
                self.assertIn("API key", out["result"]["content"][0]["text"])
        search.assert_not_called()
        self.assertEqual(self.shop.calls, [])

    def test_an_unknown_tool_without_a_key_is_invalid_params(self):
        status, out, _ = self.call_tool(None, "withdraw_everything")
        self.assertEqual(out["error"]["code"], -32602)

    def test_keyless_requests_are_rate_limited_per_address(self):
        self.api.mcp.requests_per_minute = 3
        for _ in range(3):
            self.assertEqual(self.rpc(None, "ping", client_ip="198.51.100.20")[0], 200)
        status, out, headers = self.rpc(None, "ping", client_ip="198.51.100.20")
        self.assertEqual(status, 429)
        self.assertIn("Without a key", out["error"]["message"])
        self.assertIn("Retry-After", headers)
        self.assertEqual(self.rpc(None, "ping", client_ip="198.51.100.21")[0], 200)  # another address

    def test_an_untrusted_browser_origin_is_refused_even_without_a_key(self):
        status, _, _ = self.rpc(None, "tools/list", origin="https://evil.test")
        self.assertEqual(status, 403)

    def test_a_keyless_tool_call_is_recorded_without_an_account_or_key(self):
        self.api.mcp.fetch_json = lambda url: {"ok": True}
        with patch.object(wm.analytics, "emit") as emit:
            self.call_tool(None, "list_price_symbols")
        (name, account), props = emit.call_args[0], emit.call_args[1]
        self.assertEqual((name, account), ("mcp_call", None))
        self.assertTrue(props["keyless"])
        self.assertNotIn("key_ref", props)


class AuthTests(Fixture):
    def test_a_made_up_key_is_refused(self):
        status, out, _ = self.rpc("sk_singit_" + "x" * 43, "initialize")
        self.assertEqual(status, 401)

    def test_a_revoked_key_is_refused(self):
        made = self.make_key()
        self.call("POST", "/api-keys/revoke", {"id": made["id"]})
        status, out, _ = self.rpc(made["key"], "tools/list")
        self.assertEqual(status, 401)
        self.assertEqual(self.shop.calls, [])

    def test_an_untrusted_browser_origin_is_refused_before_auth(self):
        made = self.make_key()
        status, out, _ = self.rpc(made["key"], "initialize", origin="https://evil.test")
        self.assertEqual(status, 403)
        self.assertEqual(self.shop.calls, [])

    def test_a_wrong_key_is_401_never_a_quiet_fall_back_to_keyless(self):
        for kwargs in ({}, {"client_ip": "203.0.113.5"}):
            status, out, headers = self.rpc(BAD_KEY, "tools/list", **kwargs)
            self.assertEqual(status, 401)
            self.assertIn("Bearer", headers["WWW-Authenticate"])
            self.assertEqual(out["error"]["code"], -32001)
        status, _, _ = self.api.mcp.handle(authorization=None, api_key=BAD_KEY, origin=None,
                                           protocol_version="2025-06-18", body={"jsonrpc": "2.0", "id": 1,
                                                                                "method": "ping"})
        self.assertEqual(status, 401)
        self.assertEqual(self.shop.calls, [])


class BlankAndUnexpandedCredentialTests(Fixture):
    """A blank bearer or an unexpanded "${...}" client template is a client misconfiguration, not an
    attempt to authenticate, so it must be served exactly like a request with no header at all."""

    def raw_rpc(self, method, params=None, *, authorization=None, api_key=None, id_=1):
        body = {"jsonrpc": "2.0", "method": method}
        if id_ is not None:
            body["id"] = id_
        if params is not None:
            body["params"] = params
        return self.api.mcp.handle(authorization=authorization, api_key=api_key, origin=None,
                                   protocol_version="2025-06-18", body=body)

    def test_blank_or_bare_bearer_authorization_is_served_keyless(self):
        self.api.mcp.fetch_json = lambda url: {"ok": True}
        for header in ("Bearer", "Bearer ", "bearer   ", "", "   "):
            with self.subTest(authorization=repr(header)):
                status, out, _ = self.raw_rpc("initialize", {"protocolVersion": "2025-06-18"}, authorization=header)
                self.assertEqual(status, 200)
                status, out, _ = self.raw_rpc("tools/list", authorization=header)
                self.assertEqual(status, 200)
                self.assertEqual(len(out["result"]["tools"]), 16)
                status, out, _ = self.raw_rpc("tools/call", {"name": "list_price_symbols", "arguments": {}},
                                              authorization=header)
                self.assertFalse(out["result"].get("isError"))
                status, out, _ = self.raw_rpc("tools/call", {"name": sorted(PAID_TOOL_NAMES)[0], "arguments": {}},
                                              authorization=header)
                self.assertTrue(out["result"]["isError"])
                self.assertIn("API key", out["result"]["content"][0]["text"])
        self.assertEqual(self.shop.calls, [])

    def test_blank_x_api_key_is_served_keyless(self):
        for header in ("", "   "):
            with self.subTest(api_key=repr(header)):
                status, out, _ = self.raw_rpc("tools/list", api_key=header)
                self.assertEqual(status, 200)
                self.assertEqual(len(out["result"]["tools"]), 16)

    def test_unexpanded_template_placeholder_in_authorization_is_served_keyless(self):
        self.api.mcp.fetch_json = lambda url: {"ok": True}
        for placeholder in ("Bearer ${env:SINGIT_API_KEY}", "${SINGIT_API_KEY}", "${env:SINGIT_API_KEY}",
                            "bearer ${SINGIT_API_KEY}"):
            with self.subTest(authorization=placeholder):
                status, out, _ = self.raw_rpc("tools/list", authorization=placeholder)
                self.assertEqual(status, 200)
                self.assertEqual(len(out["result"]["tools"]), 16)
                status, out, _ = self.raw_rpc("tools/call", {"name": "list_price_symbols", "arguments": {}},
                                              authorization=placeholder)
                self.assertFalse(out["result"].get("isError"))
                status, out, _ = self.raw_rpc("tools/call", {"name": sorted(PAID_TOOL_NAMES)[0], "arguments": {}},
                                              authorization=placeholder)
                self.assertTrue(out["result"]["isError"])
                self.assertIn("API key", out["result"]["content"][0]["text"])
        self.assertEqual(self.shop.calls, [])

    def test_unexpanded_template_placeholder_in_x_api_key_is_served_keyless(self):
        status, out, _ = self.raw_rpc("tools/list", api_key="${SINGIT_API_KEY}")
        self.assertEqual(status, 200)
        self.assertEqual(len(out["result"]["tools"]), 16)

    def test_a_real_but_wrong_key_still_gets_401(self):
        status, out, _ = self.raw_rpc("tools/list", authorization=f"Bearer {BAD_KEY}")
        self.assertEqual(status, 401)
        status, out, _ = self.raw_rpc("tools/list", api_key=BAD_KEY)
        self.assertEqual(status, 401)

    def test_a_value_that_merely_contains_a_dollar_brace_is_not_a_placeholder(self):
        # Only an *exact* "${...}" template (after stripping "Bearer ") is treated as unset; anything
        # else, even if it contains the same characters, goes through real auth and is just a wrong key.
        for bad in ("Bearer $" + "x" * 20, "Bearer ${SINGIT_API_KEY} extra", "${SINGIT_API_KEY}x"):
            with self.subTest(authorization=bad):
                status, out, _ = self.raw_rpc("tools/list", authorization=bad)
                self.assertEqual(status, 401)


class FailedAuthIpLimitTests(Fixture):
    def test_too_many_failed_auths_from_one_address_get_429_instead_of_401(self):
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW):
            status, _, _ = self.rpc(BAD_KEY, "initialize", client_ip="198.51.100.9")
            self.assertEqual(status, 401)
        status, out, headers = self.rpc(BAD_KEY, "initialize", client_ip="198.51.100.9")
        self.assertEqual(status, 429)
        self.assertEqual(out["error"]["code"], -32029)
        self.assertEqual(int(headers["Retry-After"]), wm.AUTH_FAILURE_WINDOW_SECONDS)

    def test_a_different_address_is_unaffected(self):
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW):
            self.rpc(BAD_KEY, "initialize", client_ip="198.51.100.9")
        status, _, _ = self.rpc(BAD_KEY, "initialize", client_ip="198.51.100.10")
        self.assertEqual(status, 401)

    def test_keyless_requests_never_count_as_failed_sign_ins(self):
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW + 5):
            self.rpc(None, "ping", client_ip="198.51.100.9", id_=None)  # notifications: not rated either
        status, _, _ = self.rpc(BAD_KEY, "ping", client_ip="198.51.100.9")
        self.assertEqual(status, 401)

    def test_a_successful_auth_does_not_count_as_a_failure(self):
        made = self.make_key()
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW):
            status, _, _ = self.rpc(made["key"], "ping", client_ip="198.51.100.9")
            self.assertEqual(status, 200)
        status, _, _ = self.rpc(made["key"], "ping", client_ip="198.51.100.9")
        self.assertEqual(status, 200)

    def test_a_valid_key_is_served_even_from_a_throttled_address(self):
        made = self.make_key()
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW + 1):
            self.rpc(BAD_KEY, "initialize", client_ip="198.51.100.9")
        status, _, _ = self.rpc(BAD_KEY, "initialize", client_ip="198.51.100.9")
        self.assertEqual(status, 429)
        status, _, _ = self.rpc(made["key"], "ping", client_ip="198.51.100.9")
        self.assertEqual(status, 200)

    def test_no_client_ip_means_no_limiting(self):
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW + 5):
            status, _, _ = self.rpc(BAD_KEY, "initialize")
            self.assertEqual(status, 401)


class TrustedOriginTests(Fixture):
    def test_the_literal_null_origin_is_never_trusted(self):
        made = self.make_key()
        status, out, _ = self.rpc(made["key"], "initialize", origin="null")
        self.assertEqual(status, 403)

    def test_a_trusted_scanner_origin_without_a_key_reads_the_catalogue(self):
        status, out, headers = self.rpc(None, "tools/list", origin="https://glama.ai")
        self.assertEqual(status, 200)
        self.assertEqual(len(out["result"]["tools"]), 16)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://glama.ai")

    def test_a_trusted_scanner_origin_with_a_valid_key_gets_cors_headers_back(self):
        made = self.make_key()
        status, out, headers = self.rpc(made["key"], "initialize", origin="https://glama.ai")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://glama.ai")
        self.assertEqual(headers["Vary"], "Origin")

    def test_a_trusted_origin_can_read_www_authenticate_on_a_401(self):
        status, _, headers = self.rpc(BAD_KEY, "initialize", origin="https://glama.ai")
        self.assertEqual(status, 401)
        self.assertIn("WWW-Authenticate", headers["Access-Control-Expose-Headers"])

    def test_the_mcp_hosts_own_origin_is_trusted(self):
        made = self.make_key()
        status, out, headers = self.rpc(made["key"], "initialize", origin=URI)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], URI)

    def test_no_origin_and_no_key_reads_the_catalogue_too(self):
        self.assertEqual(self.rpc(None, "initialize")[0], 200)
        self.assertEqual(self.rpc(None, "tools/list")[0], 200)


class AllowedOriginsEnvTests(unittest.TestCase):
    def test_the_default_allowlist_covers_the_known_mcp_scanners(self):
        self.assertEqual(allowed_origins_from_env({}), DEFAULT_ALLOWED_ORIGINS)
        self.assertIn("https://glama.ai", DEFAULT_ALLOWED_ORIGINS)
        self.assertIn("https://x402scan.com", DEFAULT_ALLOWED_ORIGINS)

    def test_the_env_override_replaces_the_defaults_rather_than_extending_them(self):
        origins = allowed_origins_from_env({"SINGIT_MCP_ALLOWED_ORIGINS": "https://only.example, https://also.example/"})
        self.assertEqual(origins, {"https://only.example", "https://also.example"})
        self.assertNotIn("https://glama.ai", origins)

    def test_web_api_passes_its_allowlist_to_the_mcp_server(self):
        from sign402_gateway.web_mcp import McpServer
        server = McpServer(Mock(), allowed_origins=allowed_origins_from_env(
            {"SINGIT_MCP_ALLOWED_ORIGINS": "https://only.example"}))
        self.assertTrue(server.is_trusted_origin("https://only.example"))
        self.assertFalse(server.is_trusted_origin("https://glama.ai"))


class FreeToolTests(Fixture):
    def test_get_price_asks_the_right_url_and_does_not_touch_the_shop(self):
        made = self.make_key(dailyUsd=1)
        fetch = Mock(return_value={"symbol": "BTC", "usd": 65000})
        self.api.mcp.fetch_json = fetch
        status, out, _ = self.call_tool(made["key"], "get_price", {"kind": "crypto", "symbol": "btc"})
        self.assertEqual(status, 200)
        fetch.assert_called_once_with(ASK_URL + "/v1/prices/crypto/BTC")
        self.assertEqual(out["result"]["structuredContent"], {"symbol": "BTC", "usd": 65000})
        self.assertEqual(self.shop.calls, [])
        self.assertEqual(self.store.key_spent(made["id"], NOW // 86400), (0, 0))

    def test_an_invalid_symbol_is_a_protocol_error_not_a_tool_error(self):
        made = self.make_key()
        status, out, _ = self.call_tool(made["key"], "get_price", {"kind": "crypto", "symbol": "!!!"})
        self.assertEqual(status, 200)
        self.assertEqual(out["error"]["code"], -32602)

    def test_an_fx_price_reads_base_and_quote(self):
        made = self.make_key()
        fetch = Mock(return_value={"rate": 1.08})
        self.api.mcp.fetch_json = fetch
        self.call_tool(made["key"], "get_price", {"kind": "fx", "base": "usd", "quote": "eur"})
        fetch.assert_called_once_with(ASK_URL + "/v1/prices/fx/USD/EUR")

    def test_list_price_symbols(self):
        made = self.make_key()
        self.api.mcp.fetch_json = Mock(return_value={"crypto": ["BTC"]})
        status, out, _ = self.call_tool(made["key"], "list_price_symbols")
        self.assertEqual(out["result"]["structuredContent"], {"crypto": ["BTC"]})

    def test_list_models_chat_goes_through_the_shop_without_billing_the_key(self):
        made = self.make_key()
        status, out, _ = self.call_tool(made["key"], "list_models")
        self.assertEqual(out["result"]["structuredContent"]["data"][0]["id"], "claude-opus-5.5")
        self.assertEqual(self.shop.calls, [("api-models", self.account, {})])
        self.assertEqual(self.store.key_spent(made["id"], NOW // 86400), (0, 0))


class WebSearchAndReadPageTests(Fixture):
    def test_web_search_bills_the_key_through_api_search(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"ok": True, "data": {"results": [{"title": "SingIt"}]}, "costAtomic": 5_000,
                                 "txId": "0x" + "ab" * 32, "network": "base"})
        status, out, _ = self.call_tool(made["key"], "web_search", {"query": "singit"})
        self.assertEqual(status, 200)
        action, account, body = self.shop.calls[-1]
        self.assertEqual((action, account, body["path"], body["body"]["query"]),
                         ("api-search", self.account, "/v1/exa/search", "singit"))
        self.assertEqual(self.store.key_spent(made["id"], NOW // 86400)[0], 5_000)
        self.assertEqual(out["result"]["structuredContent"]["results"], [{"title": "SingIt"}])

    def test_read_page_posts_exa_contents(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"ok": True, "data": {"results": [{"text": "hi"}]}, "costAtomic": 1_000,
                                 "txId": "0xdead", "network": "base"})
        self.call_tool(made["key"], "read_page", {"url": "https://singitai.app"})
        action, account, body = self.shop.calls[-1]
        self.assertEqual((action, body["path"], body["body"]["urls"]), ("api-search", "/v1/exa/contents",
                                                                        ["https://singitai.app"]))

    def test_a_bad_url_is_a_protocol_error(self):
        made = self.make_key()
        status, out, _ = self.call_tool(made["key"], "read_page", {"url": "not-a-url"})
        self.assertEqual(out["error"]["code"], -32602)
        self.assertEqual(self.shop.calls, [])

    def test_a_shop_refusal_is_a_tool_error_not_a_crash(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (403, {"ok": False, "error": "not_enabled", "text": "Set up your allowance first."})
        status, out, _ = self.call_tool(made["key"], "web_search", {"query": "singit"})
        self.assertEqual(status, 200)
        self.assertTrue(out["result"]["isError"])
        self.assertIn("Set up your allowance first.", out["result"]["content"][0]["text"])
        self.assertEqual(self.store.key_spent(made["id"], NOW // 86400), (0, 0))


class PaidDataToolTests(Fixture):
    def test_get_token_price_bills_the_key_through_api_tool(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"data": {"symbol": "ETH", "usd": 3_000}, "costAtomic": 3_000, "txId": "0xdef"})
        status, out, _ = self.call_tool(made["key"], "get_token_price", {"symbol": "eth"})
        self.assertEqual(status, 200)
        action, account, body = self.shop.calls[-1]
        self.assertEqual((action, body["toolId"], body["args"]), ("api-tool", "anchor.token_price", {"symbol": "eth"}))
        self.assertEqual(self.store.key_spent(made["id"], NOW // 86400)[0], 3_000)
        self.assertEqual(out["result"]["structuredContent"]["data"], {"symbol": "ETH", "usd": 3_000})

    def test_a_key_made_before_paid_tools_existed_is_refused_without_touching_the_shop(self):
        key, row = self.store.add_api_key(self.account, "legacy", 1_000_000, 250_000, NOW, NOW + 86400,
                                          scopes="answers search")
        status, out, _ = self.call_tool(key, "get_token_price", {"symbol": "eth"})
        self.assertEqual(status, 200)
        self.assertTrue(out["result"]["isError"])
        self.assertIn("Create a new key", out["result"]["content"][0]["text"])
        self.assertEqual(self.shop.calls, [])

    def test_an_unknown_tool_name_is_a_protocol_error(self):
        made = self.make_key()
        status, out, _ = self.call_tool(made["key"], "bitrefill_buy", {})
        self.assertEqual(out["error"]["code"], -32602)
        self.assertEqual(self.shop.calls, [])


class KeyLimitRefusalTests(Fixture):
    """Offline tools/call coverage of the owner's key caps."""

    PAID_CALLS = (("web_search", {"query": "x402"}),
                  ("read_page", {"url": "https://example.com"}),
                  ("get_token_price", {"symbol": "ETH"}))

    def setUp(self):
        super().setUp()
        self.limiter = "0x" + "ab" * 20
        self.api.allowance.store.active_limiter.return_value = {"limiter": self.limiter}

    def spent(self, made):
        return self.store.key_spent(made["id"], self.clock[0] // 86400)

    def success(self, response):
        status, out, _ = response
        self.assertEqual(status, 200)
        self.assertNotIn("error", out)
        self.assertFalse(out["result"].get("isError"))
        return out["result"]["structuredContent"]

    def refusal(self, made, response, daily=True):
        status, out, _ = response
        self.assertEqual(status, 200)
        self.assertEqual((out["jsonrpc"], out["id"]), ("2.0", 1))
        self.assertNotIn("error", out)
        self.assertIs(out["result"]["isError"], True)
        text = out["result"]["content"][0]["text"]
        # Boolean assertions keep credentials out of failure diagnostics as well.
        for private in (made["key"], self.user.address, self.account, self.limiter):
            self.assertTrue(private not in text, "refusal exposed private account data")
        if daily:
            self.assertIn("This key's daily limit of 0.01 USDC is used up", text)
            self.assertIn("00:00 UTC", text)
        return text

    def test_daily_cap_refuses_search_page_and_data_without_another_charge(self):
        self.shop.reply = (200, {"data": {}, "costAtomic": 7_000})
        for name, args in self.PAID_CALLS:
            with self.subTest(tool=name):
                made = self.make_key(dailyUsd=0.01)
                before = len(self.shop.calls)
                data = self.success(self.call_tool(made["key"], name, args))
                self.assertEqual(data["billing"]["chargedAtomic"], 7_000)
                self.assertEqual(self.spent(made), (7_000, 1))
                self.refusal(made, self.call_tool(made["key"], name, args))
                self.assertEqual(len(self.shop.calls), before + 1)
                self.assertEqual(self.spent(made), (7_000, 1))
                self.assertEqual(self.api.keys._reserved[made["id"]], 0)

    def test_in_flight_hold_counts_with_spent_and_next_call_maximum(self):
        for name, args in self.PAID_CALLS:
            with self.subTest(tool=name):
                made = self.make_key(dailyUsd=0.01, perRequestUsd=0.006)
                self.store.record_key_spend(made["id"], NOW // 86400, 1_000, NOW)
                row = self.store.api_key(made["key"], NOW)
                # Spent + next maximum fits; adding an existing hold exceeds the cap.
                done = self.api.keys._reserve(row, 4_000)
                try:
                    self.refusal(made, self.call_tool(made["key"], name, args))
                    self.assertEqual(self.shop.calls, [])
                    self.assertEqual(self.spent(made), (1_000, 1))
                    self.assertEqual(self.api.keys._reserved[made["id"]], 4_000)
                finally:
                    done(0)
                self.shop.reply = (200, {"data": {}, "costAtomic": 1_000})
                self.success(self.call_tool(made["key"], name, args))
                self.shop.calls.clear()
                self.assertEqual(self.spent(made), (2_000, 2))
                self.assertEqual(self.api.keys._reserved[made["id"]], 0)

    def test_free_tools_limits_and_receipts_work_at_exhausted_cap(self):
        made = self.make_key(dailyUsd=0.01)
        self.shop.reply = (200, {"data": {}, "costAtomic": 10_000})
        self.success(self.call_tool(made["key"], "web_search", {"query": "x402"}))
        self.refusal(made, self.call_tool(made["key"], "web_search", {"query": "x402"}))
        self.api.mcp.fetch_json = Mock(return_value={"usd": 3000})
        self.api.keys.proxy = Mock()
        self.api.keys.proxy.balances.ledger.return_value = []
        self.api.keys._balance = Mock(return_value={"availableUsd": 0})
        self.api.allowance.store.active_limiter.return_value = None
        self.success(self.call_tool(made["key"], "get_price", {"kind": "crypto", "symbol": "ETH"}))
        models = self.success(self.call_tool(made["key"], "list_models"))
        self.assertIn("claude-opus-5.5", [m["id"] for m in models["data"]])
        limits = self.success(self.call_tool(made["key"], "get_limits"))["key"]
        self.assertEqual((limits["dailyCapUsd"], limits["spentTodayUsd"], limits["remainingTodayUsd"]),
                         (0.01, 0.01, 0.0))
        self.assertEqual(limits["spentTodayUsd"] + limits["remainingTodayUsd"], limits["dailyCapUsd"])
        self.assertGreaterEqual(limits["remainingTodayUsd"], 0)
        self.assertEqual(limits["heldNowUsd"], 0)
        self.assertEqual(limits["resetsAt"], (NOW // 86400 + 1) * 86400)
        receipts = self.success(self.call_tool(made["key"], "get_receipts"))
        self.assertEqual(receipts["data"], [])
        self.api.keys.proxy.balances.ledger.assert_called_once_with(self.account, limit=200, before=None)
        self.assertEqual([c[0] for c in self.shop.calls], ["api-search", "api-models"])
        self.assertEqual(self.spent(made), (10_000, 1))

    def test_new_utc_day_allows_same_key_to_spend_again(self):
        made = self.make_key(dailyUsd=0.01)
        self.shop.reply = (200, {"data": {}, "costAtomic": 7_000})
        args = {"query": "x402"}
        self.success(self.call_tool(made["key"], "web_search", args))
        self.refusal(made, self.call_tool(made["key"], "web_search", args))
        self.clock[0] += 86400
        self.assertEqual(self.spent(made), (0, 0))
        self.success(self.call_tool(made["key"], "web_search", args))
        self.assertEqual(self.spent(made), (7_000, 1))
        self.assertEqual(self.store.key_spent(made["id"], NOW // 86400), (7_000, 1))
        self.assertEqual(len(self.shop.calls), 2)

    def test_per_request_cap_forwarded_and_shop_refusals_are_tool_errors(self):
        made = self.make_key(dailyUsd=1, perRequestUsd=0.012)
        for name, args in (self.PAID_CALLS[0], self.PAID_CALLS[2]):
            for status in (400, 429, 403):
                with self.subTest(tool=name, shop_status=status):
                    message = "Price 0.013 USDC is more than this key's per-request limit of 0.012 USDC. Nothing was paid."
                    self.shop.reply = (status, {"text": message})
                    before = len(self.shop.calls)
                    text = self.refusal(made, self.call_tool(made["key"], name, args), daily=False)
                    self.assertEqual(text, message)
                    self.assertEqual(len(self.shop.calls), before + 1)
                    action, account, body = self.shop.calls[-1]
                    self.assertEqual(action, "api-search" if name == "web_search" else "api-tool")
                    self.assertTrue(account == self.account)
                    self.assertEqual(body["limitAtomic"], 12_000)
                    self.assertEqual(self.spent(made), (0, 0))
                    self.assertEqual(self.api.keys._reserved[made["id"]], 0)

    def test_revoked_and_wrong_keys_get_401_for_paid_calls_without_shop(self):
        made = self.make_key()
        self.call("POST", "/api-keys/revoke", {"id": made["id"]})
        for key in (made["key"], BAD_KEY):
            for name, args in self.PAID_CALLS:
                with self.subTest(tool=name, revoked=key == made["key"]):
                    status, out, headers = self.call_tool(key, name, args)
                    self.assertEqual(status, 401)
                    self.assertEqual(out["error"]["code"], -32001)
                    self.assertIn("Bearer", headers["WWW-Authenticate"])
                    self.assertTrue(key not in out["error"]["message"])
        self.assertEqual(self.shop.calls, [])
        self.assertEqual(self.spent(made), (0, 0))


class ProtocolTests(Fixture):
    def test_a_notification_gets_202_and_no_body(self):
        made = self.make_key()
        status, out, headers = self.rpc(made["key"], "notifications/initialized", id_=None)
        self.assertEqual((status, out, headers), (202, None, {}))
        status, out, _ = self.rpc(made["key"], "tools/list", id_=None)
        self.assertEqual((status, out), (202, None))

    def test_an_unknown_method_is_method_not_found(self):
        made = self.make_key()
        status, out, _ = self.rpc(made["key"], "resources/list")
        self.assertEqual(out["error"]["code"], -32601)

    def test_malformed_requests(self):
        made = self.make_key()
        for body in ([{"jsonrpc": "2.0", "id": 1, "method": "ping"}], {"id": 1, "method": "ping"}, {"jsonrpc": "1.0",
                     "id": 1, "method": "ping"}):
            with self.subTest(body):
                status, out, _ = self.api.mcp.handle(authorization=f"Bearer {made['key']}", api_key=None,
                                                     origin=None, protocol_version=None, body=body)
                self.assertEqual((status, out["error"]["code"]), (400, -32600))

    def test_bad_json_bytes(self):
        made = self.make_key()
        status, out, _ = self.api.mcp.handle(authorization=f"Bearer {made['key']}", api_key=None, origin=None,
                                             protocol_version=None, body=b"{not json")
        self.assertEqual((status, out["error"]["code"]), (400, -32700))

    def test_a_key_sends_at_most_sixty_mcp_requests_a_minute(self):
        made = self.make_key(dailyUsd=1)
        self.api.mcp.fetch_json = Mock(return_value={})
        for _ in range(60):
            status, out, _ = self.call_tool(made["key"], "list_price_symbols")
            self.assertEqual(status, 200)
        status, out, headers = self.call_tool(made["key"], "list_price_symbols")
        self.assertEqual(status, 429)
        self.assertEqual(out["error"]["code"], -32029)
        self.assertIn("60 requests a minute", out["error"]["message"])
        self.assertTrue(int(headers["Retry-After"]) > 0)

    def test_the_mcp_bucket_is_separate_from_v1s(self):
        """Exhausting /v1's own bucket must not touch MCP's, and the other way round."""
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"ok": True, "data": {}, "costAtomic": 0})
        with patch("sign402_gateway.web_api_keys.REQUESTS_PER_MINUTE", 2):
            for _ in range(2):
                self.api.keys.public("POST", "/exa/search", authorization=f"Bearer {made['key']}",
                                     origin=None, body={"query": "x"})
            with self.assertRaises(wa.ApiError) as caught:
                self.api.keys.public("POST", "/exa/search", authorization=f"Bearer {made['key']}",
                                     origin=None, body={"query": "x"})
            self.assertEqual(caught.exception.status, 429)
            # /v1's bucket is now empty, but MCP's own bucket is untouched.
            status, out, _ = self.rpc(made["key"], "ping")
            self.assertEqual(status, 200)

        # The ping above already used one of this key's two MCP slots.
        self.api.mcp.requests_per_minute = 2
        status, _, _ = self.rpc(made["key"], "ping")
        self.assertEqual(status, 200)
        status, out, headers = self.rpc(made["key"], "ping")
        self.assertEqual(status, 429)
        self.assertEqual(out["error"]["code"], -32029)
        # /v1 still has its own, unrelated bucket (REQUESTS_PER_MINUTE is back to 60 outside the patch).
        status, _, _ = self.api.keys.public("POST", "/exa/search", authorization=f"Bearer {made['key']}",
                                            origin=None, body={"query": "x"})
        self.assertEqual(status, 200)

    def test_mcp_requests_per_minute_env_override(self):
        with patch.dict(os.environ, {"SINGIT_MCP_REQUESTS_PER_MINUTE": "2"}):
            mcp = wa.McpServer(self.api.keys, fetch_json=Mock(return_value={}))
        self.assertEqual(mcp.requests_per_minute, 2)
        made = self.make_key(dailyUsd=1)
        for _ in range(2):
            status, _, _ = mcp.handle(authorization=f"Bearer {made['key']}", api_key=None, origin=None,
                                      protocol_version=None, body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
            self.assertEqual(status, 200)
        status, out, headers = mcp.handle(authorization=f"Bearer {made['key']}", api_key=None, origin=None,
                                          protocol_version=None, body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], str(60))

    def test_an_invalid_env_override_falls_back_to_the_default(self):
        with patch.dict(os.environ, {"SINGIT_MCP_REQUESTS_PER_MINUTE": "not-a-number"}):
            mcp = wa.McpServer(self.api.keys)
        self.assertEqual(mcp.requests_per_minute, 60)
        with patch.dict(os.environ, {"SINGIT_MCP_REQUESTS_PER_MINUTE": "0"}):
            mcp = wa.McpServer(self.api.keys)
        self.assertEqual(mcp.requests_per_minute, 60)

    def test_search_tools_bill_only_the_mcp_bucket_not_v1s(self):
        made = self.make_key(dailyUsd=1)
        self.shop.reply = (200, {"ok": True, "data": {"results": []}, "costAtomic": 0})
        self.call_tool(made["key"], "web_search", {"query": "x"})
        with patch("sign402_gateway.web_api_keys.REQUESTS_PER_MINUTE", 1):
            # /v1's own bucket is still empty: web_search did not touch it.
            status, _, _ = self.api.keys.public("POST", "/exa/search", authorization=f"Bearer {made['key']}",
                                                origin=None, body={"query": "x"})
            self.assertEqual(status, 200)


class HttpTests(Fixture):
    """Over HTTP, the way an MCP client (Claude Code, Cursor, Codex) calls it. One server for the whole
    class (not one per test) so the suite doesn't pile up unclosed sqlite stores for the GC to warn about
    mid-test, as tearDownModule below already has to account for."""

    def setUp(self):
        super().setUp()
        self.server = wa.WebServer(("127.0.0.1", 0), self.api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/mcp"
        self.root = self.base[: -len("/mcp")]
        self.key = self.make_key()["key"]

    def _options(self, origin):
        request = urllib.request.Request(self.base, method="OPTIONS", headers={"Origin": origin} if origin else {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, dict(response.headers)
        except urllib.error.HTTPError as error:
            headers = dict(error.headers)
            error.close()
            return error.code, headers

    def test_post_initialize_with_a_key_without_one_with_a_bad_one_then_get(self):
        request = urllib.request.Request(self.base, data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            out = json.loads(response.read())
        self.assertEqual(out["result"]["serverInfo"]["name"], "singit")

        request = urllib.request.Request(self.base, data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(len(json.loads(response.read())["result"]["tools"]), 16)

        request = urllib.request.Request(self.base, data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            headers={"Authorization": f"Bearer {BAD_KEY}", "Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(caught.exception.code, 401)
        caught.exception.close()

        get_request = urllib.request.Request(self.base, method="GET")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(get_request, timeout=10)
        self.assertEqual(caught.exception.code, 405)
        self.assertEqual(caught.exception.headers.get("Allow"), "POST")
        caught.exception.close()

    def test_too_many_failed_auths_from_the_same_peer_eventually_429s(self):
        no_key = urllib.request.Request(self.base, data=json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            headers={"Authorization": f"Bearer {BAD_KEY}", "Content-Type": "application/json"})
        for _ in range(wm.AUTH_FAILURES_PER_WINDOW):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(no_key, timeout=10)
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(no_key, timeout=10)
        self.assertEqual(caught.exception.code, 429)
        self.assertTrue(caught.exception.headers.get("Retry-After"))
        caught.exception.close()

    def test_preflight_from_a_trusted_scanner_origin(self):
        status, headers = self._options("https://glama.ai")
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://glama.ai")
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))
        self.assertIn("OPTIONS", headers.get("Access-Control-Allow-Methods", ""))
        self.assertIn("Authorization", headers.get("Access-Control-Allow-Headers", ""))
        self.assertNotIn("Access-Control-Allow-Credentials", headers)

    def test_preflight_from_an_untrusted_origin_is_403_without_cors_headers(self):
        status, headers = self._options("https://evil.example")
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_preflight_from_the_mcp_hosts_own_origin(self):
        status, headers = self._options(URI)
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), URI)

    def test_server_card(self):
        with urllib.request.urlopen(self.root + "/.well-known/mcp/server-card.json", timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "*")
            self.assertIn("max-age=3600", response.headers.get("Cache-Control", ""))
            card = json.loads(response.read())
        self.assertEqual(card["transport"], {"type": "streamable-http", "url": URI + "/mcp"})
        self.assertFalse(card["authentication"]["required"])  # free tools work keyless; paid ones need a key
        self.assertEqual(card["authentication"]["schemes"], ["bearer"])
        self.assertEqual(len(card["tools"]), 16)
        self.assertLessEqual(len(card["description"]), 200)
        self.assertEqual(card, server_card(URI))

    def test_glama_json(self):
        with urllib.request.urlopen(self.root + "/.well-known/glama.json", timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "*")
            data = json.loads(response.read())
        self.assertEqual(data["maintainers"], [{"email": "contact@singitai.app"}])
        self.assertEqual(data, glama_json())

    def test_head_on_server_card_has_no_body(self):
        request = urllib.request.Request(self.root + "/.well-known/mcp/server-card.json", method="HEAD")
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")


class GatewayApiToolTests(unittest.TestCase):
    """web_internal's "api-tool" action: one of server.PAID_TOOLS, priced and paid in one step, no quote."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"SIGN402_WEB_INTERNAL_TOKEN": TOKEN})
        env.start()
        self.addCleanup(env.stop)
        from sign402_gateway.server import UserSpendLimitStore
        from sign402_gateway.web_internal import ToolQuotes

        self.server = DummyServer()
        self.server.user_event_store = Mock()
        self.server.allowance = Mock()
        self.server.allowance.owner_lookup = lambda account: OWNER if account == ACCOUNT else None
        self.server.allowance.lane_for.return_value = {"limiter_address": "0xLIMITER"}
        self.server.allowance.pay_x402.return_value = dict(PAID)
        self.server.allowance.store = AllowanceStore(Path(self.tmp.name) / "allowance.db")
        self.server.web_tool_quotes = ToolQuotes()
        self.server.user_spend_limit_store = UserSpendLimitStore(Path(self.tmp.name) / "limits.json")
        self.requirements = dict(REQUIREMENTS)
        self.server.allowance.store.record_limiter({
            "limiter_address": "0x" + "ab" * 20, "user_id": ACCOUNT, "owner_address": OWNER,
            "agent_address": "0x" + "cd" * 20, "guardian_address": "0x" + "ef" * 20, "daily_cap": 5_000_000,
            "per_purchase_cap": 1_000_000, "expiry": 2_000_000_000, "deploy_tx": "0x" + "00" * 32,
            "status": "ACTIVE", "source": "exact_match", "created_at": 1})

    def call(self, body):
        with (patch("sign402_gateway.server.fetch_x402_payment_required", return_value={"x402Version": 2}),
              patch("sign402_gateway.server.normalize_x402_payment_required",
                    side_effect=lambda *a, **k: dict(self.requirements))):
            return raw_request(self.server, "/internal/web/api-tool", {"account": ACCOUNT, **body},
                               {"X-SingIt-Internal": TOKEN})

    def test_a_price_over_the_keys_per_request_limit_pays_nothing(self):
        status, body = self.call({"toolId": "otto.crypto_news", "args": {}, "limitAtomic": 500})
        self.assertEqual(status, 400)
        self.assertIn("more than this key's per-request limit", body["text"])
        self.server.allowance.pay_x402.assert_not_called()

    def test_otherwise_it_pays_once_and_returns_the_sellers_data(self):
        status, body = self.call({"toolId": "otto.crypto_news", "args": {}, "limitAtomic": 2_000})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["data"], {"headline": "news"})
        self.assertEqual(body["costAtomic"], 1000)
        self.server.allowance.pay_x402.assert_called_once()

    def test_a_solana_account_is_refused(self):
        solana = "solana:" + "1" * 43
        status, body = self.call({"account": solana, "toolId": "otto.crypto_news", "args": {}})
        self.assertEqual(status, 403, "unknown web account: _account() never reaches our own Base-only check")
        self.server.allowance.pay_x402.assert_not_called()


def tearDownModule():
    # Quietly collected here: on Python 3.13+ an unclosed SQLite connection warns when it is
    # collected, and a warning printed mid-test (capturing stderr) fails whichever test runs then.
    import gc
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ResourceWarning)
        gc.collect()


if __name__ == "__main__":
    unittest.main()
