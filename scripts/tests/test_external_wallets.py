import importlib.util
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "external-wallets.py"

# Fixture addresses only (not real wallets).
BASE_OWNER_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
BASE_OWNER_OURS = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb"
BASE_AGENT_OURS = "0x1111111111111111111111111111111111111111"
BASE_AGENT_A = "0x2222222222222222222222222222222222222222"
LIMITER_A = "0x3333333333333333333333333333333333333333"
LIMITER_A2 = "0x3434343434343434343434343434343434343434"
LIMITER_OURS = "0x4444444444444444444444444444444444444444"
SOL_OWNER_X = "So1anaOwnerXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1"
SOL_OWNER_Y = "So1anaOwnerYyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy1"
SOL_AGENT_Y = "So1anaAgentYyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy1"
DAY = 1_790_000_000  # some UTC second


def load():
    spec = importlib.util.spec_from_file_location("external_wallets", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ew = load()


def make_base(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE agents (user_id TEXT PRIMARY KEY, agent_address TEXT, encrypted_key TEXT, created_at INTEGER);
        CREATE TABLE limiters (limiter_address TEXT PRIMARY KEY, user_id TEXT, owner_address TEXT, agent_address TEXT,
            guardian_address TEXT, daily_cap INTEGER, per_purchase_cap INTEGER, expiry INTEGER, deploy_tx TEXT,
            status TEXT, source TEXT, created_at INTEGER);
        CREATE TABLE operations (op_id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, limiter_address TEXT, amount INTEGER,
            job_id TEXT, tx_hash TEXT, state TEXT, detail TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE settlements (tx_hash TEXT, log_index TEXT, user_id TEXT, pay_to TEXT, amount INTEGER,
            resource TEXT, created_at INTEGER, PRIMARY KEY (tx_hash, log_index));
        CREATE TABLE agent_outflows (tx_hash TEXT, log_index TEXT, user_id TEXT, recipient TEXT, amount INTEGER,
            first_seen INTEGER, resolved INTEGER DEFAULT 0, PRIMARY KEY (tx_hash, log_index));
    """)
    ua, uo = f"wallet:{BASE_OWNER_A.lower()}", "104561"  # a web account and a Telegram user
    db.execute("INSERT INTO agents VALUES (?,?,?,?)", (ua, BASE_AGENT_A, "enc", DAY))
    db.execute("INSERT INTO agents VALUES (?,?,?,?)", (uo, BASE_AGENT_OURS, "enc", DAY))
    for limiter, user, owner, agent, at in ((LIMITER_A, ua, BASE_OWNER_A, BASE_AGENT_A, DAY),
                                            (LIMITER_A2, ua, BASE_OWNER_A, BASE_AGENT_A, DAY + 50),
                                            (LIMITER_OURS, uo, BASE_OWNER_OURS, BASE_AGENT_OURS, DAY)):
        db.execute("INSERT INTO limiters VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (limiter, user, owner, agent, "0xg", 1, 1, DAY * 2, "0xd", "ACTIVE", "web", at))
    db.execute("INSERT INTO operations VALUES ('o1',?, 'GRANT', ?, 5, NULL, '0x1', 'DONE', '', ?, ?)", (ua, LIMITER_A, DAY, DAY))
    db.execute("INSERT INTO operations VALUES ('o2',?, 'GRANT', ?, 5, NULL, '0x2', 'DONE', '', ?, ?)", (uo, LIMITER_OURS, DAY, DAY))
    db.execute("INSERT INTO operations VALUES ('o3',?, 'REVOKE', ?, 0, NULL, '0x3', 'DONE', '', ?, ?)", (ua, LIMITER_A, DAY, DAY))
    rows = [("0xa1", ua, 10_000, "https://x/data", DAY + 100), ("0xa2", ua, 5_000_000, "https://x/v1/credit", DAY + 200),
            ("0xb1", uo, 20_000, "https://x/data", DAY + 100), ("0xc1", "999", 7, "https://x/data", DAY + 100),
            ("0xa3", ua, 1, "https://x/data", DAY + 10 * 86400)]
    for tx, user, amount, resource, at in rows:
        db.execute("INSERT INTO settlements VALUES (?, '0', ?, '0xpay', ?, ?, ?)", (tx, user, amount, resource, at))
        db.execute("INSERT INTO agent_outflows VALUES (?, '0', ?, '0xr', ?, ?, 1)", (tx, user, amount, at))
    db.commit(); db.close()


def make_solana(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE agents (account TEXT PRIMARY KEY, agent_address TEXT, encrypted_key TEXT, created_at INTEGER);
        CREATE TABLE limits (account TEXT PRIMARY KEY, owner TEXT, daily_cap INTEGER, per_purchase_cap INTEGER,
            expiry INTEGER, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE ops (op_id TEXT PRIMARY KEY, account TEXT, kind TEXT, amount INTEGER, message_hash TEXT, state TEXT,
            tx TEXT, detail TEXT, created_at INTEGER, updated_at INTEGER, owner_pays_fee INTEGER, tx_blockhash TEXT);
        CREATE TABLE spends (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, amount INTEGER, purpose TEXT,
            pull_tx TEXT, created_at INTEGER);
    """)
    for owner, agent in ((SOL_OWNER_X, "So1anaAgentXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1"), (SOL_OWNER_Y, SOL_AGENT_Y)):
        db.execute("INSERT INTO agents VALUES (?,?,?,?)", (f"solana:{owner}", agent, "enc", DAY))
        db.execute("INSERT INTO limits VALUES (?,?,1,1,?,?,?)", (f"solana:{owner}", owner, DAY * 2, DAY, DAY))
    db.execute("INSERT INTO ops VALUES ('s1', ?, 'GRANT', 1, 'h', 'DONE', 't', '', ?, ?, 1, NULL)", (f"solana:{SOL_OWNER_Y}", DAY, DAY))
    db.execute("INSERT INTO ops VALUES ('s2', ?, 'GRANT', 1, 'h', 'PREPARED', NULL, '', ?, ?, 1, NULL)", (f"solana:{SOL_OWNER_X}", DAY, DAY))
    for account, amount, purpose, tx, at in ((SOL_OWNER_Y, 3_000, "Exa web search", "t1", DAY + 5),
                                             (SOL_OWNER_Y, 5_000_000, "Venice AI credit", "t2", DAY + 6),
                                             (SOL_OWNER_Y, 9, "Exa web search", None, DAY + 7),   # not settled
                                             (SOL_OWNER_X, 4, "Weather", "t3", DAY + 8)):        # paid, never approved by us
        db.execute("INSERT INTO spends(account, amount, purpose, pull_tx, created_at) VALUES (?,?,?,?,?)",
                   (f"solana:{account}", amount, purpose, tx, at))
    db.commit(); db.close()


def make_web(path):
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE accounts (account_id TEXT PRIMARY KEY, owner_address TEXT, telegram_user_id TEXT, created_at INTEGER, utm_json TEXT)")
    for account, owner in ((f"wallet:{BASE_OWNER_A.lower()}", BASE_OWNER_A), (f"solana:{SOL_OWNER_X}", SOL_OWNER_X),
                           (f"wallet:{BASE_OWNER_OURS.lower()}", BASE_OWNER_OURS), ("wallet:0x5555555555555555555555555555555555555555", "0x5555555555555555555555555555555555555555")):
        db.execute("INSERT INTO accounts VALUES (?,?,NULL,?,NULL)", (account, owner, DAY))
    db.commit(); db.close()


class ExternalWalletsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        self.base, self.sol, self.web = d / "allowance.db", d / "solana-allowance.db", d / "web.db"
        make_base(self.base); make_solana(self.sol); make_web(self.web)

    def report(self, exclude=frozenset(), **kw):
        return ew.build_report(allowance_db=self.base, solana_db=self.sol, web_db=self.web, exclude=exclude, **kw)

    def test_counts_without_exclusions_are_provisional(self):
        r = self.report()
        self.assertTrue(r["provisional"])
        self.assertIn("PROVISIONAL", r["note"])
        b = r["base"]
        self.assertEqual((b["wallets_with_limits"], b["wallets_granted"], b["wallets_paid"], b["wallets_granted_and_paid"]), (2, 2, 2, 2))
        self.assertEqual((b["payments"], b["credit_topup_payments"], b["unattributed_payments"]), (4, 1, 1))
        self.assertEqual(b["usdc"], "5.030001")
        self.assertEqual(b["onchain_agent_outflows"], 4)
        s = r["solana"]
        self.assertEqual((s["wallets_with_limits"], s["wallets_granted"], s["wallets_paid"], s["wallets_granted_and_paid"]), (2, 1, 2, 1))
        self.assertEqual((s["payments"], s["usdc"]), (3, "5.003004"))
        self.assertEqual(r["total"]["wallets_granted_and_paid"], 3)
        self.assertTrue(r["total"]["si88_goal_met"])
        self.assertEqual(r["signed_in_wallets_external"], 4)

    def test_an_agent_address_or_account_id_excludes_the_whole_wallet(self):
        exclude = ew.load_exclusions(f"{BASE_AGENT_OURS.upper().replace('0X', '0x')}, solana:{SOL_OWNER_Y}", None)
        r = self.report(exclude)
        self.assertEqual((r["base"]["wallets_with_limits"], r["base"]["payments"], r["base"]["excluded_wallets"],
                          r["base"]["excluded_payments"]), (1, 3, 1, 1))
        self.assertEqual(r["base"]["onchain_agent_outflows"], 3)
        self.assertEqual((r["solana"]["wallets_granted_and_paid"], r["solana"]["excluded_wallets"], r["solana"]["payments"]), (0, 1, 1))
        self.assertEqual(r["signed_in_wallets_excluded"], 1)  # our Base owner signed in; its agent excludes it too

    def test_owner_and_limiter_addresses_exclude_case_insensitively_for_evm_only(self):
        exclude = ew.load_exclusions(None, None) | ew.parse_list(f"{BASE_OWNER_A.upper().replace('0X','0x')}\n{LIMITER_OURS}")
        r = self.report(frozenset(exclude))
        self.assertEqual((r["base"]["wallets_with_limits"], r["base"]["excluded_wallets"]), (0, 2))
        self.assertFalse(r["total"]["wallets_granted_and_paid"] == 3)
        # base58 is case-sensitive: a differently-cased Solana address is a different address
        r = self.report(frozenset(ew.parse_list(SOL_OWNER_Y.lower())))
        self.assertEqual(r["solana"]["excluded_wallets"], 0)

    def test_exclude_file_with_comments(self):
        f = Path(self.tmp.name) / "own.txt"
        f.write_text(f"# ours\n{SOL_AGENT_Y}  # agent of Y\n\n{BASE_OWNER_OURS}\n")
        exclude = ew.load_exclusions("", f)
        r = self.report(exclude)
        self.assertEqual((r["base"]["excluded_wallets"], r["solana"]["excluded_wallets"]), (1, 1))
        self.assertEqual(r["exclusions_loaded"], 2)
        self.assertEqual(r["signed_in_wallets_excluded"], 1)

    def test_time_window_applies_to_payments(self):
        r = self.report(since=DAY + 150, until=DAY + 86400)
        self.assertEqual((r["base"]["payments"], r["base"]["usdc"]), (1, "5.000000"))
        self.assertEqual(r["solana"]["payments"], 0)
        self.assertEqual(r["base"]["wallets_with_limits"], 2)  # limits are not windowed

    def test_output_never_contains_an_address(self):
        exclude = ew.parse_list(BASE_AGENT_OURS)
        for argv in (["--json"], ["--json", "--ids"], []):
            out = io.StringIO()
            with redirect_stdout(out):
                ew.main(argv + ["--allowance-db", str(self.base), "--solana-db", str(self.sol), "--web-db", str(self.web)],
                        env={"SINGIT_OWN_WALLETS": BASE_AGENT_OURS, "SINGIT_ID_SALT": "test-salt"})
            text = out.getvalue().lower()
            for addr in (BASE_OWNER_A, BASE_OWNER_OURS, BASE_AGENT_OURS, BASE_AGENT_A, LIMITER_A, LIMITER_OURS,
                         SOL_OWNER_X, SOL_OWNER_Y, SOL_AGENT_Y, "104561"):
                self.assertNotIn(addr.lower(), text)
                self.assertNotIn(addr.lower()[2:12] if addr.startswith("0x") else addr.lower()[:10], text)
        self.assertTrue(exclude)

    def test_ids_are_salted_hashes(self):
        a = self.report(ids=True, salt="s1")["solana"]["wallet_ids"]
        b = self.report(ids=True, salt="s2")["solana"]["wallet_ids"]
        self.assertEqual(len(a), 2)
        self.assertNotEqual({x["id"] for x in a}, {x["id"] for x in b})
        self.assertTrue(all(len(x["id"]) == 10 for x in a))

    def test_missing_or_old_stores_count_zero(self):
        r = ew.build_report(allowance_db=Path(self.tmp.name) / "nope.db", solana_db=Path(self.tmp.name) / "nope2.db",
                            web_db=None, exclude=frozenset())
        self.assertEqual((r["total"]["wallets_with_limits"], r["total"]["payments"]), (0, 0))
        self.assertFalse(r["total"]["si88_goal_met"])
        self.assertEqual(r["sources"], {"allowance_db": False, "solana_db": False, "web_db": False})

    def test_stores_are_opened_read_only(self):
        db = ew.connect_readonly(self.base)
        with self.assertRaises(sqlite3.OperationalError):
            db.execute("DELETE FROM settlements")
        db.close()

    def test_a_rejected_limiter_never_takes_the_payments(self):
        db = sqlite3.connect(self.base)
        db.execute("INSERT INTO limiters VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("0x6666666666666666666666666666666666666666", f"wallet:{BASE_OWNER_A.lower()}",
                    "0x7777777777777777777777777777777777777777", BASE_AGENT_A, "0xg", 1, 1, DAY * 2, "0xd", "REJECTED", "web", DAY + 60))
        db.commit(); db.close()
        r = self.report(ew.parse_list(BASE_OWNER_A))  # excluding the real owner must still exclude every payment of it
        self.assertEqual((r["base"]["wallets_with_limits"], r["base"]["payments"], r["base"]["excluded_payments"]), (1, 1, 3))
        self.assertEqual(r["base"]["users_with_several_owners"], 0)

    def test_an_agent_exclusion_covers_a_payment_only_wallet(self):
        db = sqlite3.connect(self.sol)
        z, agent = "So1anaOwnerZzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz1", "So1anaAgentZzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz1"
        db.execute("INSERT INTO agents VALUES (?,?,?,?)", (f"solana:{z}", agent, "enc", DAY))
        db.execute("INSERT INTO spends(account, amount, purpose, pull_tx, created_at) VALUES (?, 5, 'x', 'tz', ?)", (f"solana:{z}", DAY))
        db.commit(); db.close()
        self.assertEqual(self.report()["solana"]["wallets_paid"], 3)
        r = self.report(ew.parse_list(agent))
        self.assertEqual((r["solana"]["wallets_paid"], r["solana"]["excluded_payments"]), (2, 1))

    def test_errors_never_echo_arguments_or_values(self):
        import contextlib
        addr = SOL_OWNER_Y
        for argv in (["--since", addr], ["--bogus", addr], ["--ids"]):
            err = io.StringIO()
            with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as caught:
                ew.main(argv + ["--allowance-db", str(self.base), "--solana-db", str(self.sol)], env={})
            self.assertNotIn(addr, err.getvalue() + str(caught.exception.code))
        db = sqlite3.connect(self.sol)
        db.execute("UPDATE spends SET amount = ? WHERE id = 1", (addr,))  # a malformed stored value
        db.commit(); db.close()
        with self.assertRaises(ew.StoreError) as caught:
            self.report()
        self.assertNotIn(addr, str(caught.exception))

    def test_a_read_error_other_than_a_missing_table_is_not_a_zero(self):
        db = sqlite3.connect(self.sol)
        db.execute("ALTER TABLE spends RENAME COLUMN pull_tx TO something_else")
        db.commit(); db.close()
        with self.assertRaises(ew.StoreError):
            self.report()

    def test_a_wal_store_is_read_from_a_copy_and_left_untouched(self):
        db = sqlite3.connect(self.sol)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("INSERT INTO spends(account, amount, purpose, pull_tx, created_at) VALUES (?, 1, 'w', 'tw', ?)",
                   (f"solana:{SOL_OWNER_Y}", DAY + 9))
        db.commit()
        directory = self.sol.parent
        before = {p.name: p.read_bytes() for p in directory.iterdir()}
        r = self.report()
        self.assertEqual(r["solana"]["payments"], 4)  # the row still in the -wal is seen
        after = {p.name: p.read_bytes() for p in directory.iterdir()}
        self.assertEqual(before, after)
        db.close()

    def test_a_wal_copy_taken_while_the_store_changes_is_retried_then_refused(self):
        from unittest.mock import patch
        db = sqlite3.connect(self.sol)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("INSERT INTO spends(account, amount, purpose, pull_tx, created_at) VALUES (?, 1, 'w', 'tw', ?)",
                   (f"solana:{SOL_OWNER_Y}", DAY + 9))
        db.commit()
        real, calls = ew.shutil.copyfile, [0]
        def copy_then_write(src, dst):
            out = real(src, dst)
            calls[0] += 1
            if calls[0] == 1:  # a writer commits between the db copy and the -wal copy, once
                db.execute("INSERT INTO spends(account, amount, purpose, pull_tx, created_at) VALUES (?, 1, 'w', 'tw2', ?)",
                           (f"solana:{SOL_OWNER_Y}", DAY + 10))
                db.commit()
            return out
        with patch.object(ew.shutil, "copyfile", copy_then_write):
            self.assertEqual(self.report()["solana"]["payments"], 5)  # the retried copy is consistent
        def always_write(src, dst):
            out = real(src, dst)
            db.execute("INSERT INTO spends(account, amount, purpose, pull_tx, created_at) VALUES (?, 1, 'w', NULL, ?)",
                       (f"solana:{SOL_OWNER_Y}", DAY + 11))
            db.commit()
            return out
        with patch.object(ew.shutil, "copyfile", always_write), self.assertRaises(ew.StoreError):
            self.report()
        db.close()

    def test_confirmed_drops_the_provisional_mark(self):
        r = self.report(confirmed=True)
        self.assertFalse(r["provisional"])
        self.assertTrue(r["exclusions_confirmed"])
        out = io.StringIO()
        with redirect_stdout(out):
            ew.main(["--allowance-db", str(self.base), "--solana-db", str(self.sol), "--web-db", str(self.web)], env={})
        self.assertIn("PROVISIONAL", out.getvalue())
        self.assertIn("SI-88", out.getvalue())


if __name__ == "__main__":
    unittest.main()
