# singit

x402 payment and client-side spending allowance for [SingIt Ask](../../singit-ask), in a few
lines. **Not published yet** — this package has no PyPI upload configuration; it is built and
tested locally only. Publishing needs a separate decision from the project owner.

## Install (once published)

```bash
pip install singit          # Base / Base Sepolia (EVM): upto + exact
pip install singit[svm]      # adds Solana: exact only (see "What isn't supported yet")
```

## Base

```python
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
    evm_private_key=..., network="base-sepolia",
    pay_to="0x...",  # required: no SingIt deployment to pin a default against
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
- **Per-day ceiling (`max_per_day_usd`).** An in-memory, per-process, per-UTC-day counter.
  Reserved at the offer's worst-case ceiling before signing, settled down to the actual billed
  amount afterwards. **Not durable**: it resets on restart and is not shared across processes —
  it is a client-side allowance guard, not a ledger. For the actual on-chain spending limit, see
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
  (SI-62) — **may not be deployed yet**; `model` is then required.
- `wallet_report(address, days=None)` — `GET {app_base_url}/v1/wallet/{address}/reconciliation`
  (SI-67). **May not be deployed yet**; this SDK does not fabricate a response, it surfaces the
  HTTP status.
- `pricing()` — `GET {base_url}/pricing.json` (SI-68). **May not be deployed yet**, same caveat.
- `allowance(address, **kwargs)` — `wallet_report(address, **kwargs)["allowance"]`: the on-chain
  spending limit set in the SingIt app, with what has been spent/remains today.

## What isn't supported yet

- **Solana `upto` is not supported.** The official `x402` Python package (2.25.0) ships an EVM
  `upto` client (`x402.mechanisms.evm.upto.client.UptoEvmScheme`) but has no Solana equivalent —
  only `x402.mechanisms.svm.exact.client.ExactSvmScheme`. This corrects an earlier assumption
  that Python might lack EVM `upto` too: it does not, Base/Base Sepolia support both schemes.
  Solana support here is `exact` only, and calling `chat(scheme="upto", network="solana")` raises
  clearly rather than silently falling back.
- The per-model route (SI-62), wallet reconciliation (SI-67) and `pricing.json` (SI-68) are not
  present anywhere in this repository yet; calling them against the live `ask.singitai.app` /
  `app.singitai.app` hosts will 404 until those PRs ship.
- No on-chain confirmation of the settlement transaction.
- The Solana `exact` client in the official package resolves a blockhash over a live RPC call
  during payload construction, so it cannot be exercised fully offline; this SDK's own test suite
  therefore only covers Solana at the offer-selection/guard level (see `tests/test_solana_offer.py`).
- `base-sepolia` is useful for integration-testing against a merchant you control; SingIt itself
  has no testnet deployment to pay.
