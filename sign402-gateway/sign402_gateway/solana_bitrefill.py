"""Bitrefill for a web account signed in with a Solana wallet.

An MCP guest invoice, created over the client whose URL carries the affiliate code, paid in
USDC on Solana straight to the invoice's own deposit address.

  1. `buy-products` with `payment_method: usdc_solana` and the buyer's email (Bitrefill
     requires it on guest invoices; it is where codes also land) returns the invoice, its
     access token and `payment_info`: the deposit address and the amount;
  2. the invoice is read again, and the agent transfers that amount straight from the
     owner's account as their approved delegate, within their limits (solana_allowance.py,
     solana-x402-service/src/invoice.mjs, InvoiceTransfers). Our fee payer pays the network fee
     in SOL and, in the same transaction, the buyer pays it back in USDC (NETWORK_FEE_ATOMIC)
     from the same wallet: nobody pays for anyone else.
     Until October 2026 this was paid over Bitrefill's x402 route (verified live on
     September 18, docs/bitrefill-solana-checks.md), whose fee payer paid the fee; that
     route no longer knows MCP invoices;
  3. `get-invoice-by-id` with the access token reports delivery; the code is shown once,
     on request, from the purchase record's encrypted access token.

The user chose that, inside their limits, the agent buys without asking again; what they
buy is still exactly the product and value they picked, at a price checked against the quote.
"""

from __future__ import annotations

import logging
import math
import re
import time
from decimal import Decimal, InvalidOperation
from typing import Any

from .agent_allowance import AllowanceError, AllowanceUnavailable
from .bitrefill_mcp import McpRateLimited
from . import purchase_progress
from .allowance_bitrefill import NeedsEmail, usage_instructions  # noqa: F401 - NeedsEmail is raised here too

logger = logging.getLogger(__name__)

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  # USDC on Solana mainnet
# Our fee payer pays each transfer's network fee in SOL (about 0.000005 SOL, well under 0.001 USDC); the
# buyer pays it back in USDC, in the same transaction, from the wallet that pays for the card.
NETWORK_FEE_ATOMIC = 1_000  # 0.001 USDC
PRICE_SLACK = Decimal("1.02")        # the invoice may round up a little from the quote, never more
DELIVERY_WAIT_SECONDS = 90
# How often to ask whether the code is ready: often at first, when most codes arrive (a few seconds after the
# payment), then less. Asking every 6 s made a code that was ready in 9 s wait until 12 s.
DELIVERY_POLL_SECONDS = (1.5, 20, 5)  # every 1.5 s for the first 20 s, then every 5 s


DELIVERY_RATE_LIMITED_SECONDS = (5, 20)  # after an HTTP 429: wait 5 s, doubling to at most 20 s


def _poll_wait(waited: float, limited: int = 0, retry_after: float | None = None) -> float:
    """How long to wait before asking again. `limited` counts 429s in a row; Bitrefill's
    Retry-After is honoured up to the longest wait, so a delivery is never given up on for it."""
    fast, during, slow = DELIVERY_POLL_SECONDS
    if not limited:
        return fast if waited < during else slow
    first, longest = DELIVERY_RATE_LIMITED_SECONDS
    backoff = min(first * 2 ** (limited - 1), longest)
    return min(max(backoff, retry_after or 0), longest)


def _delivery_poll(client: Any, invoice_id: str, token: str, limited: int) -> tuple[dict[str, Any] | None, int, float | None]:
    """One look at the invoice: (the invoice or None if Bitrefill asked us to slow down, 429s in a row, Retry-After)."""
    try:
        return client.invoice_status(invoice_id=invoice_id, invoice_access_token=token), 0, None
    except McpRateLimited as exc:
        return None, limited + 1, exc.retry_after
DONE = {"complete", "completed", "delivered", "all_delivered"}


class PriceChanged(AllowanceError):
    """Bitrefill's price went up after the user saw it: nothing is bought until they see the new one."""

    def __init__(self, shown: str, price_usd: str):
        self.price_usd = price_usd
        super().__init__(f"The price went up from {shown} to {price_usd} USDC since it was shown. "
                         "Nothing was bought; confirm the new price to buy it.")


SOLANA_ADDRESS = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
NOT_WAITING = {"expired", "payment_detected", "payment_confirmed", "paid", "blocked", "denied", "payment_error"} | DONE


