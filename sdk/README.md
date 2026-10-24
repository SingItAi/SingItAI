# SingIt SDKs

Client libraries for [SingIt Ask](../singit-ask): pay per call with x402 and keep spending inside
a client-side allowance, in a few lines.

**Not published yet.** `@singit/sdk` is `"private": true` and `singit` has no PyPI upload
configuration (both version 0.1.0). Publishing to npm/PyPI needs a separate OK from the owner.

| | TypeScript | Python |
|---|---|---|
| Package | [`@singit/sdk`](typescript) (ESM, Node ≥20) | [`singit`](python) (Python ≥3.10) |
| Base / Base Sepolia | `upto` (default) and `exact` | `exact` only |
| Solana | `exact` (via `@x402/svm`) | `exact`, optional extra `singit[svm]` |

Python is `exact`-only because the official `x402` Python package has no `upto` client scheme yet.

## Quick start

TypeScript, Base:

```js
import { SingIt } from "@singit/sdk";

const singit = new SingIt({ evmPrivateKey: process.env.AGENT_PRIVATE_KEY, network: "base", maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
console.log(answer.choices[0].message.content, answer.payment);
```

Python, Base:

```python
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
- A local daily counter must stay ≤ `maxPerDayUsd`. It is in memory, per client instance, and
  resets when the process restarts. It is an allowance-style guard, not a ledger. The on-chain
  limit set in the SingIt app is what `allowance(address)` reports.

## Not deployed yet

These endpoints belong to pending work. The SDKs call them as documented and surface a clear
error on 404 instead of inventing a response.

- Per-model route `POST /v1/chat/{model}` (SI-62), enabled with `route: "per-model"`. The default
  `POST /v1/chat/completions` works today.
- Wallet reconciliation `GET https://app.singitai.app/v1/wallet/{address}/reconciliation` (SI-67),
  behind `walletReport()` and `allowance()`.
- `GET /pricing.json` (SI-68), behind `pricing()`.

## Tests

All offline against local mock merchants on `base-sepolia`. Nothing touches a real chain or
`ask.singitai.app` / `app.singitai.app`.

```bash
cd sdk/typescript && npm ci --ignore-scripts && npm test
cd sdk/python && pip install -e ".[test]" && python -m pytest -q
```

CI runs both in `.github/workflows/security-gate.yml`.
