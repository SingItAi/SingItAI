#!/usr/bin/env python3
"""Counts unique EXTERNAL x402 payers of SingIt's Base and Solana USDC merchant address(es).

Stdlib only, Python 3.9+. Read-only: makes HTTP GET/POST / JSON-RPC requests to a block explorer or
an RPC endpoint, never a write, never a payment.

Merchant (payTo) addresses scanned, and where each comes from (see DEFAULT_MERCHANTS below):
  * Base:   0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e -- singit-ask/src/pricing.mjs (PAY_TO),
    sdk/python/src/singit/pins.py, sdk/typescript/src/pins.js, sign402-gateway/sign402_gateway/
    ask_metered.py (PAY_TO). SingIt Ask's metered-chat x402 receiver on Base.
  * Solana: 4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu -- same files' SOLANA_PAY_TO. SingIt Ask's
    metered-chat x402 receiver on Solana.

Data sources:
  * Base: Transfer(address,address,uint256) events of Base USDC
    (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) into each merchant address.
      - Primary: Blockscout's v2 API (no key needed), paginated via next_page_params.
      - Fallback (--rpc URL): eth_getLogs over an explicit block range, chunked, for when Blockscout
        answers 403. Needs --from-block and --to-block (an RPC has no equivalent of "give me
        everything"; you have to bound it).
    This path is unchanged from before Solana support was added.
  * Solana: USDC (mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) token transfers into the
    merchant address, read via plain JSON-RPC (getTokenAccountsByOwner to find the merchant's USDC
    token account(s), getSignaturesForAddress on each -- paginated with `before`, stopping once a
    page reaches --since -- then getTransaction with jsonParsed encoding and
    maxSupportedTransactionVersion 0). Per transaction, the payer is derived from
    meta.preTokenBalances/postTokenBalances for the USDC mint: the merchant's positive balance delta
    is the payment amount, and the payer is the token-balance OWNER whose USDC balance decreased the
    most -- NOT the fee payer, since x402 on Solana is settled through a facilitator that pays
    network fees and never appears as a USDC balance owner in the transaction. Failed transactions
    (meta.err set), zero-value transfers, and transactions where the merchant didn't receive USDC are
    skipped. This script does not derive the merchant's associated token account address itself (that
    needs an off-chain PDA/sha256 derivation); getTokenAccountsByOwner already returns every USDC
    account the merchant owns, which is sufficient for scanning its payment history.
    RPC endpoint: --solana-rpc URL, else $SOLANA_RPC_URL, else the public
    https://api.mainnet-beta.solana.com. The endpoint URL is never printed (it may carry an API key
    in its path or query string) -- only its hostname is. --solana-delay (default 0.2s) adds a small
    pause between RPC calls to stay under public-RPC rate limits.

Both chains retry HTTP 429 / 5xx responses a few times with exponential backoff before giving up.

--chain base|solana|all (default: all) selects which chain(s) to scan. The Base scan logic itself
(Blockscout primary, --rpc fallback) is unchanged; --chain only controls which chain(s) run.

Exclusions ("own" payments, never counted as external): the addresses in DEFAULT_MERCHANTS are
always excluded for their own chain (a merchant topping up, or paying another listed merchant, is
not a customer). Beyond that, this script hardcodes nothing else -- any other SingIt-owned wallet
(operator, treasury, test, or an app-held agent wallet) must be supplied at run time, never
committed:
  * $SINGIT_OWN_WALLETS: comma-separated addresses (works for both chains).
  * --exclude-file PATH: one address per line, '#' starts a comment (works for both chains). Keep
    this file out of git.
  * --exclude-db PATH:TABLE.COLUMN (repeatable): reads every non-empty value of one column from a
    local SQLite database, opened read-only (`file:...?mode=ro`). TABLE and COLUMN are validated as
    plain SQL identifiers before being quoted into the query. A missing database file or a missing
    table/column is a clear startup error; the error message never contains an address.
  * --vps-own-wallets: shorthand for --exclude-db against the SingIt VPS's default app-agent-wallet
    locations under ~/.sign402: allowance.db:agents.agent_address and
    solana-allowance.db:agents.agent_address only. End-user wallets and limiter addresses are
    never included by default; additional columns can be supplied explicitly with --exclude-db.
  Base (0x...) addresses are matched case-insensitively (normalized to lowercase); Solana addresses
  are base58 and case-sensitive, and are matched and reported exactly as given.
  This script only ever reports how many exclusion addresses were loaded from each source, never the
  addresses themselves.

--amount-filter-atomic LIST selects exact comma-separated USDC atomic amounts (6 decimals).
--exa-search-amounts supplies the preset 10100,6200; an explicit LIST overrides the preset.
With a filter, all metrics remain unfiltered and an additional "filtered" report contains the
same metrics per chain and combined, including per-merchant counts and date ranges. The filter
applies before own-payment and zero-value counting (zero matches only if LIST contains 0).
Amount matching alone does not prove which endpoint a payment purchased.

Output defaults to aggregate numbers only, both combined across the scanned chain(s) and broken down
per chain: unique external payers, payment count, total USDC, excluded-own-payment count,
zero-value-transfer count, date range, and a per-merchant breakdown. Combined "unique external
payers" is the SUM of each chain's count, not a deduplicated total -- Base (0x...) and Solana
(base58) addresses are different spaces and can never collide, so they cannot be meaningfully
deduplicated against each other; the output says so whenever more than one chain was scanned.
Individual payer addresses are only printed with --list (which also prints a stderr warning that the
output must not be published), and never otherwise. --json switches to machine-readable JSON.

Zero-value USDC transfers (the "address poisoning" spam pattern -- a 0-value Transfer from a
lookalike address, meant to plant a fake entry in wallet history) are skipped before any
payer/payment stat is updated; the count skipped is reported, never counted as a payment.

Blockscout/RPC requests that answer HTTP 429 or 5xx are retried a few times with exponential
backoff before giving up.

    python3 scripts/unique-payers.py
    python3 scripts/unique-payers.py --chain base --since 2026-01-01 --json
    python3 scripts/unique-payers.py --chain solana --solana-rpc https://my-rpc.example/KEY
    python3 scripts/unique-payers.py --exclude-file ~/.sign402/my-wallets.txt
    python3 scripts/unique-payers.py --vps-own-wallets
    python3 scripts/unique-payers.py --exclude-db ~/.sign402/user-wallets.db:user_wallets.wallet_address
    python3 scripts/unique-payers.py --rpc https://mainnet.base.org --from-block 20000000 --to-block 20100000
    python3 scripts/unique-payers.py --list   # WARNING: prints payer addresses; do not publish

Tests: python3 -m unittest discover -s scripts/tests
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import time
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

SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com"
SOLANA_RPC_ENV = "SOLANA_RPC_URL"
DEFAULT_SOLANA_DELAY = 0.2

# SingIt-owned merchant (payTo) addresses already public in this repo. Each is scanned for
# incoming USDC and is also always excluded as a payer (see load_exclusions): a merchant paying
# itself, or another merchant in this dict, is never an external customer.
DEFAULT_MERCHANTS = {
    "base": {
        # singit-ask/src/pricing.mjs (PAY_TO), sdk/python/src/singit/pins.py (pay_to),
        # sdk/typescript/src/pins.js (payTo), sign402-gateway/sign402_gateway/ask_metered.py (PAY_TO).
        "0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e": "singit-ask metered chat (Base)",
    },
    "solana": {
        # Same files' SOLANA_PAY_TO / pay_to / payTo.
        "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu": "singit-ask metered chat (Solana)",
    },
}

DEFAULT_EXCLUDE_ADDRESSES = frozenset(set(DEFAULT_MERCHANTS["base"]) | set(DEFAULT_MERCHANTS["solana"]))

EXCLUDE_ENV = "SINGIT_OWN_WALLETS"

# App agent signing addresses only; never limiters or end-user wallets.
VPS_OWN_WALLET_DB_SPECS = (
    ("allowance.db", "agents.agent_address"),
    ("solana-allowance.db", "agents.agent_address"),
)


def normalize_address(addr: str) -> str:
    """Base (0x...) addresses are case-insensitive and normalized to lowercase; everything else
    (Solana base58 addresses) is case-sensitive and kept exactly as given."""
    addr = addr.strip()
    if addr[:2].lower() == "0x":
        return addr.lower()
    return addr


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


def merge_merchants(defaults: dict[str, str], extra: list[str], *,
                     extra_label: str = "ad-hoc (--merchant)") -> dict[str, str]:
    """Merge DEFAULT_MERCHANTS with --merchant addresses, case-insensitively.

    Dedupes by lowercased address so the same on-chain address is only scanned once even if it's
    supplied with different casing; the first casing seen (defaults, then extra, in order) wins
    the display key.
    """
    merchants: dict[str, str] = {}
    seen: set[str] = set()
    for addr, label in defaults.items():
        lower = normalize_address(addr)
        if lower in seen:
            continue
        seen.add(lower)
        merchants[addr] = label
    for addr in extra:
        lower = normalize_address(addr)
        if lower in seen:
            continue
        seen.add(lower)
        merchants[addr] = extra_label
    return merchants


def load_exclusions(env_value: str | None, file_path: str | Path | None, *,
                     default_addresses: frozenset[str] = DEFAULT_EXCLUDE_ADDRESSES) -> frozenset[str]:
    addrs = {normalize_address(a) for a in default_addresses}
    addrs |= _parse_address_list(env_value or "")
    if file_path:
        addrs |= _parse_address_list(Path(file_path).expanduser().read_text())
    return frozenset(addrs)


_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _parse_exclude_db_spec(spec: str) -> tuple[str, str, str]:
    if ":" not in spec:
        raise ValueError(f"--exclude-db: expected PATH:TABLE.COLUMN, got {spec!r}")
    path_str, _, rest = spec.rpartition(":")
    if "." not in rest:
        raise ValueError(f"--exclude-db: expected PATH:TABLE.COLUMN, got {spec!r}")
    table, _, column = rest.rpartition(".")
    if not _IDENTIFIER_RE.match(table) or not _IDENTIFIER_RE.match(column):
        raise ValueError(f"--exclude-db: invalid table/column identifier in {spec!r}")
    return path_str, table, column


def load_exclude_db(spec: str) -> tuple[frozenset[str], str]:
    """Read one exclusion column from a local SQLite DB, opened read-only. Returns (addresses,
    source label); the label is a filename and table/column name, never an address. Raises
    ValueError with a clear, address-free message if the file or table/column is missing."""
    path_str, table, column = _parse_exclude_db_spec(spec)
    path = Path(path_str).expanduser()
    if not path.is_file():
        raise ValueError(f"--exclude-db: database file not found: {path}")
    uri = f"file:{urllib.parse.quote(str(path), safe='/:')}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        # TABLE/COLUMN were validated as plain identifiers above, so quoting them here is safe.
        rows = conn.execute(f'SELECT "{table}"."{column}" FROM "{table}"').fetchall()
    except sqlite3.OperationalError as exc:
        raise ValueError(f"--exclude-db: cannot read {table}.{column} from {path.name}: {exc}") from None
    finally:
        conn.close()
    addresses = frozenset(normalize_address(str(row[0])) for row in rows if row[0] and str(row[0]).strip())
    return addresses, f"{path.name}:{table}.{column}"


def vps_own_wallet_specs(base_dir: str | Path = "~/.sign402") -> list[str]:
    base = Path(base_dir).expanduser()
    return [f"{base / db_file}:{table_column}" for db_file, table_column in VPS_OWN_WALLET_DB_SPECS]


def _parse_iso_timestamp(value: str) -> datetime.datetime | None:
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# -- Retry with exponential backoff (HTTP 429 / 5xx from Blockscout or the RPC) -----------------

DEFAULT_RETRY_ATTEMPTS = 4
DEFAULT_RETRY_BASE_DELAY = 0.5


def _is_retryable_http_error(exc: urllib.error.HTTPError) -> bool:
    return exc.code == 429 or 500 <= exc.code < 600


def _request_with_retries(do_request: Callable[[], dict], *, attempts: int = DEFAULT_RETRY_ATTEMPTS,
                           base_delay: float = DEFAULT_RETRY_BASE_DELAY,
                           sleep: Callable[[float], None] | None = None) -> dict:
    # `sleep` defaults lazily (not `= time.sleep` in the signature) so tests can patch module-level
    # time.sleep and have it take effect without passing `sleep=` explicitly on every call site.
    sleep = sleep or time.sleep
    for attempt in range(attempts):
        try:
            return do_request()
        except urllib.error.HTTPError as exc:
            if not _is_retryable_http_error(exc) or attempt == attempts - 1:
                raise
            sleep(base_delay * (2 ** attempt))


# -- Blockscout --------------------------------------------------------------------------------

def _http_get_json(url: str, *, timeout: float, attempts: int = DEFAULT_RETRY_ATTEMPTS,
                    base_delay: float = DEFAULT_RETRY_BASE_DELAY,
                    sleep: Callable[[float], None] | None = None) -> dict:
    def do_request() -> dict:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read(READ_CAP))
    return _request_with_retries(do_request, attempts=attempts, base_delay=base_delay, sleep=sleep)


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

def _http_post_json(url: str, payload: dict, *, timeout: float, attempts: int = DEFAULT_RETRY_ATTEMPTS,
                     base_delay: float = DEFAULT_RETRY_BASE_DELAY,
                     sleep: Callable[[float], None] | None = None) -> dict:
    def do_request() -> dict:
        body = json.dumps(payload).encode()
        request = urllib.request.Request(url, data=body, method="POST",
                                          headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read(READ_CAP))
    return _request_with_retries(do_request, attempts=attempts, base_delay=base_delay, sleep=sleep)


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
    if chunk_size < 1:
        raise ValueError("chunk_size must be a positive integer")
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


# -- Solana (JSON-RPC) ----------------------------------------------------------------------------

def iter_solana_token_accounts(rpc_url: str, owner: str, mint: str, *, timeout: float = 20.0,
                                http_post: Callable[..., dict] | None = None) -> list[str]:
    http_post = http_post or _http_post_json
    result = _rpc_call(rpc_url, "getTokenAccountsByOwner",
                        [owner, {"mint": mint}, {"encoding": "jsonParsed"}],
                        timeout=timeout, http_post=http_post)
    return [item["pubkey"] for item in (result.get("value") or []) if item.get("pubkey")]


def iter_solana_signatures(rpc_url: str, address: str, *, since: datetime.date | None = None,
                            timeout: float = 20.0, http_post: Callable[..., dict] | None = None,
                            delay: float = DEFAULT_SOLANA_DELAY, sleep: Callable[[float], None] | None = None,
                            limit: int = 1000, max_pages: int = 500) -> Iterator[dict]:
    """Newest-first signatures for `address`, paginated with `before`. Stops (without raising) once
    a page reaches a signature older than `since`, or once a short page signals there's no more."""
    http_post = http_post or _http_post_json
    sleep = sleep or time.sleep
    before: str | None = None
    for _ in range(max_pages):
        params: dict[str, Any] = {"limit": limit}
        if before is not None:
            params["before"] = before
        batch = _rpc_call(rpc_url, "getSignaturesForAddress", [address, params], timeout=timeout,
                           http_post=http_post)
        if not batch:
            return
        for item in batch:
            block_time = item.get("blockTime")
            if since is not None and block_time is not None:
                day = datetime.datetime.fromtimestamp(block_time, tz=datetime.timezone.utc).date()
                if day < since:
                    return
            yield item
        if len(batch) < limit:
            return
        before = batch[-1].get("signature")
        if before is None:
            return
        if delay:
            sleep(delay)
    raise RuntimeError(f"stopped after {max_pages} Solana signature pages; it may be paginating forever")


