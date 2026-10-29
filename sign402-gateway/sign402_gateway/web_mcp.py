"""SingIt's own remote MCP server: POST /mcp on the public web API, authenticated with a SingIt API key.

A minimal, stateless server over MCP's Streamable HTTP transport (spec 2025-06-18, back to 2024-11-05):
JSON responses only, no SSE stream and no sessions, so one request is one answer and nothing is kept
between calls. Built on plain JSON-RPC 2.0 dicts, since this process is http.server, not ASGI.

Tools:
  * Free: get_price, list_price_symbols, list_models (no key needed), and get_balance, get_limits and
    get_receipts (the key's own balance, limits and charges, so they need the key; read-only).
  * Paid from the key's own limits, needing the "search" scope: web_search, read_page (Exa, through
    ApiKeys._search, exactly as /v1/exa/… is billed).
  * Paid from the key's own limits, needing the "tools" scope: every entry of server.PAID_TOOLS, under
    its mcpStyleName (get_weather, resolve_ens, …), through ApiKeys.tool.
Every tools/list entry carries a title and MCP annotations (readOnlyHint, destructiveHint, idempotentHint,
openWorldHint): paid tools debit the key's SingIt limits but never touch external state, so they are
readOnlyHint/not destructive like the free ones, but not idempotent (each call bills again) and, except
the four free lookups that only read SingIt's own data, openWorldHint (they reach third-party data).
get_sign402_report (server.PAID_TOOLS) is not offered over MCP: its demo upstream is not running in production.

A request with no credentials at all is served keyless: initialize, ping, tools/list and the three free
tools work, so catalogues and people can see what the server offers before they make a key. The same
applies to a header that only looks like a credential - empty/whitespace Authorization or x-api-key, a
bare "Bearer" with nothing after it, or an unexpanded client template like "${SINGIT_API_KEY}" or
"Bearer ${env:SINGIT_API_KEY}" - since those are a client misconfiguration, not an attempt to send a key
(_credential_is_unset). A paid tool called keyless gets a tool error asking for a key; nothing is billed
and no account is touched. A request that does send a key (Authorization: Bearer sk_singit_…, or
x-api-key) must send a valid one: a wrong or revoked key is a 401, never a quiet fall back to keyless, so
a typo in a key is noticed.

MCP has its own rate limit, separate from the /v1 one in ApiKeys._rate: heavy use of one must not starve
the other. It is per key, or per client address for keyless requests, 60 requests a minute by default,
overridden by SINGIT_MCP_REQUESTS_PER_MINUTE; it is charged once per JSON-RPC request that carries an id
(initialize, ping, tools/list, tools/call) - notifications (202) are not rated. web_search and read_page
still go through ApiKeys._search, but with rate=False: this module already rated the request, and billing
it a second time against /v1 would make the two buckets interfere.

A client address, when the caller has one, is also limited on failed authentication (a wrong or revoked
key): too many in a short window gets 429s instead of 401s, to blunt key guessing against this endpoint.
A valid key is always served, whatever its address has been doing.

Browser Origin: refused with 403 unless it is trusted, same as /v1 refuses one. Trusted means either the
same origin as the MCP host itself (McpServer's public_origin, normally SIGN402_WEB_URI) or one of
DEFAULT_ALLOWED_ORIGINS / SINGIT_MCP_ALLOWED_ORIGINS below — known MCP inspectors and scanners that need to
read tools/list without a key before a human adds one. A trusted origin still needs a valid key for
anything beyond the CORS preflight; an untrusted one is refused before authentication is even checked.

Catalog metadata that other files or endpoints read from here: server_card() for
GET /.well-known/mcp/server-card.json (SEP-1649) and glama_json() for GET /.well-known/glama.json
(both served by web_api.py, public, no key).
"""

from __future__ import annotations

import functools
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict
from typing import Any, Callable, Mapping
from urllib.parse import quote

from . import analytics
from .web_accounts import chain_of_account
from .web_api_keys import ASK_URL, ApiError, ApiKeys

logger = logging.getLogger(__name__)

SUPPORTED_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
OUR_VERSION = SUPPORTED_VERSIONS[0]
SERVER_INFO = {"name": "singit", "title": "SingIt x402", "version": "0.1.2"}
INSTRUCTIONS = (
    "Look up prices, models, web pages and market data. get_price, list_price_symbols and list_models are "
    "free and work without a key. Paid tools need a SingIt API key and are charged per call to that key's "
    "SingIt limits, in USDC on Base or Solana. web_search and read_page need the key's \"search\" scope; the "
    "market data tools need its \"tools\" scope and a Base account for now. Keys made before paid data tools existed need a new key for those."
)
KEYLESS_PAID_MESSAGE = ("This tool is paid. Create a SingIt API key at https://app.singitai.app/app/ and send it "
                        "as \"Authorization: Bearer sk_singit_...\" or \"x-api-key: sk_singit_...\".")
