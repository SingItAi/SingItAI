#!/usr/bin/env python3
"""A day's SingIt metrics, read straight from the gateway's SQLite stores.

Read-only: every database is opened with `file:PATH?mode=ro` (see
`scripts/sign402-operator.py`'s `_connect_readonly`), so this can run on the live VPS beside the
gateway without risking its state. A missing database, or a table that is not there yet on an
older deploy, is reported as `null` rather than crashing the whole run. Output is aggregate
counts and sums only — no wallet address or account id is ever printed.

    python scripts/daily-metrics.py --day 2026-10-17
    python scripts/daily-metrics.py --out ~/.sign402/metrics          # writes DIR/YYYY-MM-DD.json
    python scripts/daily-metrics.py --text                           # a ~10-line summary too

Own and test accounts can be left out of every events-based count (sign-ins, pauses, the `mcp` section):
list their uid hashes (the `uid` column of `events`, never an address) in `$SIGN402_METRICS_EXCLUDE_UIDS`
(comma-separated) and/or `--exclude-uids-file PATH` (one per line, `#` comments; keep that file out of git).
Only the number excluded is reported. Stores keyed by a raw account id (chat_usage, balance_ledger,
api_key_spend, allowance settlements) cannot be filtered by a uid hash and are not.

The day defaults to yesterday in Europe/Prague (the cron runs at 00:10 there); `--day` overrides
it. DB paths default to `$SIGN402_STATE_DIR/<file>` (falling back to `~/.sign402/<file>`), each
overridable by the same environment variable the gateway itself reads, or by a CLI flag. The
Telegram Bitrefill orders database has no default path at all — it lives outside the state dir
on deployments that have it, and is only read when `--bitrefill-orders-db` or
`SIGN402_BITREFILL_COMMERCE_STORE_PATH` names it; otherwise its section is reported as `null`.
"""

from __future__ import annotations

import argparse
import datetime
import decimal
import json
import os
import sqlite3
import urllib.parse
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TZ_NAME = "Europe/Prague"

STATE_DIR_ENV = "SIGN402_STATE_DIR"
DEFAULT_STATE_DIR = "~/.sign402"

WEB_DB_ENV = "SIGN402_WEB_DB"
WEB_DB_FILENAME = "web.db"
ALLOWANCE_DB_ENV = "SIGN402_ALLOWANCE_DB"
ALLOWANCE_DB_FILENAME = "allowance.db"
SOLANA_ALLOWANCE_DB_ENV = "SIGN402_SOLANA_ALLOWANCE_DB"
SOLANA_ALLOWANCE_DB_FILENAME = "solana-allowance.db"
USER_WALLET_DB_ENV = "SIGN402_USER_WALLET_STORE_PATH"
USER_WALLET_DB_FILENAME = "user-wallets.db"
# No filename/default here on purpose: this database lives outside the state dir (a separate
# demo-dashboard host path on deployments that have it at all) and must be named explicitly.
BITREFILL_ORDERS_DB_ENV = "SIGN402_BITREFILL_COMMERCE_STORE_PATH"
EXCLUDE_UIDS_ENV = "SIGN402_METRICS_EXCLUDE_UIDS"

# Known Telegram Bitrefill order states, grouped the way an operator reads them; anything not
# listed here (a future state, or a typo) lands in "other" rather than being dropped or crashing.
BITREFILL_STATE_BUCKETS = {
    "DELIVERED": "delivered",
    "USER_REJECTED": "user_rejected",
    "QUOTED": "pending",
    "FULFILLING": "pending",
    "RECONCILIATION_REQUIRED": "needs_reconciliation",
    "FULFILLMENT_FAILED": "failed",
    "REFUNDED": "failed",
    "QUOTE_EXPIRED": "expired",
}


def day_window(day: datetime.date, tz_name: str = TZ_NAME) -> tuple[int, int]:
    """Unix seconds [start, end) for one local midnight-to-midnight day."""
    tz = ZoneInfo(tz_name)
    start = datetime.datetime(day.year, day.month, day.day, tzinfo=tz)
    end = start + datetime.timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp())


def yesterday(tz_name: str = TZ_NAME) -> datetime.date:
    return (datetime.datetime.now(ZoneInfo(tz_name)) - datetime.timedelta(days=1)).date()


class _ReadonlyConnection:
    """Same shape as `sign402-operator.py`'s `_connect_readonly`: None for a missing file."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.db: sqlite3.Connection | None = None

    def __enter__(self) -> sqlite3.Connection | None:
        if not self.path.exists():
            return None
        uri = "file:" + urllib.parse.quote(str(self.path.resolve())) + "?mode=ro"
        self.db = sqlite3.connect(uri, uri=True, timeout=5.0)
        self.db.row_factory = sqlite3.Row
        return self.db

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.db is not None:
            self.db.close()


def _connect_readonly(path: Path) -> _ReadonlyConnection:
    return _ReadonlyConnection(path)


def _scalar(db: sqlite3.Connection, sql: str, params: tuple = ()) -> Any:
    """A query's first value, or None if the table it needs is not there."""
    try:
        row = db.execute(sql, params).fetchone()
    except sqlite3.OperationalError:
        return None
    return row[0] if row is not None else None


