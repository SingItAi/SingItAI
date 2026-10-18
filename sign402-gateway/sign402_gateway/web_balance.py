"""An account's SingIt balance: what its API keys spend, bought by the owner for an amount they choose.

The web chat does not use it: each chat answer is still paid on its own. API keys spend from this balance, which
the owner tops up in the app ("Top up now"); only if they switch on automatic top-ups does the agent buy more by
itself when the balance runs low.

The balance is credit bought over x402: the account's agent pays `ask.singitai.app/v1/credit` (singit-ask's
credit.mjs) from the owner's limits, on Base through the limiter and on Solana as their delegate, the same way it
pays any seller (web_data.pay_once). SingIt's revenue address is paid; this ledger records the credit.

Spending it involves no chain: a request holds its ceiling, and the charge is the answer's cost up to that
hold. A request still being read refreshes its hold, so a long answer is not mistaken for one that was
abandoned. Anything Surplus billed beyond the hold stays SingIt's loss; it is not taken from the balance and cannot
push it below zero. Every movement is a line in `balance_ledger`, with the balance after it.

The ledger lives in web.db, shared by web_api (which spends) and the gateway (which tops up). Every change is one
SQL transaction whose conditions are in the statement itself, so the two processes never overwrite each other.

A top-up is claimed by its id before anything is paid and is paid at most once. A failure that moved nothing ends
it; an unclear one leaves it `uncertain`, and the account tops up no more until it is resolved by hand.
"""

from __future__ import annotations

import logging
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import analytics
from .agent_allowance import AllowanceError, AllowanceUnavailable

logger = logging.getLogger(__name__)

CREDIT_URL = "https://ask.singitai.app/v1/credit"
MIN_TOPUP = 1_000_000          # $1 of credit, singit-ask's least
MAX_TOPUP = 50_000_000         # $50, its most
TOPUP_STEP = 10_000            # whole cents
DEFAULT_TOPUP = 1_000_000      # one portion: $1, so little of the owner's money waits here
DEFAULT_THRESHOLD = 300_000    # top up below $0.30 left
HOLD_SECONDS = 15 * 60         # a hold nobody has touched this long is let go
TOPUP_ID = re.compile(r"top_[0-9a-f]{16,32}")


class TopupBusy(AllowanceError):
    """Another top-up of this account is being paid, or its outcome is being checked."""


def new_topup_id() -> str:
    return "top_" + secrets.token_hex(12)


