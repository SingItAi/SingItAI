# @singitai/plugin-singit

An [ElizaOS](https://github.com/elizaOS/eliza) plugin that gives an agent [SingIt](https://singitai.app/developers/)'s tools:

- free crypto, metal and FX prices and model listing through SingIt's MCP server (no key),
- paid web search and page reading with a SingIt API key,
- optional x402-paid chat on SingIt Ask, paid in USDC on **Base**, from an EVM key you provide.

Requires Node >= 20 and `@elizaos/core` `^1.7.0` (tested with 1.7.2; the 2.x prereleases are not targeted).

## Install

```bash
npm install @singitai/plugin-singit @elizaos/core
```

That is all you need for the free and API-key actions.

### Extra step for paid chat (`SINGIT_PAID_CHAT`)

x402 payment signing uses the official `@x402/evm` package, which this plugin declares as an **optional peer dependency**. It is not installed with the plugin. Reason: every published `@x402/evm` / `@x402/core` release (latest 2.28.0) depends on `zod ^3.24.2`, which `npm audit` flags as high severity (GHSA-mrhx-c7xc-m3w5, fixed in zod 4.6.6). Making it optional keeps that advisory out of the dependency tree of everyone who does not use paid chat.

To enable paid chat, install it and force zod to a fixed version in **your** `package.json` (the `overrides` field of a dependency is ignored by npm, so this has to live in your project):

```json
{
  "dependencies": {
    "@singitai/plugin-singit": "^0.1.2",
    "@x402/evm": "^2.28.0"
  },
  "overrides": {
    "zod": "^4.6.7"
  }
}
```

The plugin's own test suite runs the real `@x402/evm` signing path against zod 4.6.7. Without `@x402/evm`, `SINGIT_PAID_CHAT` is not offered, the `SINGIT_TOOLS` provider says why, and invoking the handler directly returns an "install @x402/evm" message without sending any request or signing anything.

### Known advisories not from this plugin

`npm audit` on a project with `@elizaos/core@1.7.2` still reports advisories that come from `@elizaos/core` itself and that this plugin cannot fix: `pdfjs-dist` (high, GHSA-hq66-cqwq-w95j) and `crypto-browserify` → `elliptic` (low, GHSA-848j-6mx2-7j84). Checked on 2026-10-27 in a fresh project with `npm install @singitai/plugin-singit @elizaos/core@1.7.2`: 7 advisories (6 low, 1 high), all from `@elizaos/core`; none from this plugin's own dependencies (`viem`).

## Configuration

Settings are read with `runtime.getSetting()` and fall back to `process.env`. Put secrets in `character.settings.secrets` or the environment, never in the character file itself.

| Name | Used by | Notes |
| --- | --- | --- |
| `SINGIT_API_KEY` | `SINGIT_WEB_SEARCH`, `SINGIT_READ_PAGE` | Secret. Needs the `search` scope. |
| `SINGIT_EVM_PRIVATE_KEY` | `SINGIT_PAID_CHAT` | Secret. `0x`-prefixed EVM key holding USDC on Base. |
| `SINGIT_MAX_PER_CALL_USD` | `SINGIT_PAID_CHAT` | Required. Per-call ceiling in USD. |
| `SINGIT_MAX_PER_DAY_USD` | `SINGIT_PAID_CHAT` | Required. Rolling UTC-day ceiling in USD. |
| `SINGIT_MCP_URL` | MCP actions | Optional. Default `https://app.singitai.app/mcp`. |
| `SINGIT_ASK_BASE_URL` | `SINGIT_PAID_CHAT` | Optional. Default `https://ask.singitai.app`. |

```ts
export const character = {
  name: "MyAgent",
  plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap", "@singitai/plugin-singit"],
  settings: {
    secrets: {
      SINGIT_API_KEY: process.env.SINGIT_API_KEY,
      SINGIT_EVM_PRIVATE_KEY: process.env.SINGIT_EVM_PRIVATE_KEY,
    },
    SINGIT_MAX_PER_CALL_USD: "0.01",
    SINGIT_MAX_PER_DAY_USD: "1",
  },
};
```

Or pass the plugin object directly: `new AgentRuntime({ character, plugins: [singitPlugin] })` with `import { singitPlugin } from "@singitai/plugin-singit"`.

## Actions and provider

| Name | Needs | What it does |
| --- | --- | --- |
| `SINGIT_GET_PRICE` | nothing | MCP `get_price`: crypto, metal or FX price. Symbol is extracted from the message by regex, not an LLM. |
| `SINGIT_LIST_PRICE_SYMBOLS` | nothing | MCP `list_price_symbols`: every symbol `get_price` supports. |
| `SINGIT_LIST_MODELS` | nothing | MCP `list_models`: available models and prices. |
| `SINGIT_WEB_SEARCH` | `SINGIT_API_KEY` | MCP `web_search`. Billed per call against that key's own SingIt limits. |
| `SINGIT_READ_PAGE` | `SINGIT_API_KEY` | MCP `read_page` for one URL in the message. Same billing. |
| `SINGIT_PAID_CHAT` | `@x402/evm`, `SINGIT_EVM_PRIVATE_KEY`, both caps | One chat completion on SingIt Ask, paid over x402 on Base. |
| provider `SINGIT_TOOLS` | nothing | Tells the model which of the above are currently available. |

`validate()` returns `false` for the API-key actions without a key, and for `SINGIT_PAID_CHAT` unless the key, both caps and `@x402/evm` are all present, so unconfigured actions are simply not offered.

## x402 payment example

Character settings as above (`SINGIT_MAX_PER_CALL_USD: "0.01"`, `SINGIT_MAX_PER_DAY_USD: "1"`). A user says "ask singit ask: what is x402?". One paid call is:

1. `POST /v1/chat/completions` to SingIt Ask with no payment, which answers **402** with a `PAYMENT-REQUIRED` challenge.
2. The plugin checks the offer (see Safety) and reserves its ceiling against the daily cap. Only if every check passes does it sign (via `@x402/evm`) and retry once with a `PAYMENT-SIGNATURE` header.
3. Ask answers **200** with the completion and the billed amount. The call is settled for the amount actually billed, and the action returns `data: { answer, payment }`.

```js
payment = {
  scheme: "upto",          // or "exact"
  network: "base",
  amountAtomic: "4500",    // USDC, 6 decimals: 4500 = $0.0045
  txHash: "0x…"            // from the settlement receipt, when present
}
```

The paid request is never retried automatically; if it fails after signing, its ceiling stays counted against the daily cap.

## Safety

**What this plugin enforces, and where.**

- Spending caps are enforced **in-process by this plugin** ([`src/x402/guards.js`](src/x402/guards.js)): one cap per call and one per rolling UTC day. The daily total is held **in memory** and resets when the process restarts. The caps are **not on-chain** and **not enforced by SingIt's servers**.
- The plugin signs from the **raw EVM private key** you give it. Anything that can read that key, or that can run code in the agent process, can spend whatever the key holds. **Fund that key with only what you can afford to lose.**
- Before signing, the plugin pins the offer: network must be Base (`eip155:8453`), asset must be Base USDC, payee must be SingIt Ask's address, and the amount must be within the per-call ceiling and the remaining daily cap. Any mismatch is refused before anything is signed.
- Payment signing is delegated to the official `@x402/evm`; this plugin does not implement its own signing.
- Settings are never logged or put in thrown error messages: [`src/settings.js`](src/settings.js) only returns values, `src/` contains no logging calls, and the tests assert the API key does not appear in error text.

**Context about SingIt in general (not what this plugin does).** This plugin pays on Base only and does **not** use the `AgentAllowance` contract and has no Solana support. In the SingIt app, on Base, spending limits are enforced on-chain by the `AgentAllowance` contract only if you deploy your own limiter there. On Solana, limits are enforced by the SingIt gateway, not on-chain. Pausing: on Base the guardian `pause()` is permanent (a paused limiter cannot be unpaused; you need a new limiter); on Solana a pause is lifted only by a new owner-signed approve (new limits alone do not lift it).

## Tests

```bash
npm ci --ignore-scripts
npm test
```

Fully offline: a local mock MCP server and a local mock x402 merchant that issues a real x402 v2 challenge and verifies the signed EIP-712 payload with viem (no facilitator, no chain). Covers the free actions, API-key gating, the x402 guards (network, asset, payee and cap violations refused), and the optional-peer behavior: with `@x402/evm` absent, in a real tree that has none, paid chat is not offered and fails closed with zero requests and no signing.

## Changelog

- **0.1.2**: repository moved to SingItAi; package metadata and links updated. No code changes.
- **0.1.1**: `@x402/evm` is now an optional peer dependency, so installing the plugin no longer pulls in the zod < 4.6.6 advisory (GHSA-mrhx-c7xc-m3w5); paid chat fails closed with an install message when it is missing. README rewritten.
- **0.1.0**: initial release: free MCP actions, API-key actions, x402 paid chat on Base.

## License

MIT
