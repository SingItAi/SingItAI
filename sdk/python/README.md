# singit

x402 payment and client-side spending allowance for [SingIt Ask](../../singit-ask), in a few
lines. Limits are checked in your process before signing. The separate AgentAllowance
contract covers only the SingIt app's own agent; it does not protect other agents.

## Install

```bash
pip install singit          # Base / Base Sepolia (EVM): upto + exact
pip install singit[svm]      # adds Solana: exact only (see "What isn't supported yet")
```

## Base

```python
import os
from singit import SingIt

singit = SingIt(
    evm_private_key=os.environ["AGENT_PRIVATE_KEY"],  # or evm_account=an eth_account LocalAccount
    network="base",
    max_per_call_usd=0.01,
    max_per_day_usd=1,
)

answer = singit.chat(messages=[{"role": "user", "content": "Hello"}])
print(answer["choices"][0]["message"]["content"], answer["payment"])
```

## Solana (exact only)

```python
import os
from singit import SingIt

singit = SingIt(
    solana_signer=solana_signer,  # an x402[svm] ClientSvmSigner; requires `pip install singit[svm]`
    network="solana",
    max_per_call_usd=0.01,
    max_per_day_usd=1,
)

answer = singit.chat(messages=[{"role": "user", "content": "Hello"}], scheme="exact")
```

## Base Sepolia (testnet)

SingIt has no testnet deployment, so there is no pinned `pay_to` to default to: pass one
explicitly (e.g. your own test merchant, or a facilitator's own test receiver).

```python
singit = SingIt(
    evm_private_key=os.environ["AGENT_PRIVATE_KEY"], network="base-sepolia",
    pay_to=os.environ["TEST_MERCHANT_PAY_TO"],  # required: no SingIt deployment to pin a default against
    max_per_call_usd=0.01, max_per_day_usd=1,
)
```

## Guards

Every call pins the merchant's offer before signing anything, the same way
`singit-ask/src/metered-buyer.mjs` and `solana-buyer.mjs` do for the service's own buyers:

- **Network/asset/payTo.** The offer's `network`, `asset` and `payTo` must exactly match this
  `SingIt` instance's configured network (the built-in pin for `base`/`solana`, or the `pay_to`
  you pass for `base-sepolia`). A merchant offering a different asset or recipient is refused
  before anything is signed.
- **Per-call ceiling (`max_per_call_usd`).** The offer's atomic amount must be at or below
  `max_per_call_usd` converted to micro-USDC. A costlier offer is refused.
- **Per-day ceiling (`max_per_day_usd`).** An in-memory counter per client instance and per UTC day.
  Reserved at the offer's worst-case ceiling before signing, settled down to the actual billed
  amount for `upto` only. `exact` always counts the full offer amount. **Not durable**: it resets on restart and is not shared across processes —
  it is a client-side allowance guard, not a ledger. For the SingIt app agent’s separate on-chain limit, see
  `allowance()` below.
- **Settlement receipt.** The `payment-response` header's network and payer are checked against
  the request; a mismatch is treated as unresolved rather than returned as a success.

This SDK does **not** wait for on-chain confirmation of the settlement transaction;
`payment["txHash"]` is returned as reported by the merchant's `payment-response` header for the
caller to check independently if needed.

## API

- `SingIt(...)` — `evm_private_key | evm_account` (EVM; `evm_account` is any `eth_account`
  `LocalAccount`), `solana_signer` (an `x402[svm]` signer, for `network="solana"`), `network`,
  `base_url` (default `https://ask.singitai.app`), `app_base_url` (default
  `https://app.singitai.app`), `pay_to`, `rpc_url`, `max_per_call_usd`, `max_per_day_usd` (both
  required).
- `chat(model=None, messages=..., max_tokens=None, scheme="upto", route="completions")` —
  OpenAI-shaped chat completion. `scheme="upto"` (default) pays only the actual answer cost, up
  to the offered ceiling, on EVM networks; `"exact"` pays that ceiling flat and is the only
  scheme supported on Solana (see below). `route="completions"` (default) calls
  `POST /v1/chat/completions`, live today. `route="per-model"` calls `POST /v1/chat/{model}`
  (SI-62), live; `model` is then required.
- `wallet_report(address, days=None, api_key=None)` — `GET {app_base_url}/v1/wallet/{address}/reconciliation`
  (SI-67). The report is private: `api_key` must be a SingIt API key of the account that signs in
  with `address`; without one the server answers 401, and the SDK says so.
- `pricing()` — `GET {base_url}/pricing.json` (SI-68), live.
- `allowance(address, **kwargs)` — `wallet_report(address, **kwargs)["allowance"]`: the on-chain
  spending limit set in the SingIt app, with what has been spent/remains today.

## What isn't supported yet

- **Solana `upto` is not supported.** The official `x402` Python package (2.25.0) ships an EVM
  `upto` client (`x402.mechanisms.evm.upto.client.UptoEvmScheme`) but has no Solana equivalent —
  only `x402.mechanisms.svm.exact.client.ExactSvmScheme`. This corrects an earlier assumption
  that Python might lack EVM `upto` too: it does not, Base/Base Sepolia support both schemes.
  Solana support here is `exact` only, and calling `chat(scheme="upto", network="solana")` raises
  clearly rather than silently falling back.
- No on-chain confirmation of the settlement transaction.
- The Solana `exact` client in the official package resolves a blockhash over a live RPC call
  during payload construction, so it cannot be exercised fully offline; this SDK's own test suite
  therefore only covers Solana at the offer-selection/guard level (see `tests/test_solana_offer.py`).
- `base-sepolia` is useful for integration-testing against a merchant you control; SingIt itself
  has no testnet deployment to pay.

Framework fetch adapters are currently available only in the TypeScript SDK.

## Create a funding wallet

### No wallet yet? Quickstart in 8 lines

Run once in a new directory. The command refuses to replace an existing key.

```sh
pip install "singit[qr]"
singit wallet new --out "$HOME/.singit/wallets/quickstart.key"
# Fund the printed address / scan the QR with USDC on Base before continuing.
export AGENT_PRIVATE_KEY="$(cat "$HOME/.singit/wallets/quickstart.key")"
python -c '
import os; from singit import SingIt
client = SingIt(network="base", evm_private_key=os.environ["AGENT_PRIVATE_KEY"], max_per_call_usd=0.01, max_per_day_usd=1)
print(client.chat(messages=[{"role": "user", "content": "Hello"}]))'
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
