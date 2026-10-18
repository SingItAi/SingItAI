"""Cookieless, privacy-first product analytics: a durable `events` row in web.db, and an
optional fire-and-forget mirror to a self-hosted Umami instance.

Never raises into caller code — a broken analytics path must never break a sign-in or a
payment. Never stores a raw account_id: it is hashed with a salt (`ANALYTICS_SALT`; set one in
production, since without it the hash is still one-way but guessable from a known account_id).
Props are whitelisted: anything shaped like an address, a tx hash, an email, or a key whose name
suggests sensitive data is dropped before it reaches the events table or Umami. `client_ip` and
`user_agent` are accepted separately from props: they are forwarded to Umami only (never written
to the events table or to Umami's `data`), so a sign-in from a real browser does not collapse
into one Umami session with every other server-side event from this host's loopback address.

See docs/analytics.md for the event list and env vars.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DISABLED_ENV = "SIGN402_ANALYTICS_DISABLED"
SALT_ENV = "ANALYTICS_SALT"
UMAMI_URL_ENV = "UMAMI_URL"
UMAMI_WEBSITE_ID_ENV = "UMAMI_WEBSITE_ID"
UMAMI_HOSTNAME_ENV = "UMAMI_HOSTNAME"
DEFAULT_UMAMI_HOSTNAME = "app.singitai.app"
DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) SingItGateway/1.0"
# A short busy timeout: a locked web.db must never stall a sign-in or a payment for long.
DB_BUSY_TIMEOUT_SECONDS = 1.0
UMAMI_TIMEOUT_SECONDS = 1.0

# snake_case names only; anything else is dropped silently so a typo never raises.
KNOWN_EVENTS = frozenset({
    "landing_visit",
    "cta_open_app",
    "app_open",
    "wallet_connect",
    "sign_in",
    "limits_set",
    "approval_signed",
    "purchase_completed",
    "purchase_failed",
    "chat_answer_paid",
    "chat_message_sent",
    "revoke",
    "pause",
    "funds_added",
    "api_key_created",
    "pwa_installed",
    "push_enabled",
})

# Prop keys that are known to be safe even though a word inside them would otherwise match a
# sensitive word below (e.g. "tokens_in" contains no whole sensitive word, but is listed for
# clarity and so a future rename of the sensitive-word list cannot silently start dropping it).
_SAFE_PROP_KEYS = frozenset({
    "tokens_in", "tokens_out", "cost_usd", "amount_usd", "daily_cap_usd", "per_purchase_cap_usd",
})

# Whole snake_case words that make a prop key sensitive (matched word-by-word, not by substring,
# so "tokens_in" does not match "token" and "scopes" does not match "code").
_SENSITIVE_WORDS = frozenset({
    "address", "owner", "email", "tx", "hash", "prompt", "code", "key", "secret",
    "token", "signature", "invoice", "recipient", "phone",
})
# Compound key names that are sensitive as a whole but whose individual words are not
# (e.g. "pay" and "to" are each harmless on their own).
_SENSITIVE_EXACT_KEYS = frozenset({"pay_to"})

_EVM_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
_BASE58_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _looks_sensitive(key: str) -> bool:
    lowered = key.lower()
    if lowered in _SAFE_PROP_KEYS:
        return False
    if lowered in _SENSITIVE_EXACT_KEYS:
        return True
    return any(word in _SENSITIVE_WORDS for word in lowered.split("_"))


def looks_like_secret_value(value: str) -> bool:
    return bool(
        _EVM_ADDRESS_RE.match(value)
        or _TX_HASH_RE.match(value)
        or _EMAIL_RE.match(value)
        or _BASE58_RE.match(value)
    )


def sanitize_props(props: dict[str, Any]) -> dict[str, Any]:
    """Drop sensitive keys and address/tx/email-shaped string values; keep the rest."""
    out: dict[str, Any] = {}
    for key, value in props.items():
        if not isinstance(key, str) or _looks_sensitive(key):
            continue
        if isinstance(value, str) and looks_like_secret_value(value):
            continue
        out[key] = value
    return out


def usdc_to_usd_string(amount_atomic: int) -> str:
    """USDC atomic (1e-6) as a USD decimal string, e.g. 1234560 -> "1.23"."""
    return f"{int(amount_atomic) / 1_000_000:.2f}"


_salt_warning_lock = threading.Lock()
_salt_warned = False


def _warn_missing_salt_once() -> None:
    global _salt_warned
    with _salt_warning_lock:
        if _salt_warned:
            return
        _salt_warned = True
    logger.warning("analytics: %s is not set; uids are hashed but guessable from a known account_id", SALT_ENV)


def hash_account_id(account_id: str, salt: str | None = None) -> str:
    salt = salt if salt is not None else os.environ.get(SALT_ENV, "")
    if not salt:
        _warn_missing_salt_once()
    digest = hashlib.sha256((str(account_id) + salt).encode("utf-8")).hexdigest()
    return digest[:16]


class _EventStore:
    """Lazily creates and appends to the `events` table in web.db."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def append(self, at: int, name: str, uid: str | None, props_json: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            db = sqlite3.connect(self.path, timeout=DB_BUSY_TIMEOUT_SECONDS)
            try:
                db.execute(
                    "CREATE TABLE IF NOT EXISTS events ("
                    " id INTEGER PRIMARY KEY,"
                    " at INTEGER NOT NULL,"
                    " name TEXT NOT NULL,"
                    " uid TEXT,"
                    " props_json TEXT NOT NULL"
                    ")"
                )
                db.execute("CREATE INDEX IF NOT EXISTS events_by_name_at ON events(name, at)")
                db.execute("INSERT INTO events(at, name, uid, props_json) VALUES (?, ?, ?, ?)",
                           (at, name, uid, props_json))
                db.commit()
            finally:
                db.close()