def get_solana_transaction(rpc_url: str, signature: str, *, timeout: float = 20.0,
                            http_post: Callable[..., dict] | None = None) -> Any:
    http_post = http_post or _http_post_json
    return _rpc_call(rpc_url, "getTransaction",
                      [signature, {"encoding": "jsonParsed", "commitment": "confirmed",
                                    "maxSupportedTransactionVersion": 0}],
                      timeout=timeout, http_post=http_post)


def _solana_token_balances(meta: dict, name: str, mint: str) -> dict[str, int]:
    found: dict[str, int] = {}
    for balance in meta.get(name) or []:
        if balance.get("mint") != mint:
            continue
        owner = balance.get("owner")
        amount = (balance.get("uiTokenAmount") or {}).get("amount")
        if owner is None or amount is None:
            continue
        found[owner] = found.get(owner, 0) + int(amount)
    return found


def _solana_token_decimals(meta: dict, mint: str) -> int:
    for key in ("postTokenBalances", "preTokenBalances"):
        for balance in meta.get(key) or []:
            if balance.get("mint") == mint:
                decimals = (balance.get("uiTokenAmount") or {}).get("decimals")
                if decimals is not None:
                    return int(decimals)
    return USDC_DECIMALS_FALLBACK


def normalize_solana_transaction(tx: Any, *, merchant: str, signature: str,
                                  mint: str = SOLANA_USDC_MINT) -> dict | None:
    """The payer/amount of one Solana transaction, or None if it isn't a qualifying USDC payment to
    `merchant`: a failed transaction, one where the merchant didn't receive USDC, or one with no
    other balance that decreased to attribute the payment to.

    The payer is the token-balance OWNER (not the fee payer -- x402 on Solana settles through a
    facilitator that pays network fees and never appears as a token-balance owner here) whose USDC
    balance decreased the most; if several owners' balances decreased, the largest decrease wins.
    """
    if not isinstance(tx, dict):
        return None
    meta = tx.get("meta")
    if not isinstance(meta, dict) or meta.get("err") is not None:
        return None
    before = _solana_token_balances(meta, "preTokenBalances", mint)
    after = _solana_token_balances(meta, "postTokenBalances", mint)
    merchant_delta = after.get(merchant, 0) - before.get(merchant, 0)
    if merchant_delta <= 0:
        return None
    payer, largest_decrease = None, 0
    for owner in set(before) | set(after):
        if owner == merchant:
            continue
        delta = after.get(owner, 0) - before.get(owner, 0)
        if delta < largest_decrease:
            payer, largest_decrease = owner, delta
    if payer is None:
        return None
    decimals = _solana_token_decimals(meta, mint)
    block_time = tx.get("blockTime")
    timestamp = (datetime.datetime.fromtimestamp(block_time, tz=datetime.timezone.utc)
                 if block_time is not None else None)
    return {
        "from": normalize_address(payer),
        "from_display": payer,
        "amount": parse_amount(merchant_delta, decimals),
        "timestamp": timestamp,
        "tx_hash": signature,
    }


