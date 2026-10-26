# Framework integrations

SingIt's tools (free prices/model listing, paid web search/page reading via MCP, and x402-paid
chat on [SingIt Ask](../../singit-ask)) from three agent frameworks:

| Framework | Recipe | Runnable example |
| --- | --- | --- |
| [ElizaOS](elizaos.md) | A plugin (`@singitai/plugin-singit`) an agent character loads directly | [`integrations/elizaos-plugin`](../../integrations/elizaos-plugin) |
| [LangChain.js](langchain.md) | MCP tools via `@langchain/mcp-adapters` + x402-paid `ChatOpenAI` | [`integrations/examples/langchain`](../../integrations/examples/langchain) |
| [Vercel AI SDK](vercel-ai-sdk.md) | MCP tools via `@ai-sdk/mcp` + x402-paid `@ai-sdk/openai-compatible` | [`integrations/examples/vercel-ai-sdk`](../../integrations/examples/vercel-ai-sdk) |

All three talk to the same two live endpoints:

- **`https://app.singitai.app/mcp`** — SingIt's remote MCP server (Streamable HTTP, JSON responses
  only). `get_price`, `list_price_symbols` and `list_models` are free, no key needed. `web_search`
  and `read_page` are paid per call from a SingIt API key's own limits. See
  [`sign402-gateway/README.md#mcp-server-remote-for-claude-code-cursor-codex`](../../sign402-gateway/README.md).
- **`https://ask.singitai.app`** — [SingIt Ask](../../singit-ask)'s OpenAI-shaped chat endpoint,
  paid per answer over the [x402](https://www.x402.org/) protocol. Every recipe's x402 payment code
  is a small, vendored, Base-only copy of the guards in [`sdk/typescript`](../../sdk/typescript)
  (network/asset/payee pinning, a per-call ceiling and an in-memory per-day ceiling) — not a
  dependency on that unpublished package, so each recipe installs standalone. For Solana or the
  full feature set (wallet reconciliation, the per-model route), use `sdk/typescript` directly.

## Try it with no key and no payment

Every example (not the ElizaOS plugin, which needs a host agent) has a free mode:

```bash
cd integrations/examples/langchain    && npm ci && npm start
cd integrations/examples/vercel-ai-sdk && npm ci && npm start
```

Each lists SingIt's MCP tools, calls the free `get_price` tool, and prints the live x402 402
challenge from SingIt Ask's chat route — without spending anything.

## Status

- **ElizaOS plugin**: not on npm yet (ready as `@singitai/plugin-singit`); [the community plugin registry is
  retired](https://plugins.eliza.app/index.json), so install it from a local path or Git checkout
  until the project owner decides to publish — see [elizaos.md](elizaos.md).
- **LangChain and Vercel AI SDK examples**: runnable recipes, not published packages. Both ship
  free MCP tools, an unpaid 402 probe, and Base-only x402-paid chat behind an explicit
  `SINGIT_ALLOW_PAID=1` flag plus wallet key and spending caps.
