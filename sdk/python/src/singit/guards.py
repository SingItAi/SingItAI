"""Client-side allowance guards: pin the merchant's offer (network, asset, payTo) before signing,
cap a single call, and cap a rolling day of calls. Modeled on singit-ask's own buyers
(src/metered-buyer.mjs, src/solana-buyer.mjs): same idea, generalized to any x402 merchant.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone

_ATOMIC_RE = re.compile(r"^[1-9][0-9]{0,27}$")


class SingItPaymentError(Exception):
    pass


def is_atomic_amount(value: object) -> bool:
    return isinstance(value, str) and bool(_ATOMIC_RE.match(value))


def _same_evm_address(a: object, b: object) -> bool:
    return isinstance(a, str) and isinstance(b, str) and a.lower() == b.lower()


def _same_svm_address(a: object, b: object) -> bool:
    return isinstance(a, str) and isinstance(b, str) and a == b


def decode_header(value: str) -> dict:
    try:
        return json.loads(base64.b64decode(value).decode("utf-8"))
    except Exception as error:
        raise SingItPaymentError("The payment header could not be decoded.") from error


def encode_header(value: dict) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


def select_offer(
    challenge: dict,
    *,
    scheme: str,
    network_id: str,
    family: str,
    asset: str,
    pay_to: str,
    max_cap_atomic: str,
    resource_url: str | None = None,
) -> dict:
    """Picks the single offer matching scheme+network, then refuses to sign unless its asset
    and payTo are exactly the ones this SingIt instance was configured to pay, and its amount is
    within the per-call ceiling. Nothing here ever raises the ceiling: a merchant asking for more
    than `max_cap_atomic` is refused, never renegotiated.
    """
    if not challenge or challenge.get("x402Version") != 2:
        raise SingItPaymentError("Unexpected x402 version in the payment challenge.")
    if resource_url and (challenge.get("resource") or {}).get("url") != resource_url:
        raise SingItPaymentError("The challenge names a different resource than the one called.")
    offers = [a for a in (challenge.get("accepts") or []) if a.get("scheme") == scheme and a.get("network") == network_id]
    if len(offers) != 1:
        raise SingItPaymentError(f"Expected exactly one {scheme} offer on {network_id}; got {len(offers)}.")
    offer = offers[0]
    same_address = _same_evm_address if family == "evm" else _same_svm_address
    if not same_address(offer.get("asset"), asset):
        raise SingItPaymentError(f"Unexpected payment asset ({offer.get('asset')}); refusing to sign.")
    if not same_address(offer.get("payTo"), pay_to):
        raise SingItPaymentError(f"Unexpected payee ({offer.get('payTo')}); refusing to sign.")
    amount = offer.get("amount")
    if not is_atomic_amount(amount) or not is_atomic_amount(max_cap_atomic) or int(amount) > int(max_cap_atomic):
        raise SingItPaymentError(f"Offer amount {amount} exceeds the configured per-call ceiling ({max_cap_atomic}).")
    timeout = offer.get("maxTimeoutSeconds")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 600:
        raise SingItPaymentError("Unexpected payment timeout window in the offer.")
    if family == "evm" and offer.get("scheme") == "upto":
        facilitator = (offer.get("extra") or {}).get("facilitatorAddress", "")
        if not re.match(r"^0x[0-9a-fA-F]{40}$", facilitator or "") or re.match(r"^0x0{40}$", facilitator, re.IGNORECASE):
            raise SingItPaymentError("The offer has no usable facilitator address for the upto scheme.")
    return offer


class DailyLimiter:
    """A simple, in-memory, per-UTC-day spend counter. Not durable (lost on restart) and not
    shared across processes: a client-side allowance guard, not a ledger. Checked against the
    offer's worst-case amount before signing, then adjusted down to the amount actually billed
    afterwards, so an `upto` request that settles for less than its ceiling frees the unused
    headroom immediately.
    """

    def __init__(self, cap_atomic: str):
        self.cap_atomic = int(cap_atomic)
        self._day: str | None = None
        self._spent_atomic = 0

    def _roll_if_needed(self) -> None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._day:
            self._day = today
            self._spent_atomic = 0

    def remaining_atomic(self) -> int:
        self._roll_if_needed()
        return max(self.cap_atomic - self._spent_atomic, 0)

    def reserve(self, worst_case_atomic: str):
        self._roll_if_needed()
        amount = int(worst_case_atomic)
        if self._spent_atomic + amount > self.cap_atomic:
            raise SingItPaymentError(
                f"Daily spend cap reached: {self._spent_atomic} already spent today, "
                f"{amount} more would exceed {self.cap_atomic} micro-USDC."
            )
        self._spent_atomic += amount
        # A release only ever touches the day it was reserved on: a request spanning UTC midnight must not take
        # yesterday's reservation off today's counter (Codex review).
        day = self._day
        state = {"done": False}

        def release():
            if state["done"]:
                return
            state["done"] = True
            self._roll_if_needed()
            if self._day == day:
                self._spent_atomic -= amount

        release.day = day
        return release

    def settle(self, release, actual_atomic: str | None, worst_case_atomic: str) -> None:
        self._roll_if_needed()
        if getattr(release, "day", self._day) != self._day:
            return  # yesterday's spend; today's counter starts clean
        release()
        self._spent_atomic += int(actual_atomic if actual_atomic is not None else worst_case_atomic)


def usd_to_atomic(usd: float) -> str:
    if not isinstance(usd, (int, float)) or isinstance(usd, bool) or usd < 0:
        raise SingItPaymentError("max_per_call_usd/max_per_day_usd must be a non-negative number.")
    return str(round(usd * 1_000_000))