def iter_solana_transfers(rpc_url: str, merchant: str, *, mint: str = SOLANA_USDC_MINT,
                           since: datetime.date | None = None, timeout: float = 20.0,
                           delay: float = DEFAULT_SOLANA_DELAY, http_post: Callable[..., dict] | None = None,
                           sleep: Callable[[float], None] | None = None, max_pages: int = 500
                           ) -> Iterator[dict]:
    http_post = http_post or _http_post_json
    sleep = sleep or time.sleep
    seen: set[str] = set()
    for account in iter_solana_token_accounts(rpc_url, merchant, mint, timeout=timeout, http_post=http_post):
        for sig_info in iter_solana_signatures(rpc_url, account, since=since, timeout=timeout,
                                                http_post=http_post, delay=delay, sleep=sleep,
                                                max_pages=max_pages):
            signature = sig_info.get("signature")
            # The same tx can show up under more than one of the merchant's own token accounts.
            if not signature or signature in seen:
                continue
            seen.add(signature)
            if sig_info.get("err") is not None:
                continue
            tx = get_solana_transaction(rpc_url, signature, timeout=timeout, http_post=http_post)
            if delay:
                sleep(delay)
            transfer = normalize_solana_transaction(tx, merchant=merchant, signature=signature, mint=mint)
            if transfer is not None:
                yield transfer


