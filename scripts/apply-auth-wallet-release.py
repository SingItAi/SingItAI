#!/usr/bin/env python3
"""Install the October 11 audit release on the existing single VPS.

The prepared release must include release-manifest.json (baseline and SHA-256
per changed file). Run with sudo and --apply. It refuses a changed checkout,
backs up state/configuration/code privately, and validates wallets before and
after migration. It does not initiate any payment or social login.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

UNITS = ["sign402-web-api", "sign402-gateway", "sign402-allowance-watcher"]
# Production layout is not stored here. The offline test assigns these before
# main(); a real run sets the environment variables from private ops notes.
APP = HOME = CONFIG = BACKUP_ROOT = STATE_DIR = AGENT_ENV = None
DEPLOY_USER = ""


def _env_path(name):
    value = os.environ.get(name, "").strip()
    return Path(value) if value else None


def resolve_layout():
    """Fill unset paths from the environment. Refuse to guess production locations."""
    global APP, HOME, CONFIG, BACKUP_ROOT, STATE_DIR, AGENT_ENV, DEPLOY_USER
    APP = APP or _env_path("SIGN402_APP_ROOT")
    HOME = HOME or _env_path("SIGN402_DEPLOY_HOME")
    CONFIG = CONFIG or _env_path("SIGN402_GATEWAY_ENV")
    BACKUP_ROOT = BACKUP_ROOT or _env_path("SIGN402_BACKUP_ROOT")
    STATE_DIR = STATE_DIR or _env_path("SIGN402_STATE_DIR")
    AGENT_ENV = AGENT_ENV or _env_path("SIGN402_HERMES_ENV")
    DEPLOY_USER = DEPLOY_USER or os.environ.get("SIGN402_DEPLOY_USER", "").strip()
    missing = [name for name, value in (
        ("SIGN402_APP_ROOT", APP), ("SIGN402_GATEWAY_ENV", CONFIG),
        ("SIGN402_BACKUP_ROOT", BACKUP_ROOT), ("SIGN402_STATE_DIR", STATE_DIR),
        ("SIGN402_DEPLOY_USER", DEPLOY_USER),
    ) if not value]
    if missing:
        raise RuntimeError("Set from private ops notes: " + ", ".join(missing))


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout.strip()


def process_env(unit):
    pid = run(["systemctl", "show", unit, "-p", "MainPID", "--value"])
    data = (Path("/proc") / pid / "environ").read_bytes()
    return dict(part.decode().split("=", 1) for part in data.split(b"\0") if b"=" in part)


def verify_wallets(release, env, path, apply=False):
    account = pwd.getpwnam(DEPLOY_USER)
    args = [str(APP / "sign402-gateway/.venv/bin/python"), str(release / "scripts/verify-managed-wallets.py"),
            "--db", str(path)] + (["--apply"] if apply else [])
    return json.loads(run(args, env=env, cwd=release, user=account.pw_uid, group=account.pw_gid,
                          extra_groups=os.getgrouplist(DEPLOY_USER, account.pw_gid)))


def validate_manifest(release, manifest):
    for name, digest in manifest["files"].items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] not in {
            "sign402-gateway", "solana-x402-service", "website", "docs", "scripts", "HACKATHON.md"
        }:
            raise RuntimeError("Unexpected release path")
        source = release / relative
        if source.is_symlink() or not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Release checksum mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", required=True)
    parser.parse_args()
    resolve_layout()
    if os.geteuid() != 0:
        raise RuntimeError("Run this installer with sudo")
    os.umask(0o077)
    release = Path(__file__).resolve().parents[1]
    manifest = json.loads((release / "release-manifest.json").read_text())
    validate_manifest(release, manifest)
    git = ["git", "-c", f"safe.directory={APP}", "-C", str(APP)]
    if run(git + ["rev-parse", "HEAD"]) != manifest["baseline"] or run(git + ["status", "--porcelain"]):
        raise RuntimeError("Production checkout changed; prepare and verify a fresh release")
    for unit in UNITS:
        run(["systemctl", "is-active", "--quiet", unit])
    env = process_env("sign402-gateway")
    web_env = process_env("sign402-web-api")
    if not env.get("SIGN402_WALLET_MASTER_KEY") or env["SIGN402_WALLET_MASTER_KEY"] != web_env.get("SIGN402_WALLET_MASTER_KEY"):
        raise RuntimeError("Gateway and web wallet keys do not match")
    wallet_db = Path(env.get("SIGN402_USER_WALLET_STORE_PATH", str(STATE_DIR / "user-wallets.db")))
    state = STATE_DIR.resolve()
    for value in (wallet_db, Path(env.get("SIGN402_SOLANA_ALLOWANCE_DB", str(state / "solana-allowance.db"))),
                  Path(web_env.get("SIGN402_WEB_DB", str(state / "web.db")))):
        if not value.is_absolute() or not value.resolve().is_relative_to(state):
            raise RuntimeError("Nonstandard state path requires a reviewed backup plan")
    before = verify_wallets(release, env, wallet_db)
    if not CONFIG.is_file() or not wallet_db.is_file():
        raise RuntimeError("Required configuration or wallet state is missing")
    print("Preflight wallet verification passed:", json.dumps(before), flush=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_ROOT / (stamp + "-auth-wallet-release")
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    print("Private backup:", backup, flush=True)
    installed = False
    run(["systemctl", "stop", *UNITS])
    try:
        for unit in UNITS:
            if run(["systemctl", "show", unit, "-p", "MainPID", "--value"]) != "0":
                raise RuntimeError("Service did not stop")
        with tarfile.open(backup / "state-and-config.tar.gz", "w:gz") as archive:
            saved = [state, CONFIG, APP / "demo-dashboard", APP / "solana-x402-service/.local"]
            if AGENT_ENV is not None:
                saved.insert(1, AGENT_ENV)
            for source in saved:
                if source.exists():
                    archive.add(source, arcname=str(source).lstrip("/"))
            for unit in UNITS:
                source = Path(run(["systemctl", "show", unit, "-p", "FragmentPath", "--value"]))
                archive.add(source, arcname=str(source).lstrip("/"))
        with tarfile.open(backup / "previous-code.tar.gz", "w:gz") as archive:
            for name in manifest["files"]:
                if (APP / name).exists():
                    archive.add(APP / name, arcname=name)
        (backup / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        # Validate stopped-state snapshot before changing any production file.
        stable = verify_wallets(release, env, wallet_db)
        owner = pwd.getpwnam(DEPLOY_USER)
        installed = True
        for name in manifest["files"]:
            target = APP / name
            target.parent.mkdir(parents=True, exist_ok=True)
            os.chown(target.parent, owner.pw_uid, owner.pw_gid)
            target.parent.chmod(0o755)
            temporary = target.with_name(target.name + ".release-tmp")
            with temporary.open("xb") as handle:
                handle.write((release / name).read_bytes())
                handle.flush()
                os.fsync(handle.fileno())
            os.chown(temporary, owner.pw_uid, owner.pw_gid)
            temporary.chmod(0o644)
            os.replace(temporary, target)
        after = verify_wallets(APP, env, wallet_db, apply=True)
        if after["verified"] != stable["verified"] or not after["identities_preserved"]:
            raise RuntimeError("Wallet preservation check failed")
        run(["systemctl", "start", *UNITS])
        # Read-only local health checks; no nonce, quote or payment endpoint.
        for attempt in range(20):
            try:
                for unit in UNITS:
                    run(["systemctl", "is-active", "--quiet", unit])
                with urllib.request.urlopen("http://127.0.0.1:8130/app/", timeout=3) as response:
                    if response.status != 200:
                        raise RuntimeError("Page unavailable")
                try:
                    urllib.request.urlopen("http://127.0.0.1:8130/web/v1/session", timeout=3).close()
                    raise RuntimeError("Session route accepted an unauthenticated request")
                except urllib.error.HTTPError as error:
                    if error.code != 401:
                        raise
                break
            except Exception:
                if attempt == 19:
                    raise RuntimeError("Post-install health checks failed") from None
                time.sleep(1)
        receipt = {"installed_at": stamp, "wallets": after, "files": manifest["files"], "baseline": manifest["baseline"]}
        (backup / "success.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print("Release installed; all three services and local page/session checks passed.", flush=True)
    except Exception:
        if installed:
            run(["systemctl", "stop", *UNITS])
            print("Installation stopped after a failed check. State is preserved and services are stopped.", file=sys.stderr)
            print("Use the private backup and recovery notes; do not restore an older database over new payments.", file=sys.stderr)
        else:
            run(["systemctl", "start", *UNITS])
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # subprocess errors can contain environment/credentials: never echo them.
        print("Release installation failed. Review the stopped stage and private backup before continuing.", file=sys.stderr)
        raise SystemExit(1)