class Balances:
    def __init__(self, path: Path):
        self.path = Path(path)
        with self._db() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS balances (
                    account_id TEXT PRIMARY KEY,
                    balance_atomic INTEGER NOT NULL DEFAULT 0,
                    held_atomic INTEGER NOT NULL DEFAULT 0,
                    topup_atomic INTEGER,
                    threshold_atomic INTEGER,
                    auto_topup INTEGER NOT NULL DEFAULT 0,
                    refund_requested_at INTEGER,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS balance_holds (
                    hold_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    amount_atomic INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS holds_by_age ON balance_holds(created_at);
                CREATE TABLE IF NOT EXISTS balance_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT NOT NULL,
                    at INTEGER NOT NULL,
                    kind TEXT NOT NULL,               -- topup, charge, refund
                    amount_atomic INTEGER NOT NULL,   -- signed: + credit, - spend
                    balance_after INTEGER NOT NULL,
                    ref TEXT,                         -- topup id, or the upstream request id
                    key_id TEXT,
                    model TEXT,
                    cost_atomic INTEGER,              -- what the model cost, before the markup
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    tx_id TEXT,
                    network TEXT
                );
                CREATE INDEX IF NOT EXISTS ledger_by_account ON balance_ledger(account_id, id);
                CREATE TABLE IF NOT EXISTS credit_topups (
                    topup_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    amount_atomic INTEGER NOT NULL,
                    state TEXT NOT NULL,              -- paying, credited, failed, uncertain
                    paid_atomic INTEGER,
                    tx_id TEXT,
                    network TEXT,
                    error TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS topups_by_account ON credit_topups(account_id, state);
                """
            )

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _ensure(db: sqlite3.Connection, account: str, now: int) -> None:
        db.execute("INSERT OR IGNORE INTO balances(account_id, updated_at) VALUES (?, ?)", (account, now))

    # -- reading --

    def state(self, account: str) -> dict[str, Any]:
        with self._db() as db:
            row = db.execute("SELECT * FROM balances WHERE account_id = ?", (account,)).fetchone()
            pending = db.execute("SELECT topup_id, state, amount_atomic FROM credit_topups WHERE account_id = ?"
                                 " AND state IN ('paying', 'uncertain') ORDER BY created_at", (account,)).fetchall()
        balance, held = (int(row["balance_atomic"]), int(row["held_atomic"])) if row else (0, 0)
        return {"balanceAtomic": balance, "heldAtomic": held, "availableAtomic": balance - held,
                "topupAtomic": int(row["topup_atomic"] or DEFAULT_TOPUP) if row else DEFAULT_TOPUP,
                "thresholdAtomic": int(row["threshold_atomic"] or DEFAULT_THRESHOLD) if row else DEFAULT_THRESHOLD,
                "autoTopup": bool(row["auto_topup"]) if row else False,
                "refundRequestedAt": row["refund_requested_at"] if row else None,
                "pending": [{"id": p["topup_id"], "state": p["state"], "amountAtomic": int(p["amount_atomic"])}
                            for p in pending]}

    def ledger(self, account: str, *, limit: int = 50, before: int | None = None) -> list[sqlite3.Row]:
        with self._db() as db:
            return db.execute("SELECT * FROM balance_ledger WHERE account_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                              (account, before if before is not None else 2 ** 62, max(1, min(limit, 200)))).fetchall()

    def usage(self, account: str, since: int) -> list[sqlite3.Row]:
        """Charges since `since`, per UTC day, key and model."""
        with self._db() as db:
            return db.execute(
                "SELECT at / 86400 AS day, key_id, model, COUNT(*) AS calls, -SUM(amount_atomic) AS charged_atomic,"
                " SUM(cost_atomic) AS cost_atomic, SUM(input_tokens) AS input_tokens,"
                " SUM(output_tokens) AS output_tokens FROM balance_ledger WHERE account_id = ? AND kind = 'charge'"
                " AND at >= ? GROUP BY day, key_id, model ORDER BY day DESC, charged_atomic DESC",
                (account, since)).fetchall()

    # -- settings --

    def set_terms(self, account: str, topup: int, threshold: int, auto: bool, now: int) -> None:
        """Automatic top-ups, off unless the owner turns them on: `topup` bought whenever under `threshold`."""
        with self._db() as db:
            self._ensure(db, account, now)
            db.execute("UPDATE balances SET topup_atomic = ?, threshold_atomic = ?, auto_topup = ?, updated_at = ?"
                       " WHERE account_id = ?", (topup, threshold, int(bool(auto)), now, account))

    def request_refund(self, account: str, now: int) -> bool:
        """Freezes the balance for a refund by hand: nothing more is spent or topped up until it is resolved."""
        with self._db() as db:
            self._ensure(db, account, now)
            return bool(db.execute("UPDATE balances SET refund_requested_at = ?, updated_at = ? WHERE account_id = ?"
                                   " AND refund_requested_at IS NULL", (now, now, account)).rowcount)

    def record_refund(self, account: str, amount: int, tx_id: str, now: int) -> int:
        """The operator sent `amount` back to the owner: the balance drops by it and is open again."""
        with self._db() as db:
            self._ensure(db, account, now)
            db.execute("UPDATE balances SET balance_atomic = balance_atomic - ?, refund_requested_at = NULL,"
                       " updated_at = ? WHERE account_id = ?", (amount, now, account))
            after = db.execute("SELECT balance_atomic FROM balances WHERE account_id = ?", (account,)).fetchone()[0]
            db.execute("INSERT INTO balance_ledger(account_id, at, kind, amount_atomic, balance_after, tx_id)"
                       " VALUES (?, ?, 'refund', ?, ?, ?)", (account, now, -amount, after, tx_id))
        return int(after)

    # -- spending --

    def hold(self, account: str, hold_id: str, amount: int, now: int) -> bool:
        """Sets `amount` aside for one request if that much is free. False when it is not, or the balance is frozen."""
        with self._db() as db:
            self._ensure(db, account, now)
            for stale in db.execute("SELECT hold_id, account_id, amount_atomic FROM balance_holds WHERE created_at < ?",
                                    (now - HOLD_SECONDS,)).fetchall():
                db.execute("DELETE FROM balance_holds WHERE hold_id = ?", (stale["hold_id"],))
                db.execute("UPDATE balances SET held_atomic = MAX(0, held_atomic - ?) WHERE account_id = ?",
                           (stale["amount_atomic"], stale["account_id"]))
            taken = db.execute("UPDATE balances SET held_atomic = held_atomic + ?, updated_at = ? WHERE account_id = ?"
                               " AND refund_requested_at IS NULL AND balance_atomic - held_atomic >= ?",
                               (amount, now, account, amount)).rowcount
            if taken:
                db.execute("INSERT INTO balance_holds(hold_id, account_id, amount_atomic, created_at) VALUES (?, ?, ?, ?)",
                           (hold_id, account, amount, now))
        return bool(taken)

    def touch(self, hold_id: str, now: int) -> bool:
        """Keeps a request's hold from being treated as forgotten while that request is still being read."""
        with self._db() as db:
            return bool(db.execute("UPDATE balance_holds SET created_at = ? WHERE hold_id = ?",
                                   (now, hold_id)).rowcount)

    def release(self, hold_id: str) -> None:
        with self._db() as db:
            self._drop_hold(db, hold_id)

    @staticmethod
    def _drop_hold(db: sqlite3.Connection, hold_id: str) -> str | None:
        row = db.execute("SELECT account_id, amount_atomic FROM balance_holds WHERE hold_id = ?", (hold_id,)).fetchone()
        if row is None:
            return None
        db.execute("DELETE FROM balance_holds WHERE hold_id = ?", (hold_id,))
        db.execute("UPDATE balances SET held_atomic = MAX(0, held_atomic - ?) WHERE account_id = ?",
                   (row["amount_atomic"], row["account_id"]))
        return str(row["account_id"])

    def charge(self, account: str, hold_id: str, amount: int, now: int, **details: Any) -> int:
        """Charges up to the live hold, lets that hold go, and returns the balance after."""
        return self.bill(account, hold_id, amount, now, **details)[1]

    def bill(self, account: str, hold_id: str, amount: int, now: int, *, beyond_hold: int = 0,
             key_id: str | None = None, model: str | None = None, ref: str | None = None, cost: int | None = None,
             input_tokens: int | None = None, output_tokens: int | None = None) -> tuple[int, int]:
        """Charges `amount`, lets the hold go, and returns what was billed and the balance after.

        A charge takes its hold, and up to `beyond_hold` more from what no other hold has reserved, so an answer
        longer than its hold is still paid while there is money free for it. Whatever is left over is not collected:
        a missing hold bills nothing, and the balance cannot be driven negative or into another request's hold.
        """
        with self._db() as db:
            row = db.execute("SELECT account_id, amount_atomic FROM balance_holds WHERE hold_id = ?",
                             (hold_id,)).fetchone()
            if row is None or str(row["account_id"]) != account:
                current = db.execute("SELECT balance_atomic FROM balances WHERE account_id = ?", (account,)).fetchone()
                return 0, int(current[0]) if current is not None else 0
            reserved = int(row["amount_atomic"])
            asked = amount if type(amount) is int and amount > 0 else 0
            billed = min(asked, reserved)
            if asked > reserved and beyond_hold > 0:
                balance, held = db.execute("SELECT balance_atomic, held_atomic FROM balances WHERE account_id = ?",
                                           (account,)).fetchone()
                free = int(balance) - int(held)  # this hold is still counted in `held`, so `free` is the rest
                billed += max(0, min(asked - reserved, beyond_hold, free))
            if asked > billed:
                logger.warning("balance: charge of %s for %s capped at %s", asked, account, billed)
            self._drop_hold(db, hold_id)
            self._ensure(db, account, now)
            if billed:
                db.execute("UPDATE balances SET balance_atomic = balance_atomic - ?, updated_at = ? WHERE account_id = ?",
                           (billed, now, account))
            after = int(db.execute("SELECT balance_atomic FROM balances WHERE account_id = ?", (account,)).fetchone()[0])
            db.execute("INSERT INTO balance_ledger(account_id, at, kind, amount_atomic, balance_after, ref, key_id, model,"
                       " cost_atomic, input_tokens, output_tokens) VALUES (?, ?, 'charge', ?, ?, ?, ?, ?, ?, ?, ?)",
                       (account, now, -billed, after, ref, key_id, model, cost, input_tokens, output_tokens))
        if billed and model:
            analytics.emit("chat_answer_paid", account, model=model, lane="api_key",
                           cost_usd=analytics.usdc_to_usd_string(billed),
                           tokens_in=input_tokens or 0, tokens_out=output_tokens or 0)
        return billed, after

    # -- topping up --

    def claim_topup(self, topup_id: str, account: str, amount: int, now: int) -> None:
        with self._db() as db:
            self._ensure(db, account, now)
            if db.execute("SELECT refund_requested_at FROM balances WHERE account_id = ?",
                          (account,)).fetchone()[0] is not None:
                raise AllowanceError("A refund of this balance was requested; it is not topped up until it is done.")
            busy = db.execute("SELECT state FROM credit_topups WHERE account_id = ? AND state IN ('paying', 'uncertain')",
                              (account,)).fetchone()
            if busy is not None:
                raise TopupBusy("A top-up is being paid right now. Try again in a minute." if busy["state"] == "paying"
                                else "The last top-up's result is unclear and is being checked. Nothing more is paid "
                                     "until it is.")
            try:
                db.execute("INSERT INTO credit_topups(topup_id, account_id, amount_atomic, state, created_at, updated_at)"
                           " VALUES (?, ?, ?, 'paying', ?, ?)", (topup_id, account, amount, now, now))
            except sqlite3.IntegrityError as exc:
                raise TopupBusy("This top-up was already attempted. Nothing more was paid.") from exc

    def end_topup(self, topup_id: str, state: str, error: str, now: int) -> None:
        with self._db() as db:
            db.execute("UPDATE credit_topups SET state = ?, error = ?, updated_at = ? WHERE topup_id = ?"
                       " AND state = 'paying'", (state, error[:300], now, topup_id))

    def credit_topup(self, topup_id: str, paid: int, credit: int, tx_id: str, network: str, now: int) -> int:
        """The top-up settled: its credit joins the balance, once."""
        with self._db() as db:
            row = db.execute("SELECT account_id FROM credit_topups WHERE topup_id = ? AND state IN ('paying', 'uncertain')",
                             (topup_id,)).fetchone()
            if row is None:
                raise AllowanceError("This top-up is not open.")
            account = str(row["account_id"])
            db.execute("UPDATE credit_topups SET state = 'credited', paid_atomic = ?, tx_id = ?, network = ?,"
                       " updated_at = ? WHERE topup_id = ?", (paid, tx_id, network, now, topup_id))
            self._ensure(db, account, now)
            db.execute("UPDATE balances SET balance_atomic = balance_atomic + ?, updated_at = ? WHERE account_id = ?",
                       (credit, now, account))
            after = int(db.execute("SELECT balance_atomic FROM balances WHERE account_id = ?", (account,)).fetchone()[0])
            db.execute("INSERT INTO balance_ledger(account_id, at, kind, amount_atomic, balance_after, ref, tx_id, network)"
                       " VALUES (?, ?, 'topup', ?, ?, ?, ?, ?)", (account, now, credit, after, topup_id, tx_id, network))
        analytics.emit("funds_added", account, chain=network, amount_usd=analytics.usdc_to_usd_string(credit),
                       source="credit_topup")
        return after


def _fee(network: str) -> int:
    from .web_data import SOLANA  # noqa: PLC0415
    return 2_000 if network == SOLANA else 1_000  # singit-ask's settlement fee per network (pricing.mjs)


def _per_purchase_cap(server: Any, account: str, network: str) -> int:
    from .web_data import SOLANA  # noqa: PLC0415
    if network == SOLANA:
        lane = getattr(server, "solana_allowance", None)
        limits = lane.store.limits(account) if lane is not None else None
    else:
        limits = server.allowance.lane_for(account)
    if limits is None:
        raise AllowanceUnavailable("Set your limits and approve them from your wallet first.")
    return int(limits["per_purchase_cap"])


def topup(server: Any, gw: Any, account: str, payload: dict[str, Any], *, now: Any = time.time) -> dict[str, Any]:
    """Buys SingIt credit from the account's limits and adds it to its balance.

    `amountAtomic` is the portion wanted; it shrinks to fit the per-purchase limit with the fee, but never below
    `minAtomic` (what the waiting request needs) or $1.
    """
    from . import ask_metered, ask_solana, web_data  # noqa: PLC0415

    topup_id = str(payload.get("topupId") or "")
    if not TOPUP_ID.fullmatch(topup_id):
        raise AllowanceError("Invalid top-up id.")
    wanted, least = payload.get("amountAtomic"), payload.get("minAtomic", MIN_TOPUP)
    if type(wanted) is not int or type(least) is not int or not MIN_TOPUP <= wanted <= MAX_TOPUP or least > MAX_TOPUP:
        raise AllowanceError("Invalid top-up amount.")
    network = web_data.network_of(account)
    if network == web_data.SOLANA and account[len("solana:"):] == ask_solana.PAY_TO:
        raise AllowanceError(ask_solana.SELF_PAY)
    fee = _fee(network)
    fits = (_per_purchase_cap(server, account, network) - fee) // TOPUP_STEP * TOPUP_STEP
    least = -(-max(least, MIN_TOPUP) // TOPUP_STEP) * TOPUP_STEP
    amount = min(wanted // TOPUP_STEP * TOPUP_STEP, fits)
    if amount < least:
        raise AllowanceError(f"A top-up of at least ${least / 1e6:.2f} is needed, and your per-purchase limit allows "
                             f"${max(fits, 0) / 1e6:.2f} with the network fee. Raise the limit in Settings.")
    body = {"amountAtomic": str(amount)}
    tool = web_data.DataTool("credit", "SingIt credit", "SingIt",
                             {web_data.BASE: ask_metered.PAY_TO, web_data.SOLANA: ask_solana.PAY_TO},
                             amount + fee, lambda _p: ("POST", CREDIT_URL, body))
    balances = Balances(server.web_accounts.path)
    balances.claim_topup(topup_id, account, amount, int(now()))
    try:
        paid, _data, tx = web_data.pay_once(server, gw, account, tool, "POST", CREDIT_URL, body)
    except (AllowanceError, AllowanceUnavailable) as exc:
        balances.end_topup(topup_id, "failed", str(exc), int(now()))
        raise
    except Exception as exc:
        balances.end_topup(topup_id, "uncertain", type(exc).__name__, int(now()))
        raise AllowanceError("The top-up's result is unclear. It is being checked and will not be repeated.") from exc
    credit = max(0, paid - fee)
    after = balances.credit_topup(topup_id, paid, credit, tx, "solana" if network == web_data.SOLANA else "base", int(now()))
    return {"ok": True, "topupId": topup_id, "creditedAtomic": credit, "paidAtomic": paid, "feeAtomic": fee,
            "txId": tx, "network": "solana" if network == web_data.SOLANA else "base", "balanceAtomic": after}


def main(argv: list[str] | None = None) -> int:
    """Refunds by hand: `refunds` lists the frozen balances; `refund <account> <USDC atomic> <tx>` records one
    sent back to its owner, from SingIt's revenue wallet."""
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415
    from .web_accounts import DEFAULT_WEB_DB, WEB_DB_ENV  # noqa: PLC0415

    args = sys.argv[1:] if argv is None else argv
    balances = Balances(Path(os.environ.get(WEB_DB_ENV, "") or DEFAULT_WEB_DB).expanduser())
    if args[:1] == ["refunds"]:
        with balances._db() as db:
            for row in db.execute("SELECT account_id, balance_atomic, held_atomic, refund_requested_at FROM balances"
                                  " WHERE refund_requested_at IS NOT NULL ORDER BY refund_requested_at"):
                print(row["account_id"], f"{row['balance_atomic'] / 1e6:.6f} USDC", f"held {row['held_atomic']}",
                      time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(row["refund_requested_at"])))
        return 0
    if len(args) == 4 and args[0] == "refund" and args[2].isdigit():
        print("balance after:", balances.record_refund(args[1], int(args[2]), args[3], int(time.time())))
        return 0
    print("usage: python -m sign402_gateway.web_balance refunds | refund <account> <atomic> <tx>")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