def _rows(db: sqlite3.Connection, sql: str, params: tuple = ()) -> list[sqlite3.Row] | None:
    try:
        return db.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return None


def _usd(atomic: Any) -> str | None:
    if atomic is None:
        return None
    return f"{int(atomic) / 1_000_000:.2f}"


def _usd_precise(atomic: Any) -> str | None:
    """Exact USDC atomic as a USD string with at least 2 places (a $0.003 tool call stays "0.003")."""
    if atomic is None:
        return None
    text = f"{int(atomic) / 1_000_000:.6f}".rstrip("0")
    whole, _, frac = text.partition(".")
    return f"{whole}.{frac.ljust(2, '0')}"


def parse_uid_list(text: str) -> set[str]:
    """uid hashes from a comma- or newline-separated list; `#` starts a comment."""
    uids: set[str] = set()
    for line in text.splitlines():
        for token in line.split("#", 1)[0].split(","):
            token = token.strip()
            if token:
                uids.add(token)
    return uids


def load_exclude_uids(env_value: str | None, file_path: str | Path | None) -> frozenset[str]:
    uids = parse_uid_list(env_value or "")
    if file_path:
        uids |= parse_uid_list(Path(file_path).expanduser().read_text())
    return frozenset(uids)


def _not_excluded(exclude: frozenset[str]) -> tuple[str, tuple]:
    """An SQL fragment keeping rows whose uid is not excluded (one JSON parameter, so no variable limit)."""
    if not exclude:
        return "", ()
    return " AND (uid IS NULL OR uid NOT IN (SELECT value FROM json_each(?)))", (json.dumps(sorted(exclude)),)