READ_CAP = 2 * 1024 * 1024
USER_AGENT = "SingIt-MCP/0.1 (+https://singitai.app)"
SYMBOL_RE = re.compile(r"[A-Za-z0-9]{1,12}")
PRICE_KINDS = ("crypto", "metal", "fx")
MODEL_KINDS = ("chat", "images", "audio")
SEARCH_TYPES = ("auto", "fast", "neural", "keyword")
MCP_REQUESTS_PER_MINUTE_ENV = "SINGIT_MCP_REQUESTS_PER_MINUTE"
DEFAULT_MCP_REQUESTS_PER_MINUTE = 60
AUTH_FAILURES_PER_WINDOW = 30       # per client address, to blunt key guessing against this endpoint
AUTH_FAILURE_WINDOW_SECONDS = 600
AUTH_FAILURE_TABLE_MAX = 10_000     # addresses kept before stale ones are pruned


def _env_requests_per_minute() -> int:
    raw = os.environ.get(MCP_REQUESTS_PER_MINUTE_ENV)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MCP_REQUESTS_PER_MINUTE
    return value if value > 0 else DEFAULT_MCP_REQUESTS_PER_MINUTE


# Tools billed through ApiKeys._search: it rates the key itself, so McpServer must not rate it again.
SEARCH_TOOLS = frozenset({"web_search", "read_page"})
# The only tools that read SingIt's own data for free; every other tool bills the key per call and, except
# for these three, reaches third-party data.
FREE_TOOL_NAMES = frozenset({"get_price", "list_price_symbols", "list_models", "get_balance", "get_limits", "get_receipts"})
# Free, but about the caller's own account, so it needs a key even though it bills nothing.
KEYED_FREE_TOOLS = frozenset({"get_balance", "get_limits", "get_receipts"})
RECEIPT_KINDS = ("charge", "topup", "refund")
RECEIPTS_DEFAULT, RECEIPTS_MAX = 10, 50
# server.PAID_TOOLS entries kept out of MCP: get_sign402_report's upstream is a local demo service
# (SIGN402_BASE_REPORT_URL, 127.0.0.1:4021) that is not running in production, so it could only fail.
MCP_HIDDEN_TOOLS = frozenset({"get_sign402_report"})
# MCP-facing descriptions for server.PAID_TOOLS, by mcpStyleName: what it returns, when to use it, and how it
# differs from its neighbours (MCP directories score exactly that). The gateway's own descriptions stay as they are.
PAID_TOOL_DESCRIPTIONS: dict[str, str] = {
    "get_weather": "A sample weather forecast from GoPlausible's x402 demo service on Algorand. Takes no location "
                   "and returns a fixed example, so it is mainly useful to try a paid call end to end.",
    "get_singit_risk_check": "SingIt's risk check on Bankr x402 Cloud, run on a fixed sample payment request "
                             "(no input). Mainly useful to try a paid call end to end.",
    "get_x_profile": "Public profile data for an X (Twitter) account by username, from twit.sh's x402 API. Use to "
                     "check who is behind a handle.",
    "get_crypto_news": "Latest crypto market headlines with sentiment, from Otto AI. Use to see what is moving the "
                       "market today; takes no input.",
    "get_hyperliquid_market": "One Hyperliquid perpetual market (e.g. BTC): price, funding, open interest, max "
                              "leverage and size rules, from Otto AI. Use for Hyperliquid's own contract details; "
                              "use get_funding_rates to compare venues.",
    "get_funding_rates": "Funding rates for one symbol across exchanges, with open interest, long/short ratio, large "
                         "positions and liquidations, from Otto AI. Use to compare venues or gauge positioning; use "
                         "get_hyperliquid_market for one Hyperliquid contract.",
    "resolve_ens": "Turns an ENS name (e.g. vitalik.eth) into its address, or an address into its primary ENS name.",
    "get_token_price": "USD price of a major token by symbol from a paid x402 price API. get_price is free and "
                       "covers the same majors, so prefer it; use this as a second source.",
}
TOOL_TITLES: dict[str, str] = {
    "get_price": "Get price",
    "list_price_symbols": "List price symbols",
    "list_models": "List models",
    "web_search": "Web search",
    "read_page": "Read page",
    "get_weather": "Get weather",
    "get_balance": "Get balance",
    "get_limits": "Get limits",
    "get_receipts": "Get receipts",
    "get_singit_risk_check": "SingIt risk check",
    "get_x_profile": "Get X profile",
    "get_crypto_news": "Get crypto news",
    "get_hyperliquid_market": "Get Hyperliquid market",
    "get_funding_rates": "Get funding rates",
    "resolve_ens": "Resolve ENS name",
    "get_token_price": "Get token price",
}
# Known MCP inspectors and scanners that need to read tools/list from a browser before a key is on hand;
# an exact, lowercased, no-trailing-slash match against Origin, same as the public_origin same-origin check.
DEFAULT_ALLOWED_ORIGINS = frozenset({
    "https://glama.ai",             # Glama's connector health-check and claim verification (SI-40 catalog listing)
    "https://www.glama.ai",
    "https://x402scan.com",         # x402scan's resource crawler (indexes the x402 API, may probe /mcp too)
    "https://www.x402scan.com",
})
ALLOWED_ORIGINS_ENV = "SINGIT_MCP_ALLOWED_ORIGINS"


def _normalize_origin(origin: str) -> str:
    return origin.strip().lower().rstrip("/")


_TEMPLATE_PLACEHOLDER_RE = re.compile(r"^\$\{[^{}]*\}$")


