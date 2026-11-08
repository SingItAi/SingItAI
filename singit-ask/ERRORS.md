# Ask API errors

JSON errors retain their existing status, message, type and envelope. OpenAI-compatible routes add `error.code`; Anthropic Messages also puts the code inside `error`. Errors with a string `error` retain that string and add a top-level `code`. Clients should handle unknown codes for forward compatibility. With stream:true, errors remain JSON (never partial SSE). Invalid stream values or stream_options return 400 invalid_request before payment; stream_options accepts only include_usage:boolean and requires stream:true.

| Code | Meaning |
| --- | --- |
| `tools_unsupported` | This route does not support tools. |
| `content_blocks_unsupported` | This route does not support content blocks. |
| `tools_unsupported_for_model` | The selected model does not support tools. |
| `images_unsupported_for_model` | The selected model does not support image inputs. |
| `upstream_rejected_request` | The upstream provider rejected the request. |
| `invalid_json` | Request body is unreadable JSON. |
| `invalid_request` | Request fields cannot be accepted, including fallback_models unless it is an array of 1–3 unique nonempty model ids excluding the pinned model and singit/auto. |
| `payload_too_large` | Request exceeds the 128 kB JSON limit. |
| `model_not_found` | Requested model is unavailable. A model Surplus lists at price 0 is sold only if it has a reviewed reference price; others are not sold. |
| `not_found` | Route or price symbol is unavailable. |
| `payment_required` | Payment challenge; select an offer and retry with a signature. |
| `stale_payment_permit` | Your previous payment already spent this permit nonce. Wait for its transaction, then fetch a new 402 and sign again. Nothing was charged for this request. |
| `payment_unfunded` | On Base, fund the wallet with enough USDC; on Solana, fund the wallet and its token account. Nothing was charged for this request. |
| `payment_blockhash_stale` | On Solana, sign again with a fresh blockhash. Nothing was charged for this request. |
| `payment_replay` | Check the previous result before paying again. Nothing was charged for this request. |
| `payment_invalid` | Fix the payment before retrying. Nothing was charged for this request. |
| `permit2_allowance_required` | An `upto` payment on Base carried no EIP-2612 permit and the payer's USDC allowance to Permit2 is below the signed ceiling. Nothing was charged and no model ran: add a permit (or approve Permit2 for at least the ceiling) and retry. |
| `payment_duplicate` | Payment signature was already used. |
| `rate_limited` | Request allowance exhausted. |
| `free_tier_exhausted` | Visitor allowance or shared daily answer allowance exhausted. |
| `free_budget_exhausted` | Shared daily free budget spent; returns at midnight UTC. |
| `free_tier_busy` | Free answer concurrency is full. |
| `max_tokens_too_small` | Paid requests retry once with a larger budget when more than eight seconds remain; free requests never retry. Reasoning consumed the output allowance without an answer. |
| `no_billable_answer` | Nothing billable was returned. |
| `no_healthy_sellers` | Model has no available healthy seller. |
| `upstream_unavailable` | Catalogue, facilitator or provider is unavailable. |
| `unauthorized`, `forbidden` | Authentication or access refused. |
| `internal_error` | Unclassified server error. |
| `invalid_identity`, `invalid_payment`, `terms_changed` | Direct payment request validation failed. |
| `request_changed`, `already_prepared`, `previous_quote_pending` | Direct quote preparation conflicts with existing state. |
| `unknown_model` | Direct quote model lookup failed. |
| `already_paid`, `already_submitted`, `quote_unavailable` | Direct quote cannot be submitted in its current state. |
| `verification_unavailable`, `verification_refused`, `payment_unresolved` | Direct payment verification or settlement did not complete. |

Existing route-specific codes remain unchanged. Error schema examples list the common vocabulary without restricting future or existing provider-specific values.

Solana verification failures mentioning `InvalidAccountData` retain the original facilitator code prefix in the 402 `error` and explain that the payer must fund their wallet with USDC on Solana mainnet to create its token account, then pay from the wallet that owns it. They also carry the code `payment_unfunded`.

The OpenAPI document carries error response examples, daily and busy rate-limit header examples, and a synthetic per-model health example generated from HealthStats in tests. Payment challenges use route-specific examples: chat shows Base upto and exact offers (Solana follows each Base offer in the full challenge); Exa, images and speech show exact offers on both networks. The 503 examples use the corresponding handler messages and codes, and the 413 example matches the JSON parser response.