# -- Aggregation --------------------------------------------------------------------------------

def _fmt_usdc(amount: Decimal) -> str:
    return str(amount.quantize(Decimal("0.000001")))


def aggregate(transfers_by_merchant: dict[str, list[dict]], *, exclude: frozenset[str],
              since: datetime.date | None = None,
              amount_filter_atomic: frozenset[int] | None = None) -> dict:
    overall_payers: set[str] = set()
    overall_count = 0
    overall_amount = Decimal(0)
    overall_excluded = 0
    overall_zero_value_skipped = 0
    earliest: datetime.datetime | None = None
    latest: datetime.datetime | None = None
    per_merchant: dict[str, dict] = {}

    for merchant, transfers in transfers_by_merchant.items():
        m_payers: set[str] = set()
        m_count = 0
        m_amount = Decimal(0)
        m_excluded = 0
        m_zero_value_skipped = 0
        for t in transfers:
            if since is not None and t["timestamp"] is not None and t["timestamp"].date() < since:
                continue
            if (amount_filter_atomic is not None
                    and t["amount"] * 1_000_000 not in amount_filter_atomic):
                continue
            # Address-poisoning spam: a 0-value Transfer from a lookalike address, meant to plant
            # a fake entry in wallet history. Skip before touching payer/payment stats.
            if t["amount"] == 0:
                m_zero_value_skipped += 1
                overall_zero_value_skipped += 1
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
            "zero_value_skipped": m_zero_value_skipped,
        }

    return {
        "unique_external_payers": len(overall_payers),
        "payments": overall_count,
        "total_usdc": _fmt_usdc(overall_amount),
        "excluded_own_payments": overall_excluded,
        "zero_value_skipped": overall_zero_value_skipped,
        "date_range": {
            "from": earliest.date().isoformat() if earliest else None,
            "to": latest.date().isoformat() if latest else None,
        },
        "per_merchant": per_merchant,
        "_payers": overall_payers,
    }


