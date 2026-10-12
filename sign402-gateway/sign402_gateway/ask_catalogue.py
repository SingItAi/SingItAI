"""The models SingIt Ask can answer from, and the most one answer from each can cost.

The list is Surplus's own, relayed by the Ask service (GET /v1/models, free). A hand-kept copy of 400 models
would be stale the day a seller adds one. The ceiling here is this gateway's own estimate of what the merchant
will offer: it is what the payer's limits are checked against and what the merchant's offer may not exceed, so
the gateway never has to trust the merchant's number.
"""
import json
import logging
import threading
import time
import urllib.request

logger = logging.getLogger(__name__)

URL = "https://ask.singitai.app/v1/models"
# The merchant sits behind Cloudflare, which refuses urllib's default agent (403) while answering curl.
USER_AGENT = "SingIt-Gateway/1.0 (+https://singitai.app)"
TTL_SECONDS = 10 * 60  # the expected prices in the list move; the ceiling uses the list prices and does not
THINKING_HEADROOM = 1000  # the same allowance the merchant counts as billable (singit-ask/src/limits.mjs)
STANDING_CAP = 3000       # no answer is ever authorized for less
MARGIN_PERCENT = 1        # the merchant works from exact per-token prices; this covers rounding between us
PREFIX = "ask:"

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "models": None}
_state: dict = {"default": None, "loading": False}  # the merchant's default model id, as of the last list read


def _fetch() -> list[dict]:
    request = urllib.request.Request(URL, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=10) as response:
        data = json.loads(response.read(8_000_000))
    models = []
    _state["default"] = data.get("default") if isinstance(data.get("default"), str) else None
    for entry in data.get("data") or []:
        price = entry.get("usdPerMillionTokens") or {}
        try:
            model = {"id": str(entry["id"]), "label": str(entry.get("name") or entry["id"]),
                     "provider": str(entry.get("owned_by") or ""), "input": float(price["input"]),
                     "output": float(price["output"]), "expected": None}
            # What an answer is expected to cost: learnt from the merchant's own paid answers, or what trusted
            # sellers ask until then. Not the marketplace's best offer, which answers rarely reach.
            expected = entry.get("expectedUsdPerMillionTokens")
            if isinstance(expected, dict) and float(expected["input"]) >= 0 and float(expected["output"]) >= 0:
                model["expected"] = {"input": float(expected["input"]), "output": float(expected["output"]),
                                     "basis": str(expected.get("basis") or "")}
        except (KeyError, TypeError, ValueError):
            continue  # the standing "singit-ask" entry carries no prices, and is not a choice of its own
        if model["input"] >= 0 and model["output"] >= 0:
            models.append(model)
    return models


def _spawn(work) -> None:
    threading.Thread(target=work, daemon=True, name="ask-model-list").start()


def _reload(now, fetch) -> None:
    """Read the list and keep it only if it came back with models: a failed refresh keeps the last good one."""
    try:
        fresh = (fetch or _fetch)()
        if fresh:
            with _lock:
                _cache.update(at=now(), models=sorted(fresh, key=lambda m: m["output"]))
    except (OSError, ValueError) as error:
        # Say why: an empty picker is otherwise indistinguishable from a model list that is empty.
        logger.warning("SingIt Ask model list unavailable (%s)", type(error).__name__)
    finally:
        with _lock:
            _state["loading"] = False


def models(now=time.time, fetch=None) -> list[dict]:
    """Every model that can be asked for, cheapest answer first, ready at once. The list changes slowly and
    its live prices a little faster, and reading it takes a request: so what is cached is served even when it
    is old, and one refresh at a time runs in the background. Only the very first read waits."""
    with _lock:
        have = _cache["models"] is not None
        if have and now() - _cache["at"] < TTL_SECONDS:
            return list(_cache["models"])
        if have and _state["loading"]:
            return list(_cache["models"])
        _state["loading"] = True
        refresh_in_background = have
    if refresh_in_background:
        _spawn(lambda: _reload(now, fetch))
    else:
        _reload(now, fetch)
    with _lock:
        return list(_cache["models"] or [])


def default_id() -> str | None:
    models()
    return _state["default"]


def resolve(model_id: str, **kwargs) -> dict | None:
    return next((m for m in models(**kwargs) if m["id"] == model_id), None)


def ceiling(model: dict, chars: int, max_tokens: int, *, markup_bps: int, fee: int) -> int:
    """The most one answer can cost, in USDC micro-units: the model's worst case for this question and answer
    size, plus the markup and the fee. Input counts one token per character, the output its whole budget with
    thinking headroom. USD per million tokens times tokens is micro-USD."""
    worst = -int(-((chars * model["input"] + (max_tokens + THINKING_HEADROOM) * model["output"])
                   * (100 + MARGIN_PERCENT)) // 100)
    return max(STANDING_CAP, worst + (worst * markup_bps + 9999) // 10000 + fee)
