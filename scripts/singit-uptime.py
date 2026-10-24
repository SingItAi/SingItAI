#!/usr/bin/env python3
"""Measured uptime of SingIt's public endpoints, recorded locally in SQLite.

Each run probes a fixed list of public URLs with plain, UNPAID GET requests (never a payment
header, never a body) and appends one row per probe to `probes(ts, endpoint, ok, status,
latency_ms, error)`. `error` is an error CLASS only (timeout, connection, tls, http_status,
bad_challenge, bad_body), never a response body or an exception message.

    python scripts/singit-uptime.py                          # one probe round, recorded
    python scripts/singit-uptime.py --report                 # JSON: 24h/7d/30d per endpoint
    python scripts/singit-uptime.py --report-file out.json   # same, written to a file
    python scripts/singit-uptime.py --status-json status.json --html status.html

Probe mode is a recorder: it exits 0 even when endpoints are down (a down endpoint is data, not a
failure of the recorder). It exits non-zero only for usage or configuration errors. Report modes
never probe and never write to the database.

The database defaults to ~/.sign402/uptime.db, overridden by `SINGIT_UPTIME_DB` or `--db`. The
endpoint list defaults to the table below; `--endpoints FILE` replaces it with a JSON list of
{name, url, expect, kind, json_key, json_ok}. Unknown keys are refused, so a config can never add
request headers.

Availability is ok/total over the window, and `null` when the window has no probes: it is never
assumed to be 100%. Each window also says whether the recorded history actually `covered` it.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import concurrent.futures
import datetime
import html
import http.client
import json
import math
import os
import re
import socket
import sqlite3
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

DB_ENV = "SINGIT_UPTIME_DB"
DEFAULT_DB = "~/.sign402/uptime.db"

TIMEOUT_SECONDS = 10
MAX_BODY_BYTES = 2_000_000
USER_AGENT = "singit-uptime/1 (+unpaid GET probe)"

# Error classes stored in probes.error. Nothing else is ever written there.
ERR_TIMEOUT = "timeout"
ERR_CONNECTION = "connection"
ERR_TLS = "tls"
ERR_HTTP_STATUS = "http_status"
ERR_BAD_CHALLENGE = "bad_challenge"
ERR_BAD_BODY = "bad_body"
ERR_UNEXPECTED = "unexpected"

WINDOWS = {"24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
KINDS = ("plain", "x402", "json")
ENDPOINT_KEYS = {"name", "url", "expect", "kind", "json_key", "json_ok"}

# The web API (sign402-gateway/sign402_gateway/web_api.py) has no /health route. The page it
# serves from its static root, /app/, is the cheapest public URL that only answers 200 when the
# process is up AND its static root is configured, so that is what app-page probes. /mcp answers a
# plain GET with 405 (POST-only Streamable HTTP), which proves the MCP route is mounted without
# calling a tool. ask-health matches singit-ask/src/app.mjs: GET /health -> {"ok": true, ...}.
DEFAULT_ENDPOINTS: list[dict[str, Any]] = [
    {"name": "ask-responses", "url": "https://ask.singitai.app/v1/responses", "expect": 402, "kind": "x402"},
    {"name": "ask-chat", "url": "https://ask.singitai.app/v1/chat/completions", "expect": 402, "kind": "x402"},
    {"name": "ask-openapi", "url": "https://ask.singitai.app/openapi.json", "expect": 200,
     "kind": "json", "json_key": "openapi"},
    {"name": "ask-health", "url": "https://ask.singitai.app/health", "expect": 200,
     "kind": "json", "json_ok": True},
    {"name": "app-page", "url": "https://app.singitai.app/app/", "expect": 200, "kind": "plain"},
    {"name": "app-mcp", "url": "https://app.singitai.app/mcp", "expect": 405, "kind": "plain"},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS probes (
    ts INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    latency_ms INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS probes_endpoint_ts ON probes(endpoint, ts);
"""

Opener = Callable[[urllib.request.Request, float], "tuple[int, Any, bytes]"]


# ---------------------------------------------------------------- endpoint configuration


def load_endpoints(path: str | None) -> list[dict[str, Any]]:
    """The default list, or a validated list from a JSON file. Raises ValueError on a bad entry."""
    if not path:
        return [dict(item) for item in DEFAULT_ENDPOINTS]
    try:
        data = json.loads(Path(path).expanduser().read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f"cannot read endpoints file: {type(exc).__name__}") from None
    if isinstance(data, dict):
        data = data.get("endpoints")
    if not isinstance(data, list) or not data:
        raise ValueError("endpoints file must hold a non-empty list")
    endpoints, seen = [], set()
    for index, raw in enumerate(data):
        endpoint = _validate_endpoint(raw, index)
        if endpoint["name"] in seen:
            raise ValueError(f"endpoint #{index}: duplicate name")
        seen.add(endpoint["name"])
        endpoints.append(endpoint)
    return endpoints