def _credential_is_unset(value: str | None) -> bool:
    """True for a header that is really "no credential": empty/whitespace, a bare "Bearer" with no
    token after it (any case, any amount of whitespace), or an unexpanded client template such as
    "${SINGIT_API_KEY}" or "Bearer ${env:SINGIT_API_KEY}" - clients that fail to substitute an env var
    send the literal placeholder, which must not be looked up as a key (Codex review)."""
    text = str(value or "").strip()
    if not text:
        return True
    scheme, _, rest = text.partition(" ")
    if scheme.lower() == "bearer":
        text = rest.strip()
    return not text or bool(_TEMPLATE_PLACEHOLDER_RE.match(text))


def allowed_origins_from_env(env: Mapping[str, str] | None = None) -> frozenset[str]:
    """SINGIT_MCP_ALLOWED_ORIGINS, comma-separated exact origins (scheme+host[+port], no wildcards); unset
    keeps DEFAULT_ALLOWED_ORIGINS, set replaces it entirely rather than extending it."""
    values = os.environ if env is None else env
    raw = str(values.get(ALLOWED_ORIGINS_ENV, "")).strip()
    if not raw:
        return DEFAULT_ALLOWED_ORIGINS
    return frozenset(_normalize_origin(origin) for origin in raw.split(",") if origin.strip())


def _annotated(entry: dict[str, Any]) -> dict[str, Any]:
    """Title + MCP tool annotations (SEP: title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint).
    Every tool here is read-only and non-destructive: paid ones debit the key's limits but never change
    external state. Free lookups are idempotent and read SingIt's own data; paid ones bill again on every
    call (not idempotent) and, except the three free ones, reach third-party data (open world)."""
    name = entry["name"]
    free = name in FREE_TOOL_NAMES
    title = TOOL_TITLES.get(name) or name.replace("_", " ").capitalize()
    annotations = {"title": title, "readOnlyHint": True, "destructiveHint": False,
                   "idempotentHint": free, "openWorldHint": not free}
    return {**entry, "title": title, "annotations": annotations}


@functools.lru_cache(maxsize=1)
def _paid_tools() -> tuple[dict[str, str], tuple[dict[str, Any], ...]]:
    """server.PAID_TOOLS by mcpStyleName, and their MCP listing. Imported on first use, not when the web API
    starts: the gateway module is large and this process ran without it until now."""
    from . import server as gw  # noqa: PLC0415
    ids = {tool["mcpStyleName"]: tool_id for tool_id, tool in gw.PAID_TOOLS.items()}
    ids = {name: tool_id for name, tool_id in ids.items() if name not in MCP_HIDDEN_TOOLS}
    listed = tuple(_annotated({"name": tool["mcpStyleName"],
                               "description": PAID_TOOL_DESCRIPTIONS.get(tool["mcpStyleName"], tool["description"])
                               + " Paid per call from your key's SingIt limits in USDC; Base accounts only for now.",
                               "inputSchema": tool["inputSchema"]})
                   for tool in gw.PAID_TOOLS.values() if tool["mcpStyleName"] not in MCP_HIDDEN_TOOLS)
    return ids, listed


class _BadArgs(Exception):
    """An unknown tool or bad arguments: a JSON-RPC protocol error (-32602), not a tool failure."""


class _MethodNotFound(Exception):
    """An unsupported JSON-RPC method (-32601)."""


class _RateLimited(Exception):
    """The key's MCP bucket is empty for this minute (-32029), with how long until it is not."""

    def __init__(self, limit: int, retry_after: int):
        self.limit, self.retry_after = limit, retry_after


def _default_fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(READ_CAP)
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read(READ_CAP) or b"{}")
        except ValueError:
            body = {}
        text = str(body.get("text") or body.get("message") or body.get("error") or "The request failed.")[:500]
        raise ApiError(502, text, type_="api_error", code="upstream_error") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ApiError(503, "Try again shortly.", type_="api_error", code="unavailable") from None
    try:
        return json.loads(data)
    except ValueError:
        raise ApiError(502, "The upstream answer could not be read.", type_="api_error", code="upstream_error") from None


def _symbol(value: Any) -> str:
    text = str(value or "").strip()
    if not SYMBOL_RE.fullmatch(text):
        raise _BadArgs("Symbols are 1 to 12 letters or digits.")
    return quote(text.upper(), safe="")


GET_PRICE_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(PRICE_KINDS), "description": "What kind of price to look up."},
        "symbol": {"type": "string", "description": "Ticker for crypto or metal, e.g. BTC, XAU."},
        "base": {"type": "string", "description": "Base currency for fx, e.g. USD."},
        "quote": {"type": "string", "description": "Quote currency for fx, e.g. EUR."},
    },
    "required": ["kind"],
}
GET_RECEIPTS_SCHEMA = {
    "type": "object",
    "properties": {
        "limit": {"type": "integer", "minimum": 1, "maximum": RECEIPTS_MAX, "description": f"How many, newest first. Defaults to {RECEIPTS_DEFAULT}."},
        "kind": {"type": "string", "enum": list(RECEIPT_KINDS), "description": "charge (default): what this key spent; topup: money added to the account; refund."},
        "before": {"type": "integer", "minimum": 1, "description": "Only entries older than this receipt id: pass the last id of the previous page."},
    },
}
LIST_MODELS_SCHEMA = {
    "type": "object",
    "properties": {"kind": {"type": "string", "enum": list(MODEL_KINDS), "description": "Defaults to chat."}},
}
WEB_SEARCH_SCHEMA = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "What to search the web for."},
        "numResults": {"type": "integer", "minimum": 1, "maximum": 10, "description": "Defaults to a few."},
        "type": {"type": "string", "enum": list(SEARCH_TYPES)},
    },
    "required": ["query"],
}
READ_PAGE_SCHEMA = {
    "type": "object",
    "properties": {"url": {"type": "string", "description": "The http(s) page to read."}},
    "required": ["url"],
}

