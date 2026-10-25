"""GET /brand/numbers.json (web_api.py): public, unauthenticated, aggregate-only counts for the marketing
site. Every number comes straight from the gateway's own settlements/spends/accounts stores, seeded here
directly — never a wallet address or account id.
"""
import json
import tempfile
import threading
import unittest
import unittest.mock
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

from eth_account import Account

from sign402_gateway import agent_allowance as aa
from sign402_gateway import web_api as wa
from sign402_gateway.solana_allowance import SolanaAllowanceStore
from sign402_gateway.web_accounts import WebAccountStore, WebAuth

NOW = 1_800_000_000
DAY = 86_400
DOMAIN, URI = "app.singit.test", "https://app.singit.test"


def wallet(n: int) -> str:
    return f"wallet:{Account.create().address}" if n is None else f"wallet:0x{n:040x}"


class BrandNumbersTests(unittest.TestCase):
    """WebApi.brand_numbers() against seeded Base and Solana stores."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base_store = aa.AllowanceStore(Path(self.tmp.name) / "allowance.db")
        self.solana_store = SolanaAllowanceStore(Path(self.tmp.name) / "solana.db")
        self.web_store = WebAccountStore(Path(self.tmp.name) / "web.db")
        self.clock = [NOW]
        self.api = wa.WebApi(WebAuth(self.web_store, domain=DOMAIN, uri=URI, allowed=None, now=lambda: self.clock[0]),
                             SimpleNamespace(store=self.base_store), now=lambda: self.clock[0])
        self.api.solana = SimpleNamespace(store=self.solana_store)

    def test_settled_payments_exclude_credit_topups_on_both_chains(self):
        self.base_store.count_settlement("0x1", "0", wallet(1), "0xpay", 5_000_000, "https://ask.singitai.app/v1/chat/completions", NOW)
        self.base_store.count_settlement("0x2", "0", wallet(2), "0xpay", 1_000_000, "https://ask.singitai.app/v1/credit", NOW)
        self.solana_store.add_spend(wallet(3), 2_000_000, "data_tool", "solana-tx-1", NOW)
        self.solana_store.add_spend(wallet(4), 9_000_000, "reserved_but_unsettled", None, NOW)  # no pull_tx: not settled

        numbers = self.api.brand_numbers()

        self.assertEqual(numbers["payments"]["settled"]["total"], 2)  # the two real purchases, not the credit top-up or hold
        self.assertEqual(numbers["payments"]["payingWallets"]["total"], 2)
        self.assertEqual(numbers["payments"]["usdcVolume"]["total"], 7.0)  # 5 + 2 USDC, the credit top-up excluded

    def test_last_30_days_window_excludes_older_settlements(self):
        self.base_store.count_settlement("0x1", "0", wallet(1), "0xpay", 1_000_000, "https://ask.singitai.app/v1/chat/completions",
                                         NOW - 40 * DAY)
        self.base_store.count_settlement("0x2", "0", wallet(2), "0xpay", 3_000_000, "https://ask.singitai.app/v1/chat/completions",
                                         NOW - 1 * DAY)

        numbers = self.api.brand_numbers()

        self.assertEqual(numbers["payments"]["settled"]["total"], 2)
        self.assertEqual(numbers["payments"]["settled"]["last30d"], 1)
        self.assertEqual(numbers["payments"]["usdcVolume"]["last30d"], 3.0)

    def test_accounts_mcp_tools_chains_and_version(self):
        self.web_store.ensure_account("0x" + "11" * 20, NOW)
        self.web_store.ensure_account("0x" + "22" * 20, NOW)

        numbers = self.api.brand_numbers()

        self.assertEqual(numbers["accounts"], 2)
        self.assertEqual(numbers["chains"], ["base", "solana"])
        self.assertEqual(numbers["version"], 1)
        self.assertIsNone(numbers["models"])
        self.assertGreater(numbers["mcpTools"], 0)
        self.assertIn("ask.singitai.app", numbers["scope"])

    def test_no_wallet_or_account_id_leaves_the_response(self):
        address = "0x" + "33" * 20
        self.base_store.count_settlement("0x1", "0", f"wallet:{address}", "0xpay", 1_000_000,
                                         "https://ask.singitai.app/v1/chat/completions", NOW)
        self.web_store.ensure_account(address, NOW)

        text = json.dumps(self.api.brand_numbers())

        self.assertNotIn(address, text)
        self.assertNotIn("wallet:", text)

    def test_without_a_solana_lane_base_numbers_still_come_back(self):
        self.api.solana = None
        self.base_store.count_settlement("0x1", "0", wallet(1), "0xpay", 1_000_000,
                                         "https://ask.singitai.app/v1/chat/completions", NOW)

        numbers = self.api.brand_numbers()

        self.assertEqual(numbers["payments"]["settled"]["total"], 1)
        self.assertEqual(numbers["payments"]["usdcVolume"]["total"], 1.0)

    def test_cached_for_five_minutes_then_refreshed(self):
        first = self.api.brand_numbers()
        self.assertEqual(first["payments"]["settled"]["total"], 0)
        self.base_store.count_settlement("0x1", "0", wallet(1), "0xpay", 1_000_000,
                                         "https://ask.singitai.app/v1/chat/completions", NOW)

        self.clock[0] = NOW + 299
        self.assertEqual(self.api.brand_numbers()["payments"]["settled"]["total"], 0)  # still cached

        self.clock[0] = NOW + 301
        self.assertEqual(self.api.brand_numbers()["payments"]["settled"]["total"], 1)  # refreshed


class BrandNumbersHttpTests(unittest.TestCase):
    """The HTTP layer: open CORS, public caching, per-IP rate limiting."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base_store = aa.AllowanceStore(Path(self.tmp.name) / "allowance.db")
        self.web_store = WebAccountStore(Path(self.tmp.name) / "web.db")
        self.api = wa.WebApi(WebAuth(self.web_store, domain=DOMAIN, uri=URI, allowed=None, now=lambda: NOW),
                             SimpleNamespace(store=self.base_store), now=lambda: NOW)
        self.server = wa.WebServer(("127.0.0.1", 0), self.api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def request(self, method, path, headers=None):
        req = urllib.request.Request(self.base_url + path, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def test_free_open_cors_and_public_caching(self):
        status, headers, body = self.request("GET", "/brand/numbers.json", headers={"Origin": "https://evil.test"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(headers["Cache-Control"], "public, max-age=300")
        parsed = json.loads(body)
        self.assertEqual(parsed["accounts"], 0)
        self.assertNotIn("Set-Cookie", headers)

    def test_per_ip_rate_limited(self):
        for _ in range(60):
            status, _, _ = self.request("GET", "/brand/numbers.json")
            self.assertEqual(status, 200)
        status, _, body = self.request("GET", "/brand/numbers.json")
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body)["error"], "rate_limited")


if __name__ == "__main__":
    unittest.main()
