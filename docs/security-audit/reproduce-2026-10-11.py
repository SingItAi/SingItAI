"""Offline reproductions for the dated audit; no network, funded keys or payments.

Run with the installed gateway's Python. A nonzero exit means defects reproduced.
"""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import sqlite3
import stat
import tempfile
import threading

from cryptography.fernet import Fernet
from eth_account import Account

from sign402_gateway.agent_allowance import AllowanceError
from sign402_gateway.solana_allowance import SolanaAllowanceService, SolanaAllowanceStore
from sign402_gateway.solana_chat import SolanaChatError
from sign402_gateway.solana_keys import generate_keypair
from sign402_gateway.user_wallets import ManagedBaseWalletService, UserWalletStore, WalletEncryptionError


NOW = 1_800_000_000
DAY_START = NOW // 86400 * 86400


class OfflineBridge:
    def __init__(self):
        self.reject_submission = False

    def run(self, account, payer, key, operation, **payload):
        if operation == "allowance-state":
            return {"owner": {"amount": "100000000", "delegatedToAgent": "100000000",
                              "solLamports": "10000000"},
                    "agent": {"usdcAtomic": "0"}}
        if operation == "allowance-prepare":
            return {"transaction": "OFFLINE_FIXTURE", "messageHash": "offline-hash"}
        if operation in ("allowance-inspect", "allowance-submit") and self.reject_submission:
            raise SolanaChatError("TRANSACTION_MISMATCH", "Nothing was sent.")
        raise AssertionError("Unexpected offline bridge operation")


def make_lane(path, cipher=None):
    return SolanaAllowanceService(
        store=SolanaAllowanceStore(path), bridge=OfflineBridge(),
        fernet=cipher or Fernet(Fernet.generate_key()), fee_payer_key=None,
        max_daily=100_000_000, max_per_purchase=25_000_000,
        max_days=90, max_grant=300_000_000, now=lambda: NOW,
    )


def accepted():
    return {"state": "confirmed", "transaction": "offline-no-transaction"}


def stale_limits(root):
    lane = make_lane(root / "stale.db")
    account = "solana:" + generate_keypair()[0]
    lane.setup(account, "20", "5", "30")
    observed, release = threading.Event(), threading.Event()
    class Gate:
        def __enter__(self):
            observed.set()
            if not release.wait(5):
                raise RuntimeError("Test gate timed out")
        def __exit__(self, *args):
            pass
    lane._spend_lock = Gate()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(lane.spend, account, 4_000_000, "offline audit", accepted)
        try:
            if not observed.wait(2):
                raise RuntimeError("Could not establish the reproduction interleaving")
            lane.setup(account, "1", "1", "30")
        finally:
            release.set()
        try:
            future.result(timeout=5)
        except AllowanceError:
            return False
    recorded = lane.store.spent_since(account, DAY_START)
    print(f"  saved cap=1000000; accepted debit={recorded} atomic USDC")
    return recorded > 1_000_000


def multiple_payers(root):
    path = root / "multiple.db"
    cipher = Fernet(Fernet.generate_key())
    lanes = [make_lane(path, cipher), make_lane(path, cipher)]
    account = "solana:" + generate_keypair()[0]
    lanes[0].setup(account, "5", "5", "30")
    barrier = threading.Barrier(2)

    def simultaneous_state(*args, **kwargs):
        barrier.wait(timeout=5)
        return {"owner": {"amount": "100000000", "delegatedToAgent": "100000000"}}

    for lane in lanes:
        lane.chain_state = simultaneous_state
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(lane.spend, account, 4_000_000, "offline audit", accepted) for lane in lanes]
        for future in futures:
            try:
                future.result(timeout=10)
            except AllowanceError:
                pass
    recorded = lanes[0].store.spent_since(account, DAY_START)
    print(f"  shared cap=5000000; accepted debits={recorded} atomic USDC")
    return recorded > 5_000_000


def blocked_funding(root):
    lane = make_lane(root / "funding.db")
    account = "solana:" + generate_keypair()[0]
    lane.setup(account, "20", "5", "30")
    op = lane.prepare_wallet(account, "FUND_GAS", amount="0.005")
    lane.bridge.reject_submission = True
    try:
        lane.submit_wallet(account, op["operation"], "INVALID_OFFLINE_FIXTURE")
    except AllowanceError:
        pass
    state = lane.operation(account, op["operation"])["state"]
    try:
        lane.prepare_wallet(account, "FUND_GAS", amount="0.005")
        blocked = False
    except AllowanceError:
        blocked = True
    print(f"  proven pre-send rejection: state={state}; next preparation blocked={blocked}")
    return state in ("VALIDATING", "SUBMITTING", "UNCERTAIN") and blocked


def database_modes(root):
    if os.name != "posix":
        raise RuntimeError("This reproduction needs POSIX modes")
    path = root / "permissions" / "solana.db"
    previous = os.umask(0o022)
    try:
        SolanaAllowanceStore(path)
    finally:
        os.umask(previous)
    directory, database = (stat.S_IMODE(p.stat().st_mode) for p in (path.parent, path))
    print(f"  new directory={oct(directory)}; database={oct(database)}")
    return bool(database & 0o077)


def base_key_substitution(root):
    path = root / "managed" / "wallets.db"
    service = ManagedBaseWalletService(store=UserWalletStore(path), master_key=Fernet.generate_key().decode())
    alice = service.create_wallet("audit-alice")["wallet"]["address"]
    service.create_wallet("audit-bob")
    with sqlite3.connect(path) as db:
        db.execute("UPDATE user_wallets SET encrypted_private_key="
                   "(SELECT encrypted_private_key FROM user_wallets WHERE telegram_user_id=?) "
                   "WHERE telegram_user_id=?", ("audit-alice", "audit-bob"))
    try:
        substituted = service.decrypt_private_key_for_future_signing("audit-bob")
    except WalletEncryptionError:
        return False
    wrong_signer = Account.from_key(substituted).address == alice
    print(f"  Bob's decrypted signer is Alice={wrong_signer}; no keys printed")
    return wrong_signer


def main():
    checks = [
        ("A1 superseded Solana caps", stale_limits),
        ("A1 conditional multiple paying instances", multiple_payers),
        ("A4 permanently blocked funding", blocked_funding),
        ("A6 Solana database permissions", database_modes),
        ("A7 Base key substitution", base_key_substitution),
    ]
    reproduced = 0
    with tempfile.TemporaryDirectory(prefix="singit-offline-audit-") as directory:
        for title, check in checks:
            print(title)
            found = check(Path(directory))
            reproduced += bool(found)
            print("  REPRODUCED" if found else "  NOT REPRODUCED")
    print(f"{reproduced}/{len(checks)} known-defect reproductions triggered; no network or payments used.")
    return 1 if reproduced else 0


if __name__ == "__main__":
    raise SystemExit(main())
