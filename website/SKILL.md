---
name: singit
description: Use when an agent needs an LLM answer, web search or price lookup it has no key for, wants spending capped by an owner-set key, or wants to pay per call with its own wallet over x402.
---

# SingIt

SingIt provides model answers, search and price lookups. Choose a free answer,
an owner-set MCP key, or payment per call from your own wallet.

## Step 0: a free first call

POST https://ask.singitai.app/v1/chat/completions without a key or wallet:

```json
{"model":"free/deepseek-v4.1-flash","messages":[{"role":"user","content":"Hello"}]}
```

Six free models share up to 20 answers a day per visitor network and a $0.25
shared daily cost cap. The shared allowance may run out; it resets at midnight UTC.

## With an owner's key

Ask the owner to set up a SingIt allowance from their wallet (Base limiter or
Solana delegation), then create a key at https://app.singitai.app/app/ under
Settings → API keys. Their wallet signs the key's terms. The key is shown once.
Read SINGIT_API_KEY from the environment. Setup: https://singitai.app/docs/mcp/#key

Claude Code:

```sh
claude mcp add --transport http singit https://app.singitai.app/mcp --header 'Authorization: Bearer ${SINGIT_API_KEY}'
```

Single quotes keep ${SINGIT_API_KEY} as a reference so the key is not written into Claude Code's configuration.

Codex:

```sh
codex mcp add singit --url https://app.singitai.app/mcp --bearer-token-env-var SINGIT_API_KEY
```

Cursor (~/.cursor/mcp.json):

```json
{
  "mcpServers": {
    "singit": {
      "url": "https://app.singitai.app/mcp",
      "headers": {"Authorization": "Bearer ${env:SINGIT_API_KEY}"}
    }
  }
}
```

Verification: configuration from the repository; not run live for this guide.

| MCP tools | Access | Scope / network |
| --- | --- | --- |
| get_price, list_price_symbols, list_models | Free without a key | No paid scope |
| get_balance, get_limits, get_receipts | Free with a key, read-only | Account data |
| web_search, read_page | Paid per call within key caps | search; Base or Solana |
| get_x_profile, get_crypto_news, get_hyperliquid_market, get_funding_rates, resolve_ens, get_token_price | Paid per call within key caps | tools; Base only for now |
| get_weather, get_singit_risk_check | Paid demo calls within key caps | tools; Base only for now |

New keys include search and tools scopes. Keys made before data tools existed
need a new key. Call get_limits before spending. Report spend with get_limits
and get_receipts. Without an allowance, paid search/data calls say
“Set up your allowance first.” Wrong or revoked keys return HTTP 401.
MCP allows 60 requests per minute per key.

## With your own wallet: x402

Use https://ask.singitai.app. USDC on Base or Solana; no account or API key.
An unpaid request returns 402 with PAYMENT-REQUIRED (base64 JSON, x402Version 2).
Decode it, check the offered network, asset, recipient and amount against your
configuration and budget, sign one offer, and retry the same request with
PAYMENT-SIGNATURE. Success includes PAYMENT-RESPONSE.
Prefer upto when supported: it pays actual cost up to the signed ceiling.
Never sign above budget. Keep maxPerCallUsd and maxPerDayUsd in the client.
These are client-side guards, not on-chain limits; the SDK daily counter is in
memory per instance and UTC day. Restarting starts a new counter.

The TypeScript package [@singitai/sdk](https://github.com/SingItAi/SingItAI/blob/main/sdk/typescript/README.md)
provides chat() and paidFetch() with client-side caps. See the repository's
sdk/typescript/README.md. The PyPI package [singit](https://github.com/SingItAi/SingItAI/blob/main/sdk/python/README.md)
provides client-side caps named max_per_call_usd and max_per_day_usd; see
sdk/python/README.md. Both support Base upto and exact; Solana is exact only.
Set framework retries to zero so a retry does not sign a second payment.

## Errors

| Result | Action |
| --- | --- |
| 400 / 413 / 422 | Fix the request; reduce size for 413. Do not retry on another model. |
| 402 with PAYMENT-REQUIRED | Check budget and sign one offer, then retry. Re-sign only after checking the fresh challenge. |
| 402 without a challenge | Reconcile the submitted payment before signing again. |
| 409 payment_duplicate | Check the original result; do not reuse the signature. |
| 429 free_budget_exhausted | Wait Retry-After; the daily free budget resets at midnight UTC. |
| 503 | Wait Retry-After where supplied, then retry. No billable answer means no charge. |
| Refused tool call (isError true), daily limit used up | Stop, tell the owner, and do not try to bypass the limit. |

## Rules and boundary

Never print or store the API key or private key in chat or logs. Read secrets
from the environment. Stop when a limit refuses. The owner can revoke the key
immediately in Settings → API keys without a wallet signature.

SingIt's server enforces the key's daily and per-request caps only for calls
made with that key to SingIt's MCP and the same key's /v1 endpoint. They do not
limit spending elsewhere. SingIt's contracts do not protect other people's
agents' own wallets. A key cannot move funds or change limits.

On Base the owner's allowance limiter is an on-chain contract the owner can
pause. On Solana key caps are checked by SingIt's server; the owner can revoke
the delegation. There is no on-chain emergency stop. A paused Solana account
is unpaused only by a new grant signed after the pause.