_COMBINED_NOTE = ("unique_external_payers is the SUM across chains, not a deduplicated total: Base "
                   "(0x...) and Solana (base58) addresses are different address spaces and cannot "
                   "collide, so they cannot be compared or deduplicated against each other.")


def combine_chain_reports(chain_reports: dict[str, dict]) -> dict:
    """Combine one aggregate() report per chain (each already carrying its own "merchants"/"errors"/
    "payer_addresses", and still its "_payers" set) into one report with top-level combined totals
    plus a "chains" breakdown. See the module docstring for why the combined payer count is a sum,
    not a dedup."""
    combined_payers = combined_payments = combined_excluded = combined_zero = 0
    combined_amount = Decimal(0)
    earliest: datetime.date | None = None
    latest: datetime.date | None = None
    merchants: dict[str, str] = {}
    per_merchant: dict[str, dict] = {}
    errors: dict[str, str] = {}
    payer_addresses: set[str] = set()
    chains_out: dict[str, dict] = {}

    for chain, report in chain_reports.items():
        combined_payers += report["unique_external_payers"]
        combined_payments += report["payments"]
        combined_amount += Decimal(report["total_usdc"])
        combined_excluded += report["excluded_own_payments"]
        combined_zero += report["zero_value_skipped"]
        date_range = report["date_range"]
        if date_range["from"]:
            d = datetime.date.fromisoformat(date_range["from"])
            earliest = d if earliest is None else min(earliest, d)
        if date_range["to"]:
            d = datetime.date.fromisoformat(date_range["to"])
            latest = d if latest is None else max(latest, d)
        merchants.update(report.get("merchants", {}))
        per_merchant.update(report.get("per_merchant", {}))
        errors.update(report.get("errors", {}))
        payer_addresses.update(report.get("payer_addresses", []))
        chains_out[chain] = {k: v for k, v in report.items() if k != "_payers"}

    combined = {
        "unique_external_payers": combined_payers,
        "payments": combined_payments,
        "total_usdc": _fmt_usdc(combined_amount),
        "excluded_own_payments": combined_excluded,
        "zero_value_skipped": combined_zero,
        "date_range": {"from": earliest.isoformat() if earliest else None,
                       "to": latest.isoformat() if latest else None},
        "merchants": merchants,
        "per_merchant": per_merchant,
        "chains": chains_out,
    }
    if errors:
        combined["errors"] = errors
    if payer_addresses:
        combined["payer_addresses"] = sorted(payer_addresses)
    if len(chain_reports) > 1:
        combined["combined_note"] = _COMBINED_NOTE
    return combined