def _percentile(sorted_values: list[int], pct: int) -> int | None:
    """Nearest-rank percentile (pct in 1..100) of an ascending list."""
    if not sorted_values:
        return None
    rank = max(1, -(-pct * len(sorted_values) // 100))  # integer ceil
    return sorted_values[min(rank, len(sorted_values)) - 1]


def mcp_metrics(db: sqlite3.Connection, s: int, e: int, exclude: frozenset[str]) -> dict[str, Any] | None:
    """The `mcp_call` events of the window; None when the events table is not there yet."""
    skip, skip_params = _not_excluded(exclude)
    rows = _rows(db, "SELECT uid, props_json FROM events WHERE name = 'mcp_call' AND at >= ? AND at < ?" + skip,
                 (s, e) + skip_params)
    if rows is None:
        return None
    by_tool: dict[str, int] = {}
    by_status: dict[str, int] = {}
    latencies: list[int] = []
    uids: set[str] = set()
    keys: set[str] = set()
    paid = 0
    cost = decimal.Decimal(0)
    for row in rows:
        try:
            props = json.loads(row["props_json"])
        except (ValueError, TypeError):
            props = {}
        if not isinstance(props, dict):
            props = {}
        tool, status = str(props.get("tool") or "unknown"), str(props.get("status") or "unknown")
        by_tool[tool] = by_tool.get(tool, 0) + 1
        by_status[status] = by_status.get(status, 0) + 1
        if row["uid"]:
            uids.add(row["uid"])
        if isinstance(props.get("key_ref"), str):
            keys.add(props["key_ref"])
        latency = props.get("latency_ms")
        if type(latency) is int and latency >= 0:
            latencies.append(latency)
        if props.get("paid") is True:
            paid += 1
        if props.get("cost_usd") is not None:
            try:
                cost += decimal.Decimal(str(props["cost_usd"]))
            except decimal.InvalidOperation:
                pass
    latencies.sort()
    cost_text = f"{cost:f}"
    if "." not in cost_text:
        cost_text += ".00"
    return {
        "calls_total": len(rows),
        "by_tool": dict(sorted(by_tool.items())),
        "by_status": dict(sorted(by_status.items())),
        "distinct_uids": len(uids),
        "distinct_keys": len(keys),
        "latency_ms": {"p50": _percentile(latencies, 50), "p95": _percentile(latencies, 95)},
        "paid_calls": paid,
        "cost_usd": cost_text,
    }


def _merge_counts(a: dict[str, int] | None, b: dict[str, int] | None) -> dict[str, int] | None:
    if a is None and b is None:
        return None
    out = dict(a or {})
    for key, value in (b or {}).items():
        out[key] = out.get(key, 0) + value
    return out


def _add_count(a: int | None, b: int | None) -> int | None:
    if a is None and b is None:
        return None
    return (a or 0) + (b or 0)


# A settlement resource that is a balance top-up, not a purchase (web.db's own `credit_topups`
# already counts it; counting it again here would double it). Matches
# CREDIT_URL in web_balance.py ("https://ask.singitai.app/v1/credit").
_SETTLEMENT_CATEGORY_SQL = """
    CASE WHEN resource LIKE 'bitrefill:invoice:%' THEN 'bitrefill'
         WHEN resource LIKE '%/v1/credit' THEN 'credit_topup'
         WHEN resource LIKE '%/chat/completions/metered' OR resource LIKE '%/chat/completions' THEN 'chat_answer'
         ELSE 'data_tool' END
"""


def web_metrics(path: Path, s: int, e: int, exclude: frozenset[str] = frozenset()) -> dict[str, Any] | None:
    with _connect_readonly(path) as db:
        if db is None:
            return None
        out: dict[str, Any] = {}
        new_rows = _rows(db, "SELECT account_id FROM accounts WHERE created_at >= ? AND created_at < ?", (s, e))
        if new_rows is None:
            out["new_accounts"] = None
        else:
            out["new_accounts"] = {"base": 0, "solana": 0}
            for row in new_rows:
                chain = "solana" if str(row["account_id"]).startswith("solana:") else "base"
                out["new_accounts"][chain] += 1
        out["total_accounts"] = _scalar(db, "SELECT COUNT(*) FROM accounts")
        # `sessions` rows are deleted once they expire, so counting them is only ever a lower
        # bound for "today", not a reliable daily figure — prefer the durable `events` table.
        skip, skip_params = _not_excluded(exclude)
        signed_in_from_events = _scalar(
            db, "SELECT COUNT(DISTINCT uid) FROM events WHERE name = 'sign_in' AND at >= ? AND at < ?" + skip,
            (s, e) + skip_params)
        out["signed_in_today"] = signed_in_from_events
        out["signed_in_today_source"] = "events" if signed_in_from_events is not None else "unavailable"
        out["sessions_rows_today_unreliable"] = _scalar(
            db, "SELECT COUNT(DISTINCT account_id) FROM sessions WHERE created_at >= ? AND created_at < ?", (s, e))
        out["chat_answers"] = _scalar(
            db, "SELECT COUNT(*) FROM chat_usage WHERE created_at >= ? AND created_at < ?", (s, e))
        out["chat_payers"] = _scalar(
            db, "SELECT COUNT(DISTINCT account_id) FROM chat_usage WHERE created_at >= ? AND created_at < ?", (s, e))
        chat_cost = _scalar(
            db, "SELECT SUM(cost_atomic) FROM chat_usage WHERE created_at >= ? AND created_at < ?", (s, e))
        out["chat_cost_usd"] = _usd(chat_cost)
        topup_rows = _rows(
            db, "SELECT state, COUNT(*) n, SUM(COALESCE(paid_atomic, amount_atomic)) usd FROM credit_topups"
                " WHERE created_at >= ? AND created_at < ? GROUP BY state", (s, e))
        if topup_rows is None:
            out["topups"] = None
            out["topups_credited_usd"] = None
        else:
            out["topups"] = {row["state"]: {"count": row["n"], "usd": _usd(row["usd"])} for row in topup_rows}
            credited = out["topups"].get("credited")
            out["topups_credited_usd"] = credited["usd"] if credited else "0.00"
        out["api_keys_created"] = _scalar(
            db, "SELECT COUNT(*) FROM api_keys WHERE created_at >= ? AND created_at < ?", (s, e))
        event_rows = _rows(
            db, "SELECT name, COUNT(*) n FROM events WHERE at >= ? AND at < ?" + skip + " GROUP BY name",
            (s, e) + skip_params)
        out["events"] = {row["name"]: row["n"] for row in event_rows} if event_rows is not None else None
        pause_props = _rows(
            db, "SELECT props_json FROM events WHERE name = 'pause' AND at >= ? AND at < ?" + skip,
            (s, e) + skip_params)
        if pause_props is None:
            out["_pause_triggers"] = None
        else:
            triggers: dict[str, int] = {}
            for row in pause_props:
                try:
                    trigger = json.loads(row["props_json"]).get("trigger", "unknown")
                except (ValueError, TypeError, AttributeError):
                    trigger = "unknown"
                triggers[trigger] = triggers.get(trigger, 0) + 1
            out["_pause_triggers"] = triggers
        out["_mcp"] = mcp_metrics(db, s, e, exclude)
        # api_key_spend is keyed by UTC day (ts // 86400) and only holds billed calls (record_key_spend):
        # this is "keys that paid for a call on that date's UTC day", not every key that called, and
        # the UTC day is offset 1-2h from the Europe/Prague day of the rest of the report.
        utc_day = (day_of(s) - datetime.date(1970, 1, 1)).days
        out["api_keys_active"] = _scalar(
            db, "SELECT COUNT(DISTINCT key_id) FROM api_key_spend WHERE day = ? AND calls > 0", (utc_day,))
        out["_balance_lane"] = _balance_lane(db, s, e)
        return out


def day_of(start: int) -> datetime.date:
    """The Europe/Prague calendar date a window starts on."""
    return datetime.datetime.fromtimestamp(start, ZoneInfo(TZ_NAME)).date()


def _balance_lane(db: sqlite3.Connection, s: int, e: int) -> dict[str, Any] | None:
    """The API-key balance lane, the one store that records the provider cost beside the amount charged
    (balance_ledger.cost_atomic: "what the model cost, before the markup"). Charges without a cost are
    counted, not guessed at, and are left out of the margin."""
    rows = _rows(db, "SELECT kind, COUNT(*) n, SUM(amount_atomic) amount, SUM(cost_atomic) cost,"
                     " SUM(CASE WHEN cost_atomic IS NULL THEN 1 ELSE 0 END) no_cost,"
                     " SUM(CASE WHEN cost_atomic IS NULL THEN 0 ELSE -amount_atomic END) priced_amount"
                     " FROM balance_ledger WHERE at >= ? AND at < ? GROUP BY kind", (s, e))
    if rows is None:
        return None
    by_kind = {row["kind"]: row for row in rows}
    charge = by_kind.get("charge")
    refund = by_kind.get("refund")
    out: dict[str, Any] = {
        "charges": charge["n"] if charge else 0,
        "gross_usd": _usd_precise(-charge["amount"]) if charge else "0.00",
        "refunds_usd": _usd_precise(refund["amount"]) if refund else "0.00",
        "charges_without_cost": charge["no_cost"] if charge else 0,
        "provider_cost_usd": None,
        "margin_usd": None,
    }
    if charge and charge["cost"] is not None:
        out["provider_cost_usd"] = _usd_precise(charge["cost"])
        out["margin_usd"] = _usd_precise(charge["priced_amount"] - charge["cost"])
    return out


def base_allowance_metrics(path: Path, s: int, e: int) -> dict[str, Any] | None:
    with _connect_readonly(path) as db:
        if db is None:
            return None
        out: dict[str, Any] = {}
        out["limits_set"] = _scalar(
            db, "SELECT COUNT(*) FROM limiters WHERE created_at >= ? AND created_at < ? AND status <> 'REJECTED'",
            (s, e))
        # operations.kind is only ever GRANT, REVOKE or PAUSE on Base (unlike Solana's ops table,
        # which also has FUND_GAS) — see the CHECK constraint OPERATIONS_SQL builds in agent_allowance.py.
        op_rows = _rows(
            db, "SELECT kind, state, COUNT(*) n FROM operations WHERE created_at >= ? AND created_at < ?"
                " GROUP BY kind, state", (s, e))
        out["_operations"] = op_rows  # consumed by the caller; not part of the public summary
        purchase_rows = _rows(
            db, f"SELECT {_SETTLEMENT_CATEGORY_SQL} cat, COUNT(*) n, COUNT(DISTINCT user_id) buyers, SUM(amount) usd"
                " FROM settlements WHERE created_at >= ? AND created_at < ? GROUP BY cat", (s, e))
        if purchase_rows is None:
            out["purchases"] = None
            out["usdc_volume_base"] = None
        else:
            out["purchases"] = {row["cat"]: {"count": row["n"], "buyers": row["buyers"], "usd": _usd(row["usd"])}
                                for row in purchase_rows}
            # Credit top-ups are not purchases (and web.db's credit_topups already counts them).
            out["usdc_volume_base"] = _usd(
                sum(int(row["usd"] or 0) for row in purchase_rows if row["cat"] != "credit_topup"))
        out["active_spenders"] = _scalar(
            db, "SELECT COUNT(DISTINCT user_id) FROM settlements WHERE created_at >= ? AND created_at < ?"
                " AND resource NOT LIKE '%/v1/credit'", (s, e))
        out["first_purchases"] = _scalar(
            db, "SELECT COUNT(*) FROM (SELECT user_id, MIN(created_at) f FROM settlements"
                " WHERE resource NOT LIKE '%/v1/credit' GROUP BY user_id) WHERE f >= ? AND f < ?", (s, e))
        out["repeat_buyers"] = _scalar(
            db, "SELECT COUNT(*) FROM (SELECT user_id FROM settlements WHERE resource NOT LIKE '%/v1/credit'"
                " GROUP BY user_id HAVING COUNT(*) >= 2 AND MAX(created_at) >= ?)", (s,))
        # allowance.db's user_id is `wallet:0x…` for the web lane, matching web.db's accounts
        # exactly; a bare numeric id (no "wallet:" prefix) is a legacy Telegram-bot user.
        lane_rows = _rows(
            db, "SELECT CASE WHEN user_id LIKE 'wallet:%' THEN 'web' ELSE 'telegram' END lane,"
                " COUNT(*) n, COUNT(DISTINCT user_id) buyers, SUM(amount) usd FROM settlements"
                " WHERE created_at >= ? AND created_at < ? AND resource NOT LIKE '%/v1/credit' GROUP BY lane",
            (s, e))
        out["settlements_by_lane"] = (
            {row["lane"]: {"count": row["n"], "buyers": row["buyers"], "usd": _usd(row["usd"])}
             for row in lane_rows} if lane_rows is not None else None
        )
        alarm_rows = _rows(
            db, "SELECT severity, COUNT(*) n FROM alerts WHERE created_at >= ? AND created_at < ? GROUP BY severity",
            (s, e))
        out["alerts"] = {row["severity"]: row["n"] for row in alarm_rows} if alarm_rows is not None else None
        out["stuck_outflows"] = _scalar(db, "SELECT COUNT(*) FROM agent_outflows WHERE resolved = 0")
        return out


def solana_allowance_metrics(path: Path, s: int, e: int) -> dict[str, Any] | None:
    with _connect_readonly(path) as db:
        if db is None:
            return None
        out: dict[str, Any] = {}
        out["limits_set"] = _scalar(db, "SELECT COUNT(*) FROM limits WHERE created_at >= ? AND created_at < ?", (s, e))
        op_rows = _rows(
            db, "SELECT kind, state, COUNT(*) n FROM ops WHERE created_at >= ? AND created_at < ? GROUP BY kind, state",
            (s, e))
        out["_ops"] = op_rows
        settled = _rows(
            db, "SELECT COUNT(*) n, COUNT(DISTINCT account) accounts, SUM(amount) usd FROM spends"
                " WHERE created_at >= ? AND created_at < ? AND pull_tx IS NOT NULL", (s, e))
        if settled is None or settled[0]["n"] is None:
            out["purchases"] = None
            out["usdc_volume_solana"] = None
            out["active_spenders"] = None
        else:
            row = settled[0]
            out["purchases"] = {"count": row["n"], "buyers": row["accounts"], "usd": _usd(row["usd"])}
            out["usdc_volume_solana"] = _usd(row["usd"])
            out["active_spenders"] = row["accounts"]
        out["first_purchases"] = _scalar(
            db, "SELECT COUNT(*) FROM (SELECT account, MIN(created_at) f FROM spends WHERE pull_tx IS NOT NULL"
                " GROUP BY account) WHERE f >= ? AND f < ?", (s, e))
        out["repeat_buyers"] = _scalar(
            db, "SELECT COUNT(*) FROM (SELECT account FROM spends WHERE pull_tx IS NOT NULL GROUP BY account"
                " HAVING COUNT(*) >= 2 AND MAX(created_at) >= ?)", (s,))
        out["stuck_reservations"] = _scalar(
            db, "SELECT COUNT(*) FROM spends WHERE pull_tx IS NULL AND created_at < ?", (e - 3600,))
        # A GRANT that is still PREPARED an hour after it was made was never signed in the
        # wallet: an abandoned limit setup, not a failure of anything the gateway did.
        out["abandoned_setups"] = {
            "today": _scalar(
                db, "SELECT COUNT(*) FROM ops WHERE kind = 'GRANT' AND state = 'PREPARED'"
                    " AND created_at >= ? AND created_at < ? AND created_at < ?", (s, e, e - 3600)),
            "total_outstanding": _scalar(
                db, "SELECT COUNT(*) FROM ops WHERE kind = 'GRANT' AND state = 'PREPARED' AND created_at < ?",
                (e - 3600,)),
        }
        return out


def telegram_metrics(path: Path, s: int, e: int) -> dict[str, Any] | None:
    with _connect_readonly(path) as db:
        if db is None:
            return None
        return {
            "new_wallets": (_scalar(db, "SELECT COUNT(*) FROM user_wallets WHERE created_at >= ? AND created_at < ?",
                                    (s, e)) or 0)
            + (_scalar(db, "SELECT COUNT(*) FROM solana_user_wallets WHERE created_at >= ? AND created_at < ?",
                      (s, e)) or 0),
            "total_wallets": _scalar(db, "SELECT COUNT(*) FROM user_wallets"),
            "total_solana_wallets": _scalar(db, "SELECT COUNT(*) FROM solana_user_wallets"),
        }


def bitrefill_orders_metrics(path: Path | None, s: int, e: int) -> dict[str, Any] | None:
    if path is None:
        return None
    with _connect_readonly(path) as db:
        if db is None:
            return None
        rows = _rows(
            db, "SELECT state, COUNT(*) n FROM bitrefill_orders WHERE updated_at >= ? AND updated_at < ?"
                " GROUP BY state", (s, e))
        if rows is None:
            return None
        by_state = {row["state"]: row["n"] for row in rows}
        by_bucket: dict[str, int] = {}
        for state, n in by_state.items():
            bucket = BITREFILL_STATE_BUCKETS.get(state, "other")
            by_bucket[bucket] = by_bucket.get(bucket, 0) + n
        return {"by_state": by_state, "by_bucket": by_bucket}


def _op_state_counts(rows: list[sqlite3.Row] | None) -> dict[str, dict[str, int]] | None:
    if rows is None:
        return None
    out: dict[str, dict[str, int]] = {}
    for row in rows:
        out.setdefault(row["kind"], {})[row["state"]] = row["n"]
    return out


def _ops_total(by_kind: dict[str, dict[str, int]] | None, kinds: tuple[str, ...], state: str) -> int | None:
    if by_kind is None:
        return None
    return sum(by_kind.get(kind, {}).get(state, 0) for kind in kinds)


# Base's `operations.kind` CHECK constraint only allows these three; Solana's `ops.kind` also
# has FUND_GAS (a SOL transfer to pay the agent's own network fees, not an allowance operation).
BASE_OP_KINDS = ("GRANT", "REVOKE", "PAUSE")
SOLANA_OP_KINDS = ("GRANT", "REVOKE", "FUND_GAS")


MARGIN_NOTE = (
    "No overall margin: the stores do not record what a settlement cost us, except the API-key balance lane "
    "(revenue.balance_lane, from balance_ledger.cost_atomic). Missing cost: allowance.db settlements "
    "(x402 data tools and metered answers, Bitrefill), web.db chat_usage, solana-allowance.db spends."
)


def build_report(day: datetime.date, *, web_db: Path, allowance_db: Path, solana_db: Path,
                 user_wallet_db: Path, bitrefill_orders_db: Path | None,
                 exclude_uids: frozenset[str] = frozenset()) -> dict[str, Any]:
    s, e = day_window(day)
    web = web_metrics(web_db, s, e, exclude_uids)
    mcp = web.pop("_mcp", None) if web is not None else None
    balance_lane = web.pop("_balance_lane", None) if web is not None else None
    api_keys_active = web.get("api_keys_active") if web is not None else None
    base = base_allowance_metrics(allowance_db, s, e)
    solana = solana_allowance_metrics(solana_db, s, e)
    telegram = telegram_metrics(user_wallet_db, s, e)
    bitrefill_orders = bitrefill_orders_metrics(bitrefill_orders_db, s, e)

    base_ops = _op_state_counts(base.pop("_operations") if base is not None else None)
    solana_ops = _op_state_counts(solana.pop("_ops") if solana is not None else None)

    approvals_done = (_ops_total(base_ops, ("GRANT",), "DONE") or 0) + (_ops_total(solana_ops, ("GRANT",), "DONE") or 0) \
        if base_ops is not None or solana_ops is not None else None
    approvals_failed = (_ops_total(base_ops, ("GRANT",), "FAILED") or 0) + (_ops_total(solana_ops, ("GRANT",), "FAILED") or 0) \
        if base_ops is not None or solana_ops is not None else None
    revokes = (_ops_total(base_ops, ("REVOKE",), "DONE") or 0) + (_ops_total(solana_ops, ("REVOKE",), "DONE") or 0) \
        if base_ops is not None or solana_ops is not None else None
    pauses_total = _ops_total(base_ops, ("PAUSE",), "DONE")  # Solana has no PAUSE kind

    pause_triggers = web.pop("_pause_triggers", None) if web is not None else None
    # The legacy `operations` table has no "who triggered this" column; the new `events` table
    # does (trigger=user|watcher_auto_pause). Prefer it once there is any `pause` event in this
    # day's window, and fall back to a watcher-count estimate from `alerts` otherwise (e.g. for
    # a day before analytics was turned on).
    if pause_triggers:
        pause_by_trigger = {"user": pause_triggers.get("user", 0), "watcher": pause_triggers.get("watcher_auto_pause", 0)}
    elif pauses_total is not None:
        alarms = ((base or {}).get("alerts") or {}).get("ALARM", 0) if base is not None else 0
        watcher = min(alarms, pauses_total)
        pause_by_trigger = {"user": max(0, pauses_total - watcher), "watcher": watcher}
    else:
        pause_by_trigger = None

    ops_failed = None
    ops_expired = None
    ops_uncertain = None
    if base_ops is not None or solana_ops is not None:
        ops_failed = (_ops_total(base_ops, BASE_OP_KINDS, "FAILED") or 0) + (_ops_total(solana_ops, SOLANA_OP_KINDS, "FAILED") or 0)
        ops_expired = (_ops_total(base_ops, BASE_OP_KINDS, "EXPIRED") or 0) + (_ops_total(solana_ops, SOLANA_OP_KINDS, "EXPIRED") or 0)
        ops_uncertain = _ops_total(solana_ops, SOLANA_OP_KINDS, "UNCERTAIN")  # Base has no UNCERTAIN state

    purchases = _merge_counts(
        {k: v["count"] for k, v in (base or {}).get("purchases", {}).items() if k != "credit_topup"}
        if base and base.get("purchases") else None,
        {"data_tool": (solana or {}).get("purchases", {}).get("count")} if solana and solana.get("purchases") else None,
    )

    report: dict[str, Any] = {
        "day": day.isoformat(),
        "timezone": TZ_NAME,
        "window": {"start": s, "end": e},
        "new_accounts": (web or {}).get("new_accounts"),
        "total_accounts": (web or {}).get("total_accounts"),
        "signed_in_today": (web or {}).get("signed_in_today"),
        "signed_in_today_source": (web or {}).get("signed_in_today_source", "unavailable"),
        "sessions_rows_today_unreliable": (web or {}).get("sessions_rows_today_unreliable"),
        "limits_set": _merge_counts(
            {"base": (base or {}).get("limits_set")} if base else None,
            {"solana": (solana or {}).get("limits_set")} if solana else None,
        ),
        "approvals_done": approvals_done,
        "approvals_failed": approvals_failed,
        "revokes": revokes,
        "pauses": pause_by_trigger,
        "active_spenders": _add_count((base or {}).get("active_spenders") if base else None,
                                      (solana or {}).get("active_spenders") if solana else None),
        "first_purchases": _add_count((base or {}).get("first_purchases") if base else None,
                                      (solana or {}).get("first_purchases") if solana else None),
        "repeat_buyers": _add_count((base or {}).get("repeat_buyers") if base else None,
                                    (solana or {}).get("repeat_buyers") if solana else None),
        "purchases": purchases,
        "credit_topup_settlements": ((base or {}).get("purchases") or {}).get("credit_topup") if base else None,
        "settlements_by_lane": (base or {}).get("settlements_by_lane") if base else None,
        "usdc_volume": {
            "base": (base or {}).get("usdc_volume_base") if base else None,
            "solana": (solana or {}).get("usdc_volume_solana") if solana else None,
        },
        "chat_answers": (web or {}).get("chat_answers"),
        "chat_cost_usd": (web or {}).get("chat_cost_usd"),
        "topups_credited_usd": (web or {}).get("topups_credited_usd"),
        "abandoned_solana_setups": (solana or {}).get("abandoned_setups") if solana else None,
        "errors": {
            "ops_failed": ops_failed,
            "ops_expired": ops_expired,
            "ops_uncertain": ops_uncertain,
            "topups_failed": ((web or {}).get("topups") or {}).get("failed", {}).get("count") if web and web.get("topups") else None,
            "bitrefill_refunded": (bitrefill_orders or {}).get("by_state", {}).get("REFUNDED") if bitrefill_orders else None,
            "stuck_reservations": (solana or {}).get("stuck_reservations") if solana else None,
        },
        "api_keys": {"active": api_keys_active, "created": (web or {}).get("api_keys_created")},
        "mcp": mcp,
        "revenue": {
            "usdc_volume": {
                "base": (base or {}).get("usdc_volume_base") if base else None,
                "solana": (solana or {}).get("usdc_volume_solana") if solana else None,
            },
            "chat_answers": (web or {}).get("chat_answers"),
            "credit_topups_usd": (web or {}).get("topups_credited_usd"),
            "balance_lane": balance_lane,
            # Gross is known everywhere; the provider cost behind it is stored in one lane only.
            "margin": None,
            "margin_note": MARGIN_NOTE,
        },
        "excluded_uids_count": len(exclude_uids),
        "alarms": ((base or {}).get("alerts") or {}).get("ALARM") if base else None,
        "telegram_new_wallets": (telegram or {}).get("new_wallets") if telegram else None,
        "bitrefill_orders": bitrefill_orders,
        "events": (web or {}).get("events") if web else None,
        "detail": {
            "web": web, "base_allowance": base, "solana_allowance": solana,
            "telegram": telegram, "bitrefill_orders": bitrefill_orders,
        },
    }
    return report


def _mcp_line(mcp: dict[str, Any] | None) -> str:
    if mcp is None:
        return "—"
    latency = mcp["latency_ms"]
    return (f"{mcp['calls_total']} (by status {mcp['by_status']}; p50 {latency['p50'] if latency['p50'] is not None else '—'} ms,"
            f" p95 {latency['p95'] if latency['p95'] is not None else '—'} ms; paid {mcp['paid_calls']}, ${mcp['cost_usd']})")


def text_summary(report: dict[str, Any]) -> str:
    new_accounts = report["new_accounts"] or {}
    usdc = report["usdc_volume"] or {}
    errors = report["errors"] or {}
    lines = [
        f"SingIt daily metrics — {report['day']} ({report['timezone']})",
        f"New accounts: base {new_accounts.get('base', '—')}, solana {new_accounts.get('solana', '—')}"
        f" (total {report['total_accounts']})",
        f"Signed in today: {report['signed_in_today']} (source: {report['signed_in_today_source']})",
        f"Limits set: {report['limits_set']}",
        f"Approvals: {report['approvals_done']} done, {report['approvals_failed']} failed; revokes {report['revokes']}",
        f"Pauses: {report['pauses']}",
        f"Active spenders: {report['active_spenders']} (first purchases {report['first_purchases']},"
        f" repeat buyers {report['repeat_buyers']})",
        f"Purchases by category: {report['purchases']} (credit top-ups via settlement: {report['credit_topup_settlements']})",
        f"USDC volume — base {usdc.get('base')}, solana {usdc.get('solana')}",
        f"Chat answers: {report['chat_answers']} (${report['chat_cost_usd']})",
        f"Top-ups credited: ${report['topups_credited_usd']}",
        f"Abandoned Solana setups: {report['abandoned_solana_setups']}",
        f"MCP calls: {_mcp_line(report.get('mcp'))}",
        f"Errors: {errors}",
        f"Alarms: {report['alarms']}; Telegram new wallets: {report['telegram_new_wallets']}",
    ]
    return "\n".join(lines)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--day", help="YYYY-MM-DD, Europe/Prague; default: yesterday there")
    parser.add_argument("--out", help="directory to also write DIR/YYYY-MM-DD.json into (created if missing)")
    parser.add_argument("--text", action="store_true", help="print a short text summary instead of JSON")
    parser.add_argument("--state-dir", default=None,
                        help=f"default: ${STATE_DIR_ENV} or {DEFAULT_STATE_DIR}; base dir for the four DBs below")
    parser.add_argument("--web-db", default=None, help=f"default: ${WEB_DB_ENV} or <state-dir>/{WEB_DB_FILENAME}")
    parser.add_argument("--allowance-db", default=None,
                        help=f"default: ${ALLOWANCE_DB_ENV} or <state-dir>/{ALLOWANCE_DB_FILENAME}")
    parser.add_argument("--solana-db", default=None,
                        help=f"default: ${SOLANA_ALLOWANCE_DB_ENV} or <state-dir>/{SOLANA_ALLOWANCE_DB_FILENAME}")
    parser.add_argument("--user-wallet-db", default=None,
                        help=f"default: ${USER_WALLET_DB_ENV} or <state-dir>/{USER_WALLET_DB_FILENAME}")
    parser.add_argument("--bitrefill-orders-db", default=None,
                        help=f"no default; only read if given or ${BITREFILL_ORDERS_DB_ENV} is set")
    parser.add_argument("--exclude-uids-file", default=None,
                        help=f"one uid hash per line (# comments) to leave out of events-based counts; adds to "
                             f"${EXCLUDE_UIDS_ENV} (comma-separated). Keep the file out of git.")
    return parser


def _state_dir(cli_value: str | None, env: dict[str, str]) -> Path:
    return Path(cli_value or env.get(STATE_DIR_ENV) or DEFAULT_STATE_DIR).expanduser()


def _db_path(cli_value: str | None, env: dict[str, str], env_name: str, state_dir: Path, filename: str) -> Path:
    return Path(cli_value or env.get(env_name) or (state_dir / filename)).expanduser()


def _optional_db_path(cli_value: str | None, env: dict[str, str], env_name: str) -> Path | None:
    value = cli_value or env.get(env_name)
    return Path(value).expanduser() if value else None


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    values = os.environ if env is None else env
    args = _build_parser().parse_args(argv)
    day = datetime.date.fromisoformat(args.day) if args.day else yesterday()
    state_dir = _state_dir(args.state_dir, values)
    try:
        exclude_uids = load_exclude_uids(values.get(EXCLUDE_UIDS_ENV), args.exclude_uids_file)
    except OSError as exc:
        raise SystemExit(f"daily-metrics: cannot read --exclude-uids-file: {exc.strerror or 'error'}")

    report = build_report(
        day,
        web_db=_db_path(args.web_db, values, WEB_DB_ENV, state_dir, WEB_DB_FILENAME),
        allowance_db=_db_path(args.allowance_db, values, ALLOWANCE_DB_ENV, state_dir, ALLOWANCE_DB_FILENAME),
        solana_db=_db_path(args.solana_db, values, SOLANA_ALLOWANCE_DB_ENV, state_dir, SOLANA_ALLOWANCE_DB_FILENAME),
        user_wallet_db=_db_path(args.user_wallet_db, values, USER_WALLET_DB_ENV, state_dir, USER_WALLET_DB_FILENAME),
        bitrefill_orders_db=_optional_db_path(args.bitrefill_orders_db, values, BITREFILL_ORDERS_DB_ENV),
        exclude_uids=exclude_uids,
    )

    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        out_dir = Path(args.out).expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{day.isoformat()}.json").write_text(text + "\n")
    print(text_summary(report) if args.text else text)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
