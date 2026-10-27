"""Starter credit: $1 for up to 20 vetted users, from a $20 budget, approved by hand, spent only on small API calls.

Offline: a fake GitHub, a fake allowance lane and chain, a fake Surplus. Addresses are obviously fake test values.
"""
import http.client
import io
import json
import logging
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from eth_account import Account
from eth_account.messages import encode_defunct

from sign402_gateway import starter_credit as sc
from sign402_gateway import web_api as wa
from sign402_gateway import web_api_proxy
from sign402_gateway.agent_allowance import AllowanceError, selector
from sign402_gateway.starter_credit import (
    DAILY_ATOMIC, GRANT_ATOMIC, HARD_CAP_ATOMIC, BudgetExhausted, StarterCredit, StarterCreditNotWithdrawable,
    StarterCreditOff, StarterRefused, StarterWeb, check_allowance,
)
from sign402_gateway.web_accounts import WebAccountStore, WebAuth, account_id_for
from sign402_gateway.web_api_keys import ApiError
from sign402_gateway.web_api_proxy import Proxy
from sign402_gateway.web_balance import Balances, new_topup_id

NOW = 1_800_000_000
DAY = 86400
DOMAIN, URI = "app.singit.test", "https://app.singit.test"
REDIRECT = "https://app.singit.test/app/"
OLD = "2020-01-01T00:00:00Z"
TOKEN = "gho_FAKE_TEST_TOKEN_never_logged"
CODE = "FAKE_OAUTH_CODE_never_logged"
OPUS = {"id": "claude-opus-5.5", "label": "Opus", "provider": "anthropic", "input": 5.0, "output": 25.0}


def wallet(n: int) -> str:
    return "0x" + format(n, "040x")


def account(n: int) -> str:
    return "wallet:" + wallet(n)