def text_summary(report: dict) -> str:
    lines = [
        f"Unique external payers: {report['unique_external_payers']}",
        f"Payments: {report['payments']}",
        f"Total USDC: {report['total_usdc']}",
        f"Excluded own payments: {report['excluded_own_payments']}",
        f"Zero-value transfers skipped: {report['zero_value_skipped']}",
        f"Date range: {report['date_range']['from'] or chr(8212)} .. {report['date_range']['to'] or chr(8212)}",
    ]
    if report.get("combined_note"):
        lines.append(report["combined_note"])
    for addr, stats in sorted(report.get("per_merchant", {}).items()):
        label = report.get("merchants", {}).get(addr, "")
        lines.append(f"  {addr} ({label}): {stats['unique_payers']} payers, {stats['payments']} payments, "
                     f"{stats['total_usdc']} USDC, {stats['excluded_own_payments']} excluded, "
                     f"{stats['zero_value_skipped']} zero-value skipped")
    for chain, chain_report in sorted(report.get("chains", {}).items()):
        host_suffix = f", RPC host {chain_report['rpc_host']}" if chain_report.get("rpc_host") else ""
        lines.append(f"Chain {chain}: {chain_report['unique_external_payers']} payers, "
                     f"{chain_report['payments']} payments, {chain_report['total_usdc']} USDC{host_suffix}")
    if report.get("errors"):
        lines.append("Errors:")
        for addr, msg in sorted(report["errors"].items()):
            lines.append(f"  {addr}: {msg}")
    if report.get("payer_addresses") is not None:
        lines.append("Payer addresses (sensitive -- do not publish or commit):")
        lines.extend(f"  {a}" for a in report["payer_addresses"])
    # Render full chain metrics, including exclusions, zero counts and date ranges.
    for chain, chain_report in sorted(report.get("chains", {}).items()):
        lines.append(f"Chain {chain} metrics:")
        lines.append(text_summary({k: v for k, v in chain_report.items() if k != "filtered"}))
    if "filtered" in report:
        lines.insert(0, "Unfiltered metrics:")
        lines.append("Filtered metrics (USDC atomic amounts: "
                     + ",".join(map(str, report["amount_filter_atomic"])) + "):")
        lines.append(text_summary(report["filtered"]))
    return "\n".join(lines)


