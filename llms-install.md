# Installing the SingIt MCP server

SingIt runs a remote MCP server at `https://app.singitai.app/mcp` (Streamable HTTP, JSON responses
only). Tools: free price/model lookups and a short free-model answer (`chat_free`), plus paid web search, page reading and market data, billed per
call to your SingIt API key's own daily and per-request caps, in USDC on Base or Solana (market data tools:
Base accounts for now). Details: `sign402-gateway/README.md#mcp-server-remote-for-claude-code-cursor-codex`.

## 1. Get an API key

The free tools and the tool list work without a key; paid tools need one. Create one in the SingIt app at <https://app.singitai.app/app/> (API Keys). It looks like
`sk_singit_…`. Put it in an environment variable, e.g. `SINGIT_API_KEY`.

## 2. Add the server to your MCP client

Send the key as `Authorization: Bearer <key>` (or the `x-api-key` header, for clients that only support
plain API-key headers).

```json
{
  "mcpServers": {
    "singit": {
      "url": "https://app.singitai.app/mcp",
      "headers": { "Authorization": "Bearer ${env:SINGIT_API_KEY}" }
    }
  }
}
```

This repo's root `.mcp.json` has the same block for clients (like cursor.directory) that auto-detect it.

## 3. Verify

Call `initialize`, then `tools/list`; neither needs the key — both work keyless too, so catalogues and
people can see what the server offers before they make one. `tools/list` shows every tool; a call checks
the key's scopes (`get_price`, `list_price_symbols`, `list_models` and `chat_free` need none and work keyless; `chat` is paid within the key’s limits with no extra scope; `web_search`/
`read_page` need `search`; the rest need `tools` — all of those need a real key). A missing key behaves the
same as an empty or unexpanded `${env:SINGIT_API_KEY}` header (e.g. the client never substituted the
environment variable): both are treated as no key, not as a wrong one. A revoked or otherwise wrong key
gets `401`, never a silent empty tool list.

Keyless checks that should succeed without `SINGIT_API_KEY`:

- `get_price` with `{ "kind": "crypto", "symbol": "BTC" }` (`kind` is required: `crypto`, `metal` or `fx`)
- `list_models` with `{}`
- `chat_free` with `{ "prompt": "Reply with the single word: pong" }`

On 9 November 2026 (Europe/Prague) the live server reported version 0.1.5 and 19 tools. These three
calls returned a Bitcoin price, the model catalogue, and the text `pong`.

## Cline

Cline needs one extra field. When `type` is missing it assumes the legacy SSE transport, and
SingIt's endpoint is Streamable HTTP only (a `GET` returns 405 and
`This endpoint offers no SSE stream. Send POST.`), so the generic block above fails
to connect in Cline. Set `"type": "streamableHttp"`.

Open the MCP settings JSON (Cline panel → MCP Servers → Configure → Configure MCP Servers;
Cline CLI: `~/.cline/data/settings/cline_mcp_settings.json`) and add:

```json
{
  "mcpServers": {
    "singit": {
      "type": "streamableHttp",
      "url": "https://app.singitai.app/mcp",
      "headers": { "Authorization": "Bearer ${env:SINGIT_API_KEY}" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Cline expands `${env:SINGIT_API_KEY}` from the environment that launches it (supported since
Cline v3.43.0), so the key stays out of the file. If the variable is unset, an empty or
unexpanded `Bearer ${env:SINGIT_API_KEY}` header is treated as no key: `initialize`,
`tools/list` and the free tools in step 3 still work. Alternatively use the Remote Servers tab:
URL `https://app.singitai.app/mcp`, transport **Streamable HTTP**, and the optional `Authorization` header.
Then run step 3.

## Alternative: local server, no API key (pays from a wallet)

`@singitai/mcp` is a local stdio server that needs no Bearer key. On first use it creates a wallet on your
machine (`~/.singit/session`, mode 0600; the key never leaves it) and pays each `singit_chat` call in USDC on
Base over x402, within per-call and per-day limits. Tools: `singit_wallet`, `singit_models`, `singit_chat`.

**Not published to npm yet.** Until it is, run it from this repo: `cd mcp && npm install`, then use
`node /absolute/path/to/mcp/src/index.js` as the command. Once published, the one-liner is:

```sh
claude mcp add singit -s user -- npx -y @singitai/mcp
```

```json
{
  "mcpServers": {
    "singit": { "command": "npx", "args": ["-y", "@singitai/mcp"] }
  }
}
```

Fund the address `singit_wallet` reports with USDC on Base before the first paid call. Details, environment
variables and limits: `mcp/README.md`.
