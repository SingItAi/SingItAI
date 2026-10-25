"""A local mock merchant: issues a real x402 v2 402 challenge (upto + exact offers, EVM) and, on
the paid retry, verifies the client's signature for real -- the same EIP-712 domain/types
x402's client schemes sign with (Permit2 witness for upto, EIP-3009 for exact) -- using
eth_account. No facilitator, no chain, no network access: offline, but a genuine signature check,
not a shape check.
"""

from __future__ import annotations

import base64
import http.server
import json
import re
import threading

from eth_account import Account
from eth_account.messages import encode_typed_data

X402_UPTO_PERMIT2_PROXY_ADDRESS = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002"
PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

UPTO_WITNESS_TYPES = {
    "PermitWitnessTransferFrom": [
        {"name": "permitted", "type": "TokenPermissions"},
        {"name": "spender", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
        {"name": "witness", "type": "Witness"},
    ],
    "TokenPermissions": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "Witness": [{"name": "to", "type": "address"}, {"name": "facilitator", "type": "address"}, {"name": "validAfter", "type": "uint256"}],
}
EIP3009_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"}, {"name": "to", "type": "address"}, {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"}, {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"},
    ],
}


def decode(value: str) -> dict:
    return json.loads(base64.b64decode(value).decode("utf-8"))


def encode(value: dict) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


def _chain_id_from_caip(network: str) -> int:
    match = re.match(r"^eip155:(\d+)$", network)
    if not match:
        raise ValueError(f"Not an eip155 network: {network}")
    return int(match.group(1))


def _domain_types(fields: dict) -> list[dict]:
    kinds = {"name": "string", "version": "string", "chainId": "uint256", "verifyingContract": "address"}
    return [{"name": key, "type": kinds[key]} for key in fields]


def _recover(domain: dict, types: dict, primary_type: str, message: dict, signature: str) -> str:
    full_message = {"types": {**types, "EIP712Domain": _domain_types(domain)}, "primaryType": primary_type, "domain": domain, "message": message}
    signable = encode_typed_data(full_message=full_message)
    return Account.recover_message(signable, signature=signature)


def verify_upto_payload(payment_payload: dict):
    offer = payment_payload["accepted"]
    inner = payment_payload.get("payload") or {}
    auth = inner.get("permit2Authorization")
    signature = inner.get("signature")
    if not auth or not signature:
        return False, None
    payer = auth["from"]
    if auth["spender"].lower() != X402_UPTO_PERMIT2_PROXY_ADDRESS.lower():
        return False, payer
    if auth["witness"]["to"].lower() != offer["payTo"].lower():
        return False, payer
    if auth["witness"]["facilitator"].lower() != offer["extra"]["facilitatorAddress"].lower():
        return False, payer
    if auth["permitted"]["amount"] != offer["amount"]:
        return False, payer
    chain_id = _chain_id_from_caip(offer["network"])
    message = {
        "permitted": {"token": auth["permitted"]["token"], "amount": int(auth["permitted"]["amount"])},
        "spender": auth["spender"], "nonce": int(auth["nonce"]), "deadline": int(auth["deadline"]),
        "witness": {"to": auth["witness"]["to"], "facilitator": auth["witness"]["facilitator"], "validAfter": int(auth["witness"]["validAfter"])},
    }
    domain = {"name": "Permit2", "chainId": chain_id, "verifyingContract": PERMIT2_ADDRESS}
    try:
        recovered = _recover(domain, UPTO_WITNESS_TYPES, "PermitWitnessTransferFrom", message, signature)
    except Exception:
        return False, payer
    return recovered.lower() == payer.lower(), payer