# -- CLI ------------------------------------------------------------------------------------

def _positive_int(value: str) -> int:
    n = int(value)
    if n < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return n


def _amount_filter(value: str) -> frozenset[int]:
    tokens = value.split(",")
    if not all(re.fullmatch(r"[0-9]+", token.strip()) for token in tokens):
        raise argparse.ArgumentTypeError("expected comma-separated non-negative USDC atomic integers")
    return frozenset(int(token.strip()) for token in tokens)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chain", choices=("base", "solana", "all"), default="all",
                        help="which chain(s) to scan (default: all)")
    parser.add_argument("--amount-filter-atomic", type=_amount_filter, metavar="LIST",
                        help="exact USDC amounts in atomic units (6 decimals), comma-separated; "
                             "adds filtered metrics alongside unfiltered metrics")
    parser.add_argument("--exa-search-amounts", action="store_true",
                        help="preset amount filter 10100,6200; --amount-filter-atomic overrides it")
    parser.add_argument("--since", help="YYYY-MM-DD; only count payments on/after this UTC date")
    parser.add_argument("--exclude-file", help="extra own-wallet addresses, one per line (# comments); merges "
                                                f"with ${EXCLUDE_ENV} (comma-separated). Keep the file out of git.")
    parser.add_argument("--exclude-db", action="append", default=[], metavar="PATH:TABLE.COLUMN",
                        help="extra own-wallet addresses read from one column of a local SQLite DB, opened "
                             "read-only; repeatable")
    parser.add_argument("--vps-own-wallets", action="store_true",
                        help="shorthand for --exclude-db against the SingIt VPS's default app-agent-wallet "
                             "locations under ~/.sign402 (not custodial user wallets)")
    parser.add_argument("--rpc", metavar="URL", help="fall back to eth_getLogs on this Base RPC instead of "
                                                       "Blockscout (use when Blockscout answers 403)")
    parser.add_argument("--from-block", type=int, help="required with --rpc: first block to scan")
    parser.add_argument("--to-block", type=int, help="required with --rpc: last block to scan")
    parser.add_argument("--chunk-size", type=_positive_int, default=5000, help="blocks per eth_getLogs call (default: 5000)")
    parser.add_argument("--merchant", action="append", default=[], metavar="ADDR",
                        help="extra Base address to scan in addition to the built-in SingIt merchant(s)")
    parser.add_argument("--solana-rpc", metavar="URL", help=f"Solana JSON-RPC endpoint; else ${SOLANA_RPC_ENV}, "
                                                              f"else the public RPC (never printed; only its "
                                                              f"hostname is)")
    parser.add_argument("--solana-delay", type=float, default=DEFAULT_SOLANA_DELAY,
                        help=f"seconds to sleep between Solana RPC calls (default: {DEFAULT_SOLANA_DELAY})")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds (default: 20)")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON instead of text")
    parser.add_argument("--list", action="store_true",
                        help="also print each unique external payer address; sensitive, warns on stderr")
    return parser


def _scan_base(args: argparse.Namespace, merchants: dict[str, str]) -> tuple[dict[str, list[dict]], dict[str, str]]:
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
    return transfers_by_merchant, errors