def _validate_endpoint(raw: Any, index: int) -> dict[str, Any]:
    where = f"endpoint #{index}"
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: must be an object")
    extra = set(raw) - ENDPOINT_KEYS
    if extra:
        raise ValueError(f"{where}: unknown keys {sorted(extra)}")
    name, url, expect = raw.get("name"), raw.get("url"), raw.get("expect")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ValueError(f"{where}: name must match {NAME_RE.pattern}")
    parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
    if parsed is None or parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"{where}: url must be http(s)")
    if parsed.username or parsed.password:
        raise ValueError(f"{where}: url must not carry credentials")
    if isinstance(expect, bool) or not isinstance(expect, int) or not 100 <= expect <= 599:
        raise ValueError(f"{where}: expect must be an HTTP status")
    kind = raw.get("kind", "plain")
    if kind not in KINDS:
        raise ValueError(f"{where}: kind must be one of {KINDS}")
    json_key = raw.get("json_key")
    if json_key is not None and not isinstance(json_key, str):
        raise ValueError(f"{where}: json_key must be a string")
    json_ok = raw.get("json_ok", False)
    if not isinstance(json_ok, bool):
        raise ValueError(f"{where}: json_ok must be a boolean")
    return {"name": name, "url": url, "expect": expect, "kind": kind,
            **({"json_key": json_key} if json_key else {}), **({"json_ok": True} if json_ok else {})}


# ---------------------------------------------------------------- x402 challenge validation


def _header(headers: Any, name: str) -> Any:
    if not headers:
        return None
    wanted = name.lower()
    items = headers.items() if hasattr(headers, "items") else headers
    for key, value in items:
        if isinstance(key, str) and key.lower() == wanted:
            return value
    return None


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _amount(entry: dict[str, Any]) -> bool:
    for key in ("amount", "maxAmountRequired"):
        value = entry.get(key)
        if _text(value) or (isinstance(value, (int, float)) and not isinstance(value, bool)):
            return True
    return False


