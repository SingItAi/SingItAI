"""Bitrefill on the Trezor allowance lane: ordered through MCP, paid over x402 on Base.

The order is a guest invoice from the project's Bitrefill MCP client, whose URL
carries the owner's affiliate code (`?ref=`), so the purchase earns its commission;
an order created on Bitrefill's x402 REST API does not (Bitrefill, 17 October 2026).
The invoice is paid where Bitrefill sends guest invoices, `POST /x402/invoice/pay`,
by the user's agent key and funded by their limiter, as the Solana lane pays its own.
The pay route's recipient must be Bitrefill's published x402 address and its amount
no more than the price the user confirmed; the payment itself is
AllowanceService.pay_x402, which reads the settlement from the chain.

Bitrefill asks a guest invoice for the buyer's email (codes also land there); the
caller passes the one the user gave. The invoice's access token reads delivery and,
once, the code: it is kept only in the encrypted purchase record.

Orders made before this (mode `bitrefill_x402_allowance`) were created on the x402
API under the agent's Sign-In-With-X session; their codes are still read that way.
The SIWX message is built exactly as the Bitrefill agent skill's
`siwx_build_message.js` builds it; a test compares the two.
"""

from __future__ import annotations

import base64
import json
import logging
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation
from typing import Any, Callable

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import to_checksum_address

from .agent_allowance import USDC, USER_AGENT, AllowanceError, AllowanceService

logger = logging.getLogger(__name__)

API = "https://api.bitrefill.com/x402"
# Published in the Bitrefill agent skill (references/touchpoints/x402.md). A pay
# route that asks for any other recipient is refused, not trusted.
PAY_TO = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A"
CHAIN = "eip155:8453"
TOKEN_SECONDS = 90 * 60           # Bitrefill's token lasts about two hours
DELIVERY_WAIT_SECONDS = 90
KINDS = {"gift-cards": "gift-cards", "topups": "topups", "esims": "esims"}
PAY_URL = f"{API}/invoice/pay"  # where Bitrefill's MCP sends a guest invoice to be paid over x402
DONE = {"complete", "completed", "delivered", "all_delivered"}
FAILED = {"blocked", "denied", "payment_error"}


class NeedsEmail(AllowanceError):
    """Bitrefill needs the buyer's email once before a purchase."""


def siwe_message(info: dict[str, Any], address: str, chain_id: int) -> str:
    """The text to sign, exactly as the skill's buildSiweMessage writes it."""
    prefix = f"{info['domain']} wants you to sign in with your Ethereum account:\n{address}"
    if info.get("statement"):
        prefix += "\n\n" + info["statement"]
    suffix = [
        f"URI: {info['uri']}",
        f"Version: {info['version']}",
        f"Chain ID: {chain_id}",
        f"Nonce: {info['nonce']}",
        f"Issued At: {info['issuedAt']}",
    ]
    if info.get("expirationTime"):
        suffix.append(f"Expiration Time: {info['expirationTime']}")
    if info.get("notBefore"):
        suffix.append(f"Not Before: {info['notBefore']}")
    if info.get("requestId"):
        suffix.append(f"Request ID: {info['requestId']}")
    if info.get("resources"):
        suffix.append("\n".join(["Resources:", *[f"- {r}" for r in info["resources"]]]))
    return prefix + "\n\n" + "\n".join(suffix)


def siwx_header(extension: dict[str, Any], private_key: str) -> str:
    """The SIGN-IN-WITH-X header answering one challenge with this key."""
    info = extension["info"]
    chains = extension.get("supportedChains") or []
    chain = next((c for c in chains if c.get("chainId") == CHAIN), None) or {"chainId": CHAIN, "type": "eip191"}
    address = to_checksum_address(Account.from_key(private_key).address)
    message = siwe_message(info, address, int(chain["chainId"].split(":")[1]))
    signature = Account.sign_message(encode_defunct(text=message), private_key).signature.to_0x_hex()
    payload = {
        "domain": info["domain"], "address": address, "statement": info.get("statement"), "uri": info["uri"],
        "version": info["version"], "chainId": chain["chainId"], "type": chain.get("type") or "eip191",
        "nonce": info["nonce"], "issuedAt": info["issuedAt"], "expirationTime": info.get("expirationTime"),
        "resources": info.get("resources"),
    }
    for optional in ("notBefore", "requestId"):
        if info.get(optional):
            payload[optional] = info[optional]
    payload["signature"] = signature
    return base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()