def _deposit(invoice: dict[str, Any], price: int) -> tuple[str, int]:
    """The invoice's deposit address and exact amount in atomic USDC, or a refusal.

    Bitrefill's x402 pay route does not know MCP invoices (it asks its generic 1,000 USDC
    ceiling for any of them, seen on 17 October 2026), so the invoice is paid where it says:
    a USDC transfer on Solana to its own deposit address. Token, amount and address must be
    stated and agree, and the amount stay within the price the user was shown.
    """
    info = invoice.get("payment_info") or invoice.get("paymentInfo")
    if not isinstance(info, dict) or str(info.get("contractAddress") or info.get("contract_address") or "") != USDC_MINT:
        raise AllowanceError("Bitrefill did not ask for USDC on Solana for this order. Nothing was paid.")
    address = str(info.get("address") or "").strip()
    if not SOLANA_ADDRESS.match(address):
        raise AllowanceError("Bitrefill did not say where to pay this order. Nothing was paid.")
    try:
        amount = _atomic(info.get("altcoinPrice", info.get("amount")))
        base = info.get("altBasePrice")
        if base is not None and int(str(base)) != amount:
            raise ValueError("the two amounts disagree")
    except (AllowanceError, ValueError):
        raise AllowanceError("Bitrefill's order disagrees with itself about what to pay. Nothing was paid.") from None
    if amount <= 0:
        raise AllowanceError("Bitrefill's order disagrees with itself about what to pay. Nothing was paid.")
    if amount > math.ceil(price * PRICE_SLACK):
        raise AllowanceError("Bitrefill's invoice is above the price you were shown. Nothing was paid.")
    return address, amount


def _check_unchanged(client: Any, invoice_id: str, token: str, pay_to: str, amount: int) -> None:
    """Read the invoice again from Bitrefill; pay only an open invoice that still asks the same."""
    try:
        current, _, _ = _delivery_poll(client, invoice_id, token, 0)
    except Exception:
        current = None
    if current is None:
        raise AllowanceError("Bitrefill did not confirm the order before payment. Nothing was paid.")
    state = str(client._invoice_status(current) or "").lower()
    if state in NOT_WAITING:
        raise AllowanceError(f"Bitrefill's order {invoice_id} is {state}, not waiting for payment. Nothing was paid.")
    info = current.get("payment_info") or current.get("paymentInfo")
    if isinstance(info, dict) and info.get("address"):
        again = info.get("altBasePrice")
        if str(info["address"]).strip() != pay_to or (again is not None and str(again) != str(amount)):
            raise AllowanceError("Bitrefill's order changed before payment. Nothing was paid.")


def _client(server: Any) -> Any:
    client = getattr(getattr(server, "bitrefill_search_service", None), "bitrefill_client", None)
    if client is None or getattr(client, "checkout_mode", "") != "guest" or not hasattr(client, "quote_product"):
        raise AllowanceUnavailable("Bitrefill on Solana is not set up on this server.")
    return client


def _lane(server: Any) -> Any:
    lane = getattr(server, "solana_allowance", None)
    if lane is None:
        raise AllowanceUnavailable("Solana payments are not set up on this server.")
    return lane


def _usdc(atomic: int) -> str:
    return f"{Decimal(atomic) / 1_000_000:f}".rstrip("0").rstrip(".")


def _atomic(usdc: Any) -> int:
    try:
        return math.ceil(Decimal(str(usdc)) * 1_000_000)
    except (InvalidOperation, ValueError):
        raise AllowanceError("Bitrefill quoted an unreadable price. Nothing was paid.") from None


def email(server: Any, account: str) -> str | None:
    store = getattr(server, "buyer_email_store", None)
    return store.get_email(account) if store is not None else None


def set_email(server: Any, account: str, address: Any) -> str:
    store = getattr(server, "buyer_email_store", None)
    if store is None:
        raise AllowanceUnavailable("Emails cannot be saved on this server.")
    try:
        return store.set_email(account, str(address or ""))
    except ValueError as exc:
        raise AllowanceError(f"That email does not look right: {exc}") from None