def _challenge_ok(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    version = data.get("x402Version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        return False
    accepts = data.get("accepts")
    if not isinstance(accepts, list) or not accepts:
        return False
    return all(isinstance(entry, dict) and _text(entry.get("scheme")) and _text(entry.get("network"))
               and _text(entry.get("payTo")) and _amount(entry) for entry in accepts)


def _decode_header_challenge(value: Any) -> Any:
    if not _text(value):
        return None
    raw = value.strip()
    raw += "=" * (-len(raw) % 4)
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            return json.loads(decoder(raw))
        except (binascii.Error, ValueError):
            continue
    return None


def _decode_body_challenge(body: Any) -> Any:
    if isinstance(body, dict):
        return body
    if isinstance(body, (bytes, bytearray)):
        try:
            body = bytes(body).decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(body, str) or not body.strip():
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def validate_challenge(headers: Any, body: Any) -> bool:
    """True when a 402 carries a well-formed x402 challenge.

    v2 puts it base64-JSON in the `PAYMENT-REQUIRED` response header (the body is `{}`); v1 put
    the JSON in the body, so a valid body is accepted too. The challenge needs `x402Version` and a
    non-empty `accepts` list whose every entry has scheme, network, payTo and an amount (`amount`
    or `maxAmountRequired`).
    """
    if _challenge_ok(_decode_header_challenge(_header(headers, "PAYMENT-REQUIRED"))):
        return True
    return _challenge_ok(_decode_body_challenge(body))


# ---------------------------------------------------------------- probing


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is never followed (it could leave the host); it surfaces as its 3xx status."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def urllib_opener(request: urllib.request.Request, timeout: float) -> tuple[int, dict[str, str], bytes]:
    """The real opener: (status, lowercase-keyed headers, body up to MAX_BODY_BYTES)."""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, _lower_headers(response.headers), response.read(MAX_BODY_BYTES)
    except urllib.error.HTTPError as exc:  # 4xx/5xx and un-followed 3xx carry a status and headers
        try:
            return exc.code, _lower_headers(exc.headers), exc.read(MAX_BODY_BYTES)
        finally:
            exc.close()


def _lower_headers(headers: Any) -> dict[str, str]:
    return {key.lower(): value for key, value in headers.items()} if headers else {}


def build_request(url: str) -> urllib.request.Request:
    """GET only, with no payment header and no body, ever."""
    return urllib.request.Request(url, method="GET",
                                  headers={"User-Agent": USER_AGENT, "Accept": "application/json"})


def classify_exception(exc: BaseException) -> str:
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, (ssl.SSLError, ssl.CertificateError)):
        return ERR_TLS
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return ERR_TIMEOUT
    if isinstance(reason, (OSError, http.client.HTTPException)):
        return ERR_CONNECTION
    return ERR_UNEXPECTED


def _check_body(endpoint: dict[str, Any], body: bytes) -> bool:
    kind = endpoint.get("kind", "plain")
    if kind != "json":
        return True
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    if endpoint.get("json_key") and not (isinstance(data, dict) and endpoint["json_key"] in data):
        return False
    if endpoint.get("json_ok") and not (isinstance(data, dict) and data.get("ok") is True):
        return False
    return True


def probe_endpoint(endpoint: dict[str, Any], opener: Opener, *, timeout: float = TIMEOUT_SECONDS,
                   clock: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    """One probe -> {endpoint, ok, status, latency_ms, error}. Never raises for network trouble."""
    started = clock()
    status: int | None = None
    error: str | None = None
    try:
        status, headers, body = opener(build_request(endpoint["url"]), timeout)
    except Exception as exc:  # the class is kept, the message never is
        error = classify_exception(exc)
    latency_ms = max(0, int(round((clock() - started) * 1000)))
    if error is None:
        if status != endpoint["expect"]:
            error = ERR_HTTP_STATUS
        elif endpoint.get("kind") == "x402" and not validate_challenge(headers, body):
            error = ERR_BAD_CHALLENGE
        elif not _check_body(endpoint, body):
            error = ERR_BAD_BODY
    return {"endpoint": endpoint["name"], "ok": 1 if error is None else 0, "status": status,
            "latency_ms": latency_ms, "error": error}


def probe_round(endpoints: list[dict[str, Any]], opener: Opener, *, timeout: float = TIMEOUT_SECONDS,
                clock: Callable[[], float] = time.monotonic) -> list[dict[str, Any]]:
    """Probe every endpoint concurrently, so a round lasts about one timeout, not their sum."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
        return list(pool.map(lambda ep: probe_endpoint(ep, opener, timeout=timeout, clock=clock), endpoints))


# ---------------------------------------------------------------- storage


def resolve_db_path(arg: str | None, env: dict[str, str] | os._Environ) -> Path:
    return Path(arg or env.get(DB_ENV) or DEFAULT_DB).expanduser()


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.executescript(SCHEMA)
    return db


def open_db_readonly(path: Path) -> sqlite3.Connection:
    """Reports never create or modify the database; a missing one reads as no probes at all."""
    if not path.is_file():
        db = sqlite3.connect(":memory:")
        db.executescript(SCHEMA)
        return db
    return sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True, timeout=10)


def record(db: sqlite3.Connection, results: list[dict[str, Any]], ts: float) -> None:
    with db:
        db.executemany(
            "INSERT INTO probes(ts, endpoint, ok, status, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)",
            [(int(ts), r["endpoint"], r["ok"], r["status"], r["latency_ms"], r["error"]) for r in results])


def prune(db: sqlite3.Connection, days: int, now: float) -> int:
    with db:
        return db.execute("DELETE FROM probes WHERE ts < ?", (int(now - days * 86400),)).rowcount


# ---------------------------------------------------------------- report


def iso(ts: float | int | None) -> str | None:
    if ts is None:
        return None
    return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def percentile(values: list[int], pct: float) -> int | None:
    """Nearest-rank percentile; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(pct / 100 * len(ordered)) - 1)]


def _availability(ok: int, total: int) -> float | None:
    return round(100 * ok / total, 3) if total else None


def _coverage(first_ts: int | None, now: float, seconds: int) -> dict[str, Any]:
    """Whether recorded history reaches back over the whole window, and how much of it does."""
    start = now - seconds
    if first_ts is None:
        return {"covered": False, "first_probe_ts": None, "coverage_pct": 0.0}
    seen = now - max(first_ts, start)
    return {"covered": first_ts <= start, "first_probe_ts": iso(first_ts),
            "coverage_pct": round(100 * min(1.0, max(0.0, seen / seconds)), 1)}


