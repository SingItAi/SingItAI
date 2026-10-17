import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from eth_account import Account
from eth_account.messages import encode_defunct

from sign402_gateway import allowance_bitrefill as ab
from sign402_gateway.agent_allowance import USDC, AllowanceError

SKILL_SCRIPTS = Path(__file__).resolve().parents[2] / ".agents" / "skills" / "bitrefill" / "scripts"
CHALLENGE = {
    "x402Version": 2,
    "extensions": {"sign-in-with-x": {
        "info": {
            "domain": "api.bitrefill.com", "uri": "https://api.bitrefill.com/x402/connect", "version": "1",
            "nonce": "ac14bafad8414368663becd2df192ac2", "issuedAt": "2026-09-24T01:15:03.612Z",
            "resources": ["https://api.bitrefill.com/x402/connect"],
            "expirationTime": "2026-09-24T01:20:03.612Z",
            "statement": "Sign in to Bitrefill to access your orders and gift card codes.",
        },
        "supportedChains": [{"chainId": "eip155:8453", "type": "eip191"}, {"chainId": "eip155:137", "type": "eip191"}],
    }},
}


class SignInFormatTests(unittest.TestCase):
    def setUp(self):
        self.account = Account.create()

    @unittest.skipUnless(shutil.which("node") and (SKILL_SCRIPTS / "siwx_build_message.js").exists(), "needs node and the skill")
    def test_the_message_is_byte_for_byte_the_skills(self):
        with tempfile.TemporaryDirectory() as tmp:
            challenge = Path(tmp) / "challenge.json"
            challenge.write_text(json.dumps(CHALLENGE))
            out = subprocess.run(
                ["node", str(SKILL_SCRIPTS / "siwx_build_message.js"), self.account.address.lower(), str(challenge),
                 str(Path(tmp) / "skeleton.json")],
                capture_output=True, text=True, check=True,
            ).stdout
        theirs = out.split("MESSAGE_START\n", 1)[1].split("\nMESSAGE_END", 1)[0]
        ours = ab.siwe_message(CHALLENGE["extensions"]["sign-in-with-x"]["info"], self.account.address, 8453)
        self.assertEqual(ours, theirs)

    def test_the_header_carries_a_signature_over_that_message(self):
        extension = CHALLENGE["extensions"]["sign-in-with-x"]
        payload = json.loads(base64.b64decode(ab.siwx_header(extension, self.account.key.to_0x_hex())))
        self.assertEqual(payload["chainId"], "eip155:8453")
        self.assertEqual(payload["type"], "eip191")
        self.assertEqual(payload["address"], self.account.address)
        message = ab.siwe_message(extension["info"], self.account.address, 8453)
        signer = Account.recover_message(encode_defunct(text=message), signature=payload["signature"])
        self.assertEqual(signer, self.account.address)


class FakeBitrefill:
    """Bitrefill's x402 routes at the HTTP level: sign-in, paying a guest invoice, and old orders' codes."""

    def __init__(self):
        self.pay_to = ab.PAY_TO
        self.pay_amount = 20_000
        self.delivered = True
        self.codes_in_status = True
        self.calls = []

    def __call__(self, method, url, *, token=None, body=None, headers=None):
        self.calls.append((method, url.split("?")[0], token, body, headers))
        path = url.split("?")[0].removeprefix(ab.API)
        if path == "/connect":
            if headers and "SIGN-IN-WITH-X" in headers:
                return 200, {"token": "jwt-1"}, {}
            return 402, CHALLENGE, {}
        if path == "/invoice/pay":
            leg = {"scheme": "exact", "network": "eip155:8453", "asset": USDC.lower(), "amount": str(self.pay_amount),
                   "payTo": self.pay_to}
            return 402, {"accepts": [leg]}, {}
        if path == "/invoice/status":  # orders made on the x402 API before they moved to MCP
            if headers and "SIGN-IN-WITH-X" in headers:
                return 200, {"orders": [{"redemption_info": {"code": "SECRET-CODE"}}], "delivery_status": "all_delivered"}, {}
            if token:
                body = {"delivery_status": "all_delivered" if self.delivered else "pending"}
                if self.codes_in_status:
                    body["orders"] = [{"redemption_info": {"code": "SECRET-CODE"}}]
                return 200, body, {}
            return 402, CHALLENGE, {}
        raise AssertionError(path)


