# SingIt SDKs

Client libraries for [SingIt Ask](../singit-ask): pay per call with x402 and keep spending inside
a client-side allowance, in a few lines.

Packages are released by the maintainer, with the owner’s approval.

Install: `npm install @singitai/sdk` or `pip install singit`.

| | TypeScript | Python |
|---|---|---|
| Package | [`@singitai/sdk`](typescript) (ESM, Node ≥20) | [`singit`](python) (Python ≥3.10) |
| Base / Base Sepolia | `upto` (default) and `exact` | `upto` (default) and `exact` |
| Solana | `exact` (via `@x402/svm`) | `exact`, optional extra `singit[svm]` |

Both use the official x402 client packages (`@x402/*` 2.28.0, `x402` 2.25.0 on PyPI) for signing.

## Quick start

TypeScript, Base:

```js
import { SingIt } from "@singitai/sdk";

const singit = new SingIt({ evmPrivateKey: process.env.AGENT_PRIVATE_KEY, network: "base", maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
console.log(answer.choices[0].message.content, answer.payment);
```

Python, Base:

```python
import os
from singit import SingIt

singit = SingIt(evm_private_key=os.environ["AGENT_PRIVATE_KEY"], network="base", max_per_call_usd=0.01, max_per_day_usd=1)
answer = singit.chat(messages=[{"role": "user", "content": "Hello"}])
print(answer["choices"][0]["message"]["content"], answer["payment"])
```

Solana: see the package READMEs (`solanaSigner` / `solana_signer`, `network: "solana"`).

## Guards (before anything is signed)

- The offer's network, asset (USDC for that network) and `payTo` must match values the SDK pins
  per network, taken from `singit-ask/src/pricing.mjs`. On `base-sepolia` SingIt has no
  deployment, so you must pass `payTo` yourself.
- The offer's amount must be ≤ `maxPerCallUsd`.
- A local daily counter must stay ≤ `maxPerDayUsd`. It is in memory, per client instance and per UTC day, and
  resets when the process restarts. It is an allowance-style guard, not a ledger. The separate AgentAllowance contract covers only the SingIt app’s own agent, not other agents.

## Live endpoints

- Chat: `POST /v1/chat/completions` and `POST /v1/chat/{model}` (select `route: "per-model"`,
  or Python `route="per-model"`).
- Pricing: `GET /pricing.json`, exposed by `pricing()`.
- Wallet report (SI-67): private; `walletReport()` / `wallet_report()` and `allowance()`
  require a SingIt API key for the wallet's account. Without one the server returns HTTP 401.

## Tests

All offline against local mock merchants on `base-sepolia`. Nothing touches a real chain or
`ask.singitai.app` / `app.singitai.app`.

```bash
cd sdk/typescript && npm ci --ignore-scripts && npm test
cd sdk/python && pip install -e ".[test]" && python -m pytest -q
```

CI runs both in `.github/workflows/security-gate.yml`.
