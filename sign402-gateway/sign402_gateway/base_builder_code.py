"""Base Builder Code attribution (ERC-8021).

A short suffix appended to the calldata of Base transactions this service
sends. Contracts ignore trailing bytes past their ABI-decoded input, and
offchain indexers (base.dev) read the suffix back out, attributing the
transaction's activity to this app for the Base Builder Grant. Costs 16 gas
per non-zero byte, which must be included in any gas estimate taken after
the suffix is appended.

Set SIGN402_BASE_BUILDER_CODE to the code from base.dev > Settings > Project
Settings > Builder Code (e.g. "bc_xxxxxxxx"). Unset or invalid means no
suffix and no change in behaviour anywhere — attribution is a reporting
nicety and must never block or alter a payment.

Byte layout (ERC-8021 schema 0, one code), matching ox's
`Attribution.toDataSuffix({ codes: [code] })`:

    ascii(code) + bytes([len(code)]) + b"\\x00" + MAGIC_TAIL

MAGIC_TAIL is the fixed 16-byte tail `80218021802180218021802180218021`.
"""

from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

ENV_VAR = "SIGN402_BASE_BUILDER_CODE"

BASE_MAINNET_CHAIN_ID = 8453
BASE_SEPOLIA_CHAIN_ID = 84532
BASE_CHAIN_IDS = frozenset((BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID))

_SCHEMA_ID_BYTE = b"\x00"
_MAGIC_TAIL = bytes.fromhex("80218021802180218021802180218021")
_CODE_PATTERN = re.compile(r"^[a-z0-9_]{1,32}$")


def _valid_code(code: str) -> bool:
    return bool(_CODE_PATTERN.match(code))


def encode_data_suffix(code: str) -> bytes:
    """The ERC-8021 schema-0 data suffix for one builder code.

    Caller must validate `code` first (see `_valid_code`); this just encodes.
    """
    encoded = code.encode("ascii")
    return encoded + bytes([len(encoded)]) + _SCHEMA_ID_BYTE + _MAGIC_TAIL


def load_data_suffix(env: "os._Environ[str] | None" = None) -> bytes | None:
    """The configured data suffix, or None if attribution is disabled.

    Disabled whenever SIGN402_BASE_BUILDER_CODE is unset/empty, or set to a
    value outside the allowed charset ([a-z0-9_]) or length (1..32) — in
    which case this logs a warning and returns None rather than raising,
    since attribution must never block a payment.
    """
    source = env if env is not None else os.environ
    code = (source.get(ENV_VAR) or "").strip()
    if not code:
        return None
    if not _valid_code(code):
        logger.warning(
            "%s is set but not a valid builder code (expected 1-32 chars of "
            "[a-z0-9_]); attribution disabled.",
            ENV_VAR,
        )
        return None
    return encode_data_suffix(code)


def append_suffix(data: str, *, chain_id: int, suffix: bytes | None) -> str:
    """`data` with the builder-code suffix appended, as a 0x-hex string.

    A no-op (returns `data` unchanged) unless `suffix` is configured and
    `chain_id` is Base mainnet or Base Sepolia — other chains are completely
    unaffected. `data` may be "0x" (a plain value transfer), in which case
    the result is suffix-only, matching how the suffix is appended to a
    native send on the JS side.
    """
    if not suffix or chain_id not in BASE_CHAIN_IDS:
        return data
    body = (data or "0x").removeprefix("0x")
    # Idempotent: callers may run both a quote and a send over the same
    # logical calldata, each appending independently. Appending twice would
    # double-charge gas and emit two attribution suffixes, so a calldata that
    # already ends with the suffix is left alone.
    if body.lower().endswith(suffix.hex()):
        return "0x" + body
    return "0x" + body + suffix.hex()
