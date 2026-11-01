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

### No wallet yet? Quickstart in 8 lines

Run once in a new directory. The command refuses to replace an existing key.

```sh
npm install @singitai/sdk
npx @singitai/sdk wallet new --out "$HOME/.singit/wallets/quickstart.key" # or: pip install "singit[qr]" && singit wallet new --out "$HOME/.singit/wallets/quickstart.key"
# Fund the printed address / scan the QR with USDC on Base before continuing.
export AGENT_PRIVATE_KEY="$(cat "$HOME/.singit/wallets/quickstart.key")"
node --input-type=module -e '
import { SingIt } from "@singitai/sdk";
const client = new SingIt({network: "base", evmPrivateKey: process.env.AGENT_PRIVATE_KEY, maxPerCallUsd: 0.01, maxPerDayUsd: 1});
console.log(await client.chat({messages: [{role: "user", content: "Hello"}]}));'
```

### Wallet command reference

Use `npx @singitai/sdk wallet new`, `singit wallet new`, or `python -m singit wallet new`.
Python terminal QR support: `pip install "singit[qr]"`; Solana also requires `pip install "singit[svm]"`.

| Option | Behavior |
|---|---|
| `--network base\|solana` | Network; default `base`. |
| `--out PATH` | Key file path; default `$SINGIT_HOME/wallets/<network>-<address-prefix>.key`, with `SINGIT_HOME` defaulting to `~/.singit`. |
| `--uri` | Encode an EIP-681 transfer request on Base or Solana Pay request instead of the plain address. |
| `--amount USDC` | With `--uri` only: positive decimal, at most six decimal places. |
| `--no-qr` | Print funding text without the QR. |
| `--show-key` | Explicitly print the private key after a warning. |
| `-h`, `--help` | Show help. |

Send USDC on Base (not Ethereum mainnet or other chains), or USDC on Solana for
`--network solana`. The encoded text is printed below the QR. Without `--uri`, it is just
the address. For Base, load the file with `AGENT_PRIVATE_KEY=$(cat <file>)`; for Solana,
keep the Solana CLI JSON keypair file path for loading your `solanaSigner` (`solana_signer` in Python).

New key files use mode 0600 and new directories use 0700; permissions are best-effort on
Windows. Existing files are never overwritten. Keys are never printed unless you explicitly
use `--show-key`. The key file is the only copy: back it up, never commit or share it.
Anyone who has it can spend the funds. Fund only what you are willing to spend.
`maxPerCallUsd` / `maxPerDayUsd` are client-side limits (Python: `max_per_call_usd` / `max_per_day_usd`).

The library exports `createWallet({network, outPath, home, includeKey})` /
`create_wallet(network, out_path=None, home=None, include_key=False)` and
`fundingUri({network, address, amount})` / `funding_uri(network, address, amount=None)`.
Creation returns `network`, `address`, and `keyPath`; `privateKey` is included only when explicitly requested.


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
