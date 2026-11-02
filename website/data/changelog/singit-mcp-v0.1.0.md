# singit-mcp v0.1.0

First tagged release of the SingIt MCP documentation and manifest repository.

SingIt runs a **remote** MCP server at `https://app.singitai.app/mcp` (Streamable HTTP, JSON responses only). There is nothing to install and no local process. This repository is where you find out how to connect and what the server offers; the server code lives in [SingItAi/SingItAI](https://github.com/SingItAi/SingItAI) (`sign402-gateway`).

## What is in this release

- **MCP Registry manifest** (`server.json`) for `app.singitai/singit`, pointing at this repository. The description mentions the owner-set daily limits.
- **Client setup** for Claude Code, Codex, Cursor and other clients with a `url` and `headers` config, plus a Windsurf note (`README.md`, `docs/clients.md`, `.mcp.json`) and an install guide written for LLM clients (`llms-install.md`).
- **16 tools**, with the full reference on the website: https://singitai.app/docs/mcp-tools/ . `docs/tools.md` is the offline copy, generated from a `tools.json` snapshot of the live `tools/list`.
  - Free lookups, no key: `get_price`, `list_price_symbols`, `list_models`.
  - Your account, free and read-only, needs a key: `get_balance`, `get_limits`, `get_receipts`.
  - Web, paid per call, `search` scope, USDC on Base or Solana: `web_search`, `read_page`.
  - Market and data, paid per call, `tools` scope, Base accounts for now: `get_weather`, `get_singit_risk_check`, `get_x_profile`, `get_crypto_news`, `get_hyperliquid_market`, `get_funding_rates`, `resolve_ens`, `get_token_price`.
- **An MCP key with limits your owner sets**: a daily limit, a per-request limit and an expiry, signed by the owner's wallet. Suggested terms: $1 a day, $0.05 a request, 7 days.
- **A free live check** (`npm run check:live`, Node 20+, no dependencies) that compares the live server with the snapshot, and an offline test suite run in CI on Node 20 and 22.

## What the limits do and do not do

The key's daily and per-request caps are enforced by SingIt's server for calls made with that key to SingIt's MCP and the same key's /v1 endpoint. They do not limit what an agent spends anywhere else. SingIt's contracts do not protect other people's agents' own wallets.

## Notes

- The free tools and `tools/list` work without a key, so you can add the server and look around first.
- A wrong or revoked key returns HTTP 401. A missing or empty key is treated as keyless: free tools only. MCP allows 60 requests a minute per key.
- This repository has no package to publish. The server version is the one the live server reports (`serverInfo.version`); `server.json` is 0.1.4.
- Configuration examples are not run live. Security problems: contact@singitai.app.
