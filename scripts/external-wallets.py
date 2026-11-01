#!/usr/bin/env python3
"""Counts EXTERNAL wallets that set up an allowance in the SingIt app, and their payments (SI-99).

Stdlib only, Python 3.9+. Read-only: opens the app's SQLite stores with `mode=ro`, never writes,
never touches the network, never pays.

Why this exists: scripts/unique-payers.py (PR #90, SI-86) counts payers of SingIt's own payTo
address. Purchases made through the app's allowance go to the sellers (Bitrefill, data tools,
Exa, Venice...), not to our payTo, so that script cannot see these wallets.

Sources (the same stores the gateway and web API write):
  * allowance.db (Base): `limiters` (owner wallet, agent, limiter per user), `operations`
    (GRANT DONE = the wallet approved), `settlements` (x402 payments the agent made, incl. credit
    top-ups), `agent_outflows` (USDC the watcher saw leave each agent on chain: a cross-check).
  * solana-allowance.db (Solana): `limits` (owner wallet per account), `agents`, `ops`
    (GRANT DONE = the wallet approved), `spends` with `pull_tx` (settled payments).
  * web.db (optional context): `accounts` (wallets that signed in to the app).

A "wallet" is the owner's own address (the one that signed in and approved). Per chain it reports:
  wallets_with_limits, wallets_granted, wallets_paid, wallets_granted_and_paid (the SI-88 target:
  at least one external wallet with an allowance and a payment), payments, usdc, and how many
  wallets/payments the exclusions removed.

Exclusions ("own" wallets, never counted as external) come only from run time, never from git:
  * $SINGIT_OWN_WALLETS: comma-separated addresses or account ids.
  * --exclude-file PATH: one per line, '#' starts a comment. Keep this file out of git.
A wallet is excluded when its owner address, its agent address, its Base limiter address or its
app account id (e.g. `wallet:0x...`, `solana:...`, a Telegram user id) is listed. EVM addresses
compare case-insensitively; Solana (base58) addresses compare exactly.

Output is counts only. No address is ever printed. `--ids` adds a short salted hash per external
wallet (sha256 of $SINGIT_ID_SALT + address, 10 hex chars) so two runs can be compared without
showing who the wallet is; it refuses to run without a non-empty salt. Error messages never carry
an argument, a path or a stored value.

Read-only: a rollback-journal store is opened in place with `mode=ro`; a WAL store is copied (db +
-wal) to a private temp dir first and the copy is read, since a read-only open of a WAL database may
still create its -shm file. Only a missing table is tolerated (an older store); any other read error
stops the run instead of turning into a zero.

Until the operator confirms the own-wallet list, every number is PROVISIONAL; pass --confirmed only when
the exclusion list was confirmed.

    python3 scripts/external-wallets.py
    python3 scripts/external-wallets.py --exclude-file ~/.sign402/own-wallets.txt --json
    python3 scripts/external-wallets.py --since 2026-10-25 --until 2026-10-27

Tests: python3 -m unittest discover -s scripts/tests -p 'test_external_wallets.py'
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

EXCLUDE_ENV = "SINGIT_OWN_WALLETS"
ID_SALT_ENV = "SINGIT_ID_SALT"
STATE_DIR_ENV = "SIGN402_STATE_DIR"
DEFAULT_STATE_DIR = "~/.sign402"
WEB_DB_ENV, WEB_DB_FILENAME = "SIGN402_WEB_DB", "web.db"
ALLOWANCE_DB_ENV, ALLOWANCE_DB_FILENAME = "SIGN402_ALLOWANCE_DB", "allowance.db"
SOLANA_DB_ENV, SOLANA_DB_FILENAME = "SIGN402_SOLANA_ALLOWANCE_DB", "solana-allowance.db"
ACCOUNT_PREFIXES = ("wallet:", "solana:", "base:")


# -- exclusions --

def normalize(value: str) -> str:
    """EVM addresses lowercased; everything else (base58, ids) kept exactly. Account prefixes kept."""
    value = value.strip()
    head = ""
    for prefix in ACCOUNT_PREFIXES:
        if value.lower().startswith(prefix):
            head, value = prefix, value[len(prefix):]
            break
    if value.lower().startswith("0x"):
        value = value.lower()
    return head + value


def bare(value: str) -> str:
    """The address inside an account id (`wallet:0xabc` -> `0xabc`), normalized."""
    value = normalize(value)
    for prefix in ACCOUNT_PREFIXES:
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def parse_list(text: str) -> set[str]:
    out: set[str] = set()
    for line in text.splitlines():
        for token in line.split("#", 1)[0].split(","):
            if token.strip():
                out.add(normalize(token))
                out.add(bare(token))
    return out


def load_exclusions(env_value: str | None, file_path: str | Path | None) -> frozenset[str]:
    found = parse_list(env_value or "")
    if file_path:
        found |= parse_list(Path(file_path).expanduser().read_text())
    return frozenset(found)


# -- reading --

class StoreError(Exception):
    """A store could not be read. Its message never carries a path, an address or a stored value."""


def _is_wal(path: Path) -> bool:
    """SQLite header bytes 18/19 are 2 for a WAL database (https://sqlite.org/fileformat.html)."""
    with open(path, "rb") as f:
        header = f.read(20)
    return len(header) == 20 and header[:16] == b"SQLite format 3\x00" and (header[18] == 2 or header[19] == 2)


def _stat(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return st.st_size, st.st_mtime_ns


def _snapshot_wal(source: Path, copy: Path, attempts: int = 5) -> Path:
    """Copy a WAL store (db + -wal) so that neither file changed while it was copied, else give up.

    A checkpoint between the two copies would pair an old db with a truncated -wal; comparing size and
    mtime of both files before and after each attempt rejects that copy and tries again."""
    wal = Path(str(source) + "-wal")
    for _ in range(attempts):
        before = (_stat(source), _stat(wal))
        shutil.copyfile(source, copy)
        if before[1] is not None:
            shutil.copyfile(wal, Path(str(copy) + "-wal"))
        else:
            Path(str(copy) + "-wal").unlink(missing_ok=True)
        if (_stat(source), _stat(wal)) == before:
            return copy
    raise OSError("the store kept changing while it was copied")


def connect_readonly(path: Path, snapshots: list[str] | None = None) -> sqlite3.Connection | None:
    """A read-only connection. A rollback-journal store is opened in place with mode=ro (SQLite writes
    nothing for that). A WAL store is copied first (db + -wal, retried until neither changed during the
    copy) into a private temp dir and the copy is opened, because even a mode=ro open of a WAL database
    may create or touch its -shm sidecar."""
    path = Path(path).expanduser()
    if not path.exists():
        return None
    try:
        if _is_wal(path):
            tmp = tempfile.mkdtemp(prefix="external-wallets-")
            if snapshots is not None:
                snapshots.append(tmp)
            path = _snapshot_wal(path, Path(tmp) / "store.db")
        db = sqlite3.connect("file:" + urllib.parse.quote(str(path.resolve())) + "?mode=ro", uri=True, timeout=5.0)
        db.row_factory = sqlite3.Row
        db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
    except (OSError, sqlite3.Error) as exc:
        raise StoreError(f"cannot open a store read-only ({type(exc).__name__})") from None
    return db


def rows(db: sqlite3.Connection | None, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    """Rows, or [] only when the table does not exist (an older store); any other failure is an error."""
    if db is None:
        return []
    try:
        return db.execute(sql, params).fetchall()
    except sqlite3.OperationalError as exc:
        if str(exc).startswith("no such table"):
            return []
        raise StoreError(f"cannot read a store ({type(exc).__name__})") from None


@dataclass
class Wallet:
    chain: str
    owner: str                     # normalized owner address
    keys: set[str] = field(default_factory=set)  # everything an exclusion may name
    has_limits: bool = False
    granted: bool = False
    payments: int = 0
    atomic: int = 0
    credit_topups: int = 0
    first_payment_at: int | None = None

    def matches(self, exclude: frozenset[str]) -> bool:
        return any(k in exclude for k in self.keys)


def _in_window(at: int, since: int | None, until: int | None) -> bool:
    return (since is None or at >= since) and (until is None or at < until)


def read_base(db: sqlite3.Connection | None, since: int | None, until: int | None) -> tuple[dict[str, Wallet], dict[str, Any]]:
    wallets: dict[str, Wallet] = {}
    agents_by_user: dict[str, set[str]] = {}
    for r in rows(db, "SELECT user_id, agent_address FROM agents"):
        agents_by_user.setdefault(str(r["user_id"]), set()).add(bare(r["agent_address"]))
    owners_by_user: dict[str, list[tuple[int, str, str]]] = {}
    limiter_keys_by_user: dict[str, set[str]] = {}
    # A REJECTED deployment never spent (agent_allowance.py uses the latest ACTIVE limiter), so it owns nothing.
    for r in rows(db, "SELECT user_id, owner_address, agent_address, limiter_address, status, created_at FROM limiters "
                      "ORDER BY created_at, limiter_address"):
        user = str(r["user_id"])
        limiter_keys_by_user.setdefault(user, set()).update({bare(r["limiter_address"]), bare(r["agent_address"])})
        if str(r["status"]) == "REJECTED":
            continue
        owner = bare(r["owner_address"])
        owners_by_user.setdefault(user, []).append((int(r["created_at"]), str(r["limiter_address"]), owner))
        wallets.setdefault(owner, Wallet("base", owner)).has_limits = True

    def keys_for(user: str) -> set[str]:
        return {normalize(user)} | agents_by_user.get(user, set()) | limiter_keys_by_user.get(user, set())

    for user, owned in owners_by_user.items():
        for _, _, owner in owned:
            wallets[owner].keys |= {owner} | keys_for(user)
    ambiguous = {u for u, owned in owners_by_user.items() if len({o for _, _, o in owned}) > 1}

    def owner_of(user_id: str, at: int | None) -> str | None:
        """The user's owner when it paid: the latest non-rejected limiter created at or before then (else the first)."""
        known = owners_by_user.get(user_id)
        if known:
            chosen = known[0][2]
            for created, _, owner in known:
                if at is not None and created <= at:
                    chosen = owner
            return chosen
        if normalize(user_id).startswith("wallet:"):  # a web account that paid without a limiter row
            return bare(user_id)
        return None

    def wallet_for(user_id: str, at: int | None) -> Wallet | None:
        owner = owner_of(user_id, at)
        if owner is None:
            return None
        w = wallets.setdefault(owner, Wallet("base", owner))
        w.keys |= {owner} | keys_for(user_id)
        return w

    limiter_owner = {bare(l): o for owned in owners_by_user.values() for _, l, o in owned}
    for r in rows(db, "SELECT DISTINCT user_id, limiter_address FROM operations WHERE kind = 'GRANT' AND state = 'DONE'"):
        owner = limiter_owner.get(bare(r["limiter_address"]))
        if owner is not None:
            wallets[owner].granted = True
    stats: dict[str, Any] = {"unattributed_payments": 0, "ambiguous_users": len(ambiguous), "_outflows_by_owner": {}}
    for r in rows(db, "SELECT user_id, amount, resource, created_at FROM settlements"):
        at = int(r["created_at"])
        if not _in_window(at, since, until):
            continue
        w = wallet_for(str(r["user_id"]), at)
        if w is None:
            stats["unattributed_payments"] += 1
            continue
        w.payments += 1
        w.atomic += int(r["amount"])
        w.credit_topups += 1 if str(r["resource"]).endswith("/v1/credit") else 0
        w.first_payment_at = at if w.first_payment_at is None else min(w.first_payment_at, at)
    for r in rows(db, "SELECT user_id, amount, first_seen FROM agent_outflows"):
        at = int(r["first_seen"])
        if not _in_window(at, since, until):
            continue
        w = wallet_for(str(r["user_id"]), at)
        key = w.owner if w is not None else None
        entry = stats["_outflows_by_owner"].setdefault(key, [0, 0])
        entry[0] += 1
        entry[1] += int(r["amount"])
    return wallets, stats


def read_solana(db: sqlite3.Connection | None, since: int | None, until: int | None) -> tuple[dict[str, Wallet], dict[str, Any]]:
    wallets: dict[str, Wallet] = {}
    agents_by_account: dict[str, set[str]] = {}
    for r in rows(db, "SELECT account, agent_address FROM agents"):
        agents_by_account.setdefault(str(r["account"]), set()).add(bare(r["agent_address"]))
    by_account: dict[str, str] = {}
    for r in rows(db, "SELECT account, owner FROM limits"):
        by_account[str(r["account"])] = bare(r["owner"])

    def wallet_for(account: str, *, limits: bool = False) -> Wallet | None:
        owner = by_account.get(account) or (bare(account) if normalize(account).startswith("solana:") else None)
        if owner is None:
            return None
        w = wallets.setdefault(owner, Wallet("solana", owner))
        w.keys |= {owner, normalize(account)} | agents_by_account.get(account, set())
        w.has_limits = w.has_limits or limits
        return w

    for account in by_account:
        wallet_for(account, limits=True)
    for r in rows(db, "SELECT DISTINCT account FROM ops WHERE kind = 'GRANT' AND state = 'DONE'"):
        w = wallet_for(str(r["account"]))
        if w is not None:
            w.granted = True
    stats: dict[str, Any] = {"unattributed_payments": 0}
    for r in rows(db, "SELECT account, amount, purpose, created_at FROM spends WHERE pull_tx IS NOT NULL"):
        at = int(r["created_at"])
        if not _in_window(at, since, until):
            continue
        w = wallet_for(str(r["account"]))
        if w is None:
            stats["unattributed_payments"] += 1
            continue
        w.payments += 1
        w.atomic += int(r["amount"])
        w.credit_topups += 1 if "credit" in str(r["purpose"]).lower() else 0
        w.first_payment_at = at if w.first_payment_at is None else min(w.first_payment_at, at)
    return wallets, stats


def read_signed_in(db: sqlite3.Connection | None) -> dict[str, set[str]]:
    """Wallets that signed in to the app, by chain, each as its set of exclusion keys."""
    out: dict[str, set[str]] = {}
    for r in rows(db, "SELECT account_id, owner_address FROM accounts"):
        account = normalize(str(r["account_id"]))
        chain = "solana" if account.startswith("solana:") else "base"
        out[f"{chain}|{bare(r['owner_address'])}"] = {account, bare(r["owner_address"])}
    return out


# -- the report --

def _usdc(atomic: int) -> str:
    return f"{Decimal(atomic) / Decimal(1_000_000):.6f}"


def short_id(address: str, salt: str) -> str:
    return hashlib.sha256((salt + address).encode()).hexdigest()[:10]


def summarize(wallets: Iterable[Wallet], exclude: frozenset[str], *, ids: bool, salt: str) -> dict[str, Any]:
    external = [w for w in wallets if not w.matches(exclude)]
    excluded = [w for w in wallets if w.matches(exclude)]
    out: dict[str, Any] = {
        "wallets_with_limits": sum(w.has_limits for w in external),
        "wallets_granted": sum(w.granted for w in external),
        "wallets_paid": sum(w.payments > 0 for w in external),
        "wallets_granted_and_paid": sum(w.granted and w.payments > 0 for w in external),
        "payments": sum(w.payments for w in external),
        "credit_topup_payments": sum(w.credit_topups for w in external),
        "usdc": _usdc(sum(w.atomic for w in external)),
        "excluded_wallets": len(excluded),
        "excluded_payments": sum(w.payments for w in excluded),
        "excluded_usdc": _usdc(sum(w.atomic for w in excluded)),
    }
    if ids:
        out["wallet_ids"] = sorted(
            ({"id": short_id(w.owner, salt), "granted": w.granted, "payments": w.payments, "usdc": _usdc(w.atomic)}
             for w in external), key=lambda d: d["id"])
    return out


def build_report(*, allowance_db: Path, solana_db: Path, web_db: Path | None, exclude: frozenset[str],
                 since: int | None = None, until: int | None = None, ids: bool = False, salt: str = "",
                 confirmed: bool = False) -> dict[str, Any]:
    if ids and not salt:
        raise StoreError(f"--ids needs a non-empty ${ID_SALT_ENV}, so a known address cannot be checked against an id")
    snapshots: list[str] = []
    base_db = sol_db = web = None
    try:
        base_db, sol_db = connect_readonly(allowance_db, snapshots), connect_readonly(solana_db, snapshots)
        web = connect_readonly(web_db, snapshots) if web_db else None
        base, base_stats = read_base(base_db, since, until)
        sol, sol_stats = read_solana(sol_db, since, until)
        signed_in = read_signed_in(web)
    except (ValueError, TypeError, KeyError, IndexError) as exc:  # a malformed stored value; never echo it
        raise StoreError(f"unexpected data in a store ({type(exc).__name__})") from None
    finally:
        for db in (base_db, sol_db, web):
            if db is not None:
                db.close()
        for tmp in snapshots:
            shutil.rmtree(tmp, ignore_errors=True)
    report: dict[str, Any] = {
        "provisional": not confirmed,
        "exclusions_confirmed": confirmed,
        "note": ("PROVISIONAL: the own-wallet exclusion list is not confirmed yet." if not confirmed
                 else "Exclusion list confirmed by the operator."),
        "window": {"since": since, "until": until},
        "exclusions_loaded": len({bare(e) for e in exclude}),
        "sources": {"allowance_db": base_db is not None, "solana_db": sol_db is not None, "web_db": web is not None},
    }
    outflows = base_stats.pop("_outflows_by_owner")
    report["base"] = summarize(base.values(), exclude, ids=ids, salt=salt)
    report["base"]["unattributed_payments"] = base_stats["unattributed_payments"]
    report["base"]["users_with_several_owners"] = base_stats["ambiguous_users"]
    ext_owners = {w.owner for w in base.values() if not w.matches(exclude)}
    report["base"]["onchain_agent_outflows"] = sum(v[0] for o, v in outflows.items() if o in ext_owners)
    report["base"]["onchain_agent_outflows_usdc"] = _usdc(sum(v[1] for o, v in outflows.items() if o in ext_owners))
    report["solana"] = summarize(sol.values(), exclude, ids=ids, salt=salt)
    report["solana"]["unattributed_payments"] = sol_stats["unattributed_payments"]
    every = list(base.values()) + list(sol.values())
    total = summarize(every, exclude, ids=False, salt=salt)
    report["total"] = {k: total[k] for k in ("wallets_with_limits", "wallets_granted", "wallets_paid",
                                             "wallets_granted_and_paid", "payments", "usdc", "excluded_wallets")}
    report["total"]["si88_goal_met"] = total["wallets_granted_and_paid"] >= 1
    if web is not None:
        # A signed-in wallet is ours if it is listed, or if its allowance wallet was excluded (e.g. by its agent).
        ours = {f"{w.chain}|{w.owner}" for w in every if w.matches(exclude)}
        is_ours = {key: bool(keys & exclude) or key in ours for key, keys in signed_in.items()}
        report["signed_in_wallets_external"] = sum(not v for v in is_ours.values())
        report["signed_in_wallets_excluded"] = sum(is_ours.values())
    return report


def text_summary(report: dict[str, Any]) -> str:
    lines = [report["note"]]
    for chain in ("base", "solana", "total"):
        r = report[chain]
        lines.append(f"{chain}: {r['wallets_with_limits']} with limits, {r['wallets_granted']} approved, "
                     f"{r['wallets_paid']} paid, {r['wallets_granted_and_paid']} approved+paid; "
                     f"{r['payments']} payments, {r['usdc']} USDC; {r['excluded_wallets']} own wallets excluded")
    lines.append(f"SI-88 (>=1 external wallet with an allowance and a payment): "
                 f"{'met' if report['total']['si88_goal_met'] else 'not met'}")
    return "\n".join(lines)


def _day(value: str) -> int:
    try:
        day = datetime.date.fromisoformat(value)
    except ValueError:
        raise SystemExit("external-wallets: --since/--until must be a date YYYY-MM-DD") from None
    return int(datetime.datetime(day.year, day.month, day.day, tzinfo=datetime.timezone.utc).timestamp())


class _QuietParser(argparse.ArgumentParser):
    """argparse echoes a bad argument back; an address passed by mistake must not reach the terminal or a log."""

    def error(self, message: str) -> None:  # noqa: D401 - argparse API
        self.exit(2, "external-wallets: invalid arguments (see --help)\n")


def _build_parser() -> argparse.ArgumentParser:
    p = _QuietParser(description="Count external wallets with an app allowance and their payments (read-only).")
    p.add_argument("--state-dir", default=None, help=f"default: ${STATE_DIR_ENV} or {DEFAULT_STATE_DIR}")
    p.add_argument("--allowance-db", default=None, help=f"default: ${ALLOWANCE_DB_ENV} or <state-dir>/{ALLOWANCE_DB_FILENAME}")
    p.add_argument("--solana-db", default=None, help=f"default: ${SOLANA_DB_ENV} or <state-dir>/{SOLANA_DB_FILENAME}")
    p.add_argument("--web-db", default=None, help=f"default: ${WEB_DB_ENV} or <state-dir>/{WEB_DB_FILENAME}")
    p.add_argument("--exclude-file", default=None, help=f"own wallets/account ids, one per line; also ${EXCLUDE_ENV}. Keep out of git.")
    p.add_argument("--since", default=None, help="UTC day YYYY-MM-DD (inclusive), payments only")
    p.add_argument("--until", default=None, help="UTC day YYYY-MM-DD (exclusive), payments only")
    p.add_argument("--ids", action="store_true", help=f"add short hashed wallet ids (salt: ${ID_SALT_ENV}); never addresses")
    p.add_argument("--confirmed", action="store_true", help="the exclusion list was confirmed; drop the PROVISIONAL mark")
    p.add_argument("--json", action="store_true", help="JSON instead of a text summary")
    return p


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    values = os.environ if env is None else env
    args = _build_parser().parse_args(argv)
    state = Path(args.state_dir or values.get(STATE_DIR_ENV) or DEFAULT_STATE_DIR).expanduser()
    try:
        exclude = load_exclusions(values.get(EXCLUDE_ENV), args.exclude_file)
    except OSError as exc:
        raise SystemExit(f"external-wallets: cannot read --exclude-file: {exc.strerror or 'error'}")
    try:
        report = _report_from_args(args, values, state, exclude)
    except StoreError as exc:
        raise SystemExit(f"external-wallets: {exc}") from None
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else text_summary(report))
    return 0


def _report_from_args(args: argparse.Namespace, values: Any, state: Path, exclude: frozenset[str]) -> dict[str, Any]:
    return build_report(
        allowance_db=Path(args.allowance_db or values.get(ALLOWANCE_DB_ENV) or state / ALLOWANCE_DB_FILENAME),
        solana_db=Path(args.solana_db or values.get(SOLANA_DB_ENV) or state / SOLANA_DB_FILENAME),
        web_db=Path(args.web_db or values.get(WEB_DB_ENV) or state / WEB_DB_FILENAME),
        exclude=exclude, since=_day(args.since) if args.since else None, until=_day(args.until) if args.until else None,
        ids=args.ids, salt=values.get(ID_SALT_ENV, ""), confirmed=args.confirmed)


if __name__ == "__main__":
    sys.exit(main())
