"""SingIt's own remote MCP server: POST /mcp on the public web API, authenticated with a SingIt API key.

A minimal, stateless server over MCP's Streamable HTTP transport (spec 2025-06-18, back to 2024-11-05):
JSON responses only, no SSE stream and no sessions, so one request is one answer and nothing is kept
between calls. Built on plain JSON-RPC 2.0 dicts, since this process is http.server, not ASGI.

Tools:
  * Free: get_price, list_price_symbols, list_models.
  * Paid from the key's own limits, needing the "search" scope: web_search, read_page (Exa, through
    ApiKeys._search, exactly as /v1/exa/… is billed).
  * Paid from the key's own limits, needing the "tools" scope: every entry of server.PAID_TOOLS, under
    its mcpStyleName (get_weather, resolve_ens, …), through ApiKeys.tool.

Every call needs a valid key (Authorization: Bearer sk_singit_…, or x-api-key) before anything else,
including initialize; a browser Origin is refused for the same reason /v1 refuses one. The key's own
60-requests-a-minute rate applies once per tools/call, whether the tool is free or paid, except the two
Exa tools: they already rate inside ApiKeys._search.
"""

from __future__ import annotations

import functools
import json
import logging
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable
from urllib.parse import quote

from . import analytics
from .web_api_keys import ASK_URL, ApiError, ApiKeys

logger = logging.getLogger(__name__)

SUPPORTED_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
OUR_VERSION = SUPPORTED_VERSIONS[0]
SERVER_INFO = {"name": "singit", "title": "SingIt", "version": "0.1.0"}
INSTRUCTIONS = (
    "Look up prices, models, web pages and market data. Paid tools are charged per call to this API key's SingIt "
    "limits (Base USDC). get_price, list_price_symbols and list_models are free. web_search and "
    "read_page need the key's \"search\" scope; the other tools need its \"tools\" scope. Keys made "
    "before paid data tools existed need a new key for those."
)
READ_CAP = 2 * 1024 * 1024
USER_AGENT = "SingIt-MCP/0.1 (+https://singitai.app)"
SYMBOL_RE = re.compile(r"[A-Za-z0-9]{1,12}")
PRICE_KINDS = ("crypto", "metal", "fx")
MODEL_KINDS = ("chat", "images", "audio")
SEARCH_TYPES = ("auto", "fast", "neural", "keyword")
# Tools billed through ApiKeys._search: it rates the key itself, so McpServer must not rate it again.
SEARCH_TOOLS = frozenset({"web_search", "read_page"})


@functools.lru_cache(maxsize=1)
def _paid_tools() -> tuple[dict[str, str], tuple[dict[str, Any], ...]]:
    """server.PAID_TOOLS by mcpStyleName, and their MCP listing. Imported on first use, not when the web API
    starts: the gateway module is large and this process ran without it until now."""
    from . import server as gw  # noqa: PLC0415
    ids = {tool["mcpStyleName"]: tool_id for tool_id, tool in gw.PAID_TOOLS.items()}
    listed = tuple({"name": tool["mcpStyleName"], "description": tool["description"] + " Paid per call from your "
                    "SingIt limits (Base USDC).", "inputSchema": tool["inputSchema"]} for tool in gw.PAID_TOOLS.values())
    return ids, listed


class _BadArgs(Exception):
    """An unknown tool or bad arguments: a JSON-RPC protocol error (-32602), not a tool failure."""


class _MethodNotFound(Exception):
    """An unsupported JSON-RPC method (-32601)."""


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

OWN_TOOLS: list[dict[str, Any]] = [
    {"name": "get_price", "description": "A crypto, metal or fx price. Free.", "inputSchema": GET_PRICE_SCHEMA},
    {"name": "list_price_symbols", "description": "Every symbol get_price knows. Free.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_models", "description": "Models this key can ask for chat, images or audio, with their "
     "SingIt prices. Free.", "inputSchema": LIST_MODELS_SCHEMA},
    {"name": "web_search", "description": "Search the web (Exa). Paid per call from your SingIt limits "
     "(Base USDC); needs the key's \"search\" scope.", "inputSchema": WEB_SEARCH_SCHEMA},
    {"name": "read_page", "description": "Read a web page's text (Exa). Paid per call from your SingIt limits "
     "(Base USDC); needs the key's \"search\" scope.", "inputSchema": READ_PAGE_SCHEMA},
]