def packages(server: Any, slug: Any) -> dict[str, Any]:
    """What can be bought of one product and today's price, from Bitrefill's catalog."""
    product = _client(server).get_product_details(product_id=str(slug or ""), country="")
    return {"slug": product["productId"], "name": product["name"],
            "packages": [{"value": p["value"], "currency": product.get("currency") or "",
                          "priceUsd": str(p.get("exactPriceUsd") or p["priceUsd"])}
                         for p in product.get("packages") or []][:40],
            "recipientRequired": bool(product.get("requiredRecipientFields"))}


def _shown_atomic(usdc: Any) -> int | None:
    """The price the page showed next to the Buy button, if it sent one."""
    if usdc in (None, ""):
        return None
    try:
        amount = Decimal(str(usdc).strip())
    except (InvalidOperation, ValueError):
        amount = Decimal(-1)
    if not amount.is_finite() or amount <= 0:
        raise AllowanceError("The price shown with this purchase is unreadable. Nothing was bought.")
    return math.ceil(amount * 1_000_000)  # rounded as the quote is: the same price is never "higher"


def buy(server: Any, account: str, slug: Any, package: Any, *, shown_price: Any = None, sleep: Any = time.sleep,
        now: Any = time.time) -> dict[str, Any]:
    client, lane = _client(server), _lane(server)
    if not getattr(lane, "fee_payer_key", None):  # before anything is ordered: the transfer could not be sent
        raise AllowanceUnavailable("Gift cards from a Solana wallet are not set up on this server yet. Nothing was bought.")
    started = time.monotonic()
    # The limits from the ledger. The wallet itself (approval, balance) is read once, fresh, by spend() below:
    # status() read it too, a Node process of its own, before anything was even priced.
    limits = lane.store.limits(account)
    if limits is None:
        raise AllowanceUnavailable("Set your limits and approve them from your wallet first.")
    today = int(lane.now())
    if limits["expiry"] <= today:
        raise AllowanceError("Your Solana allowance has expired. Set new limits to continue. Nothing was bought.")
    remaining = max(0, limits["daily_cap"] - lane.store.spent_since(account, today // 86_400 * 86_400))
    buyer = email(server, account)
    if not buyer:
        raise NeedsEmail("Bitrefill needs an email for your purchases once (it also sends your codes there).")
    quote = client.quote_product(product_id=str(slug or ""), package_id=str(package or ""), country="", recipient={})
    if quote.get("requiredRecipientFields"):
        raise AllowanceError("This product is delivered to a phone or account; only products delivered as a code can be bought here.")
    exact = str(quote.get("exactPriceUsd") or quote["priceUsd"])  # unrounded: the price the invoice asks
    price = _atomic(exact)
    shown = _shown_atomic(shown_price)
    if shown is not None and price > shown:  # bought only at the price the user pressed Buy on, or below
        raise PriceChanged(str(shown_price).strip(), exact)
    if price + NETWORK_FEE_ATOMIC > int(limits["per_purchase_cap"]) or price + NETWORK_FEE_ATOMIC > remaining:
        raise AllowanceError(f"{exact} USDC and its {_usdc(NETWORK_FEE_ATOMIC)} USDC network fee do not fit your limits today. "
                             "Nothing was bought.")

    invoice = client._normalize_invoice(client._call_tool("buy-products", {
        "cart_items": [{"product_id": quote["productId"], "package_value": quote["packageValue"]}],
        "payment_method": "usdc_solana", "email": buyer, "return_payment_link": False}))
    invoice_id, token = client._invoice_id(invoice), client._invoice_access_token(invoice)
    if not invoice_id:
        raise AllowanceError("Bitrefill did not create the order. Nothing was paid.")
    pay_to, amount = _deposit(invoice, price)
    _check_unchanged(client, invoice_id, token, pay_to, amount)

    priced = time.monotonic()
    owner = lane.owner(account)
    purchase_progress.mark("paying")
    paid = lane.spend(account, amount + NETWORK_FEE_ATOMIC, f"Bitrefill {quote['name']} {quote['packageValue']}", lambda: lane._call(
        account, "bitrefill-invoice-transfer", fee_payer=True, invoiceId=invoice_id, payTo=pay_to, amount=str(amount),
        feeAmount=str(NETWORK_FEE_ATOMIC), owner=owner))

    purchase_progress.mark("paid")
    paying_done = time.monotonic()
    delivered, order = False, {}
    paid_at = now()
    deadline = paid_at + DELIVERY_WAIT_SECONDS
    limited, retry_after = 0, None
    while now() < deadline:
        current, limited, retry_after = _delivery_poll(client, invoice_id, token, limited)
        if current is None:  # rate limited: the code is still coming, ask later
            sleep(_poll_wait(now() - paid_at, limited, retry_after))
            continue
        if client._invoice_status(current) in {"blocked", "denied", "payment_error"}:
            break
        orders = client._orders(current)
        if client._invoice_status(current) in DONE or (orders and str(orders[0].get("status")).lower() == "delivered"):
            delivered, order = True, orders[0] if orders else {}
            break
        sleep(_poll_wait(now() - paid_at))
    logger.info("solana bitrefill: price and order %.1fs, wallet check and payment %.1fs, code %s after %.1fs",
                priced - started, paying_done - priced, "delivered" if delivered else "not yet", time.monotonic() - paying_done)
    how_to_use = usage_instructions(order.get("redemption_info") or order.get("redemptionInfo")) if delivered else ""

    name = quote["name"]
    denomination = f"{quote['packageValue']} {quote.get('currency') or ''}".strip()
    event = {
        "ok": True, "mode": "bitrefill_mcp_solana", "quoteId": invoice_id, "invoiceId": invoice_id,
        "bitrefill": {"status": "delivered" if delivered else "paid", "productName": name},
        "productName": name, "productSlug": quote["productId"], "package": quote["packageValue"],
        "network": "solana", "txId": paid.get("transaction"), "amountAtomic": str(amount),
        "networkFeeAtomic": str(NETWORK_FEE_ATOMIC),
        "fulfillmentToken": token,  # encrypted by the purchase store; reveals the code once
        "receipt": {"name": name, "denomination": denomination,
                    "paid": f"{_usdc(amount)} USDC + {_usdc(NETWORK_FEE_ATOMIC)} USDC network fee",
                    "network": "Solana", "txId": paid.get("transaction"), "status": "Completed" if delivered else "Paid"},
    }
    if token:
        server.user_event_store.write(account, event)
    else:
        server.user_event_store.write(account, {k: v for k, v in event.items() if k != "fulfillmentToken"})
    from .purchase_history import purchase_id
    return {"ok": True, "invoiceId": invoice_id, "purchaseId": purchase_id(event), "delivered": delivered, "name": name,
            "package": quote["packageValue"],
            "packageCurrency": quote.get("currency") or "", "priceUsd": _usdc(amount), "networkFeeUsd": _usdc(NETWORK_FEE_ATOMIC),
            "txId": paid.get("transaction"), **({"howToUse": how_to_use} if how_to_use else {})}


def reveal(server: Any, event: dict[str, Any], account: str) -> dict[str, Any]:
    """The code of an MCP guest order (Solana, or Base since orders moved to MCP), once.

    Its access token is dropped after it is shown.
    """
    name = str(event.get("productName") or "Your Bitrefill order")
    token = str(event.get("fulfillmentToken") or "").strip()
    if not token:
        return {"ok": True, "telegramText": f"{name} was already shown once — check where you saved the code."}
    client = _client(server)
    invoice = client.invoice_status(invoice_id=str(event.get("invoiceId") or ""), invoice_access_token=token)
    orders = client._orders(invoice)
    codes = (orders[0].get("redemption_info") or orders[0].get("redemptionInfo")) if orders else None
    if not codes:
        return {"ok": True, "telegramText": f"{name} is still being delivered. Try again in a minute."}
    lines = [f"{name} — your code. Store it safely, do not share it, redeem it soon:"]
    for item in codes if isinstance(codes, list) else [codes]:
        if isinstance(item, dict):
            lines.extend(f"{key}: {value}" for key, value in item.items() if value not in (None, "", {}))
        else:
            lines.append(str(item))
    from .allowance_bitrefill import redemption_fields
    from .purchase_history import purchase_id
    server.user_event_store.clear_fulfillment_token(account, purchase_id(event))
    first = next((i for i in (codes if isinstance(codes, list) else [codes]) if isinstance(i, dict)), {})
    return {"ok": True, "telegramText": "\n".join(lines), "fields": redemption_fields(codes),
            "howToUse": " ".join(str(first[k]) for k in ("instructions", "redemption_instructions", "how_to_redeem")
                                 if isinstance(first.get(k), str))}