OWN_TOOLS: list[dict[str, Any]] = [_annotated(entry) for entry in (
    {"name": "get_price", "description": "Current price of a major cryptocurrency, gold or silver (Chainlink on "
     "Base), or an exchange rate between two currencies. Use for quick quotes of well-known assets; call "
     "list_price_symbols when unsure a symbol is covered. Free, no key needed.", "inputSchema": GET_PRICE_SCHEMA},
    {"name": "list_price_symbols", "description": "Every crypto, metal and currency symbol get_price supports. "
     "Call it before get_price when unsure a symbol is covered. Free, no key needed.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_models", "description": "The AI models (chat, images or audio) available through SingIt, with "
     "their prices. They are called through SingIt's OpenAI-compatible API at https://app.singitai.app/v1 (or "
     "https://ask.singitai.app over x402), not through these MCP tools. Free, no key needed.",
     "inputSchema": LIST_MODELS_SCHEMA},
    {"name": "get_balance", "description": "Your SingIt API balance: available and held USDC, auto top-up and "
     "pending top-ups. Use to check funds before paid calls. Free, but needs your API key.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_limits", "description": "What your API key may still spend: its daily and per-request caps, spent and "
     "remaining today, scopes and expiry, plus your account's balance and, on Base, your allowance limiter (caps, "
     "left today, approved from your wallet, paused = emergency stop, expired). Read-only: it cannot change a limit. "
     "Use before a paid call to see whether it fits. Free, but needs your API key.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_receipts", "description": "Your recent receipts, newest first: for each, its id, time, model, USDC "
     "charged, tokens and the upstream reference (kind charge, this key only), or the account's top-ups and refunds "
     "with their transaction and network. Read-only; page back with `before`. Free, but needs your API key.",
     "inputSchema": GET_RECEIPTS_SCHEMA},
    {"name": "web_search", "description": "Searches the web through Exa and returns titles, URLs and snippets of "
     "matching pages. Use for current or niche information, then read_page for a full page. Paid per call from "
     "your key's SingIt limits in USDC on Base or Solana; needs the key's \"search\" scope.",
     "inputSchema": WEB_SEARCH_SCHEMA},
    {"name": "read_page", "description": "The readable text of one web page (up to 8000 characters), through Exa. "
     "Use after web_search, or when you already have a URL. Paid per call from your key's SingIt limits in USDC "
     "on Base or Solana; needs the key's \"search\" scope.", "inputSchema": READ_PAGE_SCHEMA},
)]


def tools() -> list[dict[str, Any]]:
    return OWN_TOOLS + list(_paid_tools()[1])


# Catalog metadata served by web_api.py's GET dispatch, public and keyless.
ICON_URL = "https://singitai.app/assets/icons/icon-512.png"
DOCS_URL = ("https://github.com/bubon-ik/SingItAI/blob/main/sign402-gateway/README.md"
            "#mcp-server-remote-for-claude-code-cursor-codex")
SERVER_CARD_DESCRIPTION = ("Free price, model and symbol lookups, plus paid web search, page reading and x402 "
                           "market data, in USDC on Base or Solana within your API key's SingIt limits.")
AUTH_INSTRUCTIONS = ("Free tools work without a key. For paid tools, create a SingIt API key in the app at "
                     "https://app.singitai.app/app/, then send it as \"Authorization: Bearer sk_singit_...\" or "
                     "\"x-api-key: sk_singit_...\".")


def server_card(public_origin: str, mcp_path: str = "/mcp") -> dict[str, Any]:
    """GET /.well-known/mcp/server-card.json (SEP-1649 draft shape). public_origin is the MCP host's own
    origin (e.g. https://app.singitai.app), never a reflected request Host header."""
    return {
        "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
        "version": "1.0",
        "protocolVersion": OUR_VERSION,
        "serverInfo": dict(SERVER_INFO),
        "description": SERVER_CARD_DESCRIPTION,
        "iconUrl": ICON_URL,
        "documentationUrl": DOCS_URL,
        "transport": {"type": "streamable-http", "url": f"{public_origin}{mcp_path}"},
        "capabilities": {"tools": {"listChanged": False}},
        "authentication": {"required": False, "schemes": ["bearer"], "headers": ["Authorization", "x-api-key"],
                           "instructions": AUTH_INSTRUCTIONS},
        "instructions": INSTRUCTIONS,
        "tools": tools(),
    }