def _http(method: str, url: str, *, token: str | None = None, body: dict | None = None,
          headers: dict[str, str] | None = None) -> tuple[int, Any, dict[str, str]]:
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
    data = None
    if token:
        request_headers["X-Access-Token"] = token
    if body is not None:
        request_headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, _json(response.read()), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, _json(error.read()), dict(error.headers)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AllowanceError("Bitrefill is not answering right now. Nothing was bought.") from None


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw or b"{}")
    except ValueError:
        return {}


# Where Bitrefill says how to use what was bought, and where it puts what redeems it.
INSTRUCTION_KEYS = ("instructions", "redemption_instructions", "redeem_instructions", "how_to_redeem",
                    "how_to_use", "usage", "description", "other", "terms")
BEARER_KEYS = {"code", "pin", "link", "url", "voucher", "barcode", "serial", "serial_number", "password",
               "claim_code", "activation_code", "qr", "qr_code", "esim_install_link", "lpa", "smdp", "token"}
CODE_LIKE = re.compile(r"\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{9,}\b")


def _bearer_values(obj: Any) -> list[str]:
    out: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if str(key).lower() in BEARER_KEYS and isinstance(value, (str, int)):
                out.append(str(value))
            else:
                out += _bearer_values(value)
    elif isinstance(obj, list):
        for value in obj:
            out += _bearer_values(value)
    return out