def _endpoint_report(db: sqlite3.Connection, name: str, now: float) -> dict[str, Any]:
    now_i = int(now)
    first = db.execute("SELECT MIN(ts) FROM probes WHERE endpoint = ? AND ts <= ?", (name, now_i)).fetchone()[0]
    rows = db.execute("SELECT ts, ok, latency_ms FROM probes WHERE endpoint = ? AND ts > ? AND ts <= ? "
                      "ORDER BY ts", (name, now_i - max(WINDOWS.values()), now_i)).fetchall()
    windows: dict[str, Any] = {}
    for label, seconds in WINDOWS.items():
        inside = [row for row in rows if row[0] > now_i - seconds]
        ok = sum(1 for row in inside if row[1])
        latencies = [row[2] for row in inside if row[1] and row[2] is not None]
        windows[label] = {"availability_pct": _availability(ok, len(inside)), "probes": len(inside), "ok": ok,
                          "p50_latency_ms": percentile(latencies, 50), "p95_latency_ms": percentile(latencies, 95),
                          **_coverage(first, now, seconds)}
    failure = db.execute("SELECT ts, error FROM probes WHERE endpoint = ? AND ok = 0 AND ts <= ? "
                         "ORDER BY ts DESC LIMIT 1", (name, now_i)).fetchone()
    consecutive, current = 0, "no_data"
    for position, (ok,) in enumerate(db.execute(
            "SELECT ok FROM probes WHERE endpoint = ? AND ts <= ? ORDER BY ts DESC", (name, now_i))):
        if position == 0:
            current = "up" if ok else "down"
        if ok:
            break
        consecutive += 1
    return {"name": name, "current": current, "windows": windows,
            "last_failure": {"ts": iso(failure[0]), "error": failure[1]} if failure else None,
            "consecutive_failures": consecutive}


def _overall(endpoints: list[dict[str, Any]]) -> dict[str, Any]:
    states = [ep["current"] for ep in endpoints]
    if "down" in states:
        status = "down"
    elif all(state == "no_data" for state in states):
        status = "no_data"
    elif all(state == "up" for state in states):
        status = "up"
    else:
        status = "unknown"  # some endpoints up, some never probed
    windows = {}
    for label in WINDOWS:
        parts = [ep["windows"][label] for ep in endpoints]
        total, ok = sum(p["probes"] for p in parts), sum(p["ok"] for p in parts)
        windows[label] = {"availability_pct": _availability(ok, total), "probes": total,
                          "covered": all(p["covered"] for p in parts)}
    return {"status": status, "endpoints_total": len(endpoints),
            "endpoints_up": states.count("up"), "endpoints_down": states.count("down"),
            "endpoints_no_data": states.count("no_data"), "windows": windows}


def build_report(db: sqlite3.Connection, endpoint_names: list[str], now: float) -> dict[str, Any]:
    endpoints = [_endpoint_report(db, name, now) for name in endpoint_names]
    return {"generated_at": iso(now), "latency_basis": "successful probes only",
            "endpoints": endpoints, "overall": _overall(endpoints)}


# ---------------------------------------------------------------- public outputs


def build_status(report: dict[str, Any]) -> dict[str, Any]:
    """A small public-safe document: names, up/down, availability and probe counts. No errors."""
    def windows(source: dict[str, Any]) -> dict[str, Any]:
        return {label: {"availability_pct": w["availability_pct"], "probes": w["probes"], "covered": w["covered"]}
                for label, w in source["windows"].items()}
    return {"generated_at": report["generated_at"],
            "overall": {"status": report["overall"]["status"], "windows": windows(report["overall"])},
            "endpoints": [{"name": ep["name"], "status": ep["current"], "windows": windows(ep)}
                          for ep in report["endpoints"]]}


STATUS_LABEL = {"up": "Up", "down": "Down", "no_data": "No data", "unknown": "Unknown"}

# Colors are the SingIt adaptation of DESIGN.md: Bone canvas, Ink text, Ash secondary, white cards
# on a hairline border. The Emerald accent is reserved for actions, so status is words, not color.
PAGE_CSS = """
:root { --bone: #f4f2f0; --ink: #0c0a08; --ash: #6d6c6b; --paper: #ffffff; --hairline: #e5e7eb; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bone); color: var(--ink); text-align: left;
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16px; line-height: 1.5; font-weight: 400; font-feature-settings: "ss01"; }
h1, h2, h3, strong, b, th { font-weight: 400; }
main { max-width: 1200px; margin: 0 auto; padding: 64px 24px; }
h1 { font-size: 40px; line-height: 1.05; margin: 0 0 12px; }
h2 { font-size: 24px; line-height: 1.17; margin: 0; }
.sub { color: var(--ash); margin: 0 0 32px; }
.label { font-size: 10px; line-height: 2.2; letter-spacing: 0.018em; text-transform: uppercase; color: var(--ash); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-top: 16px; }
.card { background: var(--paper); border: 1px solid var(--hairline); border-radius: 16px; padding: 24px; }
.card .state { font-size: 28px; line-height: 1.14; margin: 8px 0 16px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 8px 8px 0; border-top: 1px solid var(--hairline); }
th { color: var(--ash); }
.note { color: var(--ash); }
"""


