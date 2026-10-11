#!/usr/bin/env python3
"""Validate every existing managed wallet; optionally bind legacy Base ciphertext.

Run with the gateway's environment and Python, never a master key on argv.
The default operates on a private SQLite backup. --apply requires stopped writers
and a private backup made by the deployment operator. No keys/addresses are printed.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sign402-gateway"))

from sign402_gateway.solana_wallets import ManagedWalletService
from sign402_gateway.user_wallets import UserWalletStore


def records(path):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {table: [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY telegram_user_id")]
                for table in ("user_wallets", "solana_user_wallets") if table in tables}


def verify(path, master_key):
    before = records(path)
    service = ManagedWalletService(store=UserWalletStore(path), master_key=master_key)
    for table, chain in (("user_wallets", "base"), ("solana_user_wallets", "solana")):
        for row in before.get(table, []):
            # The service verifies owner, network and address derived from the key.
            service.decrypt_private_key_for_future_signing(row["telegram_user_id"], chain=chain)
    after = records(path)
    for table, rows in before.items():
        def stable(values):
            return [{k: v for k, v in row.items() if not (table == "user_wallets" and k == "encrypted_private_key")}
                    for row in values]
        if stable(rows) != stable(after[table]):
            raise RuntimeError("Wallet identity or metadata changed")
    return {"base": len(before.get("user_wallets", [])), "solana": len(before.get("solana_user_wallets", []))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    source = args.db.expanduser().resolve(strict=True)
    key = os.environ.get("SIGN402_WALLET_MASTER_KEY", "")
    if not key:
        raise RuntimeError("Gateway master key is not configured")
    # Always prove the migration on a consistent disposable copy first.
    with tempfile.TemporaryDirectory(prefix="singit-wallet-check-") as temporary:
        copy = Path(temporary) / "wallets.db"
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(copy) as dst:
            src.backup(dst)
        copy.chmod(0o600)
        counts = verify(copy, key)
    if args.apply:
        if verify(source, key) != counts:
            raise RuntimeError("Wallet count changed during migration")
    print(json.dumps({"verified": counts, "applied": args.apply, "identities_preserved": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Wallet verification failed. No key material is printed; investigate before restarting.", file=sys.stderr)
        raise SystemExit(1)
