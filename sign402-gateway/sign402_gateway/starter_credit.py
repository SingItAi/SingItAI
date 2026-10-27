"""Starter credit: $1 of SingIt API calls for up to 20 vetted users, from a budget capped at $20. OFF by default.

Design and runbook: docs/starter-credit.md.

Who: a signed-in Base wallet account whose own AgentAllowance limiter is active (allowance.lane_for answers, the lane's
owner is this wallet, and the limiter's on-chain `owner()` is this wallet too), and a GitHub account linked over OAuth
that is older than 182 days and owns at least one public repository that is not a fork. GitHub's answers are read
server-side with the access token we exchanged ourselves; nothing the client sends about its GitHub account is
trusted, and the token lives only in memory. Solana accounts are refused: Solana has no on-chain limiter, and v1 is
Base only.

One credit per GitHub account (its numeric id) and one per wallet, whatever became of the claim. Claims wait as
`pending` until an operator approves them by hand (`python -m sign402_gateway.starter_credit approve ...`); nothing
grants one automatically. Approval re-checks the allowance and reserves GRANT_ATOMIC from the budget in one
conditional UPDATE, in the same transaction that flips the claim, so concurrent approvals never commit more than
min(funded, cap) or more than MAX_GRANTS grants. The budget starts unfunded: nothing is approved before `fund`.

The credit is not money the user holds. It lives in its own tables, never in `balances`, so refunds and top-ups never
see it; `withdraw()` always refuses. It is spent only by web_api_proxy.Proxy on requests whose ceiling is at most
MAX_REQUEST_ATOMIC, at most DAILY_ATOMIC per UTC day (holds in flight count), and only for GRANT_SECONDS after
approval. Unspent credit stays unspent; it does not return to the budget.

Every claim, decision, refusal, funding, hold, bill and expiry is a row in `starter_audit`. Tokens, OAuth codes and
states are never stored, logged or audited (the state only as its sha256).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

from .agent_allowance import AllowanceError, selector
from .web_accounts import ACCOUNT_PREFIX, chain_of_account

logger = logging.getLogger(__name__)

ENABLED_ENV = "SIGN402_STARTER_CREDIT"                  # "1" turns the feature on; anything else leaves it OFF
CAP_ENV = "SIGN402_STARTER_CREDIT_CAP_ATOMIC"           # may only lower HARD_CAP_ATOMIC
CLIENT_ID_ENV = "SIGN402_GITHUB_CLIENT_ID"
CLIENT_SECRET_ENV = "SIGN402_GITHUB_CLIENT_SECRET"
REDIRECT_ENV = "SIGN402_STARTER_CREDIT_REDIRECT"        # the app page the callback returns the user to

HARD_CAP_ATOMIC = 20_000_000    # $20: the most the budget can ever be funded with; env may lower it, never raise
MAX_GRANTS = 20
GRANT_ATOMIC = 1_000_000        # $1 per grant
DAILY_ATOMIC = 250_000          # $0.25 spendable per grant per UTC day, holds in flight included
MAX_REQUEST_ATOMIC = 50_000     # only requests whose ceiling is at most $0.05 may use the credit
GRANT_SECONDS = 7 * 86400       # a grant expires 7 days after approval
MIN_GITHUB_AGE_DAYS = 182
STATE_SECONDS = 10 * 60         # an OAuth state is good for 10 minutes, once
HOLD_SECONDS = 15 * 60          # as web_balance: a hold nobody has touched this long is let go
CALLBACK_PATH = "/starter-credit/github/callback"
BINDING_COOKIE = "singit_starter_oauth"  # browser-bound OAuth nonce, scoped to the callback path


class StarterCreditError(Exception):
    """A refusal with a short public reason code; `status` is the HTTP status the web routes answer with."""

    status = 403

    def __init__(self, reason: str, message: str = ""):
        super().__init__(message or reason)
        self.reason, self.message = reason, message or reason


class StarterCreditOff(StarterCreditError):
    status = 404


class StarterRefused(StarterCreditError):
    pass


class BudgetExhausted(StarterRefused):
    pass


class StarterCreditNotWithdrawable(StarterCreditError):
    pass


def short_account(account: str | None) -> str:
    """`wallet:0x1234…abcd`: enough to tell accounts apart in operator output, never the whole address."""
    account = str(account or "")
    prefix, sep, rest = account.partition(":")
    if not sep:
        prefix, rest = "", account
    body = f"{rest[:6]}…{rest[-4:]}" if len(rest) > 12 else rest
    return f"{prefix}:{body}" if prefix else body


def cap_from_env(env: Mapping[str, str] | None = None) -> int:
    """HARD_CAP_ATOMIC, or less when CAP_ENV says so. A higher or malformed value is ignored: the cap never rises."""
    raw = str((os.environ if env is None else env).get(CAP_ENV, "") or "").strip()
    if raw.isdigit() and int(raw) < HARD_CAP_ATOMIC:
        return int(raw)
    if raw:
        logger.warning("starter credit: %s=%s cannot raise the cap; using %s", CAP_ENV, raw, HARD_CAP_ATOMIC)
    return HARD_CAP_ATOMIC


def enabled_from_env(env: Mapping[str, str] | None = None) -> bool:
    return str((os.environ if env is None else env).get(ENABLED_ENV, "")).strip() == "1"


class StarterCredit:
    """The claims, grants, budget, holds and audit log, in web.db beside Balances. Every money movement is one
    conditional statement inside a BEGIN IMMEDIATE transaction, so web-api's threads and the operator's CLI never
    overwrite each other."""

    def __init__(self, path: Path, *, enabled: bool = False, cap_atomic: int | None = None):
        self.path = Path(path)
        self.enabled = bool(enabled)
        self.cap = HARD_CAP_ATOMIC if cap_atomic is None else max(0, min(int(cap_atomic), HARD_CAP_ATOMIC))
        with self._db() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS starter_claims (
                    claim_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL UNIQUE,
                    github_id INTEGER NOT NULL UNIQUE,
                    github_login TEXT NOT NULL,
                    github_created_at INTEGER NOT NULL,
                    state TEXT NOT NULL,              -- pending, approved, rejected
                    amount_atomic INTEGER NOT NULL DEFAULT 0,
                    spent_atomic INTEGER NOT NULL DEFAULT 0,
                    held_atomic INTEGER NOT NULL DEFAULT 0,
                    requested_at INTEGER NOT NULL,
                    decided_at INTEGER,
                    decided_by TEXT,
                    reason TEXT,
                    approved_at INTEGER,
                    expires_at INTEGER,
                    expired_logged_at INTEGER         -- when the expiry was written to the audit log
                );
                CREATE INDEX IF NOT EXISTS starter_claims_by_state ON starter_claims(state, requested_at);
                CREATE TABLE IF NOT EXISTS starter_daily (
                    claim_id TEXT NOT NULL,
                    day INTEGER NOT NULL,             -- UTC day number: unix time // 86400
                    used_atomic INTEGER NOT NULL DEFAULT 0,   -- spent that day plus held right now
                    PRIMARY KEY (claim_id, day)
                );
                CREATE TABLE IF NOT EXISTS starter_holds (
                    hold_id TEXT PRIMARY KEY,
                    claim_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    day INTEGER NOT NULL,
                    amount_atomic INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS starter_holds_by_age ON starter_holds(created_at);
                CREATE TABLE IF NOT EXISTS starter_budget (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    funded_atomic INTEGER NOT NULL DEFAULT 0,
                    committed_atomic INTEGER NOT NULL DEFAULT 0,
                    grants INTEGER NOT NULL DEFAULT 0,
                    cap_atomic INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS starter_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    at INTEGER NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    claim_id TEXT,
                    account_id TEXT,
                    amount_atomic INTEGER,
                    detail TEXT
                );
                CREATE TABLE IF NOT EXISTS starter_oauth_states (
                    state_hash TEXT PRIMARY KEY,      -- sha256 of the state; the state itself is never stored
                    account_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0,
                    binding_hash TEXT                 -- sha256 of the browser-bound nonce; NULL on pre-binding rows
                );
                """
            )
            if "binding_hash" not in {r[1] for r in db.execute("PRAGMA table_info(starter_oauth_states)")}:
                db.execute("ALTER TABLE starter_oauth_states ADD COLUMN binding_hash TEXT")
            db.execute("INSERT OR IGNORE INTO starter_budget(id, cap_atomic) VALUES (1, ?)", (HARD_CAP_ATOMIC,))

    @classmethod
    def from_env(cls, path: Path, env: Mapping[str, str] | None = None) -> "StarterCredit":
        return cls(path, enabled=enabled_from_env(env), cap_atomic=cap_from_env(env))

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        """A write transaction that takes the database's write lock up front, so its reads and conditional
        updates see no other writer in between."""
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            yield db

    def _require_on(self) -> None:
        if not self.enabled:
            raise StarterCreditOff("starter_credit_off", "Starter credit is not enabled on this server.")

    @staticmethod
    def _log(db: sqlite3.Connection, now: int, actor: str, action: str, *, claim_id: str | None = None,
             account: str | None = None, amount: int | None = None, detail: str | None = None) -> None:
        db.execute("INSERT INTO starter_audit(at, actor, action, claim_id, account_id, amount_atomic, detail)"
                   " VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (int(now), str(actor)[:64], action, claim_id, account, amount, (detail or "")[:300] or None))

    def audit(self, now: int, actor: str, action: str, **fields: Any) -> None:
        with self._db() as db:
            self._log(db, now, actor, action, **fields)

    def _refuse(self, now: int, actor: str, reason: str, message: str, *, claim_id: str | None = None,
                account: str | None = None, error: type[StarterCreditError] = StarterRefused) -> StarterCreditError:
        self.audit(now, actor, "refused", claim_id=claim_id, account=account, detail=reason)
        return error(reason, message)

    # -- reading --

    def claim_for(self, account: str) -> sqlite3.Row | None:
        with self._db() as db:
            return db.execute("SELECT * FROM starter_claims WHERE account_id = ?", (account,)).fetchone()

    def get(self, claim_id: str) -> sqlite3.Row | None:
        with self._db() as db:
            return db.execute("SELECT * FROM starter_claims WHERE claim_id = ?", (claim_id,)).fetchone()

    def pending(self) -> list[sqlite3.Row]:
        with self._db() as db:
            return db.execute("SELECT * FROM starter_claims WHERE state = 'pending' ORDER BY requested_at").fetchall()

    def budget(self) -> dict[str, int]:
        with self._db() as db:
            row = db.execute("SELECT * FROM starter_budget WHERE id = 1").fetchone()
            spent = db.execute("SELECT COALESCE(SUM(spent_atomic), 0), COALESCE(SUM(held_atomic), 0)"
                               " FROM starter_claims WHERE state = 'approved'").fetchone()
        return {"fundedAtomic": int(row["funded_atomic"]), "committedAtomic": int(row["committed_atomic"]),
                "grants": int(row["grants"]), "capAtomic": self.cap, "maxGrants": MAX_GRANTS,
                "uncommittedAtomic": min(int(row["funded_atomic"]), self.cap) - int(row["committed_atomic"]),
                "spentAtomic": int(spent[0]), "heldAtomic": int(spent[1])}

    def audit_log(self, limit: int = 50) -> list[sqlite3.Row]:
        with self._db() as db:
            return db.execute("SELECT * FROM starter_audit ORDER BY id DESC LIMIT ?",
                              (max(1, min(int(limit), 1000)),)).fetchall()

    def status(self, account: str, now: int) -> dict[str, Any]:
        """The account's own claim, for GET /starter-credit; nothing about anyone else."""
        row = self.claim_for(account)
        if row is None:
            return {"enabled": self.enabled, "claim": None}
        remaining = int(row["amount_atomic"]) - int(row["spent_atomic"]) - int(row["held_atomic"])
        live = row["state"] == "approved" and int(row["expires_at"] or 0) > now
        today = 0
        if live:
            with self._db() as db:
                used = db.execute("SELECT used_atomic FROM starter_daily WHERE claim_id = ? AND day = ?",
                                  (row["claim_id"], now // 86400)).fetchone()
            today = max(0, min(DAILY_ATOMIC - (int(used[0]) if used else 0), remaining))
        state = "expired" if row["state"] == "approved" and not live else row["state"]
        return {"enabled": self.enabled, "claim": {
            "id": row["claim_id"], "state": state, "githubLogin": row["github_login"],
            "requestedAt": row["requested_at"], "amountAtomic": int(row["amount_atomic"]),
            "spentAtomic": int(row["spent_atomic"]), "remainingAtomic": max(0, remaining) if live else 0,
            "spendableTodayAtomic": today, "expiresAt": row["expires_at"], "dailyAtomic": DAILY_ATOMIC,
            "maxRequestAtomic": MAX_REQUEST_ATOMIC}}

    # -- OAuth states --

    def new_state(self, account: str, now: int, binding: str = "") -> str:
        """A random OAuth state bound to `account`, good once for STATE_SECONDS. Only its sha256 is stored, and so
        is the sha256 of `binding`, the nonce the starting browser keeps in a cookie."""
        self._require_on()
        state = secrets.token_urlsafe(32)
        with self._write() as db:
            db.execute("DELETE FROM starter_oauth_states WHERE expires_at <= ? OR used = 1", (now,))
            db.execute("INSERT INTO starter_oauth_states(state_hash, account_id, expires_at, binding_hash)"
                       " VALUES (?, ?, ?, ?)",
                       (_sha256(state), account, now + STATE_SECONDS, _sha256(binding) if binding else None))
            self._log(db, now, "web", "oauth_start", account=account)
        return state

    def binding_matches(self, state: str, binding: str, now: int) -> bool | None:
        """Does `binding` (the callback browser's cookie) belong to a live `state`? None when the state is unknown,
        used or expired; otherwise True or False. Consumes nothing."""
        if not state or len(state) > 200:
            return None
        with self._db() as db:
            row = db.execute("SELECT binding_hash FROM starter_oauth_states WHERE state_hash = ? AND used = 0"
                             " AND expires_at > ?", (_sha256(state), now)).fetchone()
        if row is None:
            return None
        stored = row["binding_hash"]
        if not stored or not binding or len(binding) > 200:
            return False
        return hmac.compare_digest(stored, _sha256(binding))

    def consume_state(self, state: str, now: int) -> str | None:
        """The account a state was made for, once: a used, expired or unknown state answers None."""
        if not state or len(state) > 200:
            return None
        digest = _sha256(state)
        with self._write() as db:
            if not db.execute("UPDATE starter_oauth_states SET used = 1 WHERE state_hash = ? AND used = 0"
                              " AND expires_at > ?", (digest, now)).rowcount:
                return None
            row = db.execute("SELECT account_id FROM starter_oauth_states WHERE state_hash = ?", (digest,)).fetchone()
        return str(row["account_id"])

    # -- claims --

    def claim(self, account: str, github_id: int, github_login: str, github_created_at: int, now: int, *,
              actor: str = "web") -> sqlite3.Row:
        """A pending claim for `account` and this GitHub account; the same pair again returns the same claim.

        Refused when the account already claimed with another GitHub account, when this GitHub account claimed for
        another wallet (any state, rejected included), or when it is younger than MIN_GITHUB_AGE_DAYS. Never grants.
        """
        self._require_on()
        if type(github_id) is not int or github_id <= 0:
            raise self._refuse(now, actor, "github_unreadable", "GitHub did not say who you are.", account=account)
        if now - int(github_created_at) < MIN_GITHUB_AGE_DAYS * 86400:
            raise self._refuse(now, actor, "github_too_young",
                               f"Your GitHub account must be older than {MIN_GITHUB_AGE_DAYS} days.", account=account)
        refusal: tuple[str, str] | None = None
        with self._write() as db:
            mine = db.execute("SELECT * FROM starter_claims WHERE account_id = ?", (account,)).fetchone()
            theirs = db.execute("SELECT * FROM starter_claims WHERE github_id = ?", (github_id,)).fetchone()
            if mine is not None and int(mine["github_id"]) == github_id:
                self._log(db, now, actor, "claim_retry", claim_id=mine["claim_id"], account=account)
                return mine
            if mine is not None:
                refusal = ("account_already_claimed", "This wallet already claimed its starter credit.")
            elif theirs is not None:
                refusal = ("github_already_used", "This GitHub account already claimed starter credit.")
            else:
                claim_id = "sc_" + secrets.token_hex(12)
                try:
                    db.execute("INSERT INTO starter_claims(claim_id, account_id, github_id, github_login,"
                               " github_created_at, state, requested_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                               (claim_id, account, github_id, str(github_login)[:100], int(github_created_at), now))
                except sqlite3.IntegrityError:
                    refusal = ("duplicate", "Starter credit was already claimed.")
                else:
                    self._log(db, now, actor, "claim", claim_id=claim_id, account=account,
                              detail=f"github {github_login} ({github_id})")
                    return db.execute("SELECT * FROM starter_claims WHERE claim_id = ?", (claim_id,)).fetchone()
        raise self._refuse(now, actor, refusal[0], refusal[1], account=account)

    def approve(self, claim_id: str, by: str, now: int, recheck: Callable[[str], None]) -> sqlite3.Row:
        """Grants GRANT_ATOMIC to a pending claim, after `recheck(account)` (the allowance check) passes.

        The budget is reserved by one conditional UPDATE in the same transaction that flips the claim from pending,
        so concurrent approvals never commit past min(funded, cap) or MAX_GRANTS. Approving an approved claim
        returns it and reserves nothing.
        """
        self._require_on()
        row = self.get(claim_id)
        if row is None:
            raise StarterRefused("no_such_claim", "No such claim.")
        if row["state"] == "approved":
            self.audit(now, by, "approve_noop", claim_id=claim_id, account=row["account_id"])
            return row
        if row["state"] != "pending":
            raise self._refuse(now, by, "not_pending", f"The claim is {row['state']}.", claim_id=claim_id,
                               account=row["account_id"])
        try:
            recheck(str(row["account_id"]))
        except StarterCreditError as exc:
            raise self._refuse(now, by, exc.reason, exc.message, claim_id=claim_id, account=row["account_id"]) from None
        refusal: tuple[str, str] | None = None
        with self._write() as db:
            flipped = db.execute(
                "UPDATE starter_claims SET state = 'approved', amount_atomic = ?, approved_at = ?, expires_at = ?,"
                " decided_at = ?, decided_by = ? WHERE claim_id = ? AND state = 'pending'",
                (GRANT_ATOMIC, now, now + GRANT_SECONDS, now, str(by)[:64], claim_id)).rowcount
            if not flipped:
                current = db.execute("SELECT * FROM starter_claims WHERE claim_id = ?", (claim_id,)).fetchone()
                if current is not None and current["state"] == "approved":
                    self._log(db, now, by, "approve_noop", claim_id=claim_id, account=current["account_id"])
                    return current
                refusal = ("not_pending", "The claim is no longer pending.")
            elif not db.execute(
                    "UPDATE starter_budget SET committed_atomic = committed_atomic + ?, grants = grants + 1"
                    " WHERE id = 1 AND committed_atomic + ? <= MIN(funded_atomic, ?) AND grants < ?",
                    (GRANT_ATOMIC, GRANT_ATOMIC, self.cap, MAX_GRANTS)).rowcount:
                db.rollback()  # the claim stays pending
                refusal = ("budget_exhausted", "The starter budget is used up or not funded yet.")
            else:
                self._log(db, now, by, "approve", claim_id=claim_id, account=row["account_id"], amount=GRANT_ATOMIC,
                          detail=f"expires {now + GRANT_SECONDS}")
                return db.execute("SELECT * FROM starter_claims WHERE claim_id = ?", (claim_id,)).fetchone()
        raise self._refuse(now, by, refusal[0], refusal[1], claim_id=claim_id, account=row["account_id"],
                           error=BudgetExhausted if refusal[0] == "budget_exhausted" else StarterRefused)

    def reject(self, claim_id: str, by: str, reason: str, now: int) -> sqlite3.Row:
        """A pending claim is refused for good; its GitHub account and wallet stay used."""
        with self._write() as db:
            done = db.execute("UPDATE starter_claims SET state = 'rejected', decided_at = ?, decided_by = ?, reason = ?"
                              " WHERE claim_id = ? AND state = 'pending'",
                              (now, str(by)[:64], str(reason)[:300], claim_id)).rowcount
            row = db.execute("SELECT * FROM starter_claims WHERE claim_id = ?", (claim_id,)).fetchone()
            if done:
                self._log(db, now, by, "reject", claim_id=claim_id, account=row["account_id"], detail=reason)
                return row
        raise self._refuse(now, by, "not_pending", "No such pending claim.", claim_id=claim_id,
                           account=row["account_id"] if row else None)

    def fund(self, amount: int, by: str, ref: str, now: int) -> dict[str, int]:
        """Records that the operator put `amount` into the budget. The funded total never exceeds the cap."""
        self._require_on()
        if type(amount) is not int or amount <= 0:
            raise StarterRefused("bad_amount", "Fund a positive whole number of atomic USDC.")
        with self._write() as db:
            done = db.execute("UPDATE starter_budget SET funded_atomic = funded_atomic + ? WHERE id = 1"
                              " AND funded_atomic + ? <= ?", (amount, amount, self.cap)).rowcount
            if done:
                self._log(db, now, by, "fund", amount=amount, detail=ref)
        if not done:
            self.audit(now, by, "refused", amount=amount, detail=f"fund_over_cap {ref}")
            raise StarterRefused("fund_over_cap", f"Funding would exceed the cap of {self.cap} atomic USDC.")
        return self.budget()

    def withdraw(self, account: str, now: int, actor: str = "web") -> None:
        """Starter credit is never paid out, refunded or moved to the balance. Always raises, and is audited."""
        self.audit(now, actor, "refused", account=account, detail="withdraw")
        raise StarterCreditNotWithdrawable("not_withdrawable", "Starter credit can only be spent on SingIt API "
                                           "calls; it cannot be withdrawn or refunded.")

    refund = withdraw

    def expire(self, now: int) -> int:
        """Writes each grant that has expired to the audit log, once; returns how many."""
        with self._write() as db:
            rows = db.execute("SELECT * FROM starter_claims WHERE state = 'approved' AND expires_at <= ?"
                              " AND expired_logged_at IS NULL", (now,)).fetchall()
            for row in rows:
                db.execute("UPDATE starter_claims SET expired_logged_at = ? WHERE claim_id = ?", (now, row["claim_id"]))
                self._log(db, now, "system", "expire", claim_id=row["claim_id"], account=row["account_id"],
                          amount=int(row["amount_atomic"]) - int(row["spent_atomic"]), detail="unspent")
        return len(rows)

    # -- spending (the same hold / touch / release / bill shape as Balances, for Proxy.relay) --

    def hold(self, account: str, hold_id: str, amount: int, now: int) -> bool:
        """Sets `amount` aside from the account's grant for one request. False unless the feature is on, the request
        is small enough, the grant is approved and unexpired, it has that much left, and today's spending and holds
        stay within DAILY_ATOMIC."""
        if not self.enabled or type(amount) is not int or not 0 < amount <= MAX_REQUEST_ATOMIC:
            return False
        day = now // 86400
        self._sweep(now)
        with self._write() as db:
            row = db.execute("SELECT claim_id, state, expires_at FROM starter_claims WHERE account_id = ?",
                             (account,)).fetchone()
            if row is None or row["state"] != "approved":
                return False
            claim_id = row["claim_id"]
            if not db.execute("UPDATE starter_claims SET held_atomic = held_atomic + ? WHERE claim_id = ?"
                              " AND state = 'approved' AND expires_at > ?"
                              " AND amount_atomic - spent_atomic - held_atomic >= ?",
                              (amount, claim_id, now, amount)).rowcount:
                db.rollback()
                expired = int(row["expires_at"] or 0) <= now
            else:
                db.execute("INSERT OR IGNORE INTO starter_daily(claim_id, day) VALUES (?, ?)", (claim_id, day))
                if not db.execute("UPDATE starter_daily SET used_atomic = used_atomic + ?"
                                  " WHERE claim_id = ? AND day = ? AND used_atomic + ? <= ?",
                                  (amount, claim_id, day, amount, DAILY_ATOMIC)).rowcount:
                    db.rollback()
                    return False
                db.execute("INSERT INTO starter_holds(hold_id, claim_id, account_id, day, amount_atomic, created_at)"
                           " VALUES (?, ?, ?, ?, ?, ?)", (hold_id, claim_id, account, day, amount, now))
                self._log(db, now, "proxy", "hold", claim_id=claim_id, account=account, amount=amount, detail=hold_id)
                return True
        if expired:
            self.expire(now)
        return False

    def touch(self, hold_id: str, now: int) -> bool:
        with self._db() as db:
            return bool(db.execute("UPDATE starter_holds SET created_at = ? WHERE hold_id = ?",
                                   (now, hold_id)).rowcount)

    def release(self, hold_id: str, now: int | None = None) -> None:
        now = int(time.time()) if now is None else now
        with self._write() as db:
            self._settle(db, hold_id, None, 0, now, "release")

    def bill(self, account: str, hold_id: str, amount: int, now: int, *, beyond_hold: int = 0,
             key_id: str | None = None, model: str | None = None, ref: str | None = None, cost: int | None = None,
             input_tokens: int | None = None, output_tokens: int | None = None) -> tuple[int, int]:
        """Charges up to the hold, never beyond it (`beyond_hold` is ignored), lets the hold go, and returns what was
        billed and the grant's remaining credit. An unknown or settled hold bills nothing. A hold taken before the
        grant expired is still settled: the request was let through while the credit was live."""
        asked = amount if type(amount) is int and amount > 0 else 0
        detail = json.dumps({"hold": hold_id, "ref": ref, "key": key_id, "model": model, "cost": cost,
                             "in": input_tokens, "out": output_tokens}, separators=(",", ":"))
        with self._write() as db:
            billed = self._settle(db, hold_id, account, asked, now, "bill", detail)
            row = db.execute("SELECT amount_atomic - spent_atomic - held_atomic FROM starter_claims"
                             " WHERE account_id = ?",
                             (account,)).fetchone()
        return billed, int(row[0]) if row else 0

    def _settle(self, db: sqlite3.Connection, hold_id: str, account: str | None, asked: int, now: int, action: str,
                detail: str | None = None) -> int:
        """Drops one hold, spending `asked` of it (at most the hold) and giving the rest back to the grant and to
        that day's limit. Returns what was spent; 0 for a hold that is not there (or not this account's)."""
        hold = db.execute("SELECT * FROM starter_holds WHERE hold_id = ?", (hold_id,)).fetchone()
        if hold is None or (account is not None and hold["account_id"] != account):
            return 0
        if not db.execute("DELETE FROM starter_holds WHERE hold_id = ?", (hold_id,)).rowcount:
            return 0
        reserved = int(hold["amount_atomic"])
        billed = max(0, min(asked, reserved))
        db.execute("UPDATE starter_claims SET held_atomic = MAX(0, held_atomic - ?), spent_atomic = spent_atomic + ?"
                   " WHERE claim_id = ?", (reserved, billed, hold["claim_id"]))
        db.execute("UPDATE starter_daily SET used_atomic = MAX(0, used_atomic - ?) WHERE claim_id = ? AND day = ?",
                   (reserved - billed, hold["claim_id"], hold["day"]))
        self._log(db, now, "proxy", action, claim_id=hold["claim_id"], account=hold["account_id"],
                  amount=billed if action == "bill" else reserved, detail=detail or hold_id)
        return billed

    def _sweep(self, now: int) -> None:
        """Lets go of holds nobody touched for HOLD_SECONDS (a request that died without settling)."""
        with self._write() as db:
            for stale in db.execute("SELECT hold_id FROM starter_holds WHERE created_at < ?",
                                    (now - HOLD_SECONDS,)).fetchall():
                self._settle(db, stale["hold_id"], None, 0, now, "release", f"stale {stale['hold_id']}")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# -- eligibility --

def check_allowance(allowance: Any, account: str) -> None:
    """Raises StarterRefused unless `account` is a Base wallet account with its own live AgentAllowance: lane_for
    answers with an active limiter, its owner is this wallet, and the limiter's on-chain owner() is this wallet."""
    if chain_of_account(account) == "solana":
        raise StarterRefused("solana_not_supported", "Starter credit is for Base wallets only for now: Solana has no "
                             "on-chain limiter yet. Sign in with a Base wallet that has an AgentAllowance.")
    if not account.startswith(ACCOUNT_PREFIX) or allowance is None:
        raise StarterRefused("not_eligible", "Sign in with a Base wallet that has an AgentAllowance.")
    wallet = account[len(ACCOUNT_PREFIX):]
    try:
        lane = allowance.lane_for(account)
    except AllowanceError:
        lane = None
    if lane is None:
        raise StarterRefused("no_allowance", "Set up your AgentAllowance and grant it from your wallet first.")
    if str(lane["owner_address"]).lower() != wallet.lower():
        raise StarterRefused("foreign_owner", "Your limiter must be owned by the wallet you signed in with.")
    try:
        on_chain = allowance.evm.call_word(lane["limiter_address"], selector("owner()"))
    except (AllowanceError, OSError, ValueError):
        raise StarterRefused("allowance_unreadable", "Your limiter could not be read on Base. Try again.") from None
    if on_chain != int(wallet, 16):
        raise StarterRefused("foreign_owner", "Your limiter must be owned by the wallet you signed in with.")


# -- GitHub --

class GitHubError(Exception):
    """GitHub could not be asked. Never carries a token or code."""


REPO_PAGE_SIZE, REPO_PAGE_CAP = 100, 10


class GitHubOAuth:
    """The few GitHub calls the claim needs, over urllib with timeouts. The access token stays in the caller's
    memory: it is never stored, logged or put in an error."""

    AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
    TOKEN_URL = "https://github.com/login/oauth/access_token"
    API_URL = "https://api.github.com"

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, *, timeout: float = 10.0,
                 opener: Callable[..., Any] = urllib.request.urlopen):
        self.client_id, self._secret, self.redirect_uri = client_id, client_secret, redirect_uri
        self.timeout, self.opener = timeout, opener

    def __repr__(self) -> str:
        return f"GitHubOAuth(client_id={self.client_id!r})"

    def authorize_url(self, state: str) -> str:
        return self.AUTHORIZE_URL + "?" + urllib.parse.urlencode({
            "client_id": self.client_id, "redirect_uri": self.redirect_uri, "state": state, "scope": "read:user",
            "allow_signup": "false"})

    def _json(self, request: urllib.request.Request) -> Any:
        try:
            with self.opener(request, timeout=self.timeout) as response:
                return json.loads(response.read(2_000_000))
        except urllib.error.HTTPError as error:
            error.close()
            raise GitHubError(f"GitHub answered HTTP {error.code}") from None
        except (OSError, ValueError) as error:
            raise GitHubError(f"GitHub could not be read ({type(error).__name__})") from None

    def exchange(self, code: str) -> str:
        data = urllib.parse.urlencode({"client_id": self.client_id, "client_secret": self._secret, "code": code,
                                       "redirect_uri": self.redirect_uri}).encode()
        reply = self._json(urllib.request.Request(self.TOKEN_URL, data=data, method="POST", headers={
            "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "SingIt-starter-credit"}))
        token = reply.get("access_token") if isinstance(reply, dict) else None
        if not isinstance(token, str) or not token:
            raise GitHubError("GitHub did not exchange the code")
        return token

    def _get(self, token: str, path: str) -> Any:
        return self._json(urllib.request.Request(self.API_URL + path, method="GET", headers={
            "Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SingIt-starter-credit"}))

    def user(self, token: str) -> dict[str, Any]:
        reply = self._get(token, "/user")
        if not isinstance(reply, dict):
            raise GitHubError("GitHub answered /user unexpectedly")
        return reply

    def iter_repos(self, token: str) -> Iterator[dict[str, Any]]:
        """The user's owned repositories, page by page (stops at a short page or REPO_PAGE_CAP pages)."""
        for page in range(1, REPO_PAGE_CAP + 1):
            reply = self._get(token, f"/user/repos?type=owner&per_page={REPO_PAGE_SIZE}&page={page}")
            if not isinstance(reply, list):
                raise GitHubError("GitHub answered /user/repos unexpectedly")
            yield from (r for r in reply if isinstance(r, dict))
            if len(reply) < REPO_PAGE_SIZE:
                return

    def repos(self, token: str) -> list[dict[str, Any]]:
        return list(self.iter_repos(token))

    def has_original_repo(self, token: str, github_id: int) -> bool:
        """True as soon as one public, non-fork repository owned by github_id turns up."""
        return any(is_original_repo(r, github_id) for r in self.iter_repos(token))


def is_original_repo(repo: Mapping[str, Any], github_id: int) -> bool:
    return (repo.get("fork") is False and repo.get("private") is False
            and (repo.get("owner") or {}).get("id", github_id) == github_id)


def github_from_env(env: Mapping[str, str], redirect_uri: str) -> GitHubOAuth | None:
    client_id = str(env.get(CLIENT_ID_ENV, "") or "").strip()
    secret = str(env.get(CLIENT_SECRET_ENV, "") or "").strip()
    return GitHubOAuth(client_id, secret, redirect_uri) if client_id and secret else None


def _github_time(value: Any) -> int | None:
    """GitHub's `created_at` ("2015-01-01T00:00:00Z") as unix time; None when it is not a UTC timestamp."""
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(moment.timestamp()) if moment.tzinfo is not None else None


# -- the web routes (behind WebApi.handle) --

class StarterWeb:
    """/web/v1/starter-credit: start the GitHub link, its callback, and the account's own state.

    The callback runs without the session cookie (SameSite=Strict is not sent on GitHub's redirect back): the
    single-use OAuth state, made for one signed-in account, is what ties it to that account.
    """

    def __init__(self, credit: StarterCredit, allowance: Any, github: GitHubOAuth | None, redirect: str, *,
                 now: Callable[[], float] = time.time, checker: Callable[[Any, str], None] = check_allowance):
        from .web_api import RateLimit  # noqa: PLC0415 - web_api imports this module lazily

        self.credit, self.allowance, self.github, self.redirect = credit, allowance, github, redirect.rstrip("?")
        self.now, self.checker = now, checker
        self.start_by_account = RateLimit(10, 3600)
        self.status_by_account = RateLimit(120, 3600)
        self.callback_by_ip = RateLimit(20, 600)

    def recheck(self, account: str) -> None:
        self.checker(self.allowance, account)

    def _configured(self) -> None:
        if self.github is None or not self.redirect:
            from .web_api import WebError  # noqa: PLC0415
            raise WebError(503, "starter_credit_unconfigured", "Starter credit is not configured on this server.")

    @staticmethod
    def _cookie_path() -> str:
        from .web_api import PREFIX  # noqa: PLC0415
        return PREFIX + CALLBACK_PATH

    def handle(self, method: str, path: str, account: str) -> tuple[int, dict[str, Any], dict[str, str]]:
        from .web_api import WebError  # noqa: PLC0415

        now = int(self.now())
        if not self.credit.enabled:
            raise WebError(404, "starter_credit_off", "Starter credit is not available.")
        try:
            if method == "GET" and path == "/starter-credit":
                self.status_by_account.hit(account)
                return 200, self.credit.status(account, now), {}
            if method == "POST" and path in ("/starter-credit/refund", "/starter-credit/withdraw"):
                self.credit.withdraw(account, now)
            if method == "POST" and path == "/starter-credit/github/start":
                self._configured()
                self.start_by_account.hit(account)
                try:
                    self.recheck(account)
                except StarterCreditError as exc:
                    raise self.credit._refuse(now, "web", exc.reason, exc.message, account=account,
                                              error=type(exc)) from None
                if self.credit.claim_for(account) is not None:
                    raise WebError(409, "already_claimed", "This wallet already claimed its starter credit.")
                nonce = secrets.token_urlsafe(32)  # kept by this browser only; the server keeps its sha256
                url = self.github.authorize_url(self.credit.new_state(account, now, nonce))
                cookie = (f"{BINDING_COOKIE}={nonce}; Path={self._cookie_path()}; Max-Age={STATE_SECONDS}; "
                          "HttpOnly; Secure; SameSite=Lax")  # Lax: GitHub's redirect back is a cross-site GET
                return 200, {"url": url}, {"Set-Cookie": cookie}
        except StarterCreditError as exc:
            raise WebError(exc.status, exc.reason, exc.message) from None
        raise WebError(404, "not_found", "No such endpoint.")

    def callback(self, query: Mapping[str, Any], client: str, binding: str = "") -> tuple[int, dict[str, Any], dict[str, str]]:
        """GitHub's redirect back: answered with a redirect to the app page, `?starter=pending` or
        `?starter=refused&reason=<code>`. Only `code` and `state` are read from the query; anything else the client
        adds (a created_at, a login) is ignored. `binding` is the browser's OAuth cookie: it must match the one the
        state was started with, or the link was begun in another browser and nothing is consumed or asked of GitHub."""
        from .web_api import WebError  # noqa: PLC0415

        if not self.credit.enabled:
            raise WebError(404, "starter_credit_off", "Starter credit is not available.")
        self._configured()
        now = int(self.now())
        account: str | None = None
        try:
            try:
                self.callback_by_ip.hit(client)
            except WebError:
                raise StarterRefused("rate_limited") from None
            code, state = str(query.get("code") or ""), str(query.get("state") or "")
            bound = self.credit.binding_matches(state, binding, now)
            if bound is False:
                raise self.credit._refuse(now, "web", "browser_mismatch",
                                          "Finish the link in the browser where you started it.")
            account = self.credit.consume_state(state, now) if bound else None
            if account is None:
                raise self.credit._refuse(now, "web", "bad_state", "The link expired. Start again from the app.")
            if not code or len(code) > 200:
                raise self.credit._refuse(now, "web", "no_code", "GitHub sent no code.", account=account)
            try:
                token = self.github.exchange(code)
                user = self.github.user(token)
                github_id = user.get("id")
                has_repo = (type(github_id) is int and github_id > 0
                            and self.github.has_original_repo(token, github_id))
            except GitHubError as exc:
                logger.warning("starter credit: GitHub lookup failed for %s: %s", short_account(account), exc)
                raise self.credit._refuse(now, "web", "github_unavailable", "GitHub could not be asked.",
                                          account=account) from None
            finally:
                token = None  # noqa: F841 - dropped as soon as GitHub has answered
            login = str(user.get("login") or "")
            created = _github_time(user.get("created_at"))
            if type(github_id) is not int or github_id <= 0 or created is None:
                raise self.credit._refuse(now, "web", "github_unreadable", "GitHub did not say who you are.",
                                          account=account)
            if now - created < MIN_GITHUB_AGE_DAYS * 86400:
                raise self.credit._refuse(now, "web", "github_too_young", "Your GitHub account is too new.",
                                          account=account)
            if not has_repo:
                raise self.credit._refuse(now, "web", "no_public_repo",
                                          "Your GitHub account needs a public repository of its own (not a fork).",
                                          account=account)
            try:
                self.recheck(account)
            except StarterCreditError as exc:
                raise self.credit._refuse(now, "web", exc.reason, exc.message, account=account) from None
            row = self.credit.claim(account, github_id, login, created, now)
            logger.info("starter credit: claim %s pending for %s", row["claim_id"], short_account(account))
            return self._back(now, "pending")
        except StarterCreditError as exc:
            logger.info("starter credit: claim refused (%s) for %s", exc.reason, short_account(account))
            return self._back(now, "refused", exc.reason)

    def _back(self, now: int, outcome: str, reason: str | None = None) -> tuple[int, dict[str, Any], dict[str, str]]:
        params = {"starter": outcome, **({"reason": reason} if reason else {})}
        sep = "&" if "?" in self.redirect else "?"
        return 302, {"ok": outcome == "pending", **params}, {
            "Location": self.redirect + sep + urllib.parse.urlencode(params), "Referrer-Policy": "no-referrer",
            "Set-Cookie": f"{BINDING_COOKIE}=; Path={self._cookie_path()}; Max-Age=0; HttpOnly; Secure; SameSite=Lax"}


def web_from_env(store_path: Path, allowance: Any, env: Mapping[str, str], public_uri: str, prefix: str,
                 now: Callable[[], float] = time.time) -> StarterWeb | None:
    """The routes when SIGN402_STARTER_CREDIT=1, else None (the feature is OFF and every route answers 404)."""
    if not enabled_from_env(env):
        return None
    credit = StarterCredit.from_env(store_path, env)
    github = github_from_env(env, public_uri.rstrip("/") + prefix + CALLBACK_PATH)
    redirect = str(env.get(REDIRECT_ENV, "") or "").strip()
    if github is None or not redirect:
        logger.warning("starter credit: on, but %s, %s and %s are not all set; its routes answer 503",
                       CLIENT_ID_ENV, CLIENT_SECRET_ENV, REDIRECT_ENV)
    return StarterWeb(credit, allowance, github, redirect, now=now)


# -- the operator's CLI --

USAGE = """usage: python -m sign402_gateway.starter_credit COMMAND
  queue                                    pending claims
  approve <claim_id> --by <name>           grant $1 (needs SIGN402_STARTER_CREDIT=1, a funded budget, a live allowance)
  reject <claim_id> --by <name> --reason <text>
  fund <atomic> --by <name> --ref <note>   record money put into the budget (never past the cap)
  budget                                   funded, committed, grants, spent
  audit [--limit N]                        the latest audit entries"""


def _options(args: list[str], *names: str) -> dict[str, str] | None:
    found: dict[str, str] = {}
    rest = list(args)
    while rest:
        flag = rest.pop(0)
        if flag not in names or not rest:
            return None
        found[flag] = rest.pop(0)
    return found


def _default_recheck(env: Mapping[str, str]) -> Callable[[str], None]:
    """The same allowance lane web-api loads, from the same environment."""
    from .agent_allowance import build_allowance_service_from_env  # noqa: PLC0415
    from .keyring import load_master_key  # noqa: PLC0415

    allowance = build_allowance_service_from_env(load_master_key(), env)
    if allowance is None:
        raise StarterRefused("no_allowance_lane", "The allowance lane is off (SIGN402_ALLOWANCE_ENABLED != 1).")
    return lambda account: check_allowance(allowance, account)


def main(argv: list[str] | None = None, *, env: Mapping[str, str] | None = None,
         recheck: Callable[[str], None] | None = None, now: Callable[[], float] = time.time) -> int:
    import sys  # noqa: PLC0415

    from .web_accounts import DEFAULT_WEB_DB, WEB_DB_ENV  # noqa: PLC0415

    values = os.environ if env is None else env
    args = sys.argv[1:] if argv is None else list(argv)
    credit = StarterCredit.from_env(Path(str(values.get(WEB_DB_ENV, "") or DEFAULT_WEB_DB)).expanduser(), values)
    moment = int(now())
    command, rest = (args[0], args[1:]) if args else ("", [])
    try:
        if command == "queue" and not rest:
            for row in credit.pending():
                age = (moment - int(row["github_created_at"])) // 86400
                print(row["claim_id"], row["github_login"], f"{age}d", short_account(row["account_id"]),
                      time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(row["requested_at"])))
            return 0
        if command == "budget" and not rest:
            if credit.enabled:
                credit.expire(moment)
            for key, value in credit.budget().items():
                print(f"{key}: {value}")
            return 0
        if command == "audit":
            options = _options(rest, "--limit")
            if options is None or not options.get("--limit", "50").isdigit():
                print(USAGE)
                return 2
            for row in reversed(credit.audit_log(int(options.get("--limit", "50")))):
                print(row["id"], time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(row["at"])), row["actor"],
                      row["action"],
                      row["claim_id"] or "-", short_account(row["account_id"]) if row["account_id"] else "-",
                      row["amount_atomic"] if row["amount_atomic"] is not None else "-", row["detail"] or "")
            return 0
        if command == "approve" and rest:
            options = _options(rest[1:], "--by")
            if options is None or not options.get("--by"):
                print(USAGE)
                return 2
            credit._require_on()
            row = credit.approve(rest[0], options["--by"], moment, recheck or _default_recheck(values))
            print("approved", row["claim_id"], short_account(row["account_id"]), f"{row['amount_atomic']} atomic",
                  "expires", time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(row["expires_at"])))
            return 0
        if command == "reject" and rest:
            options = _options(rest[1:], "--by", "--reason")
            if options is None or not options.get("--by") or not options.get("--reason"):
                print(USAGE)
                return 2
            row = credit.reject(rest[0], options["--by"], options["--reason"], moment)
            print("rejected", row["claim_id"], short_account(row["account_id"]))
            return 0
        if command == "fund" and rest and rest[0].isdigit():
            options = _options(rest[1:], "--by", "--ref")
            if options is None or not options.get("--by") or not options.get("--ref"):
                print(USAGE)
                return 2
            budget = credit.fund(int(rest[0]), options["--by"], options["--ref"], moment)
            print("funded", budget["fundedAtomic"], "of cap", budget["capAtomic"])
            return 0
    except StarterCreditError as exc:
        print(f"refused: {exc.reason}: {exc.message}", file=sys.stderr)
        return 1
    print(USAGE)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
