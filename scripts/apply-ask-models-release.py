#!/usr/bin/env python3
"""Install the "any Surplus model for SingIt Ask" release on the existing single VPS.

The prepared release carries release-manifest.json: for every file the SHA-256 production must have now
("before", null for a new file) and the SHA-256 the release installs ("after"). Production is not a clean
checkout (earlier releases were installed over it), so files are compared one by one: if any differs from
its "before", nothing is changed. Run with sudo and --apply; --check-only changes nothing and needs no sudo.

The release changes code only. No database, key, environment or unit file is touched, and no payment,
quote or paid endpoint is called: the post-install checks send one unpaid request, which can only be answered
with a payment request (402) or a refusal. If a check fails after installation, the previous files are put
back and the services restarted.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

ASK_UNIT = "singit-ask"  # a user unit of the deploy account
SYSTEM_UNITS = ["sign402-gateway", "sign402-web-api"]
ALLOWED = {"sign402-gateway", "singit-ask", "website"}
APP = HOME = BACKUP_ROOT = STATE_DIR = None
DEPLOY_USER = ""


def _env_path(name):
    value = os.environ.get(name, "").strip()
    return Path(value) if value else None


def resolve_layout():
    """Production paths come from the environment, not from this file."""
    global APP, HOME, BACKUP_ROOT, STATE_DIR, DEPLOY_USER, JOURNALS
    APP = APP or _env_path("SIGN402_APP_ROOT")
    HOME = HOME or _env_path("SIGN402_DEPLOY_HOME")
    BACKUP_ROOT = BACKUP_ROOT or _env_path("SIGN402_BACKUP_ROOT")
    STATE_DIR = STATE_DIR or _env_path("SIGN402_STATE_DIR")
    DEPLOY_USER = DEPLOY_USER or os.environ.get("SIGN402_DEPLOY_USER", "").strip()
    missing = [name for name, value in (
        ("SIGN402_APP_ROOT", APP), ("SIGN402_BACKUP_ROOT", BACKUP_ROOT),
        ("SIGN402_STATE_DIR", STATE_DIR), ("SIGN402_DEPLOY_USER", DEPLOY_USER),
    ) if not value]
    if missing:
        raise RuntimeError("Set from private ops notes: " + ", ".join(missing))
    JOURNALS = STATE_DIR / "ask-metered"
ASK = "http://127.0.0.1:8140"
WEB = "http://127.0.0.1:8130"


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout.strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def user_systemctl(*args):
    """systemctl for the deploy user's own units, from that user or from root."""
    uid = pwd.getpwnam(DEPLOY_USER).pw_uid
    command = ["systemctl", "--user", *args]
    if os.geteuid() == 0:
        command = ["runuser", "-u", DEPLOY_USER, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{uid}", *command]
    return run(command, env={**os.environ, "XDG_RUNTIME_DIR": f"/run/user/{uid}"})


def http(url, body=None, timeout=5):
    """(status, headers, body bytes); error statuses are answers, not exceptions."""
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def load(release):
    manifest = json.loads((release / "release-manifest.json").read_text())
    for name, hashes in manifest["files"].items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] not in ALLOWED:
            raise RuntimeError("Unexpected release path: " + name)
        source = release / relative
        if source.is_symlink() or sha(source) != hashes["after"]:
            raise RuntimeError("Release checksum mismatch: " + name)
    return manifest


def production_state(manifest):
    """'ready' when every file is as the release expects, 'installed' when all already match, else refuse."""
    ready = installed = 0
    for name, hashes in manifest["files"].items():
        current = sha(APP / name)
        ready += current == hashes["before"]
        installed += current == hashes["after"]
    total = len(manifest["files"])
    if ready == total:
        return "ready"
    if installed == total:
        return "installed"
    raise RuntimeError("Production files differ from what this release was built on; prepare a fresh release")


def preflight(manifest):
    state = production_state(manifest)
    # A previous Ask payment that is not settled up leaves a journal or checkpoint: never restart over one.
    pending = [p.name for p in JOURNALS.glob("*") if p.suffix in {".json", ".submitted"}] if JOURNALS.is_dir() else []
    if pending:
        raise RuntimeError("An Ask payment is still being settled up; try again after it is: " + ", ".join(pending))
    for unit in SYSTEM_UNITS:
        run(["systemctl", "is-active", "--quiet", unit])
    user_systemctl("is-active", "--quiet", ASK_UNIT)
    return state


