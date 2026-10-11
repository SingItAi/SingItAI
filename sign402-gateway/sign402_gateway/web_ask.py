"""SingIt Ask: one x402 payment per answer, signed by the account's own network agent.

Opt-in through the existing model picker. No prepaid chat credit, manual wallet
signature or new wallet is involved. Solana pays the measured cost directly from the owner account with its delegate.
"""
from typing import Any

from .agent_allowance import AllowanceError, AllowanceUnavailable
from . import ask_catalogue, ask_metered, ask_solana

MODEL = "singit-ask"
LABEL = "DeepSeek V4.1 Flash · SingIt Ask"
URL = ask_metered.URL
PRICE = ask_metered.CAP


def is_ask(model_id: Any) -> bool:
    """SingIt Ask's own default, or any model Surplus sells, asked for as "ask:<its id>"."""
    return model_id == MODEL or (isinstance(model_id, str) and model_id.startswith(ask_catalogue.PREFIX))


def current(server: Any, account: str) -> str:
    """The Ask model this account talks to: the default, or "ask:<id>"."""
    base = getattr(server, "chat_service", None)
    chosen = base.store.get_session("ask-web:" + account).model if base is not None else ""
    return chosen if is_ask(chosen) else MODEL


def selected(server: Any, account: str) -> bool:
    """SingIt Ask answers unless the account chose a Venice model: the private mode, behind the lock."""
    base = getattr(server, "chat_service", None)
    if base is None or not account.startswith(("wallet:", "solana:")):
        return False
    chosen = base.store.get_session("ask-web:" + account).model
    # Choosing Venice records its model and clears this one; nothing chosen yet is SingIt Ask.
    return is_ask(chosen) or (not chosen and not base.store.get_session(account).model)


def _described(model_id: str) -> tuple[str, str | None, dict | None]:
    """(label, the id Surplus knows it by, its prices) for a chosen model. The default has no id of its own."""
    if model_id == MODEL:
        return LABEL, None, None
    found = ask_catalogue.resolve(model_id[len(ask_catalogue.PREFIX):])
    if found is None:
        raise AllowanceUnavailable("That model is not available right now. Pick another; nothing was paid.")
    return f"{found['label']} · SingIt Ask", found["id"], found


def choose(server: Any, account: str, model_id: Any = MODEL) -> tuple[int, dict[str, Any]]:
    if not account.startswith(("wallet:", "solana:")):
        raise AllowanceUnavailable("A supported Base or Solana account is required.")
    base = getattr(server, "chat_service", None)
    if base is None:
        raise AllowanceUnavailable("Chat is not configured on this server.")
    if not is_ask(model_id):
        raise AllowanceUnavailable("That model is not available.")
    label, _, _ = _described(model_id)  # unknown ids are refused here, before anything is recorded
    # Keep the linked Telegram/Venice model intact: this adapter belongs to the web chat.
    base.store.set_model("ask-web:" + account, model_id)
    return 200, {"ok": True, "chosen": model_id, "label": label, "provider": "SingIt Ask"}


def listing(result: dict[str, Any], account: str) -> dict[str, Any]:
    if account.startswith(("wallet:", "solana:")):
        fee = "0.001"
        entries = [{
            "id": MODEL, "label": LABEL, "provider": "SingIt Ask",
            "blurb": f"Actual token cost + 30% + {fee} USDC settlement fee. Up to 0.003 per answer; Solana charges your wallet directly, with no agent SOL top-up.",
            "billingMode": "actual_usage", "markupPercent": 30, "settlementFeeUsd": fee, "maxChargeUsd": "0.003", "tags": ["x402"],
        }]
        # Every other model Surplus sells. A dearer model is authorized for more per answer, then charged for
        # what the answer actually cost: the ceiling is only the most it can be.
        for m in ask_catalogue.models():
            entries.append({
                "id": ask_catalogue.PREFIX + m["id"], "label": m["label"], "provider": m["provider"] or "SingIt Ask",
                "blurb": f"Actual token cost + 30% + {fee} USDC settlement fee, paid per answer.",
                "inputUsdPerMTok": m["input"], "outputUsdPerMTok": m["output"],
                "billingMode": "actual_usage", "markupPercent": 30, "settlementFeeUsd": fee, "tags": ["x402"],
            })
        result["models"][:0] = entries
        result["categories"].insert(0, {"key": "x402", "label": "Pay per answer"})
    result["provider"] = "SingIt Ask" if is_ask(result["chosen"]) else "Venice"
    if is_ask(result["chosen"]):
        result["chosenLabel"] = next((m["label"] for m in result["models"] if m["id"] == result["chosen"]), LABEL)
    return result


MAX_TOKENS = 1200
MIN_TOKENS = 200  # shorter than this is no answer worth paying for; the refusal then names what it would take


def _per_answer_limit(server: Any, account: str) -> int | None:
    """The most this account's own limits let one answer be authorized for, or None when they cannot be read."""
    try:
        if account.startswith("solana:"):
            lane = getattr(server, "solana_allowance", None)
            limits = lane.store.limits(account) if lane is not None else None
            return min(int(limits["per_purchase_cap"]), int(lane.max_per_purchase)) if limits else None
        active = server.allowance.lane_for(account)
        return int(active["per_purchase_cap"]) if active is not None else None
    except Exception:  # noqa: BLE001 - the payment path will refuse with its own reason
        return None


def _fit_tokens(ceiling: Any, limit: int | None) -> int:
    """The longest answer whose ceiling fits the account's limit, so a dear model answers shorter instead of
    being refused. The ceiling grows with the answer, hence a plain search."""
    if limit is None or ceiling(MAX_TOKENS) <= limit:
        return MAX_TOKENS
    low, high = MIN_TOKENS, MAX_TOKENS
    if ceiling(low) > limit:
        return MIN_TOKENS
    while low < high:
        mid = (low + high + 1) // 2
        low, high = (mid, high) if ceiling(mid) <= limit else (low, mid - 1)
    return low


