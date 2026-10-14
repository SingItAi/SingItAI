"""API keys: an OpenAI-compatible /v1 for code, paid from the key owner's own limits.

Design: docs/singit-api-keys-plan.md. A key (`sk_singit_…`) is made in the web app and stands for one
account. Any OpenAI SDK pointed at /v1 with the key as its Bearer token asks SingIt Ask for an answer;
the gateway pays for it from that account's own limiter (Base) or delegated USDC (Solana), exactly as
the web chat does (web_ask._paid_answer). A key can do nothing else: it cannot change limits, move
funds or buy goods.

Each key has a daily cap and a per-answer cap of its own, below the account's limits. The daily cap
is held strictly: before an answer, the key's spend today plus the most every answer in flight may
cost must fit under it. Creating a key takes a signature from the account's wallet over the exact
terms, like signing in; revoking one takes nothing but the session.

The key itself is shown once and stored only as a hash (web_accounts.WebAccountStore).
"""

from __future__ import annotations

import re
import secrets
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Mapping

from .web_accounts import NONCE_SECONDS, WebAuthError, chain_of_account

DEFAULT_DAILY_ATOMIC = 5_000_000          # $5 a day
DEFAULT_PER_REQUEST_ATOMIC = 250_000      # $0.25 an answer
DEFAULT_DAYS = 90
MAX_DAILY_ATOMIC = 1_000_000_000          # $1,000 a day; the account's own limits hold on top
MAX_PER_REQUEST_ATOMIC = 50_000_000       # $50 an answer
MAX_DAYS = 365
REQUESTS_PER_MINUTE = 60
NAME = re.compile(r"[\w .,:()'-]{1,40}")


class ApiError(Exception):
    """An error in OpenAI's shape, so SDKs show its message as it is."""

    def __init__(self, status: int, message: str, *, type_: str = "invalid_request_error", code: str | None = None):
        super().__init__(message)
        self.status, self.message, self.type, self.code = status, message, type_, code

    def body(self) -> dict[str, Any]:
        return {"error": {"message": self.message, "type": self.type, "code": self.code}}


def _usd_atomic(value: Any, default: int, *, low: int, high: int, what: str) -> int:
    if value in (None, ""):
        return default
    try:
        atomic = round(float(value) * 1_000_000)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number of dollars.") from None
    if not low <= atomic <= high:
        raise ValueError(f"{what} must be between ${low / 1e6:g} and ${high / 1e6:g}.")
    return atomic


def _date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def key_message(address: str, name: str, daily: int, per_request: int, until: int, nonce: str, issued: int) -> str:
    """What the owner signs to make a key: the exact terms, in words."""
    return (
        "SingIt: create an API key\n\n"
        f"Name: {name}\n"
        f"Spends up to {daily / 1e6:g} USDC a day and {per_request / 1e6:g} USDC per answer, "
        "from your SingIt limits.\n"
        f"Valid until: {_date(until)}\n"
        f"Account: {address}\n\n"
        "This key can only pay for answers from SingIt Ask. It cannot move your funds or change your limits.\n\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {_date(issued)}"
    )


def public_key(row: Mapping[str, Any], spent: tuple[int, int], now: int) -> dict[str, Any]:
    state = "revoked" if row["revoked_at"] is not None else ("expired" if row["expires_at"] <= now else "active")
    return {"id": row["key_id"], "name": row["name"], "prefix": row["prefix"], "state": state,
            "dailyCapUsd": row["daily_cap_atomic"] / 1e6, "perRequestCapUsd": row["per_request_cap_atomic"] / 1e6,
            "spentTodayUsd": spent[0] / 1e6, "answersToday": spent[1],
            "createdAt": row["created_at"], "expiresAt": row["expires_at"], "lastUsedAt": row["last_used_at"]}