def verify_exact_payload(payment_payload: dict):
    offer = payment_payload["accepted"]
    inner = payment_payload.get("payload") or {}
    auth = inner.get("authorization")
    signature = inner.get("signature")
    if not auth or not signature:
        return False, None
    payer = auth["from"]
    if auth["to"].lower() != offer["payTo"].lower():
        return False, payer
    if auth["value"] != offer["amount"]:
        return False, payer
    chain_id = _chain_id_from_caip(offer["network"])
    message = {
        "from": auth["from"], "to": auth["to"], "value": int(auth["value"]),
        "validAfter": int(auth["validAfter"]), "validBefore": int(auth["validBefore"]),
        "nonce": bytes.fromhex(auth["nonce"][2:]),
    }
    domain = {"name": offer["extra"]["name"], "version": offer["extra"]["version"], "chainId": chain_id, "verifyingContract": offer["asset"]}
    try:
        recovered = _recover(domain, EIP3009_TYPES, "TransferWithAuthorization", message, signature)
    except Exception:
        return False, payer
    return recovered.lower() == payer.lower(), payer


def upto_offer(*, network, asset, pay_to, amount, max_timeout_seconds=120, facilitator_address, asset_name="USDC", asset_version="2"):
    return {
        "scheme": "upto", "network": network, "asset": asset, "payTo": pay_to, "amount": amount, "maxTimeoutSeconds": max_timeout_seconds,
        "extra": {"facilitatorAddress": facilitator_address, "assetTransferMethod": "permit2", "name": asset_name, "version": asset_version,
                  "billing": {"mode": "actual_usage", "maxChargeAtomic": amount}},
    }


def exact_offer(*, network, asset, pay_to, amount, max_timeout_seconds=120, asset_name="USDC", asset_version="2"):
    return {
        "scheme": "exact", "network": network, "asset": asset, "payTo": pay_to, "amount": amount, "maxTimeoutSeconds": max_timeout_seconds,
        "extra": {"name": asset_name, "version": asset_version, "billing": {"mode": "exact_ceiling", "maxChargeAtomic": amount}},
    }


class Merchant:
    """Starts a one-shot local HTTP merchant on a background thread."""

    def __init__(self, accepts, bill=None, routes=None):
        self.accepts = accepts
        self.routes = routes or {}
        self.payment_headers: list[str] = []
        self.requests = 0
        self.refuse = False  # answer a signed payment with 402, as a facilitator that rejects it would
        self.bill = bill or (lambda offer: offer["amount"] if offer["scheme"] == "exact" else str(int(offer["amount"]) // 2))
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                outer.last_get_headers = dict(self.headers)
                status, body = outer.routes.get(self.path, (404, {"error": "Not found."}))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_POST(self):
                outer.requests += 1
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                payment_header = self.headers.get("payment-signature")
                if not payment_header:
                    offers = outer.accepts(body)
                    challenge = {"x402Version": 2, "resource": {"url": outer.resource_url}, "accepts": offers}
                    self.send_response(402)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("PAYMENT-REQUIRED", encode(challenge))
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Payment required."}).encode())
                    return
                outer.payment_headers.append(payment_header)
                payment_payload = decode(payment_header)
                offer = payment_payload["accepted"]
                verify = verify_upto_payload if offer["scheme"] == "upto" else verify_exact_payload
                ok, payer = verify(payment_payload)
                if not ok or outer.refuse:
                    self.send_response(402)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Invalid payment signature."}).encode())
                    return
                billed_atomic = outer.bill(offer)
                receipt = {"success": True, "network": offer["network"], "payer": payer, "transaction": f"0x{'ab' * 32}"}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("payment-response", encode(receipt))
                self.end_headers()
                self.wfile.write(json.dumps({
                    "id": "singit-ask-mock-1", "object": "chat.completion", "created": 0, "model": "singit-ask-mock",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello back."}, "finish_reason": "stop"}],
                    "usage": {"buyer_cost_micro": 100}, "billing": {"totalAtomic": billed_atomic},
                }).encode())

        self._server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_port}"
        self.resource_url = f"{self.url}/v1/chat/completions"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
