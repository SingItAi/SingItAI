# @singit/sdk

x402 payment and client-side spending allowance for [SingIt Ask](../../singit-ask), in a few
lines. **Not published yet** — this package is `"private": true` with no registry config; it is
built and tested locally only. Publishing needs a separate decision from the project owner.

## Install (once published)

```bash
npm install @singit/sdk
```

## Base

```js
import { SingIt } from "@singit/sdk";

const singit = new SingIt({
  evmPrivateKey: process.env.AGENT_PRIVATE_KEY, // or evmAccount: a viem Account
  network: "base",
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
console.log(answer.choices[0].message.content, answer.payment);
```

## Solana

```js
import { SingIt } from "@singit/sdk";

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
  evmPrivateKey, network: "base-sepolia",
  payTo: "0x...", // required: no SingIt deployment to pin a default against
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
- **Per-day ceiling (`maxPerDayUsd`).** An in-memory, per-process, per-UTC-day counter. Reserved at
  the offer's worst-case ceiling before signing, settled down to the actual billed amount
  afterwards (so an `upto` call that comes in under its ceiling frees the unused headroom
  immediately). **Not durable**: it resets on restart and is not shared across processes — it is a
  client-side allowance guard, not a ledger. For the actual on-chain spending limit, see
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
  (SI-62) — **may not be deployed yet**; `model` is then required.
- `walletReport(address, { days, apiKey })` — `GET {appBaseUrl}/v1/wallet/{address}/reconciliation`
  (SI-67). The report is private: `apiKey` must be a SingIt API key of the account that signs in
  with `address`; without one the server answers 401, and the SDK says so.
- `pricing()` — `GET {baseUrl}/pricing.json` (SI-68). **May not be deployed yet**, same caveat.
- `allowance(address, options)` — `(await walletReport(address, options)).allowance`: the
  on-chain spending limit set in the SingIt app, with what has been spent/remains today.

## What isn't supported yet

- The per-model route (SI-62), wallet reconciliation (SI-67) and `pricing.json` (SI-68) are not
  present anywhere in this repository yet; calling them against the live `ask.singitai.app` /
  `app.singitai.app` hosts will 404 until those PRs ship. The SDK surfaces that clearly rather than
  guessing at a response shape.
- No on-chain confirmation of the settlement transaction (see "Guards" above).
- Solana signing is implemented (via `@x402/svm`'s client schemes) but is exercised in this SDK's
  own test suite only at the offer-selection/guard level, not with a real signer — that needs a
  funded `@solana/kit` signer and a live cluster RPC, out of scope for an offline test.
- `base-sepolia` is useful for integration-testing against a merchant you control; SingIt itself
  has no testnet deployment to pay.