class ApiKeys:
    """The web app's key management (/web/v1/api-keys…) and the public /v1 the keys open."""

    def __init__(self, api: Any, now=time.time):
        self.api = api  # web_api.WebApi: its auth, shop, push and rate limits
        self.now = now
        self._lock = threading.Lock()
        self._reserved: dict[str, int] = defaultdict(int)  # key_id -> most the answers in flight may cost
        self._calls: dict[str, list[float]] = defaultdict(list)

    @property
    def store(self):
        return self.api.auth.store

    def _day(self) -> int:
        return int(self.now()) // 86400

    # -- the web app (session + CSRF, behind WebApi.handle) --

    def manage(self, method: str, path: str, account: str, owner: str, body: Mapping[str, Any]) -> tuple[int, dict, dict]:
        now = int(self.now())
        if method == "GET" and path == "/api-keys":
            day = self._day()
            keys = [public_key(r, self.store.key_spent(r["key_id"], day), now) for r in self.store.api_keys(account)]
            return 200, {"keys": keys, "baseUrl": "/v1"}, {}
        self.api.keys_by_account.hit(account)
        if method == "POST" and path == "/api-keys/prepare":
            name = str(body.get("name") or "").strip()
            if not NAME.fullmatch(name):
                raise ValueError("Name the key in up to 40 letters, digits, spaces or simple punctuation.")
            daily = _usd_atomic(body.get("dailyUsd"), DEFAULT_DAILY_ATOMIC, low=10_000, high=MAX_DAILY_ATOMIC,
                                what="The daily limit")
            per = _usd_atomic(body.get("perRequestUsd"), min(DEFAULT_PER_REQUEST_ATOMIC, daily), low=1_000,
                              high=min(MAX_PER_REQUEST_ATOMIC, daily), what="The per-answer limit")
            days = body.get("days", DEFAULT_DAYS)
            if type(days) is not int or not 1 <= days <= MAX_DAYS:
                raise ValueError(f"A key lasts 1 to {MAX_DAYS} days.")
            nonce, until = secrets.token_hex(16), now + days * 86400
            message = key_message(owner, name, daily, per, until, nonce, now)
            self.store.add_nonce(nonce, owner, message, now + NONCE_SECONDS, now)
            self.store.add_key_request(nonce, account, name, daily, per, until)
            return 200, {"message": message, "chain": chain_of_account(account), "expiresAt": now + NONCE_SECONDS}, {}
        if method == "POST" and path == "/api-keys":
            message, signature = str(body.get("message") or ""), str(body.get("signature") or "")
            nonce = next((line[len("Nonce: "):] for line in message.splitlines() if line.startswith("Nonce: ")), "")
            issued = self.store.take_nonce(nonce, now) if nonce else None
            request = self.store.take_key_request(nonce) if issued is not None else None
            if issued is None or request is None or issued["message"] != message or request["account_id"] != account:
                raise WebAuthError("This key request is unknown, used or expired. Start again.")
            if issued["address"] != owner or not self.api.auth._signed_by(owner, message, signature):
                raise WebAuthError("The signature is not from this account's wallet.")
            key, row = self.store.add_api_key(account, request["name"], request["daily_cap_atomic"],
                                              request["per_request_cap_atomic"], now, request["expires_at"])
            if self.api.push is not None:
                try:
                    self.api.push.send(account, "SingIt", f'API key "{row["name"]}" was created. '
                                       "Revoke it in SingIt if this was not you.", url="/app/")
                except Exception:  # noqa: BLE001 - a notice that fails never undoes the key
                    pass
            return 200, {"key": key, **public_key(row, (0, 0), now)}, {}
        if method == "POST" and path == "/api-keys/revoke":
            if not self.store.revoke_api_key(account, str(body.get("id") or "")[:40], now):
                raise ValueError("No such live key.")
            return 200, {"ok": True, "id": body.get("id"), "state": "revoked"}, {}
        raise ValueError("No such key action.")

    # -- the public /v1, for code holding a key --

    def _key(self, authorization: str | None):
        scheme, _, token = str(authorization or "").partition(" ")
        row = self.store.api_key(token.strip(), int(self.now())) if scheme.lower() == "bearer" else None
        if row is None:
            raise ApiError(401, "Invalid or revoked API key. Create one in the SingIt app.",
                           type_="authentication_error", code="invalid_api_key")
        return row

    def _rate(self, key_id: str) -> None:
        now = self.now()
        with self._lock:
            recent = [t for t in self._calls[key_id] if t > now - 60]
            if len(recent) >= REQUESTS_PER_MINUTE:
                raise ApiError(429, f"This key sends up to {REQUESTS_PER_MINUTE} requests a minute. Slow down.",
                               type_="rate_limit_error", code="rate_limit_exceeded")
            recent.append(now)
            self._calls[key_id] = recent

    def _shop(self, action: str, account: str, body: Mapping[str, Any]) -> tuple[int, dict[str, Any]]:
        if self.api.shop is None:
            raise ApiError(503, "Answers are not enabled on this server.", type_="api_error", code="unavailable")
        return self.api.shop(action, account, body)

    def public(self, method: str, path: str, *, authorization: str | None, origin: str | None,
               body: Mapping[str, Any]) -> tuple[int, dict[str, Any], dict[str, str]]:
        if origin:
            # A key belongs in server code. A page that holds one gives it to everyone who opens it.
            raise ApiError(403, "API keys are for server code, not browsers. Keep the key out of web pages.",
                           code="browser_request")
        row = self._key(authorization)
        if method == "GET" and path == "/models":
            status, reply = self._shop("api-models", row["account_id"], {})
            if status != 200:
                raise ApiError(502, "The model list is unavailable right now.", type_="api_error")
            return 200, {"object": "list", "data": reply.get("data") or []}, {}
        if method == "POST" and path == "/chat/completions":
            return self._chat(row, body)
        raise ApiError(404, "No such endpoint. This API answers POST /v1/chat/completions and GET /v1/models.",
                       code="not_found")

    def _chat(self, row, body: Mapping[str, Any]) -> tuple[int, dict[str, Any], dict[str, str]]:
        if body.get("stream"):
            raise ApiError(400, "Streaming is not offered yet; send stream: false.", code="stream_unsupported")
        if body.get("tools") or body.get("functions"):
            raise ApiError(400, "Tools are not offered yet.", code="tools_unsupported")
        key_id, account = row["key_id"], row["account_id"]
        per, daily = int(row["per_request_cap_atomic"]), int(row["daily_cap_atomic"])
        self._rate(key_id)
        day = self._day()
        with self._lock:
            spent, _ = self.store.key_spent(key_id, day)
            if spent + self._reserved[key_id] + per > daily:
                raise ApiError(429, f"This key's daily limit of {daily / 1e6:g} USDC is used up, counting answers "
                               "still running. It starts again at 00:00 UTC, or raise it with a new key.",
                               type_="insufficient_quota", code="insufficient_quota")
            self._reserved[key_id] += per
        try:
            tokens = body.get("max_tokens", body.get("max_completion_tokens"))
            status, reply = self._shop("api-chat", account, {
                "model": body.get("model"), "messages": body.get("messages"),
                "maxTokens": tokens if type(tokens) is int else None, "limitAtomic": per})
        finally:
            with self._lock:
                self._reserved[key_id] -= per
        if status != 200:
            raise _api_error(status, reply)
        cost = reply.get("costAtomic")
        cost = cost if type(cost) is int and cost >= 0 else per  # an answer whose cost is unreadable counts in full
        self.store.record_key_spend(key_id, day, cost, int(self.now()))
        prompt, completion = int(reply.get("promptTokens") or 0), int(reply.get("completionTokens") or 0)
        model = body.get("model") if isinstance(body.get("model"), str) and body.get("model") else "singit-ask"
        tx = str(reply.get("txId") or "")
        out = {
            "id": "chatcmpl-singit-" + (tx[2:18] if tx.startswith("0x") else secrets.token_hex(8)),
            "object": "chat.completion", "created": int(self.now()), "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": reply.get("text") or ""},
                         "finish_reason": reply.get("finishReason") or "stop"}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion},
            "billing": {**(reply.get("billing") or {}), "chargedAtomic": cost, "txId": tx or None,
                        "paidFrom": "your SingIt limits"},
        }
        return 200, out, {"X-SingIt-Charged-Atomic": str(cost)}


def _api_error(status: int, reply: Mapping[str, Any]) -> ApiError:
    """The gateway's refusal, in OpenAI's shape and in the gateway's own words."""
    text = str(reply.get("text") or reply.get("message") or "The answer could not be bought. Nothing was paid.")[:500]
    error = str(reply.get("error") or "")
    if status == 404 or error == "model_not_found":
        return ApiError(404, text, code="model_not_found")
    if status == 403:  # the account's limits are not set, approved or active
        return ApiError(403, text, type_="insufficient_quota", code="limits_not_ready")
    if status == 429:
        return ApiError(429, text, type_="rate_limit_error", code="rate_limit_exceeded")
    if status == 503:
        return ApiError(503, text, type_="api_error", code="payments_paused")
    if status == 400:
        return ApiError(400, text, code=error or "refused")
    return ApiError(502, text, type_="api_error", code=error or "upstream_error")
