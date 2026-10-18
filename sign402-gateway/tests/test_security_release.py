"""Offline migration and release rehearsal; no real service or network access."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet
from eth_account import Account
from sign402_gateway.solana_wallets import ManagedWalletService
from sign402_gateway.user_wallets import UserWalletStore

ROOT = Path(__file__).resolve().parents[2]


class WalletMigrationToolTests(unittest.TestCase):
    def test_dry_run_and_apply_preserve_existing_wallets_and_abort_on_bad_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wallets.db"
            master = Fernet.generate_key()
            store = UserWalletStore(path)
            account = Account.create()
            encrypted = Fernet(master).encrypt(account.key.to_0x_hex().encode()).decode()
            store.insert_wallet(telegram_user_id="old", telegram_username="", chain="base",
                                wallet_address=account.address, encrypted_private_key=encrypted, status="created")
            service = ManagedWalletService(store=store, master_key=master.decode())
            service.create_wallet("old", chain="solana")
            token = store.issue_access_token("old")
            command = [sys.executable, str(ROOT / "scripts/verify-managed-wallets.py"), "--db", str(path)]
            env = {**os.environ, "SIGN402_WALLET_MASTER_KEY": master.decode()}
            dry = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertEqual(store.get_wallet_by_telegram_user_id("old")["encrypted_private_key"], encrypted)
            with sqlite3.connect(path) as db:
                db.execute("UPDATE user_wallets SET wallet_address='invalid'")
            refused = subprocess.run(command + ["--apply"], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(refused.returncode, 1)
            self.assertNotIn(master.decode(), refused.stderr + refused.stdout)
            self.assertEqual(store.get_wallet_by_telegram_user_id("old")["encrypted_private_key"], encrypted)
            with sqlite3.connect(path) as db:
                db.execute("UPDATE user_wallets SET wallet_address=?", (account.address,))
            applied = subprocess.run(command + ["--apply"], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertEqual(json.loads(applied.stdout)["verified"], {"base": 1, "solana": 1})
            self.assertEqual(service.decrypt_private_key_for_future_signing("old"), account.key.to_0x_hex())
            self.assertEqual(store.resolve_telegram_user_id(token), "old")


class ReleaseInstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.release, self.app, self.home = root / "release", root / "app", root / "home"
        for path in (self.release / "scripts", self.app / "website/app", self.home / ".sign402"):
            path.mkdir(parents=True)
        script = self.release / "scripts/apply-auth-wallet-release.py"
        shutil.copy2(ROOT / "scripts/apply-auth-wallet-release.py", script)
        spec = importlib.util.spec_from_file_location("release_under_test", script)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.module.APP, self.module.HOME = self.app, self.home
        self.module.BACKUP_ROOT = self.home / "private-backups"
        self.module.STATE_DIR = self.home / ".sign402"
        self.module.DEPLOY_USER = "deploy"
        self.config = root / "gateway.env"
        self.config.write_text("private-config-fixture")
        self.module.CONFIG = self.config
        self.wallet = self.home / ".sign402/user-wallets.db"
        self.wallet.write_bytes(b"private-state-fixture")
        self.unit = root / "gateway.service"
        self.unit.write_text("unit-fixture")
        self.name = "website/app/main.js"
        (self.release / self.name).parent.mkdir(parents=True)
        (self.release / self.name).write_text("new-code")
        (self.app / self.name).write_text("old-code")
        (self.release / "release-manifest.json").write_text(json.dumps({"baseline": "baseline",
            "files": {self.name: hashlib.sha256(b"new-code").hexdigest()}}))
        self.commands, self.dirty = [], ""
        def run(args, **kwargs):
            self.commands.append(args)
            if args[0] == "git":
                return "baseline" if "rev-parse" in args else self.dirty
            if "FragmentPath" in args:
                return str(self.unit)
            if "MainPID" in args:
                return "0"
            return ""
        self.module.run = run
        self.module.process_env = lambda _: {"SIGN402_WALLET_MASTER_KEY": "fixture", "SIGN402_USER_WALLET_STORE_PATH": str(self.wallet)}
        self.result = {"verified": {"base": 1, "solana": 1}, "identities_preserved": True}
        self.module.verify_wallets = lambda *args, **kwargs: self.result

    def execute(self):
        from urllib.error import HTTPError
        def urlopen(url, **kwargs):
            if "/session" in url:
                raise HTTPError(url, 401, "auth", {}, None)
            return contextlib.nullcontext(SimpleNamespace(status=200))
        mode = os.umask(0o077)
        os.umask(mode)
        try:
            with patch.object(sys, "argv", ["installer", "--apply"]), patch.object(os, "geteuid", return_value=0), \
                    patch.object(os, "chown"), patch.object(self.module.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=1, pw_gid=1)), \
                    patch.object(self.module.urllib.request, "urlopen", side_effect=urlopen), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.module.main()
        finally:
            os.umask(mode)

    def test_install_stops_services_backs_up_then_applies_and_checks_health(self):
        self.execute()
        self.assertEqual((self.app / self.name).read_text(), "new-code")
        backup = next(self.module.BACKUP_ROOT.iterdir())
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        with tarfile.open(backup / "previous-code.tar.gz") as archive:
            self.assertEqual(archive.extractfile(self.name).read(), b"old-code")
        with tarfile.open(backup / "state-and-config.tar.gz") as archive:
            self.assertEqual(archive.extractfile(str(self.wallet.resolve()).lstrip("/")).read(), b"private-state-fixture")
            self.assertEqual(archive.extractfile(str(self.config).lstrip("/")).read(), b"private-config-fixture")
        self.assertTrue((backup / "success.json").is_file())
        self.assertIn(["systemctl", "stop", *self.module.UNITS], self.commands)
        self.assertIn(["systemctl", "start", *self.module.UNITS], self.commands)

    def test_changed_checkout_or_tampered_release_is_refused_before_stopping(self):
        self.dirty = " M existing-user-work"
        with self.assertRaises(RuntimeError):
            self.execute()
        self.dirty = ""
        (self.release / self.name).write_text("tampered")
        with self.assertRaises(RuntimeError):
            self.execute()
        self.assertNotIn(["systemctl", "stop", *self.module.UNITS], self.commands)
        self.assertEqual((self.app / self.name).read_text(), "old-code")

    def test_failed_preservation_check_does_not_restart_services_with_bad_state(self):
        def verify(*args, **kwargs):
            if kwargs.get("apply"):
                raise RuntimeError("migration failure")
            return self.result
        self.module.verify_wallets = verify
        with self.assertRaises(RuntimeError):
            self.execute()
        self.assertNotIn(["systemctl", "start", *self.module.UNITS], self.commands)
        self.assertEqual(self.wallet.read_bytes(), b"private-state-fixture")
        self.assertTrue(next(self.module.BACKUP_ROOT.glob("*/state-and-config.tar.gz")).is_file())