class FakeMcp:
    """The guest MCP client, whose URL carries the affiliate code: catalog, guest invoices, delivery."""
    checkout_mode = "guest"

    def __init__(self):
        self.price = "0.02"
        self.pay_url = f"{ab.API}/invoice/pay"
        self.delivered = True
        self.redemption = {"code": "SECRET-CODE"}
        self.calls = []

    def get_product_details(self, *, product_id, country):
        if product_id != "hediyen":
            raise ValueError("unknown product")
        return {"productId": "hediyen", "name": "Hediyen Kart", "currency": "TRY", "requiredRecipientFields": [],
                "packages": [{"value": "1", "packageId": "1", "priceUsd": self.price}]}

    def quote_product(self, *, product_id, package_id, country, recipient):
        product = self.get_product_details(product_id=product_id, country=country)
        if package_id != "1":
            raise ValueError("unknown Bitrefill package")
        return {"productId": "hediyen", "name": product["name"], "packageValue": "1", "currency": "TRY",
                "priceUsd": self.price, "requiredRecipientFields": []}

    def _call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"response": {"invoice_id": "inv-9", "invoice_access_token": "tok-secret",
                             "x402_payment_url": self.pay_url}}

    def _normalize_invoice(self, payload):
        return payload["response"]

    _invoice_id = staticmethod(lambda invoice: invoice.get("invoice_id"))
    _invoice_access_token = staticmethod(lambda invoice: invoice.get("invoice_access_token", ""))
    _invoice_status = staticmethod(lambda invoice: invoice.get("invoice_status", ""))
    _orders = staticmethod(lambda invoice: invoice.get("orders", []))

    def invoice_status(self, *, invoice_id, invoice_access_token):
        self.calls.append(("get-invoice-by-id", {"invoice_id": invoice_id, "token": invoice_access_token}))
        if not self.delivered:
            return {"invoice_id": invoice_id, "invoice_status": "paid", "orders": []}
        return {"invoice_id": invoice_id, "invoice_status": "complete",
                "orders": [{"status": "delivered", "redemption_info": self.redemption}]}


