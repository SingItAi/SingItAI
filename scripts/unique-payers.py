#!/usr/bin/env python3
"""Counts unique EXTERNAL x402 payers of SingIt's Base USDC merchant address(es).

Stdlib only, Python 3.9+. Read-only: makes HTTP GET/POST requests to a block explorer (or an RPC
endpoint), never a write, never a payment.

Merchant (payTo) addresses scanned, and where each comes from (see DEFAULT_MERCHANTS below):
  * 0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e -- singit-ask/src/pricing.mjs (PAY_TO),
    sdk/python/src/singit/pins.py, sdk/typescript/src/pins.js, sign402-gateway/sign402_gateway/
    ask_metered.py (PAY_TO). SingIt Ask's metered-chat x402 receiver on Base.
There is also a Solana payTo (4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu, same files' SOLANA_PAY_TO)
but this script only scans Base USDC Transfer events; Solana is listed for completeness, not scanned.

Data source: Transfer(address,address,uint256) events of Base USDC
(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) into each merchant address.
  * Primary: Blockscout's v2 API (no key needed), paginated via next_page_params.
  * Fallback (--rpc URL): eth_getLogs over an explicit block range, chunked, for when Blockscout
    answers 403. Needs --from-block and --to-block (an RPC has no equivalent of "give me
    everything"; you have to bound it).

Exclusions ("own" payments, never counted as external): the addresses in DEFAULT_MERCHANTS are
always excluded (a merchant topping up or paying another listed merchant is not a customer).
Beyond that, this script hardcodes nothing else -- any other SingIt-owned wallet (operator,
treasury, test) must be supplied at run time, never committed:
  * $SINGIT_OWN_WALLETS: comma-separated addresses.
  * --exclude-file PATH: one address per line, '#' starts a comment. Keep this file out of git.
Comparison is case-insensitive.

Output defaults to aggregate numbers only: unique external payers, payment count, total USDC,
excluded-own-payment count, date range, and a per-merchant breakdown. Individual payer addresses
are only printed with --list (which also prints a stderr warning that the output must not be
published), and never otherwise. --json switches to machine-readable JSON.

    python3 scripts/unique-payers.py
    python3 scripts/unique-payers.py --since 2026-01-01 --json
    python3 scripts/unique-payers.py --exclude-file ~/.sign402/my-wallets.txt
    python3 scripts/unique-payers.py --rpc https://mainnet.base.org --from-block 20000000 --to-block 20100000
    python3 scripts/unique-payers.py --list   # WARNING: prints payer addresses; do not publish

Tests: python3 -m unittest discover -s scripts/tests
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator

USER_AGENT = "singit-unique-payers/1 (+https://singitai.app)"
READ_CAP = 20_000_000

USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_DECIMALS_FALLBACK = 6

BLOCKSCOUT_BASE = "https://base.blockscout.com"

# keccak256("Transfer(address,address,uint256)") -- the standard ERC-20 Transfer event topic0.
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# SingIt-owned merchant (payTo) addresses already public in this repo. Each is scanned for
# incoming USDC and is also always excluded as a payer (see load_exclusions): a merchant paying
# itself, or another merchant in this dict, is never an external customer.
DEFAULT_MERCHANTS = {
    "base": {
        # singit-ask/src/pricing.mjs (PAY_TO), sdk/python/src/singit/pins.py (pay_to),
        # sdk/typescript/src/pins.js (payTo), sign402-gateway/sign402_gateway/ask_metered.py (PAY_TO).
        "0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e": "singit-ask metered chat (Base)",
    },
}

# Documented for completeness; not scanned by this script (its data source is Base USDC only).
# Same files as above, SOLANA_PAY_TO / pay_to / payTo.
SOLANA_MERCHANT_NOTE = "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu (Solana; not scanned here)"

DEFAULT_EXCLUDE_ADDRESSES = frozenset(DEFAULT_MERCHANTS["base"])

EXCLUDE_ENV = "SINGIT_OWN_WALLETS"


def normalize_address(addr: str) -> str:
    return addr.strip().lower()


def parse_amount(value: Any, decimals: int) -> Decimal:
    return Decimal(str(value)) / (Decimal(10) ** int(decimals))


def _parse_address_list(text: str) -> set[str]:
    out: set[str] = set()
    for line in text.splitlines():
        for token in line.split("#", 1)[0].split(","):
            token = token.strip()
            if token:
                out.add(normalize_address(token))
    return out


def load_exclusions(env_value: str | None, file_path: str | Path | None, *,
                     default_addresses: frozenset[str] = DEFAULT_EXCLUDE_ADDRESSES) -> frozenset[str]:
    addrs = {normalize_address(a) for a in default_addresses}
    addrs |= _parse_address_list(env_value or "")
    if file_path:
        addrs |= _parse_address_list(Path(file_path).expanduser().read_text())
    return frozenset(addrs)


def _parse_iso_timestamp(value: str) -> datetime.datetime | None:
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# -- Blockscout --------------------------------------------------------------------------------

def _http_get_json(url: str, *, timeout: float) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(READ_CAP))


def iter_blockscout_transfers(address: str, *, usdc_token: str = USDC_BASE, base_url: str = BLOCKSCOUT_BASE,
                               timeout: float = 20.0, http_get: Callable[..., dict] | None = None,
                               max_pages: int = 500) -> Iterator[dict]:
    http_get = http_get or _http_get_json
    params = {"type": "ERC-20", "filter": "to", "token": usdc_token}
    url = f"{base_url}/api/v2/addresses/{address}/token-transfers?{urllib.parse.urlencode(params)}"
    for _ in range(max_pages):
        payload = http_get(url, timeout=timeout)
        for item in payload.get("items") or []:
            yield item
        next_params = payload.get("next_page_params")
        if not next_params:
            return
        url = f"{base_url}/api/v2/addresses/{address}/token-transfers?" \
              f"{urllib.parse.urlencode({**params, **next_params})}"
    raise RuntimeError(f"stopped after {max_pages} Blockscout pages; it may be paginating forever")


def normalize_blockscout_item(item: dict) -> dict | None:
    from_hash = (item.get("from") or {}).get("hash")
    to_hash = (item.get("to") or {}).get("hash")
    total = item.get("total") or {}
    value = total.get("value")
    if not from_hash or not to_hash or value is None:
        return None
    decimals = total.get("decimals")
    if decimals is None:
        decimals = (item.get("token") or {}).get("decimals", USDC_DECIMALS_FALLBACK)
    timestamp = _parse_iso_timestamp(item["timestamp"]) if item.get("timestamp") else None
    return {
        "from": normalize_address(from_hash),
        "from_display": from_hash,
        "amount": parse_amount(value, decimals),
        "timestamp": timestamp,
        "tx_hash": item.get("tx_hash") or item.get("transaction_hash"),
    }


# -- RPC fallback (eth_getLogs) -----------------------------------------------------------------

def _http_post_json(url: str, payload: dict, *, timeout: float) -> dict:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, method="POST",
                                      headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(READ_CAP))


def _rpc_call(rpc_url: str, method: str, params: list, *, timeout: float,
              http_post: Callable[..., dict] | None = None) -> Any:
    http_post = http_post or _http_post_json
    result = http_post(rpc_url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=timeout)
    if "error" in result:
        raise RuntimeError(f"{method} failed: {result['error']}")
    return result["result"]


def _pad_address_topic(address: str) -> str:
    return "0x" + normalize_address(address).removeprefix("0x").rjust(64, "0")


def iter_rpc_logs(rpc_url: str, usdc_token: str, merchant_address: str, from_block: int, to_block: int, *,
                   chunk_size: int = 5000, timeout: float = 20.0,
                   http_post: Callable[..., dict] | None = None) -> Iterator[dict]:
    http_post = http_post or _http_post_json
    start = from_block
    while start <= to_block:
        end = min(start + chunk_size - 1, to_block)
        logs = _rpc_call(rpc_url, "eth_getLogs", [{
            "address": usdc_token,
            "topics": [TRANSFER_TOPIC, None, _pad_address_topic(merchant_address)],
            "fromBlock": hex(start),
            "toBlock": hex(end),
        }], timeout=timeout, http_post=http_post)
        yield from logs
        start = end + 1


def _block_timestamp(rpc_url: str, block_number_hex: str, *, timeout: float,
                      http_post: Callable[..., dict], cache: dict[str, datetime.datetime | None]
                      ) -> datetime.datetime | None:
    if block_number_hex in cache:
        return cache[block_number_hex]
    block = _rpc_call(rpc_url, "eth_getBlockByNumber", [block_number_hex, False], timeout=timeout,
                       http_post=http_post)
    ts = datetime.datetime.fromtimestamp(int(block["timestamp"], 16), tz=datetime.timezone.utc) if block else None
    cache[block_number_hex] = ts
    return ts


def normalize_rpc_log(log: dict, *, rpc_url: str, timeout: float, http_post: Callable[..., dict] | None,
                       block_ts_cache: dict, need_timestamp: bool) -> dict | None:
    http_post = http_post or _http_post_json
    topics = log.get("topics") or []
    if len(topics) < 3:
        return None
    from_addr = "0x" + topics[1][-40:]
    amount = parse_amount(int(log.get("data", "0x0"), 16), USDC_DECIMALS_FALLBACK)
    timestamp = None
    if need_timestamp and log.get("blockNumber"):
        timestamp = _block_timestamp(rpc_url, log["blockNumber"], timeout=timeout, http_post=http_post,
                                      cache=block_ts_cache)
    return {
        "from": normalize_address(from_addr),
        "from_display": from_addr,
        "amount": amount,
        "timestamp": timestamp,
        "tx_hash": log.get("transactionHash"),
    }


# -- Aggregation --------------------------------------------------------------------------------

def _fmt_usdc(amount: Decimal) -> str:
    return str(amount.quantize(Decimal("0.000001")))


def aggregate(transfers_by_merchant: dict[str, list[dict]], *, exclude: frozenset[str],
              since: datetime.date | None = None) -> dict:
    overall_payers: set[str] = set()
    overall_count = 0
    overall_amount = Decimal(0)
    overall_excluded = 0
    earliest: datetime.datetime | None = None
    latest: datetime.datetime | None = None
    per_merchant: dict[str, dict] = {}

    for merchant, transfers in transfers_by_merchant.items():
        m_payers: set[str] = set()
        m_count = 0
        m_amount = Decimal(0)
        m_excluded = 0
        for t in transfers:
            if since is not None and t["timestamp"] is not None and t["timestamp"].date() < since:
                continue
            payer = t["from"]
            if payer in exclude:
                m_excluded += 1
                overall_excluded += 1
                continue
            m_payers.add(payer)
            overall_payers.add(payer)
            m_count += 1
            overall_count += 1
            m_amount += t["amount"]
            overall_amount += t["amount"]
            if t["timestamp"] is not None:
                earliest = t["timestamp"] if earliest is None else min(earliest, t["timestamp"])
                latest = t["timestamp"] if latest is None else max(latest, t["timestamp"])
        per_merchant[merchant] = {
            "unique_payers": len(m_payers),
            "payments": m_count,
            "total_usdc": _fmt_usdc(m_amount),
            "excluded_own_payments": m_excluded,
        }

    return {
        "unique_external_payers": len(overall_payers),
        "payments": overall_count,
        "total_usdc": _fmt_usdc(overall_amount),
        "excluded_own_payments": overall_excluded,
        "date_range": {
            "from": earliest.date().isoformat() if earliest else None,
            "to": latest.date().isoformat() if latest else None,
        },
        "per_merchant": per_merchant,
        "_payers": overall_payers,
    }


def text_summary(report: dict) -> str:
    lines = [
        f"Unique external payers: {report['unique_external_payers']}",
        f"Payments: {report['payments']}",
        f"Total USDC: {report['total_usdc']}",
        f"Excluded own payments: {report['excluded_own_payments']}",
        f"Date range: {report['date_range']['from'] or chr(8212)} .. {report['date_range']['to'] or chr(8212)}",
    ]
    for addr, stats in sorted(report.get("per_merchant", {}).items()):
        label = report.get("merchants", {}).get(addr, "")
        lines.append(f"  {addr} ({label}): {stats['unique_payers']} payers, {stats['payments']} payments, "
                     f"{stats['total_usdc']} USDC, {stats['excluded_own_payments']} excluded")
    if report.get("errors"):
        lines.append("Errors:")
        for addr, msg in sorted(report["errors"].items()):
            lines.append(f"  {addr}: {msg}")
    if report.get("payer_addresses") is not None:
        lines.append("Payer addresses (sensitive -- do not publish or commit):")
        lines.extend(f"  {a}" for a in report["payer_addresses"])
    return "\n".join(lines)


# -- CLI ------------------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", help="YYYY-MM-DD; only count payments on/after this UTC date")
    parser.add_argument("--exclude-file", help="extra own-wallet addresses, one per line (# comments); merges "
                                                f"with ${EXCLUDE_ENV} (comma-separated). Keep the file out of git.")
    parser.add_argument("--rpc", metavar="URL", help="fall back to eth_getLogs on this Base RPC instead of "
                                                       "Blockscout (use when Blockscout answers 403)")
    parser.add_argument("--from-block", type=int, help="required with --rpc: first block to scan")
    parser.add_argument("--to-block", type=int, help="required with --rpc: last block to scan")
    parser.add_argument("--chunk-size", type=int, default=5000, help="blocks per eth_getLogs call (default: 5000)")
    parser.add_argument("--merchant", action="append", default=[], metavar="ADDR",
                        help="extra Base address to scan in addition to the built-in SingIt merchant(s)")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds (default: 20)")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON instead of text")
    parser.add_argument("--list", action="store_true",
                        help="also print each unique external payer address; sensitive, warns on stderr")
    return parser


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    values = os.environ if env is None else env
    args = _build_parser().parse_args(argv)
    if args.rpc and (args.from_block is None or args.to_block is None):
        raise SystemExit("unique-payers: --rpc needs both --from-block and --to-block")

    try:
        exclude = load_exclusions(values.get(EXCLUDE_ENV), args.exclude_file)
    except OSError as exc:
        raise SystemExit(f"unique-payers: cannot read --exclude-file: {exc.strerror or 'error'}")

    since = datetime.date.fromisoformat(args.since) if args.since else None

    merchants = dict(DEFAULT_MERCHANTS["base"])
    for addr in args.merchant:
        merchants.setdefault(addr, "ad-hoc (--merchant)")
    exclude |= {normalize_address(addr) for addr in merchants}

    transfers_by_merchant: dict[str, list[dict]] = {}
    errors: dict[str, str] = {}
    for addr in merchants:
        try:
            if args.rpc:
                cache: dict[str, datetime.datetime | None] = {}
                raw_logs = iter_rpc_logs(args.rpc, USDC_BASE, addr, args.from_block, args.to_block,
                                         chunk_size=args.chunk_size, timeout=args.timeout)
                transfers = [normalize_rpc_log(log, rpc_url=args.rpc, timeout=args.timeout, http_post=None,
                                               block_ts_cache=cache, need_timestamp=True) for log in raw_logs]
            else:
                items = iter_blockscout_transfers(addr, timeout=args.timeout)
                transfers = [normalize_blockscout_item(item) for item in items]
            transfers_by_merchant[addr] = [t for t in transfers if t is not None]
        except urllib.error.HTTPError as exc:
            errors[addr] = f"HTTP {exc.code}"
            transfers_by_merchant[addr] = []
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError, ValueError) as exc:
            errors[addr] = f"{type(exc).__name__}: {exc}"
            transfers_by_merchant[addr] = []

    report = aggregate(transfers_by_merchant, exclude=exclude, since=since)
    payers = report.pop("_payers")
    report["merchants"] = dict(merchants)
    if errors:
        report["errors"] = errors

    if args.list:
        print("WARNING: --list output includes individual payer wallet addresses. "
              "Do not publish or commit this output.", file=sys.stderr)
        report["payer_addresses"] = sorted(payers)

    print(json.dumps(report, indent=2, sort_keys=True) if args.json else text_summary(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
