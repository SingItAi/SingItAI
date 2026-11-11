"""SINGIT holders on Base get a higher daily limit at the top tier.

The tiers are the ones singit-ask quotes discounts for (SINGIT_ASK_HOLDER_TIERS; here SIGN402_HOLDER_TIERS first, then
that name, then the documented defaults): the tier marked `+daily` raises the daily limits below. The balance is
min(now, about a day ago) and unknown means not a holder, so a failing RPC can never raise a limit.

  SIGN402_HOLDER_TOP_MAX_DAILY_ATOMIC       the largest daily cap an API key may be given (default: twice MAX_DAILY_ATOMIC)
  SIGN402_HOLDER_TOP_CEILING_DAILY_ATOMIC   the operator's daily ceiling for user wallets (default: twice
                                            SIGN402_USER_WALLET_CEILING_DAILY_ATOMIC; unset ceiling stays unset)

The exact numbers are an open product decision; the defaults only give the doubling that was proposed.
Nothing here logs an address or a balance.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Mapping
from typing import Any

from .base_balances import (
    DEFAULT_HOLDER_TIERS,
    DEFAULT_SINGIT_TOKEN_ADDRESS,
    HolderBalanceReader,
    JsonRpcClient,
    _validate_rpc_url,
    parse_holder_tiers,
)

logger = logging.getLogger(__name__)

_ACCOUNT_PREFIX = "wallet:"
_reader: HolderBalanceReader | None = None
_reader_built = False
_top_min_tokens: int | None = None
_lock = threading.Lock()


def top_tier_min_tokens(env: Mapping[str, str]) -> int | None:
    """Whole tokens of the tier marked `+daily` (the last one if several), or None when no tier raises the limit."""
    text = str(env.get("SIGN402_HOLDER_TIERS") or env.get("SINGIT_ASK_HOLDER_TIERS") or "").strip() or DEFAULT_HOLDER_TIERS
    try:
        tiers = parse_holder_tiers(text)
    except ValueError:
        logger.warning("holder tiers ignored, using the defaults")
        tiers = parse_holder_tiers(DEFAULT_HOLDER_TIERS)
    raising = [minimum for minimum, _bps, daily in tiers if daily]
    return raising[-1] if raising else None


def build_holder_reader_from_env(env: Mapping[str, str]) -> HolderBalanceReader | None:
    rpc_url = str(env.get("SIGN402_BASE_RPC_URL", "") or "").strip()
    if not rpc_url:
        return None
    try:
        _validate_rpc_url(rpc_url)
        token = str(
            env.get("SIGN402_SINGIT_TOKEN_ADDRESS", "") or DEFAULT_SINGIT_TOKEN_ADDRESS
        ).strip()
        return HolderBalanceReader(rpc=JsonRpcClient(endpoint_url=rpc_url, timeout=3.0), token_address=token)
    except Exception:  # noqa: BLE001 - a bad config means no raised limits, not a failing gateway
        logger.warning("holder balance reader disabled: bad RPC or token configuration")
        return None


def holder_reader() -> HolderBalanceReader | None:
    global _reader, _reader_built, _top_min_tokens
    with _lock:
        if not _reader_built:
            _reader = build_holder_reader_from_env(os.environ)
            _top_min_tokens = top_tier_min_tokens(os.environ)
            _reader_built = True
        return _reader


def set_holder_reader(reader: HolderBalanceReader | Any | None, top_min_tokens: int | None = 150_000_000) -> None:
    """Install a reader (tests, or a gateway that builds its own)."""
    global _reader, _reader_built, _top_min_tokens
    with _lock:
        _reader, _reader_built, _top_min_tokens = reader, True, top_min_tokens


def is_top_holder(address: object) -> bool:
    """True only when the address's effective balance reaches the `+daily` tier. Never raises."""
    try:
        reader = holder_reader()
        if reader is None or _top_min_tokens is None:
            return False
        return bool(reader.holds_at_least(address, _top_min_tokens))
    except Exception:  # noqa: BLE001
        return False


def _env_atomic(name: str) -> int | None:
    raw = str(os.environ.get(name, "") or "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def raised_max_daily_atomic(address: object, standard: int) -> int:
    """The largest daily cap an API key may be given to this owner."""
    if not is_top_holder(address):
        return standard
    return max(standard, _env_atomic("SIGN402_HOLDER_TOP_MAX_DAILY_ATOMIC") or standard * 2)


def raised_ceiling_daily_atomic(address: object, standard: int | None) -> int | None:
    """The operator's daily ceiling for a user wallet; no ceiling stays no ceiling."""
    if standard is None or not is_top_holder(address):
        return standard
    return max(standard, _env_atomic("SIGN402_HOLDER_TOP_CEILING_DAILY_ATOMIC") or standard * 2)


def base_address_of(server: Any, user_id: object) -> str | None:
    """The Base address behind a spending-limit key: a web account (`wallet:0x…`), an owner address or a Telegram user's wallet."""
    text = str(user_id or "")
    if text.startswith(_ACCOUNT_PREFIX):
        text = text[len(_ACCOUNT_PREFIX):]
    if text.startswith("0x") and len(text) == 42:
        return text
    try:
        row = server.user_wallet_service.store.get_wallet_by_telegram_user_id(text, chain="base")
        address = (row or {}).get("wallet_address")
        return str(address) if address else None
    except Exception:  # noqa: BLE001
        return None