def install(release, manifest):
    owner = pwd.getpwnam(DEPLOY_USER)
    for name in manifest["files"]:
        target = APP / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".release-tmp")
        with temporary.open("xb") as handle:
            handle.write((release / name).read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temporary, owner.pw_uid, owner.pw_gid)
        temporary.chmod(0o644)
        os.replace(temporary, target)


def restore(backup, manifest):
    """Put the previous files back (and remove the ones the release added). Code only: no state to undo."""
    owner = pwd.getpwnam(DEPLOY_USER)
    with tarfile.open(backup / "previous-code.tar.gz") as archive:
        for name, hashes in manifest["files"].items():
            target = APP / name
            if hashes["before"] is None:
                target.unlink(missing_ok=True)
                continue
            data = archive.extractfile(name).read()
            temporary = target.with_name(target.name + ".restore-tmp")
            temporary.write_bytes(data)
            os.chown(temporary, owner.pw_uid, owner.pw_gid)
            temporary.chmod(0o644)
            os.replace(temporary, target)


def retry(check, attempts=20):
    for attempt in range(attempts):
        try:
            return check()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(1)


def check_ask():
    status, _, body = http(ASK + "/health")
    if status != 200 or json.loads(body).get("ok") is not True:
        raise RuntimeError("singit-ask is not healthy")
    # The list is free and, with this release, names the default and carries Surplus's prices.
    status, _, body = http(ASK + "/v1/models", timeout=15)
    listing = json.loads(body)
    if status != 200 or "default" not in listing or not listing.get("data"):
        raise RuntimeError("The model list is not the new one")
    # Unpaid and unknown: refused before any payment is asked for.
    status, headers, _ = http(ASK + "/v1/chat/completions",
                              {"messages": [{"role": "user", "content": "ping"}], "model": "no-such-model"}, timeout=15)
    if status != 400:
        raise RuntimeError("An unknown model was not refused")
    # Unpaid and default: still offered at the standing ceiling, on both networks.
    status, headers, _ = http(ASK + "/v1/chat/completions", {"messages": [{"role": "user", "content": "ping"}]}, timeout=15)
    if status != 402:
        raise RuntimeError("The default question was not offered for payment")
    import base64
    offered = json.loads(base64.b64decode(headers["payment-required"]))["accepts"]
    if sorted(a["amount"] for a in offered) != ["3000", "3000"]:
        raise RuntimeError("The default model's ceiling changed")


def check_web():
    for unit in SYSTEM_UNITS:
        run(["systemctl", "is-active", "--quiet", unit])
    if http(WEB + "/app/")[0] != 200:
        raise RuntimeError("Page unavailable")
    if http(WEB + "/web/v1/session")[0] != 401:
        raise RuntimeError("Session route accepted an unauthenticated request")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    arguments = parser.parse_args()
    if arguments.apply == arguments.check_only:
        raise RuntimeError("Choose exactly one of --apply and --check-only")
    resolve_layout()
    release = Path(__file__).resolve().parents[1]
    manifest = load(release)
    state = preflight(manifest)
    if arguments.check_only:
        print(f"Release is intact; production is '{state}'; no Ask payment is pending. Nothing was changed.")
        return
    if os.geteuid() != 0:
        raise RuntimeError("Run this installer with sudo")
    if state == "installed":
        print("This release is already installed. Nothing was changed.")
        return
    os.umask(0o077)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_ROOT / (stamp + "-ask-models-release")
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    with tarfile.open(backup / "previous-code.tar.gz", "w:gz") as archive:
        for name, hashes in manifest["files"].items():
            if hashes["before"] is not None:
                archive.add(APP / name, arcname=name)
    (backup / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Private backup:", backup, flush=True)
    installed = False
    try:
        installed = True
        install(release, manifest)
        # The merchant first, so the gateway never talks to an older one through the new code.
        user_systemctl("restart", ASK_UNIT)
        retry(check_ask)
        run(["systemctl", "restart", *SYSTEM_UNITS])
        retry(check_web)
        (backup / "success.json").write_text(json.dumps({"installed_at": stamp, "files": manifest["files"]}, indent=2) + "\n")
        print("Release installed; singit-ask, the gateway and the page passed their checks.", flush=True)
    except Exception:
        if installed:
            restore(backup, manifest)
            user_systemctl("restart", ASK_UNIT)
            run(["systemctl", "restart", *SYSTEM_UNITS])
            print("A check failed: the previous files were put back and the services restarted.", file=sys.stderr)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Subprocess errors can carry environment values: print only our own messages.
        print("Release not installed or rolled back:", error if isinstance(error, RuntimeError) else type(error).__name__,
              file=sys.stderr)
        raise SystemExit(1)