def _pct(window: dict[str, Any]) -> str:
    return "No data" if window["availability_pct"] is None else f"{window['availability_pct']:.2f}%"


def _rows(windows: dict[str, Any]) -> str:
    out = []
    for label, w in windows.items():
        note = "" if w["covered"] or w["probes"] == 0 else ' <span class="note">partial history</span>'
        out.append(f"<tr><th>{html.escape(label)}</th><td>{html.escape(_pct(w))}{note}</td>"
                   f"<td>{html.escape(str(w['probes']))} probes</td></tr>")
    return "\n".join(out)


def render_html(report: dict[str, Any]) -> str:
    e = html.escape
    overall = report["overall"]
    cards = []
    for ep in report["endpoints"]:
        cards.append(
            f'<section class="card"><div class="label">{e(ep["name"])}</div>'
            f'<div class="state">{e(STATUS_LABEL.get(ep["current"], "Unknown"))}</div>'
            f'<table>{_rows(ep["windows"])}</table></section>')
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SingIt status</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400&amp;display=swap" rel="stylesheet">
<style>{PAGE_CSS}</style>
</head>
<body>
<main>
<h1>SingIt status</h1>
<p class="sub">Measured by unpaid probes recorded once a minute. Updated {e(str(report["generated_at"]))}.
Percentages marked partial history cover less than the full window.</p>
<section class="card"><div class="label">Overall</div>
<div class="state">{e(STATUS_LABEL.get(overall["status"], "Unknown"))}</div>
<table>{_rows(overall["windows"])}</table></section>
<div class="grid">
{chr(10).join(cards)}
</div>
</main>
</body>
</html>
"""


def write_atomic(path: str, text: str) -> None:
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------- CLI


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record and report measured uptime of SingIt's public endpoints (unpaid GET probes only). "
                    "With no output flag it runs one probe round and records it; probe mode exits 0 even "
                    "when endpoints are down.")
    parser.add_argument("--db", help=f"SQLite file (default ${DB_ENV}, else {DEFAULT_DB})")
    parser.add_argument("--endpoints", help="JSON file replacing the default endpoint list")
    parser.add_argument("--report", action="store_true", help="print the JSON availability report; no probing")
    parser.add_argument("--report-file", metavar="PATH", help="also write the JSON report to PATH (implies report mode)")
    parser.add_argument("--status-json", metavar="PATH", help="write a small public-safe status JSON (report mode)")
    parser.add_argument("--html", metavar="PATH", help="write a static status page (report mode)")
    parser.add_argument("--prune-days", type=int, metavar="N",
                        help="after a probe round, delete probes older than N days (default: keep everything)")
    return parser


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None,
         opener: Opener | None = None, now: float | None = None) -> int:
    values = os.environ if env is None else env
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.prune_days is not None and args.prune_days < 1:
        parser.error("--prune-days must be at least 1")
    try:
        endpoints = load_endpoints(args.endpoints)
    except ValueError as exc:
        print(f"singit-uptime: {exc}", file=sys.stderr)
        return 2
    db_path = resolve_db_path(args.db, values)
    stamp = time.time() if now is None else now

    if args.report or args.report_file or args.status_json or args.html:
        db = open_db_readonly(db_path)
        try:
            report = build_report(db, [ep["name"] for ep in endpoints], stamp)
        finally:
            db.close()
        if args.report_file:
            write_atomic(args.report_file, json.dumps(report, indent=2, sort_keys=True) + "\n")
        if args.status_json:
            write_atomic(args.status_json, json.dumps(build_status(report), indent=2, sort_keys=True) + "\n")
        if args.html:
            write_atomic(args.html, render_html(report))
        if args.report:
            print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    results = probe_round(endpoints, opener or urllib_opener)
    db = open_db(db_path)
    try:
        record(db, results, stamp)
        if args.prune_days:
            prune(db, args.prune_days, stamp)
    finally:
        db.close()
    for result in results:
        detail = result["error"] or "ok"
        print(f"{result['endpoint']} {'up' if result['ok'] else 'down'} status={result['status']} "
              f"latency_ms={result['latency_ms']} {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
