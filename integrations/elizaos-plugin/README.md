# @singit/plugin-singit

An [ElizaOS](https://github.com/elizaOS/eliza) plugin that gives an agent [SingIt](../../README.md)'s
tools: free crypto/metal/FX prices and model listing through SingIt's MCP server, optional paid web
search and page reading with a SingIt API key, and optional x402-paid chat on
[SingIt Ask](../../singit-ask) (Base) when the agent has a funded wallet key and explicit spending
caps.

**Not published.** This package is `"private": true`, version `0.1.0`. The
[elizaOS community plugin registry is retired](https://plugins.eliza.app/index.json) (`410
registry_retired`) and no longer accepts third-party registry submissions, so until this is
published to npm, install it from a local path or a Git checkout:

```bash
git clone https://github.com/bubon-ik/SingItAI.git
npm install ./SingItAI/integrations/elizaos-plugin
```

Once the project owner publishes it, this becomes:

```bash
npm install @singit/plugin-singit
```

## Add it to an agent

```ts
export const character = {
  name: "MyAgent",
  // character.plugins takes package names (strings); the package must be installed in the project.
  plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap", "@singit/plugin-singit"],
  settings: {
    secrets: {
      // Optional: paid MCP tools (web_search, read_page).
      SINGIT_API_KEY: process.env.SINGIT_API_KEY,
      // Optional: x402-paid chat on SingIt Ask (Base). All three are required together.
      SINGIT_EVM_PRIVATE_KEY: process.env.SINGIT_EVM_PRIVATE_KEY,
    },
    SINGIT_MAX_PER_CALL_USD: "0.01",
    SINGIT_MAX_PER_DAY_USD: "1",
  },
};
```

Or pass the plugin object to the runtime directly (the runtime's `plugins` option takes `Plugin[]`):

```ts
import { AgentRuntime } from "@elizaos/core";
import { singitPlugin } from "@singit/plugin-singit";

const runtime = new AgentRuntime({ character, plugins: [singitPlugin] });
```

Settings are read through `runtime.getSetting()` with a `process.env` fallback
([`src/settings.js`](src/settings.js)); none of them are ever logged or included in a thrown error
message.

## What's included

### Free actions — SingIt's MCP server, no key needed

Talk to `https://app.singitai.app/mcp` directly over JSON-RPC
([`src/mcp-client.js`](src/mcp-client.js); see
[`sign402-gateway/README.md#mcp-server-remote-for-claude-code-cursor-codex`](../../sign402-gateway/README.md)
for the full server). The server is stateless Streamable HTTP (JSON responses only, no session), so
every call is a single POST — no `initialize` handshake is needed first.

| Action | MCP tool | Does |
| --- | --- | --- |
| `SINGIT_GET_PRICE` | `get_price` | A crypto, metal or FX price. Symbol/kind is extracted from the message with a small regex ([`src/price-args.js`](src/price-args.js)), not an LLM call. |
| `SINGIT_LIST_PRICE_SYMBOLS` | `list_price_symbols` | Every symbol `get_price` supports. |
| `SINGIT_LIST_MODELS` | `list_models` | SingIt's available chat/image/audio models and prices. |

### Paid actions — need `SINGIT_API_KEY`

Call the same MCP server with `Authorization: Bearer $SINGIT_API_KEY`, billed per call from that
key's own SingIt limits (needs the key's `search` scope). `validate()` returns `false` without a
key, so these actions are simply absent from an unconfigured agent rather than failing loudly:

| Action | MCP tool | Does |
| --- | --- | --- |
| `SINGIT_WEB_SEARCH` | `web_search` | Searches the web (Exa). |
| `SINGIT_READ_PAGE` | `read_page` | Reads one web page's text (Exa). |

### Optional x402-paid chat — needs a wallet key and explicit caps

`SINGIT_PAID_CHAT` pays [SingIt Ask](../../singit-ask) over x402 on **Base** for one OpenAI-shaped
chat completion (`POST https://ask.singitai.app/v1/chat/completions`), the same protocol
[`sdk/typescript`](../../sdk/typescript) speaks. It needs all three settings — `validate()` returns
`false` if any is missing, so an agent never pays without an explicitly funded, explicitly capped
wallet:

- `SINGIT_EVM_PRIVATE_KEY` — a `0x`-prefixed EVM private key funded with USDC on Base.
- `SINGIT_MAX_PER_CALL_USD` — hard ceiling per call, in whole USD (e.g. `"0.01"`).
- `SINGIT_MAX_PER_DAY_USD` — hard ceiling per rolling UTC day across all calls, in whole USD,
  tracked in memory per process (not durable — see [`src/x402/guards.js`](src/x402/guards.js)).

Before signing anything, [`src/x402/guards.js`](src/x402/guards.js) and
[`src/x402/pay.js`](src/x402/pay.js) — trimmed from `sdk/typescript/src/{guards,pins,signers,singit}.js`
— check that the merchant's offer is on Base, pays the pinned SingIt Ask address in the pinned USDC
contract, and is within both ceilings. A merchant asking for a different network, asset, payee or a
higher amount is refused before anything is signed. This plugin does **not** depend on the
unpublished `@singit/sdk` package by path (so it installs standalone); it vendors the minimal guard
logic instead. For the full SDK — Solana, the per-model route, wallet reconciliation — see
[`sdk/typescript`](../../sdk/typescript).

### Provider

`SINGIT_TOOLS` tells the agent which of the actions above are currently available, based on which
settings are configured, so the model does not attempt `SINGIT_WEB_SEARCH` or `SINGIT_PAID_CHAT`
when they are not set up.

## Settings reference

| Setting | Required for | Notes |
| --- | --- | --- |
| `SINGIT_MCP_URL` | all MCP actions | Default `https://app.singitai.app/mcp`. Override to test against a local gateway. |
| `SINGIT_API_KEY` | `SINGIT_WEB_SEARCH`, `SINGIT_READ_PAGE` | `sk_singit_...`, from the SingIt app's API Keys page. Needs the `search` scope. |
| `SINGIT_EVM_PRIVATE_KEY` | `SINGIT_PAID_CHAT` | `0x`-prefixed EVM private key, funded with USDC on Base. |
| `SINGIT_MAX_PER_CALL_USD` | `SINGIT_PAID_CHAT` | Required together with the key and the per-day cap. |
| `SINGIT_MAX_PER_DAY_USD` | `SINGIT_PAID_CHAT` | In-memory per process; resets on restart. |
| `SINGIT_ASK_BASE_URL` | `SINGIT_PAID_CHAT` | Default `https://ask.singitai.app`. Override to test against a local mock merchant. |

## Tests

Fully offline: a local mock MCP server (`test/helpers/mock-mcp-server.mjs`, implementing
`initialize`/`tools/list`/`tools/call`) and a local mock x402 merchant
(`test/helpers/mock-merchant.mjs`, issuing a real x402 v2 402 challenge and verifying the signed
EIP-712 payload with viem — no facilitator, no chain, no network access). Covers the free actions,
API-key gating (absent/refused without a key, `Authorization` header sent with one, the key never
appearing in logs or thrown errors), and the x402 guards (network/asset/payTo mismatch refused, a
per-call or per-day cap exceeded refused).

```bash
npm ci --ignore-scripts
npm test
```

## Status

Ships the free MCP actions, the API-key-gated paid MCP actions, and x402-paid chat on Base, as
scoped by [SI-50](../../docs). Solana x402 chat is not included here (see `sdk/typescript` for that
path); it would need a `@solana/kit` signer setting analogous to `SINGIT_EVM_PRIVATE_KEY`.
