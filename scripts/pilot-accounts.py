#!/usr/bin/env python3
"""Pilot attribution (SI-88): how many accounts arrived with `utm_medium=pilot`, per campaign, and how far they got.

Read-only: web.db is opened with `file:PATH?mode=ro`, so this can run on the live VPS beside the gateway. Output is
aggregate counts only (per `utm_campaign` and `utm_source`): never an address, account id, key id or key name.

The app stores first-touch attribution once, when an account is created (`WebAccountStore.ensure_account`,
column `accounts.utm_json`, keys `UTM_KEYS` in web_accounts.py). A pilot link therefore has to carry
`?utm_source=github&utm_medium=pilot&utm_campaign=<project>` and be opened by someone who is not yet an account.

    python scripts/pilot-accounts.py                 # JSON on stdout
    python scripts/pilot-accounts.py --text          # a short table too
    python scripts/pilot-accounts.py --medium pilot --db /path/to/web.db

Columns per campaign: `accounts` (created with that attribution), `with_key` (made at least one API key),
`with_spend` (at least one key spent something), `last_account_at` (UTC date of the newest account, no time).
`accounts_with_utm` and `accounts_total` show how many accounts carry any attribution at all, so a zero can be
told apart from "attribution is not being written".
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path(os.environ.get("SIGN402_STATE_DIR", Path.home() / ".sign402")) / "web.db"
LABEL_MAX = 60


def _label(value) -> str:
    text = str(value or "(none)").replace("\n", " ").strip()
    return text[:LABEL_MAX] or "(none)"


def pilot_report(db_path: Path, medium: str = "pilot") -> dict:
    path = Path(db_path)
    if not path.exists():
        return {"ok": False, "error": "web.db not found", "medium": medium}
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        db.row_factory = sqlite3.Row
        columns = {r["name"] for r in db.execute("PRAGMA table_info(accounts)")}
        if "utm_json" not in columns:
            return {"ok": False, "error": "accounts.utm_json column is missing (older deploy)", "medium": medium}
        rows = db.execute("SELECT account_id, created_at, utm_json FROM accounts").fetchall()
        tables = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        keyed: set[str] = set()
        spent: set[str] = set()
        if "api_keys" in tables:
            keyed = {r["account_id"] for r in db.execute("SELECT DISTINCT account_id FROM api_keys")}
            if "api_key_spend" in tables:
                spent = {r["account_id"] for r in db.execute(
                    "SELECT DISTINCT k.account_id FROM api_keys k JOIN api_key_spend s ON s.key_id = k.key_id "
                    "WHERE s.spent_atomic > 0")}
    finally:
        db.close()
    total, with_utm = len(rows), 0
    groups: dict[tuple[str, str], dict] = {}
    for row in rows:
        try:
            utm = json.loads(row["utm_json"]) if row["utm_json"] else None
        except (TypeError, ValueError):
            utm = None
        if not isinstance(utm, dict) or not utm:
            continue
        with_utm += 1
        if utm.get("utm_medium") != medium:
            continue
        group = groups.setdefault((_label(utm.get("utm_campaign")), _label(utm.get("utm_source"))),
                                  {"accounts": 0, "with_key": 0, "with_spend": 0, "newest": 0})
        group["accounts"] += 1
        group["with_key"] += row["account_id"] in keyed
        group["with_spend"] += row["account_id"] in spent
        group["newest"] = max(group["newest"], int(row["created_at"] or 0))
    campaigns = [{"utm_campaign": c, "utm_source": s, "accounts": g["accounts"], "with_key": g["with_key"],
                  "with_spend": g["with_spend"],
                  "last_account_at": datetime.datetime.fromtimestamp(g["newest"], datetime.timezone.utc).strftime("%Y-%m-%d")}
                 for (c, s), g in sorted(groups.items(), key=lambda kv: (-kv[1]["accounts"], kv[0]))]
    return {"ok": True, "medium": medium, "accounts_total": total, "accounts_with_utm": with_utm,
            "pilot_accounts": sum(c["accounts"] for c in campaigns), "campaigns": campaigns}


def render_text(report: dict) -> str:
    if not report.get("ok"):
        return f"pilot-accounts: {report.get('error')}"
    lines = [f"utm_medium={report['medium']}: {report['pilot_accounts']} accounts "
             f"({report['accounts_with_utm']} of {report['accounts_total']} accounts carry any attribution)"]
    for c in report["campaigns"]:
        lines.append(f"  {c['utm_campaign']} / {c['utm_source']}: {c['accounts']} accounts, {c['with_key']} with a key, "
                     f"{c['with_spend']} with spend, newest {c['last_account_at']}")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="web.db (default $SIGN402_STATE_DIR/web.db)")
    parser.add_argument("--medium", default="pilot", help="utm_medium to count (default pilot)")
    parser.add_argument("--text", action="store_true", help="also print a short table to stderr")
    args = parser.parse_args(argv)
    report = pilot_report(args.db, args.medium)
    print(json.dumps(report, indent=2))
    if args.text:
        print(render_text(report), file=sys.stderr)
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