An OpenAI-compatible error looks like:

```json
{"error":{"type":"invalid_request_error","message":"Send valid JSON.","code":"invalid_json"}}
```

The 402 challenge body contains `x402Version`, `accepts`, `error: "payment_required"` and `code: "payment_required"`. `x402Version` and `accepts` exactly match the decoded `PAYMENT-REQUIRED` header, whose bytes remain unchanged. Existing spend-limit metadata remains available. When a payment was submitted but could not be settled, the 402 has no `PAYMENT-REQUIRED` header and its body includes error, the refusal code, action and message. `x402Version` and `accepts` are optional in the schema: present for a payment challenge and absent for this settlement failure. A payment refusal without a challenge header retains its existing error and adds its code; it does not invent offers.

429 responses retain `Retry-After` in seconds. Exhausted free daily allowances add `X-RateLimit-Limit` (configured per-visitor daily allowance), `X-RateLimit-Remaining: 0` (no free requests currently available), and `X-RateLimit-Reset` (Unix seconds at the next UTC midnight). `free_budget_exhausted` includes only `Retry-After` until midnight UTC, without per-visitor X-RateLimit headers. Busy responses include only `Retry-After: 5`; a daily allowance cannot describe the concurrency limit.

Prices use fixed minute windows. Their 429 headers describe the blocking allowance (60 per visitor, or 3,000 overall), zero remaining requests, and the actual next minute boundary. The existing `Retry-After: 60` remains a conservative wait and can extend past that boundary. Successful responses do not gain rate-limit headers.


`/health` model entries include 24-hour `reasoning422` (empty reasoning exhaustion) and
`reasoningRetries` (successful answers after an automatic retry). Exhaustion does not increase
attempts, successes or failures, and leaves the last outcome unchanged. Successful retries count once
as success and once as retry. Three or more reasoning 422s with
`reasoning422 / (attempts + reasoning422) > 0.2` make a model at least degraded; down and unavailable
statuses are preserved. Persisted files without the new counters remain readable.

## Payment refusal codes

Refused payments keep error: "payment_required" and add a specific code, action and safe message, also exposed in X-SingIt-Error. Nothing was charged for this request, on Base or Solana: the x402 middleware holds the answer until settlement succeeds. Clients should treat payment_duplicate and payment_replay as the same condition.

| Code | Action | What to do | Charged? |
| --- | --- | --- | --- |
| `payment_unfunded` | `fund_wallet` | Base: fund the wallet with enough USDC on Base. Solana: fund the wallet and its token account. | Nothing was charged for this request. |
| `permit2_allowance_required` | `use_exact_or_provide_permit` | Base `upto` only: sign an `eip2612GasSponsoring` permit, approve Permit2 for at least the ceiling, or pay the `exact` offer. `details` names the scheme, network and extension. | Nothing was charged; the model did not run. |
| `payment_blockhash_stale` | `sign_again` | On Solana, sign again with a fresh blockhash. | Nothing was charged for this request. |
| `payment_replay` | `check_previous_result` | Check the previous result before paying again. | Nothing was charged for this request. |
| `payment_invalid` | `fix_payment` | Fix the payment before retrying. | Nothing was charged for this request. |

Limits of the classification: a refusal is coded only when the facilitator reports it (verification refusal, or a settlement failure with a reason). A settlement that may have reached the chain (transaction hash present, pending, timeout, transport error) keeps the plain `payment_required` answer without an action, because it cannot be said that nothing was charged. A payment rejected before verification (malformed `PAYMENT-SIGNATURE`, or one that does not match an offer) also keeps the plain `payment_required` challenge.

## Solana `exact`: answer window and blockhash

On Solana `exact` the payment is verified before the model answers and settled after it. The transaction's blockhash
is accepted by the chain for about 150 blocks (roughly 60–90 seconds from when the payer fetched it); the offer's
`maxTimeoutSeconds` (300) does not extend that. So the model gets **20 seconds from successful verification**: an
answer not complete by then is cut off and refused with 503 `no_billable_answer`, `Retry-After: 30`,
`X-SingIt-Error` and a `request_id`, before any settlement. Nothing is charged; try again with a fresh signature.
A stale blockhash at verification is a 402 `payment_blockhash_stale` (`sign_again`) before the model. This narrows the
risk of a settlement refused after the answer; it does not rule it out (a payer may sign with an already old
blockhash). Base and Solana `upto` have no such window: Solana `upto` settles its escrow deposit before the model.

