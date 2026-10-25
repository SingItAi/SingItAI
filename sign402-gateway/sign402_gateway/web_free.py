"""Free answers for signed-in wallets: a chat model asked for as "free/<id>" on the API-key /v1 is answered at no
charge, within small daily limits per account (wallet), per client network and for everyone together.

OFF unless SIGN402_WEB_FREE_MODELS names models, and only when the universal /v1 has its Surplus key (the upstream
a free answer uses; SingIt Ask's own free route would count every gateway user as one visitor). A free answer
never touches the key's limits, the balance or the per-minute rate of ApiKeys, and is never charged. Counters are in
memory: a restart starts the day's counts again, which can give out at most one more day's allowance, and the daily
ceiling keeps that small.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict
from ipaddress import IPv6Address, ip_address
from typing import Any, Callable, Mapping

from .web_ask import _api_messages

logger = logging.getLogger(__name__)

PREFIX = "free/"
DEFAULT_PER_ACCOUNT = 20
DEFAULT_PER_NETWORK = 40
DEFAULT_PER_DAY = 1_000
DEFAULT_MAX_TOKENS = 400
MAX_CHARS = 4_000  # the question, as singit-ask's free route keeps it
READ_LIMIT = 2_000_000


def network_of(address: str | None) -> str:
    """The network an address is counted in: its IPv4 /24 or IPv6 /64 (an IPv4-mapped IPv6 address counts as that
    IPv4 address), so rotating addresses inside one subnet does not multiply the allowance. Anything that is not
    an address is its own bucket text; none at all is "unknown"."""
    text = str(address or "").strip().strip("[]").split("%")[0]
    try:
        ip = ip_address(text)
    except ValueError:
        return text or "unknown"
    if isinstance(ip, IPv6Address):
        if ip.ipv4_mapped is None:
            return ":".join(f"{(int(ip) >> (112 - 16 * i)) & 0xFFFF:x}" for i in range(4)) + "::/64"
        ip = ip.ipv4_mapped
    octets = str(ip).split(".")
    return ".".join(octets[:3]) + ".0/24"


def _seconds_to_midnight(now: float) -> int:
    return int(86400 - now % 86400) + 1


class FreeModels:
    def __init__(self, models: list[str], upstream: Any, *, per_account: int = DEFAULT_PER_ACCOUNT,
                 per_network: int = DEFAULT_PER_NETWORK, per_day: int = DEFAULT_PER_DAY,
                 max_tokens: int = DEFAULT_MAX_TOKENS, now: Callable[[], float] = time.time):
        self.models, self.upstream = list(models), upstream
        self.per_account, self.per_network, self.per_day, self.max_tokens = per_account, per_network, per_day, max_tokens
        self.now = now
        self._lock = threading.Lock()
        self._day = int(now()) // 86400
        self._accounts: dict[str, int] = defaultdict(int)
        self._networks: dict[str, int] = defaultdict(int)
        self._total = 0

    @property
    def limits(self) -> dict[str, int]:
        return {"perAccountPerDay": self.per_account, "perNetworkPerDay": self.per_network,
                "maxTokens": self.max_tokens, "maxChars": MAX_CHARS}

    def listing(self) -> list[dict[str, Any]]:
        """The /v1/models entries, next to the paid ones."""
        return [{"id": PREFIX + m, "object": "model", "owned_by": "singit", "free": True, "limits": self.limits}
                for m in self.models]

    def asks(self, model: Any) -> bool:
        return isinstance(model, str) and model.startswith(PREFIX)

    def _roll(self) -> None:
        today = int(self.now()) // 86400
        if today != self._day:
            self._day, self._total = today, 0
            self._accounts, self._networks = defaultdict(int), defaultdict(int)

    def _take(self, account: str, network: str, error: type) -> int:
        """One free answer for this account and network, or a 429 with Retry-After. Returns what is left today."""
        with self._lock:
            self._roll()
            reason = None
            if self._accounts[account] >= self.per_account:
                reason = "That is today's free answers for this account."
            elif self._networks[network] >= self.per_network:
                reason = "That is today's free answers from this network."
            elif self._total >= self.per_day:
                reason = "Today's free answers are used up."
            if reason:
                raise error(429, f"{reason} Use a paid model instead, or come back tomorrow (UTC).",
                            type_="rate_limit_error", code="free_limit_reached",
                            retry_after=_seconds_to_midnight(self.now()))
            self._accounts[account] += 1
            self._networks[network] += 1
            self._total += 1
            return self.per_account - self._accounts[account]

    def _give_back(self, account: str, network: str) -> None:
        with self._lock:
            self._roll()
            self._accounts[account] = max(0, self._accounts[account] - 1)
            self._networks[network] = max(0, self._networks[network] - 1)
            self._total = max(0, self._total - 1)

    def answer(self, row: Mapping[str, Any], body: Mapping[str, Any], client: str, error: type) -> tuple[int, dict[str, Any], dict[str, str]]:
        """One free answer for the key's account. `error` is ApiError: a refusal costs nothing and spends nothing."""
        if body.get("tools") or body.get("functions"):
            raise error(400, "Tools are not offered yet.", code="tools_unsupported")
        model = str(body.get("model"))[len(PREFIX):]
        if model not in self.models:
            raise error(404, "Free answers come from " + ", ".join(PREFIX + m for m in self.models) + ".",
                        code="model_not_found")
        try:
            messages = _api_messages(body.get("messages"))
        except ValueError as exc:
            raise error(400, str(exc), code="invalid_messages") from None
        if sum(len(m["content"].encode("utf-16-le")) // 2 for m in messages) > MAX_CHARS:
            raise error(400, f"Keep a free question under {MAX_CHARS} characters.", code="too_long")
        asked = body.get("max_tokens", body.get("max_completion_tokens"))
        tokens = min(asked if type(asked) is int and asked > 0 else self.max_tokens, self.max_tokens)
        account, network = str(row["account_id"]), network_of(client)
        left = self._take(account, network, error)
        started = self.now()
        try:
            data = self._ask(model, messages, tokens)
            text = data["choices"][0]["message"]["content"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("no text")
        except Exception as exc:  # noqa: BLE001 - nothing came back: not counted, nothing is owed
            self._give_back(account, network)
            logger.warning("web free: no answer from %s (%s)", model, type(exc).__name__)
            raise error(502, "No answer came back. Try again.", type_="api_error", code="upstream_error") from None
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        logger.info("web free: answer from %s for %s (%s micro-USD at cost)", model, account,
                    usage.get("buyer_cost_micro", "unknown"))
        out = {"id": f"chatcmpl-singit-free-{int(started * 1000)}", "object": "chat.completion",
               "created": int(started), "model": PREFIX + model,
               "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                            "finish_reason": data["choices"][0].get("finish_reason") or "stop"}],
               "usage": {k: usage.get(k, 0) for k in ("prompt_tokens", "completion_tokens", "total_tokens")},
               "billing": {"free": True, "chargedAtomic": 0, "paidFrom": "nothing: free answer"}}
        return 200, out, {"X-SingIt-Free": "true", "X-SingIt-Free-Remaining": str(left)}

    def _ask(self, model: str, messages: list[dict[str, str]], tokens: int) -> dict[str, Any]:
        request = {"model": model, "messages": messages, "max_tokens": tokens, "temperature": 0.4,
                   "reasoning_effort": "none", "si_route": {"objective": "price"}}
        response = self.upstream.send("/v1/chat/completions", request, {})
        with response:
            status = response.status if hasattr(response, "status") else response.code
            data = json.loads(response.read(READ_LIMIT))
        if status == 400 and "reasoning" in json.dumps(data).lower():
            # Some sellers refuse to switch thinking off; asked once more with as little as they allow.
            response = self.upstream.send("/v1/chat/completions", {**request, "reasoning_effort": "low"}, {})
            with response:
                status = response.status if hasattr(response, "status") else response.code
                data = json.loads(response.read(READ_LIMIT))
        if status != 200 or not isinstance(data, dict):
            raise ValueError(f"upstream HTTP {status}")
        return data
