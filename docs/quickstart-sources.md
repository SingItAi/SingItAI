# Quickstart claim sources

The page is static documentation. No wallets, signatures or payments were used to produce it. The 31 October 2026 observations were made by running the free commands listed in the verification record at the end of this file. Line references refer to this working tree.

| Claim / page section | Source |
| --- | --- |
| API key surfaces, SDKs, Claude Code, MCP | `docs/first-paid-call.md:197`; `website/developers/index.html` (SDK and MCP sections) |
| Free model, no wallet, 20 answers/day per network | `docs/first-paid-call.md:20`; `docs/free-models.md` |
| Unpaid curl, decode command, expected 402, version 2, four-offer order | `docs/first-paid-call.md:32-65`; `singit-ask/src/app.mjs:841`; live check of 31.10.2026 (verification record) |
| 402 body matches header; settlement failure has no challenge | `singit-ask/ERRORS.md:40`; `singit-ask/src/errors.mjs:40-44`; `singit-ask/test/error-codes.test.mjs:64-92`; `singit-ask/test/openapi-errors.test.mjs:102-121` |
| Node 20+, own key, USDC on Base, Permit2/EIP-2612 gas sponsorship | `docs/first-paid-call.md:26-27` |
| Generic Base withdrawal/bridge instructions, check network, fresh small wallet | Task's explicit Step 2 instructions; operational guidance, no provider ranking or safety guarantee |
| 0.0015 USDC ceiling, 1500 atomic; CLI 0.002 cap | `website/data/models-snapshot.json:1275-1284` (deepseek-v4.1-flash Base offer); request-specific minimum in `docs/first-paid-call.md:13-14,52-57,175`; CLI observation |
| Hundreds of short answers; 666 at the stated ceiling | Arithmetic: floor(1 / 0.0015) = 666. This is a ceiling-based illustration, not a guarantee for every model or prompt. |
| Variant A run once 28.10.2026, install and full script | `docs/first-paid-call.md:5,81-111` |
| upto charges actual usage within ceiling; exact flat price | `docs/first-paid-call.md:63-66,175-179`; `singit-ask/test/metered.test.mjs:78-104` |
| billing.totalAtomic and PAYMENT-RESPONSE | `docs/first-paid-call.md:180-185` |
| X-SingIt-Receipt JSON fields | `singit-ask/src/spend-limit.mjs:7-8`; `singit-ask/test/spend-limit.test.mjs` |
| Missing signature/retry, network/asset, ceiling troubleshooting | `docs/first-paid-call.md:74,175`; `singit-ask/src/metered-buyer.mjs:16-25,55-65`; `singit-ask/test/metered.test.mjs:34`; task's required troubleshooting guidance |
| Balance must cover ceiling | Task's required troubleshooting guidance; `docs/first-paid-call.md:26-27` (funded Base wallet). Advice to check the ceiling, not a claim of a bespoke balance error code. |
| 409 payment_duplicate; stale_payment_permit | `singit-ask/src/errors.mjs:5,14`; `singit-ask/ERRORS.md:15-16`; `singit-ask/test/error-codes.test.mjs:184`; `singit-ask/test/permit-guard.test.mjs:31` |
| Settlement failure retry and no charge for an answer | `singit-ask/ERRORS.md:40`; `singit-ask/test/app.test.mjs:151`; task's explicit settlement-failure instruction |
| Variant B free initialize/list/search/validate, tool prefix, four offers, dependency failure and fix, paid steps not run | Supplied 31.10.2026 (Prague) run facts, now recorded in `docs/first-paid-call.md:115-119`. No CDP wallet creation, funding or proxy_tool_call was run. |
| Variant C version/Node, details without login or -X/-d, search price, authenticated status, pay flags, paid steps not run | Supplied 31.10.2026 (Prague) run facts, now recorded in `docs/first-paid-call.md:160-162`. No login/verify, balance or x402 pay was run. |
| Solana | Only offer ordering is described; no Solana wallet-limit claims are made. |

## Verified code block inventory

“Verified” describes the 28.10.2026 paid run (Variant A) or the free checks of 31.10.2026 in the verification record. Expected output is an illustrative shape and the paid CLI template is explicitly not run.

| HTML code ID | Evidence and scope |
| --- | --- |
| `unpaid-curl` | `docs/first-paid-call.md:32-36`; unpaid request from the historical guide |
| `decode-offers` | `docs/first-paid-call.md:42-49`; historical header decoder |
| `install-a` | `docs/first-paid-call.md:82`; Variant A historical run 28.10.2026 |
| `paid-a` | `docs/first-paid-call.md:86-110`; copied verbatim; Variant A historical run 28.10.2026 |
| `install-b` | `docs/first-paid-call.md:117,129`; import-resolution/free-search check (verification record) with CDP SDK 1.60.0; no paid execution |
| `cli-free` | `docs/first-paid-call.md:160`; three no-login CLI checks (verification record), awal 2.12.1, Node 24.22.1 |

## Verification record, 31 October 2026 (Europe/Prague)

Free, unpaid checks run from the build machine (Node 24.22.1):

- Step 1: unpaid `curl -X POST https://ask.singitai.app/v1/chat/completions` returned HTTP 402; the JSON body keys were `accepts`, `code`, `error`, `x402Version`, equal to the decoded `PAYMENT-REQUIRED` header; offer order upto Base, upto Solana, exact Base, exact Solana.
- Variant B: JSON-RPC `initialize`, `tools/list`, `tools/call search_resources` (`curatedOnly:false`, query "SingIt Ask chat completions") and `tools/call validate_endpoint` (POST `https://ask.singitai.app/v1/chat/completions`) against `https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp`, no auth. In a scratch npm project, `npm install @coinbase/cdp-sdk @modelcontextprotocol/sdk @x402/core @x402/evm @x402/mcp` alone made `import { CdpX402Client } from "@coinbase/cdp-sdk/x402"` fail with `ERR_MODULE_NOT_FOUND`; adding `@x402/extensions @x402/svm` made all four imports resolve (package.json `"type": "module"`).
- Variant C: `npx awal@2.12.1 --version`, `x402 details`, `x402 bazaar search "SingIt Ask"`, `status`, and `x402 pay --help`; `x402 details -X ...` returned `error: unknown option '-X'`.
- Not run: any paid call, CDP wallet creation, `awal auth login`, `balance`, `x402 pay`.
