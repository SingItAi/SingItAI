# Model pages and spending limits

Refresh from the live read-only endpoints, then regenerate the committed HTML:

```sh
node scripts/models-snapshot.mjs && node scripts/generate-model-pages.mjs
node scripts/generate-model-pages.mjs --check
cd website && node --test tests/*.test.mjs
```

For an offline refresh, supply both `--models-input` and `--pricing-input` JSON files and `--fetched-at` with a UTC ISO timestamp to the snapshot script. `--out` changes its output path. The generator always reads `website/data/models-snapshot.json`. Cloudflare publishes `website/` directly; commit the snapshot and generated output together after review.

`/v1/models` supplies list prices, expected SingIt token prices including markup, basis, fees and model facts. `/pricing.json` supplies reference-request `upto` ceilings and `exact` flat prices on Base and Solana. The snapshot retains only the basis of the upstream expected-price object, not its raw cost estimates. It also preserves the free offer's model and daily limit to source the separate free-try copy. Missing fields stay missing. Models without a SingIt token price show only request prices, with no zero-dollar token offer.

Formatting treats digits beyond the 12th significant digit as binary floating-point noise (for example, the server's decimal product `0.052 * 1.3` becomes `0.06760000000000001`) and normalizes with `x = Number(n.toPrecision(12))`. On that number's decimal string, it keeps up to nine decimal places; if more remain, it rounds UP at the ninth decimal using string arithmetic, then trims trailing zeros. Snapshot numbers remain unchanged in JSON. Live values and the actual request's 402 are authoritative. Titles fall back to a shorter form; descriptions drop the optional price sentence before shortening a name.

The shell was copied from the former spending-limit page into `scripts/templates/model-shell.html`. Limits copy is in `scripts/templates/spending-limits.mjs`. Both are generator inputs. Sitemap and llms.txt edits replace only the marked generated blocks. The live models table has a plain directory link; its JavaScript is unchanged.

## Models with uncensored/heretic/role-play in the name

These eight chat models are listed because `/v1/models` lists them: `deepseek-v4.1-flash-uncensored`, `e2ee-gemma-4-26b-a4b-uncensored-p`, `e2ee-qwen3-6-35b-a3b-uncensored-p`, `gemma-4-uncensored`, `glm-4.7-flash-heretic`, `qwen3.6-plus-uncensored`, `venice-uncensored-1.2` and `venice-uncensored-role-play`. Checked 30.10.2026: all eight returned a valid unpaid x402 402 on `/v1/chat/completions`. An unpaid 402 did not prove answerability. `deepseek-v4.1-flash-uncensored` was hidden on 30.10.2026 after `no_healthy_sellers` (nothing charged) and returned after its seller was healthy for six consecutive hourly checks; no paid call has been made since the hide. All eight pages are generated like all other model pages, with no special wording beyond their names; pricing and payment follow the ordinary chat model rules.

In `singit-ask/src/catalogue.mjs`, the `OTHER_SERVICE` pattern `/edit|remover|upscale/i` is applied to image, speech/transcription and video model IDs and excludes only matching models, which take an image as input and belong to another service. Models with uncensored, nsfw or lustify in their names are sold like chat models. Video stays disabled by default (`video_disabled`).

## Claim sources

Line numbers refer to this checkout. The limits templates use only the claims below; model-page formula and integration sources are included for review.

| Claim on the limits pages | Source file/line in this repo |
| --- | --- |
| Sign in with wallet; sign-in is separate from approval | `docs/allowance-web-v1.md:43`, `docs/allowance-web-v1.md:67` |
| Choose daily, per-purchase and lifetime; deploy limiter; SingIt pays deployment gas | `docs/allowance-web-v1.md:79`, `docs/allowance-web-v1.md:85` |
| Approve USDC once from owner's wallet; approval is a separate total | `agent-allowance/src/AgentAllowance.sol:13`, `agent-allowance/src/AgentAllowance.sol:132`, `docs/allowance-web-v1.md:93` |
| Limiter holds no tokens; spend uses transferFrom from owner to payee | `agent-allowance/src/AgentAllowance.sol:18`, `agent-allowance/src/AgentAllowance.sol:109`, `docs/trezor-allowance-v1.md:300` |
| Agent-only caller; reject over caps, at expiry or while paused | `agent-allowance/src/AgentAllowance.sol:88`, `agent-allowance/src/AgentAllowance.sol:103` |
| UTC calendar days, midnight reset; adjacent days have separate caps | `agent-allowance/src/AgentAllowance.sol:98` |
| Immutable limits; no admin/proxy/setter; changes need new limiter and approval | `agent-allowance/src/AgentAllowance.sol:21`, `agent-allowance/src/AgentAllowance.sol:30` |
| Owner or guardian can pause; guardian can do nothing else; Base pause permanent | `agent-allowance/src/AgentAllowance.sol:113`, `docs/allowance-web-v1.md:139` |
| Pause in app or wallet; revoke by approve zero, also via revoke.cash without SingIt | `docs/allowance-web-v1.md:26`, `docs/allowance-web-v1.md:134`, `docs/allowance-web-v1.md:139` |
| App shows purchases and receipts | `docs/allowance-web-v1.md:394`, `docs/allowance-web-v1.md:523` |
| Solana has no limiter contract; SPL delegate total enforced by chain; Revoke ends approval | `sign402-gateway/sign402_gateway/solana_allowance.py:3` |
| Solana daily/per-purchase/expiry checked on server before payment | `sign402-gateway/sign402_gateway/solana_allowance.py:9` |
| Solana pause refuses new purchases, retains delegate approval, lifted only by new owner-signed approval; reserved purchase may settle | `sign402-gateway/sign402_gateway/solana_allowance.py:16`, `docs/allowance-web-v1.md:142` |
| x402 402 header, offers upto then exact, Base then Solana; retry with signature | `singit-ask/README.md:32`, `docs/first-paid-call.md:40`, `docs/first-paid-call.md:177` |
| upto signs ceiling, settles actual cost plus markup and fee, refuses excess | `singit-ask/src/pricing.mjs:61`, `singit-ask/src/pricing.mjs:68` |
| exact flat price, no refund | `docs/first-paid-call.md:65`, `singit-ask/src/pricing.mjs:58` |
| X-SingIt-Limiter and X-SingIt-Spend-Limit; Base only, Solana offers unchecked; cached 15 seconds, balance not read | `singit-ask/README.md:169` |
| Settled answers carry X-SingIt-Receipt with charged amount, ceiling and optional prior limit figures | `singit-ask/README.md:180` |
| AgentAllowance covers SingIt app's own agent; independent signing wallets are outside it | `sdk/README.md:49`, `integrations/elizaos-plugin/README.md:116` |
| SDK caps are in-memory per client, reset at restart, only as strong as client | `sdk/README.md:43` |
| Plugin paid chat uses Base; caps in process memory, reset at restart, not on-chain or server-enforced | `integrations/elizaos-plugin/README.md:110` |
| Provider charge + markup + per-request network fee | `singit-ask/src/pricing.mjs:7`, `singit-ask/src/pricing.mjs:13`, `singit-ask/src/pricing.mjs:61` |
| Funded hot wallet / stored key risks funds accessible to it (problem framing inferred from compromised-key loss scope); client software limits depend on the client | `docs/trezor-allowance-v1.md:483`, `sdk/README.md:43` |
| Spend alerts report after activity rather than imposing caps | `docs/trezor-allowance-v1.md:296`, `docs/trezor-allowance-v1.md:309` |
| Sign in with email, Google or Apple as well as a wallet; signing in moves nothing | `README.md:72` |
| Base vs Solana comparison: approvals, enforcement and wallet custody; Base micro-payment float up to 0.20 USDC by default | `README.md:84`, `README.md:86`, `docs/trezor-allowance-v1.md:266`, `sign402-gateway/sign402_gateway/solana_allowance.py:6` |
| Published spend excerpt, with omission markers; caller, pause, expiry, caps, UTC day and transferFrom | `agent-allowance/src/AgentAllowance.sol:87`, `agent-allowance/src/AgentAllowance.sol:109` |
| Watcher reads Base chain; unexpected payee or unusual hourly burst pauses and alerts; guardian cannot move funds or raise caps | `docs/trezor-allowance-v1.md:296`, `docs/trezor-allowance-v1.md:300`, `docs/trezor-allowance-v1.md:304`, `docs/trezor-allowance-v1.md:311`, `agent-allowance/src/AgentAllowance.sol:113` |
| Budget buys Bitrefill gift cards/eSIMs/top-ups, capped paid live answers, per-answer chat and Venice credit | `README.md:147`, `README.md:148`, `README.md:149`, `README.md:150` |
| Base caps hold even with compromised server/agent; setup gas and normal wallet approval | `README.md:160`, `docs/allowance-web-v1.md:85`, `docs/allowance-web-v1.md:93` |
| MCP free tools without key | `integrations/elizaos-plugin/README.md:77` |

The dry technical pages describe enforcement boundaries, not guarantees about a wallet or client. No unverified signing implementation is supplied. No payments are made by refresh, generation or tests.

## Temporarily hidden models

`scripts/hidden-models.json` holds models whose listed availability has failed in paid calls. Regeneration
keeps the raw snapshot intact but removes their pages, directory entries, related links and discovery links.
The generator maintains temporary 302 redirects from both forms of each old URL to `/models/all/`.
To unhide a model after a paid call answers, remove its entry and run `node scripts/generate-model-pages.mjs`.
An entry also becomes moot once the server stops listing the model and the next snapshot drops it; remove
that stale entry when the generator warns that it is absent from the snapshot.

## Agent text files

Fetch machine-readable files (llms.txt, pricing.json, openapi.json, .well-known/x402) from https://ask.singitai.app because singitai.app is behind a browser check that blocks some default HTTP-library user agents; model pages link to the x402 seller's llms.txt there.

`node scripts/ask-routes-snapshot.mjs` refreshes `website/data/ask-routes.json` from the free public OpenAPI endpoint. It retains sorted path/method summaries and payment price ranges, excludes unsupported media routes, and records public operations without payment metadata as zero-priced. Private operations without payment metadata have no price. For offline input use `--input openapi.json --fetched-at <UTC ISO timestamp>`; `--out` selects an output file. No model call or payment is made.

Run `node scripts/generate-model-pages.mjs` after refreshing either snapshot. Its dependency-free llms renderer writes the task and money blocks in `website/llms.txt`, a short Models block, `website/llms-models.txt` (all visible model links, token prices and reference-request prices), and `website/llms-full.txt` (the llms body without markers followed by that models list). The model hold list applies to all three files. Missing required routes fail generation rather than supplying guessed prices. Route ranges come from `ask-routes.json`; markup, settlement fees and reference requests come from `models-snapshot.json`. The Errors section and existing introductory sections remain maintained by hand against the current API implementation.

Verify with `node --test website/tests/*.test.mjs` and `node scripts/generate-model-pages.mjs --check`. Both use committed snapshots without network access, npm packages or imports from the Ask service. The two extra text files have explicit plain-text headers and are excluded from the sitemap. Review and commit refreshed snapshots together with generated text.

Repeated seller rejections hide a model from live listings until an answer or a qualifying seller change restores it. Static pages use `scripts/hidden-models.json` as a temporary hold list: e2ee-gemma-3-27b, e2ee-gemma-4-31b and gemini-3.1-pro are held from 2026-11-01. After a newer snapshot lists one again, the generator warns to remove its hold entry and regenerate. The default model, automatic tier models and the four paying-agent models configured in the service never enter suspension.