def require_payment_ready(server: Any, gw: Any, account: str) -> None:
    """Do not buy more search data while the selected answer model is blocked.

    A previous payment that the chain can settle up is settled up first, so it blocks only while it cannot.
    """
    if account.startswith("solana:"):
        ask_solana.recover(server, account)
    elif account.startswith("wallet:"):
        ask_metered.recover(server, gw, account)


def usage(account: str = "") -> tuple[int, dict[str, Any]]:
    return 200, {"ok": True, "model": MODEL, "modelLabel": LABEL, "billingMode": "actual_usage",
                 "maxChargeAtomic": PRICE, "markupPercent": 30, "settlementFeeAtomic": 1000, "creditAtomic": None, "topUps": []}


def _payment_context(messages: list[dict[str, str]], account: str, label: str = LABEL) -> list[dict[str, str]]:
    """Authoritative provider/network context, kept even when old turns are trimmed."""
    common = (
        f"Current selected chat service: {label.removesuffix(' · SingIt Ask')} via SingIt Ask. "
        "Each answer uses x402 automatically within the approved limits: actual model cost + 30% + "
        "0.001 USDC, never more than the ceiling authorized for that answer. This is not Venice credit or a prepaid chat balance. "
        "Do not infer payment failure or request an agent top-up from old assistant messages or an "
        "internal float balance. Only actual operation results can establish a payment problem. "
        "A greeting needs a brief greeting, not an unsolicited wallet status or funding checklist. "
    )
    if account.startswith("solana:"):
        payment = (
            "The connected network is Solana. For SingIt Ask the existing SPL delegate pays USDC "
            "directly from the user's wallet to the merchant; Coinbase CDP pays transaction fees. "
            "Zero USDC or SOL on the agent is normal and does not block Ask. No agent SOL top-up, "
            "agent token account or Agent funds step is needed for this chat. SOL in the user's own "
            "wallet is needed only for wallet actions they sign, such as approving/revoking the grant. "
            "Do not extend Ask's payment rules to every other purchase; those use their own quotes/checks."
        )
    else:
        payment = (
            "The connected network is Base. The existing limiter funds the agent automatically "
            "when necessary; CDP settles the actual chat invoice. The legacy funding leg can use "
            "operator-funded ETH, so do not claim every Base network cost is recovered from the user. "
            "Do not tell a Base user to add SOL."
        )
    out = [dict(m) for m in messages]
    instruction = "\n\nCurrent payment configuration (supersedes older funding advice): " + common + payment
    if out and out[0]["role"] == "system":
        out[0]["content"] += instruction
    else:
        out.insert(0, {"role": "system", "content": instruction.strip()})
    while len(out) > 40:
        out.pop(1)
    return out


def chat(server: Any, gw: Any, account: str, raw_messages: Any, context: Any = None) -> tuple[int, dict[str, Any]]:
    from .web_internal import _limits_from_limiter
    from .web_venice import _messages, _with_data

    if not account.startswith(("wallet:", "solana:")):
        raise AllowanceUnavailable("Unsupported account network. No payment was attempted.")
    if getattr(gw, "_purchases_paused", lambda: False)():
        raise AllowanceUnavailable("Payments are paused. No payment was attempted.")
    messages = _payment_context(_with_data(_messages(raw_messages), context), account,
                                _described(current(server, account))[0])
    # Match the merchant's 24,000 UTF-16 code-unit limit before any payment.
    def size() -> int:
        return sum(len(m["content"].encode("utf-16-le")) // 2 for m in messages)
    while size() > 24000 and len(messages) > 2:
        messages.pop(1 if messages[0]["role"] == "system" else 0)
    if size() > 24000:
        raise ValueError("This question is too long for SingIt Ask. Shorten it and try again; nothing was paid.")
    if not account.startswith("solana:"):
        _limits_from_limiter(server, gw, account)
    gw._enforce_user_purchase_rate(account)
    server.user_event_store.preflight_write()
    payer = ask_solana if account.startswith("solana:") else ask_metered
    label, surplus_id, info = _described(current(server, account))
    max_tokens = MAX_TOKENS
    kwargs: dict[str, Any] = {}
    if info is not None:
        chars = sum(len(m["content"].encode("utf-16-le")) // 2 for m in messages)
        def ceiling(tokens: int) -> int:
            return ask_catalogue.ceiling(info, chars, tokens, markup_bps=ask_metered.MARKUP_BPS, fee=ask_metered.FEE)
        max_tokens = _fit_tokens(ceiling, _per_answer_limit(server, account))
        kwargs["cap"] = ceiling(max_tokens)
    amount, data, tx = payer.pay(server, gw, account,
                                {"model": surplus_id or MODEL, "messages": messages, "max_tokens": max_tokens}, **kwargs)
    # Never retry a paid request on a missing or malformed answer.
    choices = data.get("choices") if isinstance(data, dict) else None
    first = choices[0] if isinstance(choices, list) and choices else None
    message = first.get("message") if isinstance(first, dict) else None
    text = message.get("content") if isinstance(message, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise AllowanceError("The paid response contained no answer. Do not pay again until its settlement is checked.")
    used = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    def tokens(key: str) -> int:
        value = used.get(key)
        return value if type(value) is int and value >= 0 else 0
    return 200, {"ok": True, "text": text, "model": current(server, account), "modelLabel": label,
                 "costAtomic": amount, "billingMode": "actual_usage", "billing": data.get("billing"), "txId": tx,
                 "promptTokens": tokens("prompt_tokens"), "completionTokens": tokens("completion_tokens")}
