# LangChain.js recipe

Runnable example: [`integrations/examples/langchain`](../../integrations/examples/langchain). This
page is the walkthrough; the example's own
[README](../../integrations/examples/langchain/README.md) has the exact commands.

## Install

```bash
npm install @langchain/mcp-adapters @langchain/core @langchain/openai
```

(`@langchain/mcp-adapters` requires `@langchain/core ^1.2.6`; `createAgent`, used in LangChain's
own MCP quickstart, additionally needs `@langchain/langgraph` — not required for the tool-loading
and chat-model use in this recipe.)

## Load SingIt's MCP tools

```ts
import { MCPAdapter } from "@langchain/mcp-adapters";

const adapter = new MCPAdapter({
  servers: { singit: { url: "https://app.singitai.app/mcp" } }, // add headers: { Authorization: `Bearer ${key}` } for paid tools
});

try {
  const tools = await adapter.listTools(); // names are prefixed, e.g. "singit_get_price"
  const priceTool = tools.find(t => t.name.endsWith("get_price"));
  console.log(await priceTool.invoke({ kind: "crypto", symbol: "BTC" }));
} finally {
  await adapter.close();
}
```

Pass these tools straight to `createAgent({ model, tools })` (from the `langchain` package) if you
want an agent loop instead of calling a tool directly — see
[LangChain's MCP quickstart](https://docs.langchain.com/oss/javascript/langchain/mcp) for that
pattern; it's unchanged by SingIt.

## x402-paid chat on SingIt Ask (Base)

SingIt Ask's `/v1/chat/completions` is OpenAI-shaped but paid per call over x402 instead of an API
key, so point `ChatOpenAI` at it with a `fetch` that pays the 402 challenge:

```ts
import { ChatOpenAI } from "@langchain/openai";
import { createSingitPaidFetch } from "./x402/pay.js"; // see integrations/examples/langchain/src/x402/pay.js

const fetchImpl = createSingitPaidFetch({
  evmPrivateKey: process.env.SINGIT_EVM_PRIVATE_KEY, // funded with USDC on Base
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const chat = new ChatOpenAI({
  model: "deepseek-v4.1-flash",
  apiKey: "unused-singit-pays-over-x402",
  maxRetries: 0, // never auto-retry: a retry would sign a second payment
  configuration: { baseURL: "https://ask.singitai.app/v1", fetch: fetchImpl },
});

console.log((await chat.invoke("What is x402?")).content);
```

`createSingitPaidFetch` is a small, vendored copy of `sdk/typescript`'s guards (network/asset/payee
pinning, a per-call ceiling, an in-memory per-day ceiling), reshaped as a fetch wrapper so it drops
into `configuration.fetch`. It only pays the origin it is pinned to (`ask.singitai.app` by default);
requests elsewhere pass through unpaid. See [`sdk/typescript`](../../sdk/typescript) for the full
SDK (Solana, the per-model route, wallet reconciliation).

## Try it free, no key or payment

```bash
cd integrations/examples/langchain
npm ci
npm start   # lists MCP tools, calls get_price, and prints the live 402 challenge unpaid
```

Paid mode (real payment on Base) needs `SINGIT_ALLOW_PAID=1`, `SINGIT_EVM_PRIVATE_KEY`,
`SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD` — see the example's README.
