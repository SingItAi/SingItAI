# Vercel AI SDK recipe

Runnable example: [`integrations/examples/vercel-ai-sdk`](../../integrations/examples/vercel-ai-sdk).
This page is the walkthrough; the example's own
[README](../../integrations/examples/vercel-ai-sdk/README.md) has the exact commands.

## Install

```bash
npm install ai @ai-sdk/mcp @ai-sdk/openai-compatible
```

## Load SingIt's MCP tools

```ts
import { createMCPClient } from "@ai-sdk/mcp"; // also exported as experimental_createMCPClient from "ai"

const client = await createMCPClient({
  transport: { type: "http", url: "https://app.singitai.app/mcp" }, // add headers: { Authorization: `Bearer ${key}` } for paid tools
});

try {
  const tools = await client.tools(); // { get_price, list_price_symbols, list_models, ... }
  console.log(await tools.get_price.execute({ kind: "crypto", symbol: "BTC" }));
} finally {
  await client.close();
}
```

Pass `tools` straight to `generateText({ model, tools, prompt })` if you want the model to call
them itself instead of invoking a tool directly.

## x402-paid chat on SingIt Ask (Base)

SingIt Ask's `/v1/chat/completions` is OpenAI-shaped but paid per call over x402 instead of an API
key, so point `createOpenAICompatible` at it with a `fetch` that pays the 402 challenge:

```ts
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createSingitPaidFetch } from "./x402/pay.js"; // see integrations/examples/vercel-ai-sdk/src/x402/pay.js

const fetchImpl = createSingitPaidFetch({
  evmPrivateKey: process.env.SINGIT_EVM_PRIVATE_KEY, // funded with USDC on Base
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const singitAsk = createOpenAICompatible({
  name: "singit-ask",
  baseURL: "https://ask.singitai.app/v1",
  apiKey: "unused-singit-pays-over-x402",
  fetch: fetchImpl,
});

const result = await generateText({ model: singitAsk.chatModel("deepseek-v4.1-flash"), prompt: "What is x402?" });
console.log(result.text);
```

`createSingitPaidFetch` is a small, vendored copy of `sdk/typescript`'s guards (network/asset/payee
pinning, a per-call ceiling, an in-memory per-day ceiling), reshaped as a fetch wrapper so it drops
into the provider's `fetch` option. It only pays the origin it is pinned to (`ask.singitai.app` by
default); requests elsewhere pass through unpaid. See [`sdk/typescript`](../../sdk/typescript) for
the full SDK (Solana, the per-model route, wallet reconciliation).

## Try it free, no key or payment

```bash
cd integrations/examples/vercel-ai-sdk
npm ci
npm start   # lists MCP tools, calls get_price, and prints the live 402 challenge unpaid
```

Paid mode (real payment on Base) needs `SINGIT_ALLOW_PAID=1`, `SINGIT_EVM_PRIVATE_KEY`,
`SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD` — see the example's README.
