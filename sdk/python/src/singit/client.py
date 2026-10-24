"""SingIt: x402 payment and client-side spending allowance for SingIt Ask, in a few lines::

    singit = SingIt(evm_private_key=..., network="base", max_per_call_usd=0.01, max_per_day_usd=1)
    answer = singit.chat(messages=[{"role": "user", "content": "Hello"}])

Every payment is checked against a pinned network/asset/payTo and a per-call and per-day USDC
ceiling before anything is signed; see guards.py. Nothing here ever raises a configured ceiling.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .guards import DailyLimiter, SingItPaymentError, decode_header, encode_header, is_atomic_amount, select_offer, usd_to_atomic
from .pins import DEFAULT_APP_BASE_URL, DEFAULT_BASE_URL, NETWORKS, ROUTE, per_model_route


def _post_json(url: str, body: bytes, headers: dict, timeout: float = 90.0):
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (merchant URL is caller-configured)
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def _get_json(url: str, timeout: float = 30.0):
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _required_model(model: str | None) -> str:
    if not model:
        raise SingItPaymentError('model is required when route is "per-model".')
    return model


def _payer_from_payload(payload: dict) -> str | None:
    inner = payload.get("payload") or {}
    auth = inner.get("permit2Authorization") or inner.get("authorization")
    if auth:
        return auth.get("from")
    return inner.get("from")


def _same_payer(family: str, a: object, b: object) -> bool:
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return a.lower() == b.lower() if family == "evm" else a == b


class SingIt:
    def __init__(
        self,
        *,
        evm_private_key: str | None = None,
        evm_account: object | None = None,
        solana_signer: object | None = None,
        network: str,
        base_url: str = DEFAULT_BASE_URL,
        app_base_url: str = DEFAULT_APP_BASE_URL,
        pay_to: str | None = None,
        rpc_url: str | None = None,
        max_per_call_usd: float | None = None,
        max_per_day_usd: float | None = None,
    ):
        pin = NETWORKS.get(network)
        if pin is None:
            raise SingItPaymentError(f'Unknown network "{network}". Use "base", "base-sepolia" or "solana".')
        if pin.pay_to is None and not pay_to:
            raise SingItPaymentError(f"SingIt has no deployment on {network}; pass pay_to explicitly (see README).")
        if max_per_call_usd is None or max_per_day_usd is None:
            raise SingItPaymentError("max_per_call_usd and max_per_day_usd are required: this SDK never pays without a ceiling.")
        self.network = network
        self.pin = pin
        self.base_url = base_url.rstrip("/")
        self.app_base_url = app_base_url.rstrip("/")
        self.pay_to = pay_to or pin.pay_to
        self.rpc_url = rpc_url or pin.default_rpc_url
        self.max_per_call_atomic = usd_to_atomic(max_per_call_usd)
        self.limiter = DailyLimiter(usd_to_atomic(max_per_day_usd))
        self._evm_account = None
        if pin.family == "evm":
            if evm_account is not None:
                self._evm_account = evm_account
            elif evm_private_key is not None:
                from eth_account import Account

                self._evm_account = Account.from_key(evm_private_key)
            else:
                raise SingItPaymentError("Pass evm_private_key or evm_account to pay on an EVM network.")
        self._solana_signer = solana_signer

    def _sign(self, scheme: str, offer: dict, extensions: dict | None) -> dict:
        from x402.schemas import PaymentRequirements

        requirements = PaymentRequirements.model_validate(offer)
        if self.pin.family == "evm":
            if scheme == "upto":
                from x402.mechanisms.evm.upto.client import UptoEvmScheme as Scheme
            else:
                from x402.mechanisms.evm.exact.client import ExactEvmScheme as Scheme
            inner = Scheme(self._evm_account).create_payment_payload(requirements, extensions=extensions)
            payload_extensions = inner.pop("__extensions", None)
            payload = {"x402Version": 2, "accepted": offer, "payload": inner}
            if payload_extensions:
                payload["extensions"] = payload_extensions
            return payload
        # Solana: the official x402 Python package has no `upto` SVM client yet (see README).
        if scheme != "exact":
            raise SingItPaymentError("The official x402 Python package has no Solana `upto` client yet; use scheme='exact'.")
        if not self._solana_signer:
            raise SingItPaymentError("Pass solana_signer (and install singit[svm]) to pay on Solana.")
        from x402.mechanisms.svm.exact.client import ExactSvmScheme

        inner = ExactSvmScheme(self._solana_signer, rpc_url=self.rpc_url).create_payment_payload(requirements)
        return {"x402Version": 2, "accepted": offer, "payload": inner}

    def chat(
        self,
        *,
        model: str | None = None,
        messages: list[dict],
        max_tokens: int | None = None,
        scheme: str = "upto",
        route: str = "completions",
    ) -> dict:
        """One OpenAI-shaped chat completion, paid over x402.

        `route="per-model"` calls POST /v1/chat/{model} (SI-62), which may not be deployed yet;
        the default calls POST /v1/chat/completions, which is live today.
        """
        if not messages:
            raise SingItPaymentError("messages must be a non-empty list.")
        if scheme not in ("upto", "exact"):
            raise SingItPaymentError('scheme must be "upto" or "exact".')
        if route not in ("completions", "per-model"):
            raise SingItPaymentError('route must be "completions" or "per-model".')
        path = per_model_route(_required_model(model)) if route == "per-model" else ROUTE
        url = f"{self.base_url}{path}"
        body = {"messages": messages, "stream": False}
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if model and route == "completions":
            body["model"] = model
        encoded = json.dumps(body).encode("utf-8")

        status, headers, raw = _post_json(url, encoded, {})
        if status != 402:
            if status >= 400:
                raise SingItPaymentError(f"Request failed with HTTP {status}: {raw[:300]!r}")
            return {**json.loads(raw), "payment": None}

        header = headers.get("payment-required")
        if not header:
            raise SingItPaymentError("Got HTTP 402 with no PAYMENT-REQUIRED header.")
        challenge = decode_header(header)
        offer = select_offer(
            challenge,
            scheme=scheme,
            network_id=self.pin.caip,
            family=self.pin.family,
            asset=self.pin.asset,
            pay_to=self.pay_to,
            max_cap_atomic=self.max_per_call_atomic,
            resource_url=url,
        )

        release = self.limiter.reserve(offer["amount"])
        try:
            payload = self._sign(scheme, offer, challenge.get("extensions"))
        except Exception:
            release()
            raise

        try:
            status, headers, raw = _post_json(url, encoded, {"PAYMENT-SIGNATURE": encode_header(payload)})
        except Exception:
            release()
            raise
        if status != 200:
            release()
            raise SingItPaymentError(f"Paid request returned HTTP {status}; it was not repeated.")
        result = json.loads(raw)
        total_atomic = (result.get("billing") or {}).get("totalAtomic")
        if not is_atomic_amount(total_atomic) or int(total_atomic) > int(offer["amount"]):
            release()
            raise SingItPaymentError("The invoice does not match the offered ceiling; treating the payment as unresolved.")
        self.limiter.settle(release, total_atomic, offer["amount"])

        receipt_header = headers.get("payment-response")
        receipt = decode_header(receipt_header) if receipt_header else None
        payer = _payer_from_payload(payload)
        if receipt and (
            receipt.get("network") != self.pin.caip
            or (payer and receipt.get("payer") and not _same_payer(self.pin.family, receipt["payer"], payer))
        ):
            raise SingItPaymentError("The settlement receipt does not match this request; treating the payment as unresolved.")

        payment_info = {"scheme": scheme, "network": self.network, "amountAtomic": total_atomic}
        if receipt and receipt.get("transaction"):
            payment_info["txHash"] = receipt["transaction"]
        return {**result, "payment": payment_info}

    def wallet_report(self, address: str, *, days: int | None = None) -> dict:
        """GET /v1/wallet/{address}/reconciliation on app_base_url (SI-67; may not be deployed yet)."""
        qs = f"?days={days}" if days is not None else ""
        url = f"{self.app_base_url}/v1/wallet/{urllib.parse.quote(address)}/reconciliation{qs}"
        status, raw = _get_json(url)
        if status >= 400:
            raise SingItPaymentError(
                f"Wallet reconciliation is not available (HTTP {status}). This endpoint (SI-67) may not be deployed yet; see the SDK README."
            )
        return json.loads(raw)

    def pricing(self) -> dict:
        """GET /pricing.json on base_url (SI-68; may not be deployed yet)."""
        url = f"{self.base_url}/pricing.json"
        status, raw = _get_json(url)
        if status >= 400:
            raise SingItPaymentError(
                f"pricing.json is not available (HTTP {status}). This endpoint (SI-68) may not be deployed yet; see the SDK README."
            )
        return json.loads(raw)

    def allowance(self, address: str, **kwargs) -> object:
        """The on-chain spending limit set in the SingIt app for `address`, with today's spent/remaining."""
        report = self.wallet_report(address, **kwargs)
        return report.get("allowance") if isinstance(report, dict) else None