class BitrefillX402Tests(unittest.TestCase):
    def setUp(self):
        self.agent = Account.create()
        self.allowance = Mock()
        self.allowance.agent_key.return_value = (self.agent.address, self.agent.key.to_0x_hex())
        self.allowance.pay_x402.return_value = {
            "ok": True, "status": 200, "delivered": True, "settlementTx": "0x" + "ab" * 32, "payer": self.agent.address,
            "limiter": "0xLIMITER", "funding": "exact 0.02 USDC", "fundingTx": "0xF",
        }
        self.http = FakeBitrefill()
        self.mcp = FakeMcp()
        self.clock = [1_800_000_000]
        self.bitrefill = ab.BitrefillX402(self.allowance, x402_client="client", http=self.http, mcp=self.mcp,
                                          now=lambda: self.clock[0], sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s))

    def buy(self, ceiling=20_000):
        return self.bitrefill.buy("u", "hediyen", "1", ceiling, email="buyer@example.com")

    def test_signing_in_once_and_reusing_the_token(self):
        self.assertEqual(self.bitrefill.token("u"), "jwt-1")
        self.assertEqual(self.bitrefill.token("u"), "jwt-1")
        self.assertEqual(sum(1 for c in self.http.calls if c[1].endswith("/connect")), 2)

    def test_price_requests_arriving_together_sign_in_once(self):
        slow = self.http.__call__
        def connect_slowly(method, url, **kw):
            if url.endswith("/connect"):
                time.sleep(0.05)  # long enough for the other requests to arrive while signing in
            return slow(method, url, **kw)
        self.bitrefill.http = connect_slowly
        with ThreadPoolExecutor(max_workers=6) as pool:
            tokens = list(pool.map(lambda _: self.bitrefill.token("u"), range(6)))
        self.assertEqual(set(tokens), {"jwt-1"})
        self.assertEqual(sum(1 for c in self.http.calls if c[1].endswith("/connect")), 2)  # challenge + sign-in

    def test_a_quote_is_the_price_bitrefills_mcp_asks_now(self):
        quote = self.bitrefill.quote("u", "hediyen", "1")
        self.assertEqual((quote["priceUsd"], quote["priceAtomic"], quote["packageCurrency"]), ("0.02", 20_000, "TRY"))
        with self.assertRaises(AllowanceError):
            self.bitrefill.quote("u", "hediyen", "999")
        self.assertEqual([c for c in self.http.calls if c[1].endswith("/connect")], [], "no x402 sign-in to price it")

    def test_how_to_use_comes_from_bitrefill_without_anything_that_redeems(self):
        self.mcp.redemption = {"code": "QUO-8812-7731-0042", "link": "https://br.quocardpay.jp/card/abc123secret",
                               "instructions": "Open https://br.quocardpay.jp/card/abc123secret and show the barcode "
                                               "QUO-8812-7731-0042 to the cashier. <b>Registers only</b>, not self-checkout."}
        result = self.buy()
        self.assertEqual(result["howToUse"], "Open … and show the barcode … to the cashier. Registers only, not self-checkout.")
        dumped = json.dumps(result)
        for secret in ("QUO-8812-7731-0042", "abc123secret"):
            self.assertNotIn(secret, dumped)
    def test_every_kind_of_code_becomes_a_labelled_field(self):
        self.assertEqual(ab.redemption_fields({"code": "WOLT-AB12-CD34", "pin": "4471", "instructions": "Add it in the app."}),
                         [{"label": "Code", "value": "WOLT-AB12-CD34", "kind": "code"}, {"label": "PIN", "value": "4471", "kind": "code"}])
        self.assertEqual(ab.redemption_fields([{"link": "https://br.quocardpay.jp/card/x", "expirationTime": "2027-03-27T00:00:00.000Z"}]),
                         [{"label": "Link", "value": "https://br.quocardpay.jp/card/x", "kind": "link"},
                          {"label": "Expires", "value": "2027-03-27T00:00:00.000Z", "kind": "date"}])
        self.assertEqual(ab.redemption_fields({"esim_install_link": "https://esim.example/lpa"})[0]["label"], "Install link")
        self.assertEqual(ab.redemption_fields("ALZA-VOUCHER-1"), [{"label": "Code", "value": "ALZA-VOUCHER-1", "kind": "code"}])

    def test_usage_instructions_never_pass_a_bare_code_or_code_like_token(self):
        self.assertEqual(ab.usage_instructions("ABCD-1234-EFGH"), "")
        self.assertEqual(ab.usage_instructions([{"pin": "9921", "other": "Enter PIN 9921 at checkout. Serial X9Y8Z7W6V5U4."}]),
                         "Enter PIN … at checkout. Serial ….")
        self.assertEqual(ab.usage_instructions({"code": "C0DE"}), "")

    def test_the_packages_on_offer_come_with_their_price_now(self):
        offered = self.bitrefill.packages("u", "hediyen")
        self.assertEqual(offered, {"slug": "hediyen", "name": "Hediyen Kart", "recipientRequired": False,
                                   "packages": [{"value": "1", "currency": "TRY", "priceUsd": "0.02"}]})

    def test_an_order_is_a_guest_mcp_invoice_paid_from_the_agent_and_carries_no_code(self):
        result = self.buy()
        name, arguments = self.mcp.calls[0]
        self.assertEqual((name, arguments), ("buy-products", {
            "cart_items": [{"product_id": "hediyen", "package_value": "1"}], "payment_method": "usdc_base",
            "email": "buyer@example.com", "return_payment_link": False}))
        args, kwargs = self.allowance.pay_x402.call_args
        self.assertEqual(args[1], f"{ab.API}/invoice/pay")
        self.assertEqual(args[2], {"amountAtomic": "20000", "receiver": ab.PAY_TO, "asset": USDC})
        self.assertEqual(kwargs, {"method": "POST", "request_body": {"invoice_id": "inv-9"}})
        self.assertEqual((result["invoiceId"], result["mode"], result["fulfillmentToken"]),
                         ("inv-9", "bitrefill_mcp_base", "tok-secret"))
        self.assertTrue(result["delivered"])
        self.assertIn(("get-invoice-by-id", {"invoice_id": "inv-9", "token": "tok-secret"}), self.mcp.calls)
        self.assertNotIn("SECRET-CODE", json.dumps(result))
        self.assertIn("/last_purchase", result["telegramText"])
        self.assertFalse([c for c in self.http.calls if "/invoice/create" in c[1]], "never an x402 REST order")
        self.assertEqual({c[2] for c in self.http.calls}, {None}, "the guest invoice is paid without a sign-in")

    def test_no_email_or_no_guest_checkout_orders_nothing(self):
        with self.assertRaises(ab.NeedsEmail):
            self.bitrefill.buy("u", "hediyen", "1", 20_000, email="  ")
        self.mcp.checkout_mode = "account"  # an order from our own account would never earn the commission
        with self.assertRaises(AllowanceError):
            self.buy()
        self.assertEqual(self.mcp.calls, [])
        self.allowance.pay_x402.assert_not_called()

    def test_nothing_is_paid_when_it_should_not_be(self):
        cases = {
            "the price rose": lambda: setattr(self.mcp, "price", "0.03"),
            "another payment route": lambda: setattr(self.mcp, "pay_url", "https://evil.example/pay"),
            "another recipient": lambda: setattr(self.http, "pay_to", Account.create().address),
            "an order above the confirmed price": lambda: setattr(self.http, "pay_amount", 20_001),
        }
        for name, spoil in cases.items():
            with self.subTest(name):
                self.setUp()
                spoil()
                with self.assertRaises(AllowanceError):
                    self.buy()
                self.allowance.pay_x402.assert_not_called()

    def test_charged_but_unconfirmed_names_both(self):
        self.allowance.pay_x402.return_value = dict(self.allowance.pay_x402.return_value, ok=False, delivered=False,
                                                     status=500)
        with self.assertRaises(AllowanceError) as raised:
            self.buy()
        self.assertIn("took the payment", str(raised.exception))
        self.assertIn("inv-9", str(raised.exception))

    def test_slow_delivery_is_not_a_failure(self):
        self.mcp.delivered = False
        result = self.buy()
        self.assertTrue(result["ok"])
        self.assertFalse(result["delivered"])
        self.assertIn("still delivering", result["telegramText"])

    def test_a_base_orders_code_is_shown_like_any_guest_orders(self):
        from unittest.mock import patch
        from sign402_gateway import server as gw
        event = {"mode": "bitrefill_mcp_base", "invoiceId": "inv-9", "fulfillmentToken": "tok-secret"}
        with patch("sign402_gateway.solana_bitrefill.reveal", return_value={"ok": True}) as reveal:
            self.assertEqual(gw._last_bitrefill_purchase_response("server", event, "u"), {"ok": True})
        reveal.assert_called_once_with("server", event, "u")

    def test_an_old_x402_orders_code_is_fetched_with_or_without_a_second_signature(self):
        self.assertEqual(self.bitrefill.redemption("u", "inv-9"), {"code": "SECRET-CODE"})
        self.http.codes_in_status = False
        self.assertEqual(self.bitrefill.redemption("u", "inv-9"), {"code": "SECRET-CODE"})
        self.http.delivered = False
        self.assertIsNone(self.bitrefill.redemption("u", "inv-9"))