def _scan_solana(args: argparse.Namespace, merchants: dict[str, str], rpc_url: str, *,
                  since: datetime.date | None) -> tuple[dict[str, list[dict]], dict[str, str]]:
    transfers_by_merchant: dict[str, list[dict]] = {}
    errors: dict[str, str] = {}
    host = urllib.parse.urlparse(rpc_url).hostname or "unknown"
    for addr in merchants:
        try:
            transfers_by_merchant[addr] = list(iter_solana_transfers(
                rpc_url, addr, since=since, timeout=args.timeout, delay=args.solana_delay))
        except urllib.error.HTTPError as exc:
            errors[addr] = f"HTTP {exc.code}"
            transfers_by_merchant[addr] = []
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError, ValueError) as exc:
            # The RPC URL may carry an API key; never let it leak into a reported error message.
            errors[addr] = f"{type(exc).__name__}: {exc}".replace(rpc_url, host)
            transfers_by_merchant[addr] = []
    return transfers_by_merchant, errors


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    values = os.environ if env is None else env
    args = _build_parser().parse_args(argv)
    if args.rpc and (args.from_block is None or args.to_block is None):
        raise SystemExit("unique-payers: --rpc needs both --from-block and --to-block")
    if args.rpc and not (0 <= args.from_block <= args.to_block):
        raise SystemExit("unique-payers: --from-block must be >= 0 and <= --to-block")

    amounts = args.amount_filter_atomic
    if amounts is None and args.exa_search_amounts:
        amounts = frozenset({10100, 6200})

    chains = ["base", "solana"] if args.chain == "all" else [args.chain]

    try:
        exclude = load_exclusions(values.get(EXCLUDE_ENV), args.exclude_file)
        exclude_db_specs = list(args.exclude_db)
        if args.vps_own_wallets:
            exclude_db_specs += vps_own_wallet_specs()
        for spec in exclude_db_specs:
            addrs, label = load_exclude_db(spec)
            exclude |= addrs
            print(f"unique-payers: loaded {len(addrs)} exclusion address(es) from {label}", file=sys.stderr)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"unique-payers: {exc}")

    since = datetime.date.fromisoformat(args.since) if args.since else None

    base_merchants = merge_merchants(DEFAULT_MERCHANTS["base"], args.merchant)
    solana_merchants = dict(DEFAULT_MERCHANTS["solana"])
    exclude |= {normalize_address(a) for a in base_merchants}
    exclude |= {normalize_address(a) for a in solana_merchants}

    chain_reports: dict[str, dict] = {}
    filtered_reports: dict[str, dict] = {}

    def add_filtered(chain, transfers, merchants):
        if amounts is None:
            return
        filtered = aggregate(transfers, exclude=exclude, since=since, amount_filter_atomic=amounts)
        payers = filtered.pop("_payers")
        filtered["merchants"] = dict(merchants)
        if args.list:
            filtered["payer_addresses"] = sorted(payers)
        filtered_reports[chain] = filtered

    if "base" in chains:
        transfers_by_merchant, errors = _scan_base(args, base_merchants)
        report = aggregate(transfers_by_merchant, exclude=exclude, since=since)
        payers = report.pop("_payers")
        report["merchants"] = dict(base_merchants)
        if errors:
            report["errors"] = errors
        if args.list:
            report["payer_addresses"] = sorted(payers)
        chain_reports["base"] = report
        add_filtered("base", transfers_by_merchant, base_merchants)

    if "solana" in chains:
        solana_rpc = args.solana_rpc or values.get(SOLANA_RPC_ENV) or DEFAULT_SOLANA_RPC
        transfers_by_merchant, errors = _scan_solana(args, solana_merchants, solana_rpc, since=since)
        report = aggregate(transfers_by_merchant, exclude=exclude, since=since)
        payers = report.pop("_payers")
        report["merchants"] = dict(solana_merchants)
        report["rpc_host"] = urllib.parse.urlparse(solana_rpc).hostname or "unknown"
        if errors:
            report["errors"] = errors
        if args.list:
            report["payer_addresses"] = sorted(payers)
        chain_reports["solana"] = report
        add_filtered("solana", transfers_by_merchant, solana_merchants)

    report = combine_chain_reports(chain_reports)
    if amounts is not None:
        report["amount_filter_atomic"] = sorted(amounts)
        report["filtered"] = combine_chain_reports(filtered_reports)
        for chain, filtered in filtered_reports.items():
            report["chains"][chain]["filtered"] = filtered

    if args.list:
        print("WARNING: --list output includes individual payer wallet addresses. "
              "Do not publish or commit this output.", file=sys.stderr)

    print(json.dumps(report, indent=2, sort_keys=True) if args.json else text_summary(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