def tools() -> list[dict[str, Any]]:
    return OWN_TOOLS + list(_paid_tools()[1])


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
    """One request, one answer: no session, no SSE. Construct with the web app's ApiKeys."""

    def __init__(self, keys: ApiKeys, *, fetch_json: Callable[[str], dict[str, Any]] | None = None):
        self.keys = keys
        self.fetch_json = fetch_json or _default_fetch_json

    def handle(self, *, authorization: str | None, api_key: str | None, origin: str | None,
               protocol_version: str | None, body: bytes | dict[str, Any]) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        if origin:
            # A key is for server code; the page never holds one. Also satisfies the spec's DNS-rebinding check.
            return 403, rpc_error(None, -32600, "API keys are for server code, not browsers. Keep the key out of "
                                  "web pages."), {}
        try:
            row = self.keys._key(authorization, api_key)
        except ApiError:
            return (401, rpc_error(None, -32001, "Invalid or revoked API key. Create one in the SingIt app."),
                   {"WWW-Authenticate": 'Bearer realm="singit", error="invalid_token"'})
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
        params = parsed.get("params") if isinstance(parsed.get("params"), dict) else {}
        try:
            result = self._dispatch(row, method, params, protocol_version)
        except _MethodNotFound as exc:
            return 200, rpc_error(msg_id, -32601, str(exc)), {}
        except _BadArgs as exc:
            return 200, rpc_error(msg_id, -32602, str(exc)), {}
        return 200, _result(msg_id, result), {}

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
            known = {t["name"] for t in OWN_TOOLS} | set(_paid_tools()[0])
            props: dict[str, Any] = {"tool": name if isinstance(name, str) and name in known else "unknown",
                                     "status": status, "latency_ms": int((time.monotonic() - started) * 1000),
                                     "paid": False, "key_ref": analytics.key_ref(row["key_id"])}
            if error_kind:
                props["error_kind"] = error_kind
            billing = (result or {}).get("structuredContent", {}).get("billing") if status == "ok" else None
            charged = billing.get("chargedAtomic") if isinstance(billing, dict) else None
            if type(charged) is int and charged > 0:
                props["paid"], props["cost_usd"] = True, analytics.usdc_to_usd_precise(charged)
            analytics.emit("mcp_call", row["account_id"], **props)
        except Exception as exc:  # noqa: BLE001 - analytics must never break a tool call
            logger.warning("mcp_call analytics failed: %s", exc)

    def _tools_call(self, row, params: dict[str, Any], seen: list | None = None) -> dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str) or not name:
            raise _BadArgs("name is required.")
        args = params.get("arguments")
        args = args if isinstance(args, dict) else {}
        try:
            if name not in SEARCH_TOOLS:  # /exa/… tools already rate inside ApiKeys._search
                self.keys._rate(row["key_id"])
            data = self._call_tool(row, name, args)
        except ApiError as exc:
            if seen is not None:
                seen.append(exc)
            return _tool_error(exc.message)
        return _tool_success(data)

    def _call_tool(self, row, name: str, args: dict[str, Any]) -> Any:
        if name == "get_price":
            return self._get_price(args)
        if name == "list_price_symbols":
            return self.fetch_json(f"{ASK_URL}/v1/prices")
        if name == "list_models":
            return self._list_models(row, args)
        if name == "web_search":
            return self._web_search(row, args)
        if name == "read_page":
            return self._read_page(row, args)
        tool_id = _paid_tools()[0].get(name)
        if tool_id is None:
            raise _BadArgs(f"Unknown tool '{name}'.")
        _status, data, _headers = self.keys.tool(row, tool_id, args)
        return data

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
        status, reply = self.keys._shop("api-models", row["account_id"], {})
        if status != 200:
            raise ApiError(502, "The model list is unavailable right now.", type_="api_error")
        return {"object": "list", "data": reply.get("data") or []}

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
        _status, data, _headers = self.keys._search(row, "/exa/search", body)
        return data

    def _read_page(self, row, args: dict[str, Any]) -> Any:
        url = str(args.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise _BadArgs("url must be an http or https page.")
        _status, data, _headers = self.keys._search(row, "/exa/contents", {
            "urls": [url], "text": {"maxCharacters": 8000}})
        return data