_store_lock = threading.Lock()
_store: _EventStore | None = None
_store_path: Path | None = None


def _event_store() -> _EventStore:
    global _store, _store_path
    from .web_accounts import DEFAULT_WEB_DB, WEB_DB_ENV  # noqa: PLC0415 - avoid a module-load cycle

    path = Path(os.environ.get(WEB_DB_ENV, "") or DEFAULT_WEB_DB).expanduser()
    with _store_lock:
        if _store is None or _store_path != path:
            _store = _EventStore(path)
            _store_path = path
        return _store


def _post_to_umami(name: str, uid: str | None, props: dict[str, Any], client_ip: str | None,
                   user_agent: str | None) -> None:
    url = os.environ.get(UMAMI_URL_ENV, "").strip()
    website_id = os.environ.get(UMAMI_WEBSITE_ID_ENV, "").strip()
    if not url or not website_id:
        return
    hostname = os.environ.get(UMAMI_HOSTNAME_ENV, "").strip() or DEFAULT_UMAMI_HOSTNAME
    payload = {
        "type": "event",
        "payload": {
            "website": website_id,
            "hostname": hostname,
            "url": f"/server/{name}",
            "name": name,
            "data": {**props, **({"uid": uid} if uid else {})},
            **({"id": uid} if uid else {}),
        },
    }
    headers = {"Content-Type": "application/json", "User-Agent": user_agent or DEFAULT_USER_AGENT}
    if client_ip:
        headers["X-Forwarded-For"] = client_ip
        headers["X-Real-IP"] = client_ip
    try:
        request = urllib.request.Request(
            url.rstrip("/") + "/api/send",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        urllib.request.urlopen(request, timeout=UMAMI_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 - analytics must never raise into a payment path
        logger.debug("analytics: umami send for %s failed: %s", name, exc)


def _umami_configured() -> bool:
    return bool(os.environ.get(UMAMI_URL_ENV, "").strip()) and bool(os.environ.get(UMAMI_WEBSITE_ID_ENV, "").strip())


def emit(name: str, account_id: str | None = None, *, client_ip: str | None = None,
        user_agent: str | None = None, **props: Any) -> None:
    """Record a product analytics event. Never raises; never stores a raw account_id.

    `client_ip` and `user_agent` are forwarded to Umami only (as request headers, never as
    stored props) and are never passed by payment-internal code — only by request handlers
    that already have them, such as the sign-in route.
    """
    try:
        if os.environ.get(DISABLED_ENV, "") == "1":
            return
        if name not in KNOWN_EVENTS:
            logger.debug("analytics: dropping unknown event %r", name)
            return
        uid = hash_account_id(account_id) if account_id else None
        clean = sanitize_props(props)
        at = int(time.time())
        try:
            _event_store().append(at, name, uid, json.dumps(clean, sort_keys=True))
        except Exception as exc:  # noqa: BLE001
            logger.warning("analytics: failed to record event %r: %s", name, exc)
        if _umami_configured():
            threading.Thread(target=_post_to_umami, args=(name, uid, clean, client_ip, user_agent),
                             daemon=True).start()
    except Exception as exc:  # noqa: BLE001 - emit() must never raise into caller code
        logger.warning("analytics: emit(%r) failed: %s", name, exc)
