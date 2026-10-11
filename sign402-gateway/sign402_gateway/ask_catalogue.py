"""The models SingIt Ask can answer from, and the most one answer from each can cost.

The list is Surplus's own, relayed by the Ask service (GET /v1/models, free). A hand-kept copy of 400 models
would be stale the day a seller adds one. The ceiling here is this gateway's own estimate of what the merchant
will offer: it is what the payer's limits are checked against and what the merchant's offer may not exceed, so
the gateway never has to trust the merchant's number.
"""
import json
import threading
import time
import urllib.request

URL = "https://ask.singitai.app/v1/models"
TTL_SECONDS = 6 * 60 * 60
THINKING_HEADROOM = 1000  # the same allowance the merchant counts as billable (singit-ask/src/limits.mjs)
STANDING_CAP = 3000       # no answer is ever authorized for less
MARGIN_PERCENT = 1        # the merchant works from exact per-token prices; this covers rounding between us
PREFIX = "ask:"

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "models": None}


def _fetch() -> list[dict]:
    request = urllib.request.Request(URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        data = json.loads(response.read(8_000_000))
    models = []
    for entry in data.get("data") or []:
        price = entry.get("usdPerMillionTokens") or {}
        try:
            model = {"id": str(entry["id"]), "label": str(entry.get("name") or entry["id"]),
                     "provider": str(entry.get("owned_by") or ""), "input": float(price["input"]),
                     "output": float(price["output"])}
        except (KeyError, TypeError, ValueError):
            continue  # the standing "singit-ask" entry carries no prices, and is not a choice of its own
        if model["input"] >= 0 and model["output"] >= 0:
            models.append(model)
    return models


def models(now=time.time, fetch=None) -> list[dict]:
    """Every model that can be asked for, cheapest answer first. The last good list survives a failed refresh."""
    with _lock:
        if _cache["models"] is None or now() - _cache["at"] >= TTL_SECONDS:
            try:
                fresh = (fetch or _fetch)()
                if fresh:
                    _cache.update(at=now(), models=sorted(fresh, key=lambda m: m["output"]))
            except (OSError, ValueError):
                pass
        return list(_cache["models"] or [])


def resolve(model_id: str, **kwargs) -> dict | None:
    return next((m for m in models(**kwargs) if m["id"] == model_id), None)


def ceiling(model: dict, chars: int, max_tokens: int, *, markup_bps: int, fee: int) -> int:
    """The most one answer can cost, in USDC micro-units: the model's worst case for this question and answer
    size, plus the markup and the fee. Input counts one token per character, the output its whole budget with
    thinking headroom. USD per million tokens times tokens is micro-USD."""
    worst = -int(-((chars * model["input"] + (max_tokens + THINKING_HEADROOM) * model["output"])
                   * (100 + MARGIN_PERCENT)) // 100)
    return max(STANDING_CAP, worst + (worst * markup_bps + 9999) // 10000 + fee)
