# SingIt + Vercel AI SDK example

Runnable recipe for the walkthrough in [`docs/integrations/vercel-ai-sdk.md`](../../../docs/integrations/vercel-ai-sdk.md).
Standalone package (own `package.json`/lockfile), not part of the main SingIt build.

```bash
npm ci
npm test       # offline, against local mocks
npm start      # free mode: live MCP tools + an unpaid 402 probe, no key/payment
node src/run.mjs paid "What is x402?"   # paid mode, see below
```

## Free mode (no key, no payment)

`npm start` (or `node src/run.mjs free`):

1. Loads SingIt's MCP tools with the AI SDK's MCP client (`@ai-sdk/mcp`'s `createMCPClient`,
   `src/free-mcp-tools.mjs`) and calls the free `get_price` tool.
2. Sends an unpaid request to `POST https://ask.singitai.app/v1/chat/completions` and prints the
   x402 402 challenge's offers (`src/free-chat-probe.mjs`) — network, asset, amount, payee — without
   paying.

## Paid mode (real x402 payment on Base)

Runs only with all of:

```bash
export SINGIT_ALLOW_PAID=1
export SINGIT_EVM_PRIVATE_KEY=0x...   # funded with USDC on Base
export SINGIT_MAX_PER_CALL_USD=0.01
export SINGIT_MAX_PER_DAY_USD=1
node src/run.mjs paid "What is x402?"
```

`src/paid-chat.mjs` builds an AI SDK `@ai-sdk/openai-compatible` provider pointed at
`https://ask.singitai.app/v1` with its `fetch` replaced by `src/x402/pay.js`'s
`createSingitPaidFetch` — a vendored, trimmed copy of `sdk/typescript`'s guards (see
[`sdk/typescript`](../../../sdk/typescript) for the full SDK), then calls `generateText()`. Before
signing anything it checks the merchant's offer is on Base, pays the pinned SingIt Ask address in
the pinned USDC contract, and is within both the per-call and per-day ceilings.

## Tests

Fully offline, against `test/helpers/mock-mcp-server.mjs` (JSON-RPC stand-in for the MCP server) and
`test/helpers/mock-merchant.mjs` (a real x402 402 challenge + EIP-712 signature verification, no
facilitator or chain).
