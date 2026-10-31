# Documentation page claim sources

Line numbers refer to this checkout. These pages document existing API behavior, not new payment or Solana features. No live calls, signing or payments were made for this work. Prices are not transcribed into a route-price table.

| Claim / page | Repository source (starting line; related code follows) |
| --- | --- |
| All pages: metadata shell, SVG, navigation, footer, exact tracker | [website/x402-llm-api/index.html:1](../website/x402-llm-api/index.html#L1) |
| Errors and FAQ: additive envelope codes; unknown codes; 402 challenge and settlement refusal; 429 headers | [singit-ask/ERRORS.md:1](../singit-ask/ERRORS.md#L1) |
| Errors: complete stable vocabulary and default status mapping; OpenAPI component schemas | [singit-ask/src/errors.mjs:2](../singit-ask/src/errors.mjs#L2) |
| Errors/limits/FAQ: free defaults, network identity, reset, default $0.25 daily budget and persistence, busy response and failure give-back | [singit-ask/src/free.mjs:16](../singit-ask/src/free.mjs#L16) |
| Limits: IPv4 /24 and IPv6 /64 grouping | [singit-ask/src/free.mjs:57](../singit-ask/src/free.mjs#L57) |
| Limits: reset, shared daily cap, budget and concurrency decisions | [singit-ask/src/free.mjs:69](../singit-ask/src/free.mjs#L69) |
| Limits/errors: free token clamp, headers, failure and returned allowance | [singit-ask/src/free.mjs:147](../singit-ask/src/free.mjs#L147) |
| Limits: configuration defaults and proposal/live distinction; gateway free lane is separate | [docs/free-models.md:6](../docs/free-models.md#L6) |
| Limits/errors: 60 visitor / 3000 global price requests per fixed minute; 429 reset and Retry-After | [singit-ask/src/prices.mjs:14](../singit-ask/src/prices.mjs#L14) |
| Limits/errors: JSON body limit 128 KiB (express.json `128kb` = 131,072 bytes); parse errors before payment | [singit-ask/src/app.mjs:385](../singit-ask/src/app.mjs#L385) |
| Limits/keys: caps, expiry, account-cap relationship and documented defaults/maximums | [docs/singit-api-keys-plan.md:144](../docs/singit-api-keys-plan.md#L144) |
| Limits/keys: implemented 5/day, 0.25/request, 90 days, 1000/day, 50/request, 365 days, 60/minute | [sign402-gateway/sign402_gateway/web_api_keys.py:36](../sign402-gateway/sign402_gateway/web_api_keys.py#L36) |
| Limits/payments/security/FAQ: top-ups 1–50 USDC; wallet signs key limits; key API URL | [website/llms.txt:52](../website/llms.txt#L52) |
| Limits/payments: model markup and Base/Solana settlement fees, default maxChargeAtomic | [singit-ask/src/pricing.mjs:7](../singit-ask/src/pricing.mjs#L7) |
| Limits/payments: 0.3 exact output fraction, 1500 authorization floor and refusal above upto ceiling | [singit-ask/src/pricing.mjs:51](../singit-ask/src/pricing.mjs#L51) |
| Limits/payments: request-specific quotes replace standing maxChargeAtomic; both schemes on both networks | [singit-ask/src/metered.mjs:84](../singit-ask/src/metered.mjs#L84) |
| Payments/FAQ: challenge, header flow, no account/key, Base gas sponsoring, upto/exact semantics, Claude Opus | [docs/first-paid-call.md:1](../docs/first-paid-call.md#L1) |
| Payments/errors: no settlement on upstream failures; 422 reasoning without answer | [singit-ask/test/upstream-errors.test.mjs:79](../singit-ask/test/upstream-errors.test.mjs#L79) |
| Errors: stale permit nonce returns 409, wait for prior settlement then sign again | [singit-ask/src/permit-guard.mjs:49](../singit-ask/src/permit-guard.mjs#L49) |
| Payments/errors: 503/422 handling after upstream answer and before settlement | [singit-ask/src/metered.mjs:329](../singit-ask/src/metered.mjs#L329) |
| Payments: Exa request pricing, default zero markup/fee, verify then answer then settle | [singit-ask/src/search.mjs:1](../singit-ask/src/search.mjs#L1) |
| Payments/FAQ: receipt header, settlement-only receipt and atomic amount vs ceiling | [singit-ask/src/spend-limit.mjs:177](../singit-ask/src/spend-limit.mjs#L177) |
| Payments: receipt header written alongside facilitator PAYMENT-RESPONSE | [singit-ask/src/spend-limit.mjs:18](../singit-ask/src/spend-limit.mjs#L18) |
| Security/limits: network/asset/payTo selection and budget checks | [sdk/typescript/src/guards.js:24](../sdk/typescript/src/guards.js#L24) |
| Security: production pay-to and USDC pins | [sdk/typescript/src/pins.js:5](../sdk/typescript/src/pins.js#L5) |
| Security/limits: required maxPerCallUsd and maxPerDayUsd | [sdk/typescript/src/singit.js:54](../sdk/typescript/src/singit.js#L54) |
| Security/limits: local keys and budgets, per-instance memory counter/UTC reset | [sdk/typescript/README.md:1](../sdk/typescript/README.md#L1) |
| Security: private keys stay out of chat/issues/repository | [docs/trezor-allowance-t4-runbook.md:9](../docs/trezor-allowance-t4-runbook.md#L9) |
| Security: private reporting address, requested report details, no real keys/seeds or public issues | [SECURITY.md:6](../SECURITY.md#L6) |
| Security/FAQ: MCP transport, keyless lookups, search/tools scopes, revoked-key 401 | [llms-install.md:1](../llms-install.md#L1) |
| Security: MCP scopes and key caps | [sign402-gateway/README.md:543](../sign402-gateway/README.md#L543) |
| Security: allowance applies only to wallets granting SingIt authority; Base vs server-enforced Solana caps | [website/agent-spending-limits/index.html:252](../website/agent-spending-limits/index.html#L252) |
| Solana: integration boundaries; no CLI wallet as user wallet; contextual source, no numerical quota inferred | [docs/solana-integration.md:1](../docs/solana-integration.md#L1) |
| Solana/Exa: native chat approval and read-only quote validation; contextual source, no quota inferred | [docs/exa-solana-chat.md:1](../docs/exa-solana-chat.md#L1) |
| Solana pause: only a fresh owner-signed confirmed GRANT prepared after pause; new limits alone insufficient | [sign402-gateway/sign402_gateway/solana_allowance.py:249](../sign402-gateway/sign402_gateway/solana_allowance.py#L249) |
| Solana pause: regression cases including old approval and new limits | [sign402-gateway/tests/test_solana_allowance.py:434](../sign402-gateway/tests/test_solana_allowance.py#L434) |
| FAQ: displayed list prices vs SingIt prices, fee separation | [docs/model-pages.md:25](../docs/model-pages.md#L25) |

## Supplied live verification

The task records verification on **31 October 2026, Europe/Prague**, against ask.singitai.app: unpaid chat POST returns 402 with `{x402Version, accepts, error:"payment_required", code:"payment_required"}` and matching decoded PAYMENT-REQUIRED fields; unknown GET /nope returns the documented nested 404; malformed JSON returns the documented nested 400. OpenAPI schemas include ErrorResponse, AnthropicErrorResponse, PaymentRequired402 and RateLimited429. The errors page marks the two literal live response examples with `data-verification="live-2026-10-31"`; the Messages envelope and settlement refusal are source-schema examples, not claimed live runs. The challenge offers are described rather than copied with public payment addresses.

## Solana pause cross-check

The Solana pause claim is grounded in `sign402-gateway/sign402_gateway/solana_allowance.py:249–277` and its regression tests: a confirmed new GRANT prepared after the pause, signed by the owner, with an unreplayed signature and the prepared blockhash, lifts the pause. New limits, a revoke, failed approval or old prepared approval do not. No undocumented Solana quota is stated. The Ask fee and offer claims come from `pricing.mjs`, `metered.mjs` and `docs/first-paid-call.md`, not from the separate Exa/Venice integration paths.

## Verification and scope

`website/tests/docs-pages.test.mjs` imports the dependency-free ERROR_CODES and defaultErrorCode, compares the full page vocabulary, checks metadata/schema/sitemap/internal files/tracker/forbidden text/example provenance, verifies llms error-table codes, and matches FAQPage text word for word. The six pages are hand-written static output with existing CSS. No audit claim, route-price range or additional Solana quota is made. No unsourced numerical claim was added. The private-key statement expresses the documented handling policy (local signer, never chat/support); it does not describe custody guarantees for other products.

## Verification record, 31 October 2026 (Europe/Prague)

Run from the build machine against https://ask.singitai.app, unpaid and free (no wallet, no payment):

| Command | Result |
| --- | --- |
| `curl -s -D h.txt -X POST https://ask.singitai.app/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"deepseek-v4.1-flash","max_tokens":200,"messages":[{"role":"user","content":"hi"}]}'` | HTTP 402; body keys `accepts`, `code`, `error`, `x402Version`; `error` and `code` both `payment_required`; body `x402Version` and `accepts` equal the decoded `PAYMENT-REQUIRED` header; offers in order upto Base, upto Solana, exact Base, exact Solana |
| `curl -s -w '\n%{http_code}\n' https://ask.singitai.app/nope` | 404, `{"error":{"type":"invalid_request_error","message":"Cannot GET /nope","code":"not_found"}}` |
| `curl -s -X POST https://ask.singitai.app/v1/chat/completions -H 'Content-Type: application/json' -d '{bad'` | 400, `{"error":{"type":"invalid_request_error","message":"Send valid JSON.","code":"invalid_json"}}` |
| `curl -s https://ask.singitai.app/openapi.json` | `components.schemas` has ErrorResponse, AnthropicErrorResponse, PaymentRequired402, RateLimited429 |