def iso(moment: int) -> str:
    return datetime.fromtimestamp(moment, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sign(signer, message):
    return Account.sign_message(encode_defunct(text=message), signer.key).signature.to_0x_hex()


class FakeEvm:
    def __init__(self):
        self.owners: dict[str, int] = {}

    def call_word(self, to, data):
        assert data == selector("owner()")
        if to not in self.owners:
            raise AllowanceError("no answer")
        return self.owners[to]


class FakeAllowance:
    """lane_for as agent_allowance answers it: a row, None (no limiter), or AllowanceError (paused, expired,
    nothing granted)."""

    def __init__(self):
        self.evm = FakeEvm()
        self.lanes: dict[str, dict] = {}
        self.broken: dict[str, str] = {}

    def give(self, acct: str, *, owner: str | None = None, on_chain: str | None = None) -> None:
        address = acct.split(":", 1)[1]
        limiter = "0x" + "ee" * 19 + address[-2:]
        self.lanes[acct] = {"owner_address": owner or address, "limiter_address": limiter,
                            "per_purchase_cap": 5_000_000, "expiry": NOW + 90 * DAY}
        self.evm.owners[limiter] = int(on_chain or address, 16)

    def lane_for(self, acct):
        if acct in self.broken:
            raise AllowanceError(self.broken[acct])
        return self.lanes.get(acct)


class FakeGitHub:
    def __init__(self, gid=4242, login="octo", created=OLD, repos=None):
        self.gid, self.login, self.created = gid, login, created
        self.repo_list = [{"fork": False, "private": False, "owner": {"id": gid}}] if repos is None else repos
        self.codes: list[str] = []

    def authorize_url(self, state):
        return "https://github.com/login/oauth/authorize?state=" + state

    def exchange(self, code):
        self.codes.append(code)
        return TOKEN

    def user(self, token):
        assert token == TOKEN
        return {"id": self.gid, "login": self.login, "created_at": self.created}

    def repos(self, token):
        assert token == TOKEN
        return self.repo_list


def audit_actions(credit):
    return [(r["action"], r["detail"]) for r in reversed(credit.audit_log(1000))]


class StoreFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "web.db"
        self.credit = StarterCredit(self.path, enabled=True)
        self.allowance = FakeAllowance()
        self.recheck = lambda acct: check_allowance(self.allowance, acct)

    def pending(self, n, gid=None):
        self.allowance.give(account(n))
        return self.credit.claim(account(n), gid or 1000 + n, f"user{n}", NOW - 400 * DAY, NOW)

    def granted(self, n=1, fund=HARD_CAP_ATOMIC):
        if self.credit.budget()["fundedAtomic"] == 0:
            self.credit.fund(fund, "kostya", "test", NOW)
        row = self.pending(n)
        return self.credit.approve(row["claim_id"], "kostya", NOW, self.recheck)


class ClaimTests(StoreFixture):
    def test_a_claim_waits_pending_and_nothing_grants_it(self):
        row = self.pending(1)
        self.assertEqual((row["state"], row["amount_atomic"]), ("pending", 0))
        self.assertFalse(self.credit.hold(account(1), "hold_a", 10_000, NOW))
        self.assertEqual(self.credit.status(account(1), NOW)["claim"]["state"], "pending")

    def test_claiming_again_with_the_same_github_returns_the_same_claim(self):
        first = self.pending(1)
        again = self.credit.claim(account(1), 1001, "user1", NOW - 400 * DAY, NOW + 5)
        self.assertEqual(first["claim_id"], again["claim_id"])
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM starter_claims").fetchone()[0], 1)

    def test_one_wallet_one_github(self):
        self.pending(1)
        with self.assertRaises(StarterRefused) as caught:
            self.credit.claim(account(1), 9999, "other", NOW - 400 * DAY, NOW)
        self.assertEqual(caught.exception.reason, "account_already_claimed")

    def test_sybil_same_github_two_wallets_is_refused_and_audited(self):
        self.pending(1, gid=77)
        with self.assertRaises(StarterRefused) as caught:
            self.pending(2, gid=77)
        self.assertEqual(caught.exception.reason, "github_already_used")
        self.assertIn(("refused", "github_already_used"), audit_actions(self.credit))
        self.assertIsNone(self.credit.claim_for(account(2)))

    def test_a_rejected_claim_still_uses_up_the_github_and_the_wallet(self):
        row = self.pending(1, gid=77)
        self.credit.reject(row["claim_id"], "kostya", "spam", NOW)
        with self.assertRaises(StarterRefused):
            self.pending(2, gid=77)
        with self.assertRaises(StarterRefused):
            self.credit.claim(account(1), 78, "again", NOW - 400 * DAY, NOW)

    def test_a_young_github_is_refused(self):
        with self.assertRaises(StarterRefused) as caught:
            self.credit.claim(account(1), 5, "new", NOW - 181 * DAY, NOW)
        self.assertEqual(caught.exception.reason, "github_too_young")

    def test_off_refuses_claims_holds_approvals_and_funding(self):
        off = StarterCredit(self.path)
        self.assertFalse(off.enabled)
        with self.assertRaises(StarterCreditOff):
            off.claim(account(1), 5, "x", NOW - 400 * DAY, NOW)
        with self.assertRaises(StarterCreditOff):
            off.fund(1_000_000, "kostya", "x", NOW)
        row = self.granted(1)
        with self.assertRaises(StarterCreditOff):
            off.approve(row["claim_id"], "kostya", NOW, self.recheck)
        self.assertFalse(off.hold(account(1), "hold_a", 10_000, NOW))


class EligibilityTests(StoreFixture):
    def assertRefused(self, acct, reason):
        with self.assertRaises(StarterRefused) as caught:
            check_allowance(self.allowance, acct)
        self.assertEqual(caught.exception.reason, reason)

    def test_own_live_limiter_passes(self):
        self.allowance.give(account(1))
        check_allowance(self.allowance, account(1))
        self.allowance.give(account(2))
        check_allowance(self.allowance, "wallet:" + wallet(2).upper().replace("0X", "0x"))  # case-insensitive

    def test_what_is_refused(self):
        self.assertRefused(account(1), "no_allowance")  # no limiter at all
        self.allowance.give(account(2))
        self.allowance.broken[account(2)] = "Your allowance is paused."
        self.assertRefused(account(2), "no_allowance")
        self.allowance.give(account(3), owner=wallet(99))
        self.assertRefused(account(3), "foreign_owner")
        self.allowance.give(account(4), on_chain=wallet(99))
        self.assertRefused(account(4), "foreign_owner")
        self.assertRefused("solana:FakeSo1anaAddress111111111111111111111111", "solana_not_supported")

    def test_approval_rechecks_the_allowance(self):
        self.credit.fund(HARD_CAP_ATOMIC, "kostya", "test", NOW)
        for n, breaks in ((1, lambda: self.allowance.broken.__setitem__(account(1), "paused")),
                          (2, lambda: self.allowance.give(account(2), on_chain=wallet(99))),
                          (3, lambda: self.allowance.give(account(3), owner=wallet(99))),
                          (4, lambda: self.allowance.lanes.pop(account(4)))):
            with self.subTest(n):
                row = self.pending(n)
                breaks()
                with self.assertRaises(StarterRefused):
                    self.credit.approve(row["claim_id"], "kostya", NOW, self.recheck)
                self.assertEqual(self.credit.get(row["claim_id"])["state"], "pending")
        self.assertEqual(self.credit.budget()["grants"], 0)


class BudgetTests(StoreFixture):
    def test_nothing_is_approved_before_funding(self):
        row = self.pending(1)
        with self.assertRaises(BudgetExhausted):
            self.credit.approve(row["claim_id"], "kostya", NOW, self.recheck)
        self.assertEqual(self.credit.get(row["claim_id"])["state"], "pending")
        self.assertIn(("refused", "budget_exhausted"), audit_actions(self.credit))

    def test_funding_never_passes_the_cap(self):
        self.credit.fund(15_000_000, "kostya", "a", NOW)
        with self.assertRaises(StarterRefused) as caught:
            self.credit.fund(5_000_001, "kostya", "b", NOW)
        self.assertEqual(caught.exception.reason, "fund_over_cap")
        self.credit.fund(5_000_000, "kostya", "c", NOW)
        with self.assertRaises(StarterRefused):
            self.credit.fund(1, "kostya", "d", NOW)
        self.assertEqual(self.credit.budget()["fundedAtomic"], HARD_CAP_ATOMIC)

    def test_env_may_lower_the_cap_and_never_raise_it(self):
        self.assertEqual(sc.cap_from_env({sc.CAP_ENV: "50000000"}), HARD_CAP_ATOMIC)
        self.assertEqual(sc.cap_from_env({sc.CAP_ENV: "garbage"}), HARD_CAP_ATOMIC)
        self.assertEqual(sc.cap_from_env({sc.CAP_ENV: "5000000"}), 5_000_000)
        self.assertEqual(StarterCredit(self.path, enabled=True, cap_atomic=10 ** 9).cap, HARD_CAP_ATOMIC)
        high = StarterCredit.from_env(self.path, {sc.ENABLED_ENV: "1", sc.CAP_ENV: "100000000"})
        with self.assertRaises(StarterRefused):
            high.fund(HARD_CAP_ATOMIC + 1, "kostya", "x", NOW)
        low = StarterCredit.from_env(self.path, {sc.ENABLED_ENV: "1", sc.CAP_ENV: "2000000"})
        with self.assertRaises(StarterRefused):
            low.fund(2_000_001, "kostya", "x", NOW)

    def test_approving_twice_reserves_once(self):
        row = self.granted(1)
        again = self.credit.approve(row["claim_id"], "kostya", NOW + 9, self.recheck)
        self.assertEqual((again["state"], again["approved_at"]), ("approved", NOW))
        budget = self.credit.budget()
        self.assertEqual((budget["grants"], budget["committedAtomic"]), (1, GRANT_ATOMIC))
        self.assertEqual(row["expires_at"], NOW + 7 * DAY)

    def race(self, funded, claims=25, threads=25):
        self.credit.fund(funded, "kostya", "race", NOW)
        ids = [self.pending(n)["claim_id"] for n in range(1, claims + 1)]
        barrier = threading.Barrier(threads)
        outcomes = []

        def approve(claim_id):
            mine = StarterCredit(self.path, enabled=True)
            barrier.wait()
            try:
                mine.approve(claim_id, "kostya", NOW, self.recheck)
                outcomes.append("ok")
            except BudgetExhausted:
                outcomes.append("budget")

        workers = [threading.Thread(target=approve, args=(i,)) for i in ids[:threads]]
        for w in workers:
            w.start()
        for w in workers:
            w.join(30)
        return outcomes

    def test_concurrent_approvals_never_pass_the_budget(self):
        outcomes = self.race(HARD_CAP_ATOMIC)
        self.assertEqual((outcomes.count("ok"), outcomes.count("budget")), (20, 5))
        budget = self.credit.budget()
        self.assertEqual((budget["grants"], budget["committedAtomic"]), (20, 20_000_000))
        with closing(sqlite3.connect(self.path)) as db, db:
            approved = db.execute("SELECT COUNT(*) FROM starter_claims WHERE state = 'approved'").fetchone()[0]
        self.assertEqual(approved, 20)

    def test_concurrent_approvals_stop_at_what_was_funded(self):
        outcomes = self.race(3_000_000, claims=10, threads=10)
        self.assertEqual(outcomes.count("ok"), 3)
        self.assertEqual(self.credit.budget()["committedAtomic"], 3_000_000)

    def test_rejecting_needs_a_pending_claim(self):
        row = self.granted(1)
        with self.assertRaises(StarterRefused):
            self.credit.reject(row["claim_id"], "kostya", "late", NOW)


class SpendingTests(StoreFixture):
    def test_a_day_spends_at_most_its_quarter_and_the_next_day_more(self):
        self.granted(1)
        for i in range(5):
            self.assertTrue(self.credit.hold(account(1), f"hold_{i}", 50_000, NOW))
            self.assertEqual(self.credit.bill(account(1), f"hold_{i}", 50_000, NOW)[0], 50_000)
        self.assertFalse(self.credit.hold(account(1), "hold_x", 1, NOW))
        self.assertEqual(self.credit.status(account(1), NOW)["claim"]["spendableTodayAtomic"], 0)
        tomorrow = (NOW // DAY + 1) * DAY
        self.assertTrue(self.credit.hold(account(1), "hold_y", 50_000, tomorrow))
        self.assertEqual(self.credit.status(account(1), tomorrow)["claim"]["spendableTodayAtomic"],
                         DAILY_ATOMIC - 50_000)

    def test_a_bill_gives_back_what_it_did_not_use(self):
        self.granted(1)
        self.assertTrue(self.credit.hold(account(1), "hold_a", 50_000, NOW))
        billed, remaining = self.credit.bill(account(1), "hold_a", 80_000, NOW)
        self.assertEqual((billed, remaining), (50_000, GRANT_ATOMIC - 50_000))  # never beyond the hold
        self.assertTrue(self.credit.hold(account(1), "hold_b", 40_000, NOW))
        self.assertEqual(self.credit.bill(account(1), "hold_b", 1_000, NOW)[0], 1_000)
        status = self.credit.status(account(1), NOW)["claim"]
        self.assertEqual((status["spentAtomic"], status["spendableTodayAtomic"]), (51_000, DAILY_ATOMIC - 51_000))

    def test_an_unknown_or_settled_hold_bills_nothing(self):
        self.granted(1)
        self.assertEqual(self.credit.bill(account(1), "hold_nope", 10_000, NOW)[0], 0)
        self.assertTrue(self.credit.hold(account(1), "hold_a", 10_000, NOW))
        self.assertEqual(self.credit.bill(account(2), "hold_a", 10_000, NOW)[0], 0)  # not this account's hold
        self.assertEqual(self.credit.bill(account(1), "hold_a", 10_000, NOW)[0], 10_000)
        self.assertEqual(self.credit.bill(account(1), "hold_a", 10_000, NOW)[0], 0)
        self.credit.release("hold_a")
        self.assertEqual(self.credit.claim_for(account(1))["spent_atomic"], 10_000)

    def test_a_big_request_is_not_served(self):
        self.granted(1)
        self.assertFalse(self.credit.hold(account(1), "hold_a", 50_001, NOW))
        self.assertTrue(self.credit.hold(account(1), "hold_b", 50_000, NOW))

    def test_concurrent_holds_stay_within_the_day_and_the_grant(self):
        self.granted(1)
        results = []
        barrier = threading.Barrier(20)

        def take(i):
            mine = StarterCredit(self.path, enabled=True)
            barrier.wait()
            results.append(mine.hold(account(1), f"hold_{i}", 40_000, NOW))

        workers = [threading.Thread(target=take, args=(i,)) for i in range(20)]
        for w in workers:
            w.start()
        for w in workers:
            w.join(30)
        self.assertEqual(results.count(True), 6)  # 240_000 of 250_000
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT used_atomic FROM starter_daily").fetchone()[0], 240_000)
            self.assertEqual(db.execute("SELECT held_atomic FROM starter_claims").fetchone()[0], 240_000)

    def test_concurrent_holds_stay_within_what_the_grant_has_left(self):
        self.granted(1)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE starter_claims SET spent_atomic = ?", (GRANT_ATOMIC - 40_000,))
        results = []
        barrier = threading.Barrier(10)

        def take(i):
            mine = StarterCredit(self.path, enabled=True)
            barrier.wait()
            results.append(mine.hold(account(1), f"hold_{i}", 30_000, NOW))

        workers = [threading.Thread(target=take, args=(i,)) for i in range(10)]
        for w in workers:
            w.start()
        for w in workers:
            w.join(30)
        self.assertEqual(results.count(True), 1)

    def test_a_grant_expires_after_seven_days_and_is_audited_once(self):
        row = self.granted(1)
        self.assertTrue(self.credit.hold(account(1), "hold_a", 10_000, row["expires_at"] - 1))
        self.assertFalse(self.credit.hold(account(1), "hold_b", 10_000, row["expires_at"]))
        self.assertFalse(self.credit.hold(account(1), "hold_c", 10_000, row["expires_at"] + DAY))
        self.assertEqual([a for a, _ in audit_actions(self.credit)].count("expire"), 1)
        self.assertEqual(self.credit.status(account(1), row["expires_at"])["claim"]["state"], "expired")
        self.assertEqual(self.credit.budget()["committedAtomic"], GRANT_ATOMIC, "unspent credit is not returned")

    def test_a_forgotten_hold_is_let_go(self):
        self.granted(1)
        for i in range(5):
            self.assertTrue(self.credit.hold(account(1), f"hold_{i}", 50_000, NOW))
        self.assertFalse(self.credit.hold(account(1), "hold_x", 50_000, NOW + 60))
        self.credit.touch("hold_0", NOW + 600)
        self.assertTrue(self.credit.hold(account(1), "hold_y", 50_000, NOW + sc.HOLD_SECONDS + 1))
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM starter_holds").fetchone()[0], 2)

    def test_it_cannot_be_withdrawn_and_never_joins_the_balance(self):
        self.granted(1)
        for attempt in (self.credit.withdraw, self.credit.refund):
            with self.assertRaises(StarterCreditNotWithdrawable):
                attempt(account(1), NOW)
        self.assertEqual([d for a, d in audit_actions(self.credit) if a == "refused"], ["withdraw", "withdraw"])
        balances = Balances(self.path)
        self.assertEqual(balances.state(account(1))["balanceAtomic"], 0)
        balances.request_refund(account(1), NOW)
        self.assertEqual(balances.state(account(1))["balanceAtomic"], 0)
        self.assertEqual(balances.ledger(account(1)), [])
        self.assertEqual(self.credit.claim_for(account(1))["amount_atomic"], GRANT_ATOMIC)

    def test_every_action_is_audited(self):
        row = self.granted(1)
        other = self.pending(2)
        self.credit.reject(other["claim_id"], "kostya", "dupe", NOW)
        self.credit.hold(account(1), "hold_a", 10_000, NOW)
        self.credit.bill(account(1), "hold_a", 5_000, NOW)
        self.credit.hold(account(1), "hold_b", 10_000, NOW)
        self.credit.release("hold_b")
        actions = [a for a, _ in audit_actions(self.credit)]
        for expected in ("fund", "claim", "approve", "reject", "hold", "bill", "release"):
            self.assertIn(expected, actions)
        approve = [r for r in self.credit.audit_log(100) if r["action"] == "approve"][0]
        self.assertEqual((approve["actor"], approve["claim_id"], approve["amount_atomic"]),
                         ("kostya", row["claim_id"], GRANT_ATOMIC))


class CliTests(StoreFixture):
    def run_cli(self, *argv, on=True):
        env = {"SIGN402_WEB_DB": str(self.path), **({sc.ENABLED_ENV: "1"} if on else {})}
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = sc.main(list(argv), env=env, recheck=self.recheck, now=lambda: NOW)
        return code, out.getvalue(), err.getvalue()

    def test_the_operator_flow(self):
        row = self.pending(0x1234)
        code, out, _ = self.run_cli("queue")
        self.assertEqual(code, 0)
        self.assertIn(row["claim_id"], out)
        self.assertIn("400d", out)
        self.assertIn("wallet:0x0000…1234", out)
        self.assertNotIn(wallet(0x1234), out)
        self.assertEqual(self.run_cli("approve", row["claim_id"], "--by", "kostya")[0], 1)  # not funded yet
        self.assertEqual(self.run_cli("fund", "20000001", "--by", "kostya", "--ref", "too much")[0], 1)
        self.assertEqual(self.run_cli("fund", "2000000", "--by", "kostya", "--ref", "tx 0xfeed")[0], 0)
        code, out, _ = self.run_cli("approve", row["claim_id"], "--by", "kostya")
        self.assertEqual(code, 0)
        self.assertIn("approved", out)
        code, out, _ = self.run_cli("budget")
        self.assertIn("committedAtomic: 1000000", out)
        code, out, _ = self.run_cli("audit", "--limit", "20")
        self.assertIn("approve", out)
        self.assertNotIn(wallet(0x1234), out)

    def test_off_refuses_approve_and_fund_but_reads(self):
        row = self.pending(1)
        code, _, err = self.run_cli("fund", "1000000", "--by", "kostya", "--ref", "x", on=False)
        self.assertEqual(code, 1)
        self.assertIn("starter_credit_off", err)
        code, _, err = self.run_cli("approve", row["claim_id"], "--by", "kostya", on=False)
        self.assertEqual(code, 1)
        self.assertEqual(self.credit.get(row["claim_id"])["state"], "pending")
        for read in (("queue",), ("budget",), ("audit",)):
            self.assertEqual(self.run_cli(*read, on=False)[0], 0)

    def test_reject_and_bad_usage(self):
        row = self.pending(1)
        self.assertEqual(self.run_cli("reject", row["claim_id"], "--by", "kostya")[0], 2)  # needs --reason
        self.assertEqual(self.run_cli("reject", row["claim_id"], "--by", "kostya", "--reason", "bot")[0], 0)
        self.assertEqual(self.credit.get(row["claim_id"])["state"], "rejected")
        self.assertEqual(self.run_cli("approve", row["claim_id"], "--by", "kostya")[0], 1)
        self.assertEqual(self.run_cli("nonsense")[0], 2)


class RouteFixture(unittest.TestCase):
    """WebApi.handle with a real signed-in session, a fake allowance and a fake GitHub."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "web.db"
        self.user = Account.create()
        self.store = WebAccountStore(self.path)
        self.auth = WebAuth(self.store, domain=DOMAIN, uri=URI, allowed=None, now=lambda: NOW)
        self.allowance = FakeAllowance()
        self.api = wa.WebApi(self.auth, self.allowance, now=lambda: NOW)
        self.credit = StarterCredit(self.path, enabled=True)
        self.github = FakeGitHub()
        self.api.starter = StarterWeb(self.credit, self.allowance, self.github, REDIRECT, now=lambda: NOW)
        issued = self.auth.nonce(self.user.address)
        self.session = self.auth.verify(issued["message"], sign(self.user, issued["message"]))
        self.account = account_id_for(self.user.address)
        self.allowance.give(self.account)

    def call(self, method, path, body=None, session=None, client="198.51.100.7"):
        session = session if session is not None else self.session
        return self.api.handle(method, path, token=session.get("token", ""), csrf=session.get("csrfToken"),
                               body=body or {}, client=client, expected_account=None)

    def start(self):
        status, out, _ = self.call("POST", "/starter-credit/github/start")
        self.assertEqual(status, 200)
        return out["url"].split("state=", 1)[1]

    def callback(self, state, code=CODE, **extra):
        return self.call("GET", "/starter-credit/github/callback", {"code": code, "state": state, **extra}, session={})


class RouteTests(RouteFixture):
    def test_the_whole_claim_lands_pending_without_the_cookie(self):
        state = self.start()
        status, out, headers = self.callback(state)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], REDIRECT + "?starter=pending")
        self.assertEqual(self.github.codes, [CODE])
        row = self.credit.claim_for(self.account)
        self.assertEqual((row["state"], row["github_id"], row["github_login"]), ("pending", 4242, "octo"))
        _, mine, _ = self.call("GET", "/starter-credit")
        self.assertEqual(mine["claim"]["state"], "pending")
        self.assertEqual(mine["claim"]["spendableTodayAtomic"], 0)

    def test_the_real_github_authorize_url(self):
        github = sc.GitHubOAuth("Iv1.fakeclientid", "fake-secret", URI + "/web/v1/starter-credit/github/callback")
        url = github.authorize_url("st4te")
        self.assertTrue(url.startswith("https://github.com/login/oauth/authorize?"))
        for part in ("client_id=Iv1.fakeclientid", "state=st4te", "scope=read%3Auser", "allow_signup=false",
                     "redirect_uri=https%3A%2F%2Fapp.singit.test%2Fweb%2Fv1%2Fstarter-credit%2Fgithub%2Fcallback"):
            self.assertIn(part, url)
        self.assertNotIn("fake-secret", url + repr(github))

    def test_the_state_is_single_use_bound_and_short_lived(self):
        state = self.start()
        self.assertEqual(self.callback("wrong")[2]["Location"], REDIRECT + "?starter=refused&reason=bad_state")
        self.assertEqual(self.callback(state)[2]["Location"], REDIRECT + "?starter=pending")
        self.assertEqual(self.callback(state)[2]["Location"], REDIRECT + "?starter=refused&reason=bad_state")
        self.assertEqual(len(self.github.codes), 1, "a refused state never reaches GitHub")
        with closing(sqlite3.connect(self.path)) as db, db:
            stored = [r[0] for r in db.execute("SELECT state_hash FROM starter_oauth_states")]
        self.assertNotIn(state, stored)

    def test_an_expired_state_is_refused(self):
        state = self.start()
        self.api.starter.now = lambda: NOW + sc.STATE_SECONDS
        self.assertEqual(self.callback(state)[2]["Location"], REDIRECT + "?starter=refused&reason=bad_state")
        self.assertIsNone(self.credit.claim_for(self.account))

    def test_a_young_github_or_one_without_a_public_repo_is_refused(self):
        cases = {"github_too_young": FakeGitHub(created=iso(NOW - 100 * DAY)),
                 "no_public_repo": FakeGitHub(repos=[{"fork": True, "private": False, "owner": {"id": 4242}},
                                                     {"fork": False, "private": True, "owner": {"id": 4242}},
                                                     {"fork": False, "private": False, "owner": {"id": 1}}])}
        for reason, github in cases.items():
            with self.subTest(reason):
                self.api.starter.github = github
                status, _, headers = self.callback(self.start())
                self.assertEqual(headers["Location"], f"{REDIRECT}?starter=refused&reason={reason}")
                self.assertIsNone(self.credit.claim_for(self.account))
                self.assertIn(("refused", reason), audit_actions(self.credit))

    def test_a_created_at_sent_by_the_client_is_ignored(self):
        self.api.starter.github = FakeGitHub(created=iso(NOW - 10 * DAY))
        _, _, headers = self.callback(self.start(), created_at=OLD, github_created_at=OLD, login="old-timer")
        self.assertEqual(headers["Location"], REDIRECT + "?starter=refused&reason=github_too_young")
        self.assertIsNone(self.credit.claim_for(self.account))

    def test_one_github_two_wallets(self):
        self.callback(self.start())
        other = Account.create()
        issued = self.auth.nonce(other.address)
        session = self.auth.verify(issued["message"], sign(other, issued["message"]))
        self.allowance.give(session["account"])
        _, out, _ = self.call("POST", "/starter-credit/github/start", session=session)
        _, _, headers = self.callback(out["url"].split("state=", 1)[1])
        self.assertEqual(headers["Location"], REDIRECT + "?starter=refused&reason=github_already_used")
        self.assertIsNone(self.credit.claim_for(session["account"]))

    def test_a_wallet_with_a_claim_cannot_start_again(self):
        self.callback(self.start())
        with self.assertRaises(wa.WebError) as caught:
            self.call("POST", "/starter-credit/github/start")
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "already_claimed"))

    def test_no_allowance_is_refused_at_start_and_at_the_callback(self):
        self.allowance.broken[self.account] = "paused"
        with self.assertRaises(wa.WebError) as caught:
            self.call("POST", "/starter-credit/github/start")
        self.assertEqual((caught.exception.status, caught.exception.code), (403, "no_allowance"))
        del self.allowance.broken[self.account]
        state = self.start()
        self.allowance.give(self.account, on_chain=wallet(99))  # the limiter changed hands in between
        self.assertEqual(self.callback(state)[2]["Location"], REDIRECT + "?starter=refused&reason=foreign_owner")
        self.assertIsNone(self.credit.claim_for(self.account))

    def test_a_solana_account_is_refused(self):
        self.api.starter.recheck = lambda acct: check_allowance(self.allowance, "solana:FakeSo1ana111111111111111111")
        with self.assertRaises(wa.WebError) as caught:
            self.call("POST", "/starter-credit/github/start")
        self.assertEqual(caught.exception.code, "solana_not_supported")

    def test_withdrawing_starter_credit_is_refused(self):
        for path in ("/starter-credit/refund", "/starter-credit/withdraw"):
            with self.assertRaises(wa.WebError) as caught:
                self.call("POST", path)
            self.assertEqual((caught.exception.status, caught.exception.code), (403, "not_withdrawable"))

    def test_off_every_route_answers_404(self):
        self.api.starter = None
        for method, path, session in (("POST", "/starter-credit/github/start", None), ("GET", "/starter-credit", None),
                                      ("GET", "/starter-credit/github/callback", {}),
                                      ("POST", "/starter-credit/refund", None)):
            with self.subTest(path), self.assertRaises(wa.WebError) as caught:
                self.call(method, path, {"code": "c", "state": "s"}, session=session)
            self.assertEqual((caught.exception.status, caught.exception.code), (404, "starter_credit_off"))
        self.assertEqual(self.github.codes, [])

    def test_on_without_oauth_answers_503(self):
        self.api.starter.github = None
        for method, path, session in (("POST", "/starter-credit/github/start", None),
                                      ("GET", "/starter-credit/github/callback", {})):
            with self.subTest(path), self.assertRaises(wa.WebError) as caught:
                self.call(method, path, {"code": "c", "state": "s"}, session=session)
            self.assertEqual(caught.exception.status, 503)

    def test_the_callback_is_rate_limited_by_ip(self):
        for _ in range(20):
            self.callback("nope")
        self.assertEqual(self.callback("nope")[2]["Location"], REDIRECT + "?starter=refused&reason=rate_limited")

    def test_neither_token_nor_code_is_logged_or_audited(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            self.callback(self.start())
            self.api.starter.github = FakeGitHub(created=iso(NOW - DAY))
            self.callback("whatever")
        text = "\n".join(logs.output)
        self.assertIn("pending", text)
        with closing(sqlite3.connect(self.path)) as db, db:
            dump = "\n".join(db.iterdump())
        for secret in (TOKEN, CODE):
            self.assertNotIn(secret, text)
            self.assertNotIn(secret, dump)


class FromEnvTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {"SIGN402_WEB_DOMAIN": DOMAIN, "SIGN402_WEB_URI": URI, "SIGN402_WEB_ALLOWED_ADDRESSES": "*",
                    "SIGN402_WEB_DB": str(Path(self.tmp.name) / "web.db"), "SIGN402_WEB_CHAT_ENABLED": "0",
                    "SIGN402_WEB_INTERNAL_TOKEN": "t" * 40, "SIGN402_WEB_SURPLUS_API_KEY": "inf_fake_test_key"}

    def test_off_by_default(self):
        api, _ = wa.build_web_api_from_env(Mock(), self.env)
        self.assertIsNone(api.starter)
        self.assertIsNone(api.keys.proxy.starter)

    def test_on_wires_routes_and_spending(self):
        api, _ = wa.build_web_api_from_env(Mock(), {**self.env, sc.ENABLED_ENV: "1", sc.CLIENT_ID_ENV: "Iv1.fake",
                                                    sc.CLIENT_SECRET_ENV: "fake", sc.REDIRECT_ENV: REDIRECT})
        self.assertTrue(api.starter.credit.enabled)
        self.assertIs(api.keys.proxy.starter, api.starter.credit)
        self.assertEqual(api.starter.github.redirect_uri, URI + "/web/v1/starter-credit/github/callback")

    def test_on_without_oauth_has_no_github(self):
        api, _ = wa.build_web_api_from_env(Mock(), {**self.env, sc.ENABLED_ENV: "1"})
        self.assertIsNone(api.starter.github)


class HttpCallbackTests(RouteFixture):
    """The real HTTP layer: GitHub's redirect back, with no cookie, ends in a 302 to the app."""

    def setUp(self):
        super().setUp()
        self.server = wa.WebServer(("127.0.0.1", 0), self.api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_callback_over_http_without_a_cookie(self):
        state = self.start()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        with self.assertLogs("sign402_gateway", level=logging.DEBUG) as logs:
            connection.request("GET", f"/web/v1/starter-credit/github/callback?code={CODE}&state={state}")
            response = connection.getresponse()
            response.read()
        connection.close()
        self.assertEqual(response.status, 302)
        self.assertEqual(response.getheader("Location"), REDIRECT + "?starter=pending")
        self.assertEqual(self.credit.claim_for(self.account)["state"], "pending")
        self.assertNotIn(CODE, "\n".join(logs.output))
        self.assertNotIn(state, "\n".join(logs.output))


class ProxyStarterTests(RouteFixture):
    """A request paid from starter credit leaves the balance and its ledger alone."""

    def setUp(self):
        super().setUp()
        self.api.shop = lambda action, acct, body=None: (200, {"object": "list", "data": []})
        self.balances = Balances(self.path)
        self.surplus = Mock()
        self.sent = []
        self.surplus.send.side_effect = self._send
        self.api.keys.proxy = Proxy(self.api.keys, self.surplus, self.balances, starter=self.credit)
        for p in (patch.object(web_api_proxy.ask_catalogue, "default_id", return_value="deepseek-v4.1-flash"),
                  patch.object(web_api_proxy.ask_catalogue, "resolve",
                               side_effect=lambda i: OPUS if i == OPUS["id"] else None),
                  patch.object(web_api_proxy, "background", lambda work: work())):
            p.start()
            self.addCleanup(p.stop)
        _, prepared, _ = self.call("POST", "/api-keys/prepare", {"name": "bot", "dailyUsd": 10, "perRequestUsd": 1})
        _, made, _ = self.call("POST", "/api-keys", {"message": prepared["message"],
                                                   "signature": sign(self.user, prepared["message"])})
        self.key = made["key"]
        self.credit.fund(HARD_CAP_ATOMIC, "kostya", "test", NOW)
        self.callback(self.start())
        self.credit.approve(self.credit.claim_for(self.account)["claim_id"], "kostya", NOW,
                            lambda acct: check_allowance(self.allowance, acct))

    def _send(self, path, body, headers):
        self.sent.append(body)
        payload = json.dumps({"id": "c1", "object": "chat.completion",
                              "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi"}}],
                              "usage": {"prompt_tokens": 10, "completion_tokens": 2, "buyer_cost_micro": 1000}})
        response = Mock(status=200, headers={"Content-Type": "application/json", "x-request-id": "req_1"})
        stream = io.BytesIO(payload.encode())
        response.read.side_effect = lambda n=-1: stream.read(n)
        return response

    def ask(self, body):
        _, relay, _ = self.api.keys.public("POST", "/chat/completions", authorization=f"Bearer {self.key}",
                                           origin=None, body=body, headers={})
        return relay, json.loads(b"".join(relay))

    def test_a_small_request_is_paid_from_starter_credit(self):
        relay, out = self.ask({"model": "claude-opus-5.5", "max_tokens": 100,
                               "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(relay.status, 200)
        self.assertEqual(out["billing"]["chargedAtomic"], 1300)
        self.assertEqual(out["billing"]["paidFrom"], "your SingIt starter credit")
        claim = self.credit.claim_for(self.account)
        self.assertEqual((claim["spent_atomic"], claim["held_atomic"]), (1300, 0))
        self.assertEqual(self.balances.ledger(self.account), [])
        self.assertEqual(self.balances.state(self.account)["balanceAtomic"], 0)
        self.assertIn("bill", [a for a, _ in audit_actions(self.credit)])

    def test_a_big_request_falls_back_to_the_balance(self):
        with self.assertRaises(ApiError) as caught:  # 4096 tokens of Opus may cost more than $0.05; no balance
            self.ask({"model": "claude-opus-5.5", "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(caught.exception.code, "balance_low")
        topup = new_topup_id()
        self.balances.claim_topup(topup, self.account, 1_000_000, NOW)
        self.balances.credit_topup(topup, 1_001_000, 1_000_000, "0xfake", "base", NOW)
        relay, out = self.ask({"model": "claude-opus-5.5", "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(out["billing"]["paidFrom"], "your SingIt balance")
        self.assertEqual(self.balances.state(self.account)["balanceAtomic"], 1_000_000 - 1300)
        self.assertEqual(self.credit.claim_for(self.account)["spent_atomic"], 0)

    def test_off_the_proxy_never_touches_starter_credit(self):
        self.api.keys.proxy.starter = None
        with self.assertRaises(ApiError):
            self.ask({"model": "claude-opus-5.5", "max_tokens": 100, "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(self.credit.claim_for(self.account)["spent_atomic"], 0)
        self.api.keys.proxy.starter = StarterCredit(self.path)  # present but switched off
        with self.assertRaises(ApiError):
            self.ask({"model": "claude-opus-5.5", "max_tokens": 100, "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(self.credit.claim_for(self.account)["spent_atomic"], 0)

    def test_an_upstream_failure_releases_the_starter_hold(self):
        self.surplus.send.side_effect = OSError("down")
        with self.assertRaises(ApiError) as caught:
            self.ask({"model": "claude-opus-5.5", "max_tokens": 100, "messages": [{"role": "user", "content": "Hi"}]})
        self.assertEqual(caught.exception.status, 502)
        claim = self.credit.claim_for(self.account)
        self.assertEqual((claim["spent_atomic"], claim["held_atomic"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