# The support address already published in the website footer (mailto:contact@singitai.app), reused
# here so Glama's claim can verify we control this domain.
GLAMA_MAINTAINER_EMAIL = "contact@singitai.app"


def glama_json() -> dict[str, Any]:
    """GET /.well-known/glama.json: Glama's claim-by-well-known-file verification."""
    return {"$schema": "https://glama.ai/mcp/schemas/connector.json",
            "maintainers": [{"email": GLAMA_MAINTAINER_EMAIL}]}


def _result(id_: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def rpc_error(id_: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _tool_success(data: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": json.dumps(data)}]}
    if isinstance(data, dict):
        out["structuredContent"] = data
    return out


def _tool_error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _classify(exc: ApiError | None) -> tuple[str, str]:
    """(status, error_kind) of a failed tool call, from the ApiError's status/code only, never its message."""
    if exc is None:
        return "error", "upstream"
    code = exc.code
    if code == "rate_limit_exceeded":
        return "rate_limited", "limit"
    if code in ("scope_missing", "base_only"):
        return "refused", "scope"
    if code in ("insufficient_quota", "payment_not_ready"):
        return "refused", "limit"
    if exc.status in (401, 403):
        return "refused", "auth"
    if exc.status in (400, 404):
        return "error", "bad_args"
    return "error", "upstream"


class McpServer:
    """One request, one answer: no session, no SSE. Construct with the web app's ApiKeys.

    `requests_per_minute` fixes the MCP bucket's size, overriding SINGIT_MCP_REQUESTS_PER_MINUTE; tests
    pass it directly instead of setting the environment. The env is otherwise read once here, at
    construction, not at import time (the web API builds one of these for the life of the process).

    public_origin is this MCP server's own origin (normally SIGN402_WEB_URI); together with
    allowed_origins (default: allowed_origins_from_env()) it decides which browser Origins are trusted
    enough to even reach the auth check, below. A key is still required for anything beyond that: trust
    here only buys an untrusted scanner a 401 instead of a 403, plus the CORS headers to read it.
    """

    def __init__(self, keys: ApiKeys, *, fetch_json: Callable[[str], dict[str, Any]] | None = None,
                 requests_per_minute: int | None = None, public_origin: str = "",
                 allowed_origins: frozenset[str] | None = None):
        self.keys = keys
        self.fetch_json = fetch_json or _default_fetch_json
        self.requests_per_minute = requests_per_minute if requests_per_minute is not None else _env_requests_per_minute()
        self._lock = threading.Lock()
        self._calls: dict[str, list[float]] = defaultdict(list)
        self._auth_failures: dict[str, list[float]] = defaultdict(list)
        self.public_origin = _normalize_origin(public_origin) if public_origin else ""
        self.allowed_origins = allowed_origins_from_env() if allowed_origins is None else allowed_origins

    def is_trusted_origin(self, origin: str | None) -> bool:
        if not origin:
            return False
        normalized = _normalize_origin(origin)
        if normalized == "null":  # the sandboxed-origin literal, never a real site
            return False
        return normalized == self.public_origin or normalized in self.allowed_origins

    def handle(self, *, authorization: str | None, api_key: str | None, origin: str | None,
               protocol_version: str | None, body: bytes | dict[str, Any],
               client_ip: str | None = None) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        if origin and not self.is_trusted_origin(origin):
            # A key is for server code; the page never holds one. Also satisfies the spec's DNS-rebinding check.
            return 403, rpc_error(None, -32600, "API keys are for server code, not browsers. Keep the key out of "
                                  "web pages."), {}
        status, result, headers = self._authenticated(authorization, api_key, protocol_version, body, client_ip)
        if origin:  # trusted, checked above: let the caller read the answer across origins
            # Expose-Headers on the real answer too, not only the preflight: a 401's WWW-Authenticate is
            # otherwise unreadable to the page (Codex review).
            headers = {**headers, "Access-Control-Allow-Origin": origin, "Vary": "Origin",
                       "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id"}
        return status, result, headers

    def _authenticated(self, authorization: str | None, api_key: str | None, protocol_version: str | None,
                        body: bytes | dict[str, Any], client_ip: str | None = None) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        if _credential_is_unset(authorization) and _credential_is_unset(api_key):
            row, bucket = None, f"keyless:{client_ip or '-'}"
        else:
            try:
                row = self.keys._key(authorization, api_key)
            except ApiError:
                # Checked only after the key failed, so a valid key behind a shared NAT or proxy is never locked
                # out by someone else's bad requests from the same address (Codex review).
                if client_ip is not None and self._failed_auth(client_ip):
                    return (429, rpc_error(None, -32029, "Too many failed sign-ins from this address. Try again in "
                                           "a few minutes."), {"Retry-After": str(AUTH_FAILURE_WINDOW_SECONDS)})
                return (401, rpc_error(None, -32001, "Invalid or revoked API key. Create one in the SingIt app."),
                       {"WWW-Authenticate": 'Bearer realm="singit", error="invalid_token"'})
            bucket = row["key_id"]
        if isinstance(body, (bytes, bytearray)):
            try:
                parsed = json.loads(body) if body else {}
            except (ValueError, UnicodeError):
                return 400, rpc_error(None, -32700, "Parse error."), {}
        else:
            parsed = body
        if isinstance(parsed, list):
            return 400, rpc_error(None, -32600, "Batch requests are not supported."), {}
        if not isinstance(parsed, dict) or parsed.get("jsonrpc") != "2.0" or not isinstance(parsed.get("method"), str):
            return 400, rpc_error(None, -32600, "Invalid Request."), {}
        method, msg_id, has_id = parsed["method"], parsed.get("id"), "id" in parsed
        if not has_id or method.startswith("notifications/"):
            return 202, None, {}
        try:
            self._rate(bucket)
        except _RateLimited as exc:
            who = "This key sends" if row is not None else "Without a key, one address sends"
            return (429, rpc_error(msg_id, -32029, f"{who} up to {exc.limit} requests a minute to MCP. "
                                   "Slow down."), {"Retry-After": str(exc.retry_after)})
        params = parsed.get("params") if isinstance(parsed.get("params"), dict) else {}
        try:
            result = self._dispatch(row, method, params, protocol_version)
        except _MethodNotFound as exc:
            return 200, rpc_error(msg_id, -32601, str(exc)), {}
        except _BadArgs as exc:
            return 200, rpc_error(msg_id, -32602, str(exc)), {}
        return 200, _result(msg_id, result), {}

    def _rate(self, bucket: str) -> None:
        """MCP's own bucket, per key id or "keyless:<address>": independent of ApiKeys._rate (the /v1 one),
        so heavy use of one endpoint never starves the other."""
        now = self.keys.now()
        with self._lock:
            recent = [t for t in self._calls[bucket] if t > now - 60]
            if len(recent) >= self.requests_per_minute:
                raise _RateLimited(self.requests_per_minute, max(1, round(60 - (now - recent[0]))))
            recent.append(now)
            self._calls[bucket] = recent

    def _failed_auth(self, client_ip: str) -> bool:
        """Records one failed authentication from `client_ip`; True once it is over the limit for the window.
        Stale addresses are dropped whenever the table grows large, so it cannot grow without bound."""
        now = self.keys.now()
        cutoff = now - AUTH_FAILURE_WINDOW_SECONDS
        with self._lock:
            if len(self._auth_failures) > AUTH_FAILURE_TABLE_MAX:
                for ip in [ip for ip, times in self._auth_failures.items() if not times or times[-1] <= cutoff]:
                    del self._auth_failures[ip]
            recent = [t for t in self._auth_failures[client_ip] if t > cutoff]
            over = len(recent) >= AUTH_FAILURES_PER_WINDOW
            if not over:
                recent.append(now)
            self._auth_failures[client_ip] = recent
            return over

    def _dispatch(self, row, method: str, params: dict[str, Any], protocol_version: str | None) -> Any:
        if method == "initialize":
            return self._initialize(params)
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": tools()}
        if method == "tools/call":
            return self._tools_call_observed(row, params)
        raise _MethodNotFound(f"Unknown method '{method}'.")

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        requested = params.get("protocolVersion")
        version = requested if requested in SUPPORTED_VERSIONS else OUR_VERSION
        return {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": dict(SERVER_INFO), "instructions": INSTRUCTIONS}

    def _tools_call_observed(self, row, params: dict[str, Any]) -> dict[str, Any]:
        """_tools_call, then one `mcp_call` analytics event (docs/analytics.md). The event is built from the
        outcome only; it never reads tool arguments, and nothing in here can raise into the request."""
        started, seen = time.monotonic(), []
        try:
            result = self._tools_call(row, params, seen)
        except _BadArgs:
            self._record_call(row, params, started, None, "error", "bad_args")
            raise
        except Exception:
            self._record_call(row, params, started, None, "error", "internal")
            raise
        status, kind = ("ok", None) if not result.get("isError") else _classify(seen[0] if seen else None)
        self._record_call(row, params, started, result, status, kind)
        return result

    def _record_call(self, row, params, started: float, result, status: str, error_kind: str | None) -> None:
        try:
            name = params.get("name")
            paid_names = set(SEARCH_TOOLS) | set(_paid_tools()[0])
            known = {t["name"] for t in OWN_TOOLS} | paid_names
            tool = name if isinstance(name, str) and name in known else "unknown"
            # `paid` is whether the tool is a paid one (Codex review: don't infer it from the result shape);
            # `cost_usd` is only set when the result reports an actual charge.
            props: dict[str, Any] = {"tool": tool, "status": status,
                                     "latency_ms": int((time.monotonic() - started) * 1000),
                                     "paid": tool in paid_names}
            if row is not None:
                props["key_ref"] = analytics.key_ref(row["key_id"])
            else:
                props["keyless"] = True
            if error_kind:
                props["error_kind"] = error_kind
            billing = (result or {}).get("structuredContent", {}).get("billing") if status == "ok" else None
            charged = billing.get("chargedAtomic") if isinstance(billing, dict) else None
            if type(charged) is int and charged > 0:
                props["cost_usd"] = analytics.usdc_to_usd_precise(charged)
            analytics.emit("mcp_call", row["account_id"] if row is not None else None, **props)
        except Exception as exc:  # noqa: BLE001 - analytics must never break a tool call
            logger.warning("mcp_call analytics failed: %s", exc)

    def _tools_call(self, row, params: dict[str, Any], seen: list | None = None) -> dict[str, Any]:
        # handle() already rated this call once in the MCP bucket; web_search and read_page must not
        # also be rated in ApiKeys._search (the /v1 bucket) - see their rate=False below.
        name = params.get("name")
        if not isinstance(name, str) or not name:
            raise _BadArgs("name is required.")
        args = params.get("arguments")
        args = args if isinstance(args, dict) else {}
        try:
            data = self._call_tool(row, name, args)
        except ApiError as exc:
            if seen is not None:
                seen.append(exc)
            return _tool_error(exc.message)
        return _tool_success(data)

    def _call_tool(self, row, name: str, args: dict[str, Any]) -> Any:
        if row is None and name in KEYED_FREE_TOOLS:
            raise ApiError(401, "This tool reads your own SingIt account, so it needs your API key (it costs "
                           "nothing). Send it as \"Authorization: Bearer sk_singit_...\".",
                           type_="authentication_error", code="api_key_required")
        if row is None and name not in FREE_TOOL_NAMES:
            if name in SEARCH_TOOLS or name in _paid_tools()[0]:
                raise ApiError(401, KEYLESS_PAID_MESSAGE, type_="authentication_error", code="api_key_required")
            raise _BadArgs(f"Unknown tool '{name}'.")
        if name == "get_price":
            return self._get_price(args)
        if name == "list_price_symbols":
            return self.fetch_json(f"{ASK_URL}/v1/prices")
        if name == "list_models":
            return self._list_models(row, args)
        if name == "get_balance":
            if getattr(self.keys, "proxy", None) is None:
                raise ApiError(503, "Balances are not available on this server.", type_="api_error", code="unavailable")
            return self.keys._balance(row["account_id"])
        if name == "get_limits":
            return self._get_limits(row)
        if name == "get_receipts":
            return self._get_receipts(row, args)
        if name == "web_search":
            return self._web_search(row, args)
        if name == "read_page":
            return self._read_page(row, args)
        tool_id = _paid_tools()[0].get(name)
        if tool_id is None:
            raise _BadArgs(f"Unknown tool '{name}'.")
        _status, data, _headers = self.keys.tool(row, tool_id, args)
        return data

    def _get_limits(self, row) -> dict[str, Any]:
        """The key's own caps and today's spend, the account's balance, and the account's allowance limiter on Base.
        Read-only: nothing here writes, advances a pending grant, or reveals an address other than the limiter's."""
        now = int(self.keys.now())
        spent, answers = self.keys.store.key_spent(row["key_id"], int(self.keys.now()) // 86400)
        daily, per_request = int(row["daily_cap_atomic"]), int(row["per_request_cap_atomic"])
        held = int(getattr(self.keys, "_reserved", {}).get(row["key_id"], 0))  # answers still running
        revoked = row["revoked_at"] is not None
        out: dict[str, Any] = {"object": "limits", "currency": "USDC", "key": {
            "id": row["key_id"], "name": row["name"], "prefix": row["prefix"],
            "state": "revoked" if revoked else ("expired" if row["expires_at"] <= now else "active"),
            "dailyCapUsd": daily / 1e6, "perRequestCapUsd": per_request / 1e6, "spentTodayUsd": spent / 1e6,
            "heldNowUsd": held / 1e6, "remainingTodayUsd": max(0, daily - spent - held) / 1e6, "answersToday": answers,
            "scopes": str(row["scopes"]).split(), "expiresAt": row["expires_at"],
            "resetsAt": (int(self.keys.now()) // 86400 + 1) * 86400,
            "note": "Caps are per key and reset at 00:00 UTC; answers still running are held against the daily cap (heldNowUsd)."}}
        if getattr(self.keys, "proxy", None) is not None:
            try:
                balance = self.keys._balance(row["account_id"])
                out["balance"] = {k: balance[k] for k in ("availableUsd", "heldUsd", "autoTopup") if k in balance}
            except Exception as exc:  # noqa: BLE001 - one unreadable part must not hide the key's own limits
                logger.warning("get_limits: balance unreadable (%s)", type(exc).__name__)
                out["balance"] = {"available": False}
        out["allowance"] = self._allowance_view(row["account_id"])
        return out

    def _allowance_view(self, account: str) -> dict[str, Any]:
        """The account's active Base allowance limiter, as the owner would read it (no owner, agent or guardian
        address). `paused` is the emergency stop; `approvedUsd` 0 means the owner's approval is revoked or not granted."""
        if chain_of_account(account) == "solana":
            return {"configured": False, "chain": "solana",
                    "note": "Allowance limits are on Base only for now. Solana limits are checked by SingIt's server."}
        allowance = getattr(self.keys.api, "allowance", None)
        try:
            active = allowance.store.active_limiter(account)
            if active is None:
                return {"configured": False, "chain": "base"}
            seen = allowance._describe(active)
        except Exception as exc:  # noqa: BLE001
            logger.warning("get_limits: allowance unreadable (%s)", type(exc).__name__)
            return {"available": False, "chain": "base", "note": "The allowance could not be read right now."}
        usd = lambda atomic: int(atomic) / 1e6  # noqa: E731
        state = str(seen.get("state", ""))
        return {"configured": True, "chain": "base", "limiter": seen["limiter"], "state": state if state in (
                    "paused", "expired", "granted") else "waiting_for_grant",
                "dailyCapUsd": usd(seen["dailyCapAtomic"]), "perPurchaseCapUsd": usd(seen["perPurchaseCapAtomic"]),
                "remainingTodayUsd": usd(seen["remainingTodayAtomic"]), "approvedUsd": usd(seen["allowanceAtomic"]),
                "paused": bool(seen["paused"]), "expiresAt": int(seen["expiry"])}

    def _get_receipts(self, row, args: dict[str, Any]) -> dict[str, Any]:
        if getattr(self.keys, "proxy", None) is None:
            raise ApiError(503, "Receipts are not available on this server.", type_="api_error", code="unavailable")
        limit = args.get("limit", RECEIPTS_DEFAULT)
        if type(limit) is not int or not 1 <= limit <= RECEIPTS_MAX:
            raise _BadArgs(f"limit must be a whole number from 1 to {RECEIPTS_MAX}.")
        kind = args.get("kind", "charge")
        if kind not in RECEIPT_KINDS:
            raise _BadArgs("kind must be charge, topup or refund.")
        before = args.get("before")
        if before is not None and (type(before) is not int or before < 1):
            raise _BadArgs("before must be a receipt id (a positive whole number).")
        data: list[dict[str, Any]] = []
        cursor, scanned, end = before, 0, False
        # The ledger is the account's; a charge belongs to one key. Page until `limit` of this key's are found
        # (or a bounded number of rows has been read, so an idle key cannot make this scan a whole ledger).
        while len(data) < limit and scanned < 400 and not end:
            rows = self.keys.proxy.balances.ledger(row["account_id"], limit=200, before=cursor)
            if not rows:
                end = True
                break
            scanned += len(rows)
            for entry in rows:
                cursor = entry["id"]
                if entry["kind"] != kind or (kind == "charge" and entry["key_id"] != row["key_id"]):
                    continue
                item: dict[str, Any] = {"id": entry["id"], "at": int(entry["at"]), "kind": kind,
                                        "amountUsd": abs(int(entry["amount_atomic"])) / 1e6}
                if kind == "charge":
                    item.update({"model": entry["model"], "reference": entry["ref"],
                                 "inputTokens": entry["input_tokens"] or 0, "outputTokens": entry["output_tokens"] or 0,
                                 "balanceAfterUsd": int(entry["balance_after"]) / 1e6})
                else:
                    item.update({"transaction": entry["tx_id"], "network": entry["network"], "reference": entry["ref"]})
                data.append(item)
                if len(data) == limit:
                    break
            else:
                end = len(rows) < 200   # the whole batch was read and the ledger had no more
                continue
            break
        return {"object": "list", "currency": "USDC", "kind": kind, "data": data,
                "next": None if end else cursor}

    def _get_price(self, args: dict[str, Any]) -> Any:
        kind = args.get("kind")
        if kind not in PRICE_KINDS:
            raise _BadArgs("kind must be crypto, metal or fx.")
        if kind == "fx":
            url = f"{ASK_URL}/v1/prices/fx/{_symbol(args.get('base'))}/{_symbol(args.get('quote'))}"
        else:
            url = f"{ASK_URL}/v1/prices/{kind}/{_symbol(args.get('symbol'))}"
        return self.fetch_json(url)

    def _list_models(self, row, args: dict[str, Any]) -> Any:
        kind = args.get("kind") or "chat"
        if kind not in MODEL_KINDS:
            raise _BadArgs("kind must be chat, images or audio.")
        if kind != "chat":
            return self.fetch_json(f"{ASK_URL}/v1/{kind}/models")
        if row is None:  # keyless: SingIt Ask's public list, the models any caller can pay for over x402
            return {"object": "list", "data": list(self.fetch_json(f"{ASK_URL}/v1/models").get("data") or [])}
        status, reply = self.keys._shop("api-models", row["account_id"], {})
        if status != 200:
            raise ApiError(502, "The model list is unavailable right now.", type_="api_error")
        free = self.keys.free.listing() if self.keys.free is not None else []
        return {"object": "list", "data": [*free, *(reply.get("data") or [])]}

    def _web_search(self, row, args: dict[str, Any]) -> Any:
        query = str(args.get("query") or "").strip()
        if not query:
            raise _BadArgs("query is required.")
        body: dict[str, Any] = {"query": query}
        num = args.get("numResults")
        if num is not None:
            if type(num) is not int or not 1 <= num <= 10:
                raise _BadArgs("numResults must be a whole number from 1 to 10.")
            body["numResults"] = num
        type_ = args.get("type")
        if type_ is not None:
            if type_ not in SEARCH_TYPES:
                raise _BadArgs("type must be auto, fast, neural or keyword.")
            body["type"] = type_
        _status, data, _headers = self.keys._search(row, "/exa/search", body, rate=False)
        return data

    def _read_page(self, row, args: dict[str, Any]) -> Any:
        url = str(args.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise _BadArgs("url must be an http or https page.")
        _status, data, _headers = self.keys._search(row, "/exa/contents", {
            "urls": [url], "text": {"maxCharacters": 8000}}, rate=False)
        return data
