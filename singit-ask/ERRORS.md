# Ask API errors

JSON errors retain their existing status, message, type and envelope. OpenAI-compatible routes add `error.code`; Anthropic Messages also puts the code inside `error`. Errors with a string `error` retain that string and add a top-level `code`. Clients should handle unknown codes for forward compatibility.

| Code | Meaning |
| --- | --- |
| `invalid_json` | Request body is unreadable JSON. |
| `invalid_request` | Request fields cannot be accepted, including fallback_models unless it is an array of 1–3 unique nonempty model ids excluding the pinned model and singit/auto. |
| `payload_too_large` | Request exceeds the 128 kB JSON limit. |
| `model_not_found` | Requested model is unavailable. A model Surplus lists at price 0 is not sold. |
| `not_found` | Route or price symbol is unavailable. |
| `payment_required` | Payment challenge; select an offer and retry with a signature. |
| `stale_payment_permit` | Payment permit is stale; obtain a fresh challenge. |
| `payment_duplicate` | Payment signature was already used. |
| `rate_limited` | Request allowance exhausted. |
| `free_tier_exhausted` | Visitor allowance or shared daily answer allowance exhausted. |
| `free_budget_exhausted` | Shared daily free budget spent; returns at midnight UTC. |
| `free_tier_busy` | Free answer concurrency is full. |
| `max_tokens_too_small` | Reasoning consumed the output allowance without an answer. |
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

The OpenAPI document carries error response examples, daily and busy rate-limit header examples, and a synthetic per-model health example generated from HealthStats in tests. Payment challenges use route-specific examples: chat shows Base upto and exact offers (Solana follows each Base offer in the full challenge); Exa, images and speech show exact offers on both networks. The 503 examples use the corresponding handler messages and codes, and the 413 example matches the JSON parser response.

An OpenAI-compatible error looks like:

```json
{"error":{"type":"invalid_request_error","message":"Send valid JSON.","code":"invalid_json"}}
```

The 402 challenge body contains `x402Version`, `accepts`, `error: "payment_required"` and `code: "payment_required"`. `x402Version` and `accepts` exactly match the decoded `PAYMENT-REQUIRED` header, whose bytes remain unchanged. Existing spend-limit metadata remains available. When a payment was submitted but could not be settled, the 402 has no `PAYMENT-REQUIRED` header and its body is only `{"error":"payment_required","code":"payment_required"}`. `x402Version` and `accepts` are optional in the schema: present for a payment challenge and absent for this settlement failure. A payment refusal without a challenge header retains its existing error and adds its code; it does not invent offers.

429 responses retain `Retry-After` in seconds. Exhausted free daily allowances add `X-RateLimit-Limit` (configured per-visitor daily allowance), `X-RateLimit-Remaining: 0` (no free requests currently available), and `X-RateLimit-Reset` (Unix seconds at the next UTC midnight). `free_budget_exhausted` includes only `Retry-After` until midnight UTC, without per-visitor X-RateLimit headers. Busy responses include only `Retry-After: 5`; a daily allowance cannot describe the concurrency limit.

Prices use fixed minute windows. Their 429 headers describe the blocking allowance (60 per visitor, or 3,000 overall), zero remaining requests, and the actual next minute boundary. The existing `Retry-After: 60` remains a conservative wait and can extend past that boundary. Successful responses do not gain rate-limit headers.