def usage_instructions(redemption: Any) -> str:
    """How to use a delivered product, in Bitrefill's words, with anything that redeems it removed.

    The result may be shown in the chat and kept in the purchase record, so it must never carry
    the code: bearer fields are cut out wherever they recur, links (a link can be the voucher)
    and code-like tokens are dropped, and a bare string is ignored, since it may be the code.
    """
    items = redemption if isinstance(redemption, list) else [redemption]
    found = next((i for i in items if isinstance(i, dict)), None)
    if found is None:
        return ""
    text = " ".join(str(found[k]) for k in INSTRUCTION_KEYS if isinstance(found.get(k), str) and found[k].strip())
    text = re.sub(r"<[^>]+>", " ", text)
    for secret in sorted(set(_bearer_values(found)), key=len, reverse=True):
        if len(secret.strip()) >= 4:
            text = text.replace(secret.strip(), "…")
    text = re.sub(r"(?:https?://|www\.)\S+", "", text)
    text = CODE_LIKE.sub("…", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", " ".join(text.split()))
    return text[:397] + "…" if len(text) > 400 else text


FIELD_LABELS = {"code": "Code", "pin": "PIN", "link": "Link", "url": "Link", "voucher": "Voucher", "barcode": "Barcode",
                "serial": "Serial", "serial_number": "Serial", "password": "Password", "claim_code": "Code",
                "activation_code": "Activation code", "esim_install_link": "Install link", "lpa": "LPA",
                "expirationtime": "Expires", "expiration_date": "Expires", "expires_at": "Expires", "expiry": "Expires"}


def redemption_fields(codes: Any) -> list[dict[str, str]]:
    """What redeems a delivered product, labelled for the page: codes to copy, links to open.

    Bitrefill sends different shapes per product (a Wolt code, an Alza voucher, a QUO Card Pay link,
    an eSIM install link…); every non-empty field is kept, in Bitrefill's order. Only for showing
    once to the owner: never stored, never logged, never given to a model.
    """
    fields: list[dict[str, str]] = []
    for item in codes if isinstance(codes, list) else [codes]:
        if isinstance(item, dict):
            for key, value in item.items():
                if value in (None, "", {}, []) or str(key).lower() in INSTRUCTION_KEYS:
                    continue
                text = str(value)
                label = FIELD_LABELS.get(str(key).lower(), str(key).replace("_", " ").capitalize())
                kind = "link" if text.startswith(("https://", "http://")) else "date" if label == "Expires" else "code"
                fields.append({"label": label, "value": text, "kind": kind})
        elif item not in (None, ""):
            fields.append({"label": "Code", "value": str(item), "kind": "link" if str(item).startswith("http") else "code"})
    return fields


def _find(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        if obj.get(name) not in (None, ""):
            return obj[name]
        for value in obj.values():
            found = _find(value, name)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = _find(value, name)
            if found is not None:
                return found
    return None


class BitrefillX402:
    def __init__(
        self,
        allowance: AllowanceService,
        x402_client: Callable[..., dict[str, Any]],
        *,
        http: Callable[..., tuple[int, Any, dict[str, str]]] = _http,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        mcp: Any = None,
    ):
        self.allowance = allowance
        self._mcp_client = mcp
        self.x402_client = x402_client
        self.http = http
        self.now = now
        self.sleep = sleep
        self._tokens: dict[str, tuple[str, float]] = {}
        self._signing_in: dict[str, threading.Lock] = {}
        self._signing_in_guard = threading.Lock()

    def mcp(self) -> Any:
        """The guest MCP client: the only one whose orders carry the affiliate code."""
        client = self._mcp_client
        if client is None or getattr(client, "checkout_mode", "") != "guest" or not hasattr(client, "quote_product"):
            raise AllowanceError("Bitrefill checkout is not set up on this server. Nothing was bought.")
        return client

    # -- sign-in --

    def _challenge(self, method: str, url: str) -> dict[str, Any]:
        status, body, _ = self.http(method, url)
        extension = (body.get("extensions") or {}).get("sign-in-with-x") if isinstance(body, dict) else None
        if status != 402 or not extension:
            raise AllowanceError("Bitrefill did not offer a sign-in. Nothing was bought.")
        return extension

    def token(self, user_id: str) -> str:
        agent, key = self.allowance.agent_key(user_id)
        cached = self._tokens.get(agent)
        if cached and cached[1] > self.now():
            return cached[0]
        with self._signing_in_guard:
            lock = self._signing_in.setdefault(agent, threading.Lock())
        with lock:  # price requests arriving together wait for one sign-in, then share its token
            cached = self._tokens.get(agent)
            if cached and cached[1] > self.now():
                return cached[0]
            return self._sign_in(agent, key)

    def _sign_in(self, agent: str, key: str) -> str:
        header = siwx_header(self._challenge("POST", f"{API}/connect"), key)
        status, body, _ = self.http("POST", f"{API}/connect", headers={"SIGN-IN-WITH-X": header})
        token = body.get("token") if isinstance(body, dict) else None
        if status != 200 or not token:
            raise AllowanceError("Bitrefill refused the agent's sign-in. Nothing was bought.")
        self._tokens[agent] = (token, self.now() + TOKEN_SECONDS)
        return token

    # -- catalog --

    def search(self, user_id: str, query: str, *, kind: str = "gift-cards", country: str = "") -> list[dict[str, Any]]:
        if kind not in KINDS:
            raise AllowanceError("Search gift-cards, topups or esims.")
        params = {"q": query}
        if country:
            params["country"] = country.upper()
        status, body, _ = self.http("GET", f"{API}/{KINDS[kind]}/search?" + urllib.parse.urlencode(params),
                                    token=self.token(user_id))
        if status != 200 or not isinstance(body, dict):
            raise AllowanceError("Bitrefill search failed. Try again.")
        return [{"slug": p.get("slug"), "name": p.get("name"), "currency": p.get("currency"),
                 "countries": p.get("countries")} for p in body.get("products", [])]

    def packages(self, user_id: str, slug: str) -> dict[str, Any]:
        """What can be bought of one product (card values, eSIM plans) and what each costs now.

        From the MCP catalog, which prices the invoices this lane pays.
        """
        try:
            product = self.mcp().get_product_details(product_id=str(slug or ""), country="")
        except ValueError:
            raise AllowanceError(f"Bitrefill has no product {slug!r}.") from None
        offered = []
        for p in product.get("packages") or []:
            try:  # the unrounded price: the one the invoice will ask
                price = str(Decimal(str(p.get("exactPriceUsd") or p["priceUsd"])))
            except (InvalidOperation, KeyError):
                continue  # no price, nothing to consent to
            offered.append({"value": str(p.get("value")), "currency": product.get("currency") or "", "priceUsd": price})
        return {"slug": product["productId"], "name": product.get("name") or slug, "packages": offered[:40],
                "recipientRequired": bool(product.get("requiredRecipientFields"))}

    def quote(self, user_id: str, slug: str, package: str) -> dict[str, Any]:
        """Product, package and the price Bitrefill quotes now, in USDC."""
        try:
            quote = self.mcp().quote_product(product_id=str(slug or ""), package_id=str(package), country="", recipient={})
        except ValueError as exc:
            if "recipient" in str(exc):
                raise AllowanceError("This product needs a recipient; only products delivered as a code can be bought here.") from None
            if "unknown" in str(exc) or "required" in str(exc):
                raise AllowanceError(f"Bitrefill has no package {package!r} for {slug}.") from None
            raise AllowanceError(f"Bitrefill cannot sell that here: {exc}.") from None  # e.g. above its live maximum
        if quote.get("requiredRecipientFields"):
            raise AllowanceError("This product needs a recipient; only products delivered as a code can be bought here.")
        try:  # the unrounded price: the one the invoice will ask
            price = Decimal(str(quote.get("exactPriceUsd") or quote["priceUsd"]))
        except (InvalidOperation, KeyError):
            raise AllowanceError("Bitrefill did not quote a price for it.") from None
        return {
            "slug": quote["productId"], "name": quote.get("name") or slug, "package": str(quote["packageValue"]),
            "packageCurrency": quote.get("currency"), "priceUsd": str(price),
            "priceAtomic": math.ceil(price * 1_000_000),
        }

    # -- purchase --

    def buy(self, user_id: str, slug: str, package: str, ceiling_atomic: int, *, email: str) -> dict[str, Any]:
        """Order through MCP and pay it from the agent, never above `ceiling_atomic`.

        The ceiling is the price the user confirmed. A price that rose since, a
        payment route or recipient other than Bitrefill's published ones, or more
        than the ceiling: nothing is paid. The result carries no code; its
        `fulfillmentToken` (the invoice's access token) is for the encrypted record only.
        """
        if not str(email or "").strip():
            raise NeedsEmail("Bitrefill needs an email for your purchases once (it also sends your codes there).")
        quoted = self.quote(user_id, slug, package)
        if quoted["priceAtomic"] > ceiling_atomic:
            raise AllowanceError(
                f"Bitrefill now asks {quoted['priceUsd']} USDC, above the price you confirmed. Nothing was bought; quote again."
            )
        client = self.mcp()
        try:
            invoice = client._normalize_invoice(client._call_tool("buy-products", {
                "cart_items": [{"product_id": quoted["slug"], "package_value": quoted["package"]}],
                "payment_method": "usdc_base", "email": str(email).strip(), "return_payment_link": False}))
        except Exception:
            raise AllowanceError("Bitrefill did not create the order. Nothing was paid.") from None
        invoice_id, access = client._invoice_id(invoice), client._invoice_access_token(invoice)
        if not invoice_id:
            raise AllowanceError("Bitrefill did not create the order. Nothing was paid.")
        if str(invoice.get("x402_payment_url") or PAY_URL) != PAY_URL:
            raise AllowanceError("Bitrefill offered an unexpected payment route. Nothing was paid.")

        pay_body = {"invoice_id": invoice_id}
        status, challenge, headers = self.http("POST", PAY_URL, body=pay_body)
        header = headers.get("payment-required") or headers.get("Payment-Required")
        if header:
            challenge = json.loads(base64.b64decode(header))
        legs = [a for a in (challenge or {}).get("accepts", [])
                if a.get("scheme") == "exact" and a.get("network") == CHAIN and str(a.get("asset", "")).lower() == USDC.lower()]
        if status != 402 or not legs:
            raise AllowanceError("Bitrefill did not ask for USDC on Base for this order. Nothing was paid.")
        amount = int(legs[0].get("amount") or legs[0]["maxAmountRequired"])
        pay_to = to_checksum_address(legs[0]["payTo"])
        if pay_to != PAY_TO:
            raise AllowanceError(f"Bitrefill's pay route asked for {pay_to}, not its published address. Nothing was paid.")
        if amount > ceiling_atomic:
            logger.warning("bitrefill: invoice %s for %s %s asks %d, confirmed %d (micro-USDC); not paid",
                           invoice_id, quoted["slug"], quoted["package"], amount, ceiling_atomic)
            raise AllowanceError(
                f"Bitrefill asks {Decimal(amount) / 1_000_000:f} USDC for this order, above the "
                f"{Decimal(ceiling_atomic) / 1_000_000:f} USDC you confirmed. Nothing was paid."
            )

        from . import purchase_progress
        purchase_progress.mark("paying")
        paid = self.allowance.pay_x402(
            user_id, PAY_URL, {"amountAtomic": str(amount), "receiver": pay_to, "asset": USDC},
            self.x402_client, method="POST", request_body=pay_body,
        )
        if not paid["ok"]:
            if paid["settlementTx"] and not paid["delivered"]:
                raise AllowanceError(
                    f"Bitrefill took the payment ({paid['settlementTx']}) but did not confirm order {invoice_id}. "
                    "Keep both to claim it; Bitrefill support after 3 hours."
                )
            raise AllowanceError(f"Order {invoice_id} was not paid (HTTP {paid['status']}). Nothing was charged.")

        purchase_progress.mark("paid")
        order = self._wait_delivery(client, invoice_id, access)
        delivered = order is not None
        how_to_use = usage_instructions(order.get("redemption_info") or order.get("redemptionInfo")) if order else ""
        name = f"{quoted['name']} {quoted['package']} {quoted.get('packageCurrency') or ''}".strip()
        text = (
            f"Bought {name} for {Decimal(amount) / 1_000_000} USDC from your Trezor allowance ({paid['funding']}).\n"
            f"Payment: https://basescan.org/tx/{paid['settlementTx']}\n"
            + ("Your code is ready: send /last_purchase to see it." if delivered
               else "Bitrefill is still delivering it; /last_purchase will show it when it is ready.")
        )
        return {
            "ok": True, "mode": "bitrefill_mcp_base", "invoiceId": invoice_id, "productSlug": quoted["slug"],
            "package": quoted["package"], "productName": quoted["name"], "priceUsd": str(Decimal(amount) / 1_000_000),
            "amountAtomic": amount, "txId": paid["settlementTx"], "funding": paid["funding"],
            "fundingTx": paid["fundingTx"], "payer": paid["payer"], "limiter": paid["limiter"],
            "delivered": delivered, "telegramText": text, **({"howToUse": how_to_use} if how_to_use else {}),
            **({"fulfillmentToken": access} if access else {}),
        }

    def _wait_delivery(self, client: Any, invoice_id: str, access: str) -> dict[str, Any] | None:
        """The delivered order, read with the invoice's access token, or None if it is not ready in time."""
        from .solana_bitrefill import _poll_wait  # the same pace: often at first, when most codes arrive
        paid_at = self.now()
        deadline = paid_at + DELIVERY_WAIT_SECONDS
        while True:
            try:
                current = client.invoice_status(invoice_id=invoice_id, invoice_access_token=access)
            except Exception:
                current = {}
            state, orders = client._invoice_status(current), client._orders(current)
            if state in FAILED:
                return None
            if state in DONE or (orders and str(orders[0].get("status")).lower() == "delivered"):
                logger.info("bitrefill: code delivered %.1fs after payment", self.now() - paid_at)
                return orders[0] if orders else {}
            if self.now() >= deadline:
                return None
            self.sleep(_poll_wait(self.now() - paid_at))

    def _status(self, token: str, invoice_id: str) -> Any:
        status, body, _ = self.http("GET", f"{API}/invoice/status?" + urllib.parse.urlencode({"invoice_id": invoice_id}),
                                    token=token)
        return body if status == 200 else None

    def redemption(self, user_id: str, invoice_id: str) -> Any:
        """The code of one order made on the x402 API before orders moved to MCP, or None. Returned to the caller only."""
        token = self.token(user_id)
        body = self._status(token, invoice_id)
        if _find(body, "delivery_status") != "all_delivered":
            return None
        codes = _find(body, "redemption_info")
        if codes is not None:
            return codes
        # Codes are shown to the paying wallet: sign the status route itself.
        url = f"{API}/invoice/status?" + urllib.parse.urlencode({"invoice_id": invoice_id})
        _, key = self.allowance.agent_key(user_id)
        status, body, _ = self.http("GET", url, headers={"SIGN-IN-WITH-X": siwx_header(self._challenge("GET", url), key)})
        return _find(body, "redemption_info") if status == 200 else None
