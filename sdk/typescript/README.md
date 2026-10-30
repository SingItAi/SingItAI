# @singitai/sdk

Pay [SingIt Ask](../../singit-ask) over x402 from your own code or agent, with spend limits that are
checked **in your process before anything is signed**: a ceiling per call and a ceiling per day.
USDC on Base or Solana, no account and no API key.

```bash
npm install @singitai/sdk
```

Keys never go in code: pass your own `viem` account (`evmAccount`) or read a private key from the
environment, as below. The limits here are client-side. They protect the wallet you give this SDK
from a runaway loop or a merchant asking for more than you allowed; they are not an on-chain limit.
The SingIt AgentAllowance contract is a separate thing that covers only the SingIt app's own agent.

## Base

```js
import { SingIt } from "@singitai/sdk";

const singit = new SingIt({
  evmPrivateKey: process.env.AGENT_PRIVATE_KEY, // or evmAccount: a viem Account
  network: "base",
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
console.log(answer.choices[0].message.content, answer.payment);
```

## With LangChain, the Vercel AI SDK or the OpenAI SDK

`paidFetch()` returns a `fetch` that pays a 402 from SingIt Ask exactly like `chat()` (same pins,
same per-call and per-day ceilings, shared with `chat()` on the same instance). Requests to other
hosts pass through unpaid. Answers must be non-streaming, and the framework must not retry (a retry
would sign a second payment).

```js
import { ChatOpenAI } from "@langchain/openai";
const llm = new ChatOpenAI({ model: "deepseek-v4.1-flash", apiKey: "x402", maxRetries: 0,
  configuration: { baseURL: "https://ask.singitai.app/v1", fetch: singit.paidFetch() } });
```

```js
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const singitProvider = createOpenAICompatible({ name: "singit", apiKey: "x402",
  baseURL: "https://ask.singitai.app/v1", fetch: singit.paidFetch() });
```

(`singit` is the instance from the Base example above. Pass `maxRetries: 0` to AI SDK calls too.)

## Solana

```js
import { SingIt } from "@singitai/sdk";

const singit = new SingIt({
  solanaSigner, // a @solana/kit TransactionSigner
  network: "solana",
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
```

## Base Sepolia (testnet)

SingIt has no testnet deployment, so there is no pinned `payTo` to default to: pass one
explicitly (e.g. your own test merchant, or a facilitator's own test receiver).

```js
const singit = new SingIt({
  evmPrivateKey: process.env.AGENT_PRIVATE_KEY, network: "base-sepolia",
  payTo: process.env.TEST_MERCHANT_PAY_TO, // required: no SingIt deployment to pin a default against
  maxPerCallUsd: 0.01, maxPerDayUsd: 1,
});
```

## Guards

Every call pins the merchant's offer before signing anything, the same way
`singit-ask/src/metered-buyer.mjs` and `solana-buyer.mjs` do for the service's own buyers:

- **Network/asset/payTo.** The offer's `network`, `asset` and `payTo` must exactly match this
  `SingIt` instance's configured network (the built-in pin for `base`/`solana`, or the `payTo` you
  pass for `base-sepolia`). A merchant offering a different asset or recipient is refused before
  anything is signed.
- **Per-call ceiling (`maxPerCallUsd`).** The offer's atomic amount must be at or below
  `maxPerCallUsd` converted to micro-USDC. A costlier offer is refused.
- **Per-day ceiling (`maxPerDayUsd`).** An in-memory counter per client instance and per UTC day. Reserved at
  the offer's worst-case ceiling before signing. Only `upto` settles down to the actual billed amount,
  freeing unused headroom immediately; `exact` always counts the full offer amount. **Not durable**: it resets on restart and is not shared across processes — it is a
  client-side allowance guard, not a ledger. For the SingIt app agent’s separate on-chain limit, see
  `allowance()` below.
- **Settlement receipt.** The `payment-response` header's network and payer are checked against
  the request; a mismatch is treated as unresolved rather than returned as a success.

This SDK does **not** wait for on-chain confirmation of the settlement transaction (unlike
`metered-buyer.mjs`'s `validateTransfer`/`validateSolanaSettlement`); `payment.txHash` is returned
as reported by the merchant's `payment-response` header for the caller to check independently if
needed.

## API

- `new SingIt(options)` — `evmPrivateKey | evmAccount` (EVM, viem `Account`), `solanaSigner` (a
  `@solana/kit` `TransactionSigner`, for `network: "solana"`), `network`, `baseUrl` (default
  `https://ask.singitai.app`), `appBaseUrl` (default `https://app.singitai.app`), `payTo`,
  `rpcUrl`, `maxPerCallUsd`, `maxPerDayUsd` (both required).
- `chat({ model, messages, max_tokens, scheme, route })` — OpenAI-shaped chat completion.
  `scheme: "upto"` (default) pays only the actual answer cost, up to the offered ceiling;
  `"exact"` pays that ceiling flat. `route: "completions"` (default) calls
  `POST /v1/chat/completions`, live today. `route: "per-model"` calls `POST /v1/chat/{model}`
  (SI-62), live; `model` is then required.
- `walletReport(address, { days, apiKey })` — `GET {appBaseUrl}/v1/wallet/{address}/reconciliation`
  (SI-67). The report is private: `apiKey` must be a SingIt API key of the account that signs in
  with `address`; without one the server answers 401, and the SDK says so.
- `pricing()` — `GET {baseUrl}/pricing.json` (SI-68), live.
- `paidFetch({ scheme })` — a guarded `fetch` for frameworks, see above.
- `allowance(address, options)` — `(await walletReport(address, options)).allowance`: the
  on-chain spending limit set in the SingIt app, with what has been spent/remains today.

## What isn't supported yet

- The wallet report (SI-67) is private and needs a SingIt API key of the account that signs in
  with the wallet; without one the server answers 401 and the SDK says so.
- The daily counter is in memory, per `SingIt` instance and per UTC day. A new process or a new
  instance starts at zero, so build one instance per agent and keep it for the life of the process.
- `paidFetch()` reads the billed amount from the JSON answer: streaming answers are not supported.
- No on-chain confirmation of the settlement transaction (see "Guards" above).
- Solana signing is implemented (via `@x402/svm`'s client schemes) but is exercised in this SDK's
  own test suite only at the offer-selection/guard level, not with a real signer — that needs a
  funded `@solana/kit` signer and a live cluster RPC, out of scope for an offline test.
- `base-sepolia` is useful for integration-testing against a merchant you control; SingIt itself
  has no testnet deployment to pay.
