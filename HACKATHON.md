# Crypto World's Fair 2026 — development record

## Review links

- [Original SingIt project](https://github.com/bubon-ik/SingItAI)
- [Imported baseline](https://github.com/bubon-ik/singit-solana/tree/f39959059922b693f14c2a3e9bec97c87881e07b)
- [Changes since the imported baseline](https://github.com/bubon-ik/singit-solana/compare/singit-base-baseline...main)
- [Commit history](https://github.com/bubon-ik/singit-solana/commits/main/)
- [Standalone Solana client checks](solana-x402-service/CHECKS.md)
- [Managed wallet and Telegram command checks](docs/solana-wallet-checks.md)
- [First real Bitrefill Solana purchase](docs/bitrefill-solana-checks.md)
- [Native Telegram UI and purchase history checks](docs/telegram-ui-checks.md)
- [Conversation and Telegram Menu checks](docs/conversation-ui-checks.md)
- [Venice/Solana agent integration](docs/venice-solana-agent.md)
- [Integration plan](docs/solana-integration.md)

## Competition period and disclosure

The [official rules](https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf), section 5, specify September 14, 2026 at 6:00 AM PT through October 12, 2026 at 11:59 PM PT. The [Colosseum FAQ](https://colosseum.com/hackathon) permits existing code, requires disclosure of relevant previous development, and says products are judged on work completed during the competition period.

SingIt existed before this Solana effort. This repository preserves its Git history and builds on its existing agent, Base wallet, payment and approval infrastructure. Creating this repository does not make the imported code new hackathon work.

The imported baseline is `f39959059922b693f14c2a3e9bec97c87881e07b`, dated September 17, 2026. The tag `singit-base-baseline` marks the source version used for this integration. **It is not a snapshot from the competition's September 14 start.** The comparison above isolates changes in this Solana repository; it is not an exhaustive list of all work across other repositories during the competition. Imported upstream work is excluded from the Solana contribution described here.

## Existing foundation

The imported source already contains the Telegram/Hermes agent, managed Base wallets, gateway authentication, payment policies and approval channels, Bitrefill purchase flows, Base x402 tooling, and a Venice integration using Ethereum authentication. These are reused components, not new Solana capabilities. Their availability in a running deployment depends on configuration.

## Work recorded in this repository

| Date | Commit | Contribution | Evidence and limits |
| --- | --- | --- | --- |
| 2026-09-17 | [2f5c1b0](https://github.com/bubon-ik/singit-solana/commit/2f5c1b0) | Added the standalone Solana/Venice x402 client, tests, integration plan and CI workflow to the imported agent repository. | 34 local tests passed. Live Solana authentication and an unpaid Venice quote were checked. No real payment or paid model response was completed. The client was developed separately earlier in this work session and first committed here as a module; this is not a record of each individual implementation step. |
| 2026-09-17 | [57ef9c3](https://github.com/bubon-ik/singit-solana/commit/57ef9c3) | Documented the separate public repository. | Documentation only. |
| 2026-09-17 | [f0eaa0b](https://github.com/bubon-ik/singit-solana/commit/f0eaa0b) | Converted the root and Solana module README files to English. | Documentation only. |
| 2026-09-17 | [eb10f40](https://github.com/bubon-ik/singit-solana/commit/eb10f40) | Added per-user encrypted Solana wallets, mainnet SOL/native-USDC balances, explicit network routing, and `/wallet solana` / `/balance solana` in the Telegram plugin. Preserved Base wallets and blocked Solana requests from entering legacy Base spending routes. | 1,234 gateway tests and 284 plugin tests passed. A temporary empty wallet was accepted by the Solana SDK; live mainnet RPC returned zero SOL and USDC. No production deployment, real Telegram transport run or payment. |
| 2026-09-18 | [19ae280](https://github.com/bubon-ik/singit-solana/commit/19ae280) | Refreshed native Telegram navigation, added named inline shopping controls and order review, editable operation cards, a Base/Solana wallet selector, and private purchase history with selected-order code reveal. | 1,245 gateway tests and 302 plugin tests passed, including actual PTB handler/markup construction with mocked transport. Existing Base approvals and spending policy remain in place. No Mini App, live bot deployment or Solana payment integration. [Details](docs/telegram-ui-checks.md). |
| 2026-09-19 | [37f7863](https://github.com/bubon-ik/singit-solana/commit/37f7863) | Replaced persistent Telegram navigation with native Menu and inline controls; added free-text AI entry, model/budget review and approval before the saved first question, payment-aware settings, safe cancellation and catalog search shortcuts. | 1,246 gateway and 332 plugin tests passed locally and on the VPS. Deployed to the existing bot at `a2ac835`; native Telegram Menu verified via API. Payments and transport tests were mocked; agent spending remains on Base. [Details](docs/conversation-ui-checks.md). |
| 2026-09-20 | [858a11e](https://github.com/bubon-ik/singit-solana/commit/858a11e) | Added Settings beside Wallet on Home, explained phone linking before payment, and put WhatsApp/iMessage connection first in Settings. | 332 plugin tests passed locally and on the VPS. Deployed to the existing bot; 95 wallet records and purchase history preserved. Existing phone verification and payment controls are unchanged. |
| 2026-09-20 | [PR #3](https://github.com/bubon-ik/singit-solana/pull/3) · [715d919](https://github.com/bubon-ik/singit-solana/commit/715d919), [337e777](https://github.com/bubon-ik/singit-solana/commit/337e777) | Integrated Venice into managed Solana wallets, added an AI network selector, separate per-network models/budgets, exact-quote phone approval, persistent payment holds and read-only recovery. | 1,289 gateway, 343 Telegram and 39 Node tests passed locally and on the VPS; all seven CI checks passed. Deployed at `337e777`, preserving 95 Base and 1 Solana wallet. Live managed-wallet SIWX balance and an unpaid quote were verified; no live Venice payment or paid Solana answer has been completed. [Flow and limits](docs/venice-solana-agent.md). |

The Venice client implements Solana SIWX authentication, mainnet USDC quote validation, explicit quote approval, SDK transaction construction, durable payment attempts, duplicate prevention and read-only reconciliation. Its Venice payment flow has only been exercised with mocked network responses.

### September 18: first real Bitrefill purchase

An operator-assisted Alza CZ 200 CZK purchase completed through the project Bitrefill MCP client and the Solana SDK payment wrapper. The final charge was 9.44 USDC, the exact transaction was confirmed on mainnet, and the actual gift-card code was retrieved using the paying wallet. [Evidence and limits](docs/bitrefill-solana-checks.md) · [Record history](https://github.com/bubon-ik/singit-solana/commits/main/docs/bitrefill-solana-checks.md).

Temporary helpers coordinated this live check; it does not constitute a reusable Bitrefill Solana adapter or a deployed Telegram purchase flow. No redemption data, buyer email or payment credentials are published.

### September 18: existing Telegram bot updated

At the owner's explicit request, release
[`6b3c2f5`](https://github.com/bubon-ik/singit-solana/commit/6b3c2f5) replaced the
existing VPS bot after private backups. It retained the existing bot identity,
Base wallets, configuration and purchase history. Before switching, 1,245
gateway tests, 302 plugin tests with the server's installed Telegram library,
and 46 CDP helper tests passed. Both services started, gateway health and
Telegram authentication succeeded, and unauthenticated purchase-history access
was rejected. Manual Telegram navigation and a purchase through the refreshed
UI remain unverified. This deployment does not enable Solana spending through
the bot. [Deployment checks](docs/telegram-ui-checks.md#existing-vps-bot-replacement).

### September 19: conversation and native Menu deployed

Release [`a2ac835`](https://github.com/bubon-ik/singit-solana/commit/a2ac835)
updated the existing VPS bot after private backups and server-runtime checks.
All 95 wallet records, configuration and purchase history were verified intact.
Both services are healthy; Telegram API confirms the six-command native Menu.
No live inference or purchase was performed for verification.
[Deployment details](docs/conversation-ui-checks.md#existing-vps-bot-updated).

### September 20: optional natural-language routing (local verification)

[619ec8c](https://github.com/bubon-ik/singit-solana/commit/619ec8c) adds a
TypeSafe-based entry point to the imported Telegram plugin. Ordinary messages
can select existing catalog and read-only wallet workflows without first
opening Venice chat. Direct delivery, physical-goods and booking requests
offer gift cards only as a separately accepted alternative. This is application
routing work, not a new Solana payment integration.

All 313 plugin tests passed locally (284 existing plus 29 new), using mocked
provider responses. No live TypeSafe request, bot deployment or purchase was
performed. The feature is disabled by default. Semantic accuracy, product
matching beyond catalog categories, and reconciliation with the deployed bot
remain unverified. See [setup and limitations](docs/natural-language-assistant.md).

### September 21: TypeSafe validation against the deployed code

The natural-language routing work was integrated with `venice-solana` at
`337e777` plus its documentation follow-up `8a5de52`. All 375 plugin tests
passed using the VPS bot's actual runtime, including native Telegram checks.
Seven synthetic live TypeSafe requests returned the expected decisions in
0.60–0.71 seconds. This verifies the configured API key and a small sample of
intents; it is not a production accuracy benchmark. No purchase or wallet
payment was performed. Pending chat setup and genuine Venice conversation
remain supported. See [verification details](docs/natural-language-assistant.md).

Release [`adca498`](https://github.com/bubon-ik/singit-solana/commit/adca498),
[PR #4](https://github.com/bubon-ik/singit-solana/pull/4), is now installed on the
existing bot. All six applicable CI checks passed. Private backups and state
comparison confirmed preservation of 95 Base wallets, 1 Solana wallet, bot
configuration values and purchase history. Only the Telegram service restarted;
the payment gateway remained running. An initial formatting-only `.env`
difference triggered a code rollback; a second attempt verified parsed values
and completed successfully. Real Telegram conversations remain a manual check.

### September 21: conversation routing corrections

[PR #4](https://github.com/bubon-ik/singit-solana/pull/4) also fixes two failures
reported in Telegram screenshots: a borderline eSIM classification now prompts
a focused confirmation, and catalog browsing no longer traps new balance
questions. Checkout fields retain their existing input handling. All 382 plugin
tests passed in the server runtime. A live TypeSafe harness replayed the exact
internet, Czech food, gift-card and repeated Base-balance messages with fake
catalog/wallet handlers. Actual Telegram delivery and catalog availability after
this fix remain manual checks; no purchases or wallet payments were made.

Fix [`0647997`](https://github.com/bubon-ik/singit-solana/commit/0647997) was then
deployed to the existing bot after all six GitHub checks passed and a fresh
private backup was created. Only Telegram restarted; both services are active.
All 95 Base wallets, the Solana wallet, configuration values and purchase history
were verified preserved.

### September 21: pending-task context correction

[PR #4](https://github.com/bubon-ik/singit-solana/pull/4) additionally fixes the
reported US-food conversation: free-form gift-card follow-ups retain the pending
country/category, and a newly recognized task can interrupt a country question.
Expired context is not reused; explicit new fields replace previous fields.
Provider failure preserves pending context and local cancellation rejects late
classification results. All 391 plugin tests passed in the VPS runtime. Live
TypeSafe checks with fake catalog/wallet handlers passed the exact reported
conversation, balance interruption during country clarification, and a country
name completing an eSIM request. Post-fix Telegram delivery remains a manual
check; no wallet payment or purchase was made.

Context fix [`b371841`](https://github.com/bubon-ik/singit-solana/commit/b371841)
was deployed after all six GitHub checks passed. A fresh private backup and
post-restart comparison verified all 95 Base wallets, the Solana wallet,
configuration and purchase history intact. Only Telegram restarted; both
services are active and the payment gateway process stayed unchanged.

### September 21: conversation regression audit

[PR #4](https://github.com/bubon-ik/singit-solana/pull/4) expands the checks from
reported phrases to browsing/pending-state transitions, cancellation, duplicate
and delayed messages, expiry and provider failures. Fixes add bounded enum
context to classification, natural follow-up replies, network clarification,
short wallet-task interruption of search, explicit all-category changes and
recovery of cancelled loading screens. Private checkout input stays local.

A repeatable opt-in live classifier harness covers 18 synthetic conversations
with fake Telegram/catalog/wallet handlers. The first run failed five cases;
all 18 passed after correction. This is regression coverage, not a guarantee of
arbitrary-language accuracy or verification of real Telegram delivery. No
purchase or wallet payment was made. All 414 plugin tests passed in the VPS
runtime. See the [verification instructions](docs/natural-language-assistant.md#conversation-regression-audit).

Release [`2015199`](https://github.com/bubon-ik/singit-solana/commit/2015199)
was deployed after all six GitHub checks passed. A fresh private backup and
post-restart comparison verified preservation of 95 Base wallets, the Solana
wallet, configuration and purchase history. Only Telegram restarted; both
services are active and the payment gateway process stayed unchanged.

### September 22: Exa search for Solana Venice chat

[PR #5](https://github.com/bubon-ik/singit-solana/pull/5) extends the current conversation release with a fixed
Exa x402 v2 search adapter, per-user Solana signing, a separately approved search
budget, durable payment holds/recovery, source links and a separate cost/receipt
in the selected Venice model's answer. Base search behavior is retained.

The exact unpaid request returned HTTP 402 with a 0.007-USDC Solana option and
sponsored fees. Offline tests cover consent, limits, concurrency and recovery;
the full SVM fixture uses real transaction signatures against local providers.
Local checks passed: 1,309 gateway tests, 422 plugin tests and 49 Solana Node
tests. No real Exa payment or paid Venice answer was sent. See the
[feature record](docs/exa-solana-chat.md) for limits and verification.

Release [`12d8dc0`](https://github.com/bubon-ik/singit-solana/commit/12d8dc004235352262bb5c22fbbb124e8ad72e9b) was deployed to the existing bot after all seven
GitHub checks and the full VPS test suites passed. A private backup and post-restart
checks preserved 95 Base wallets, the Solana wallet, configuration and history.
Authenticated Exa review and signed Venice balance checks passed; search stayed
off and no real payment was made. [Deployment evidence](docs/exa-solana-chat.md#existing-vps-deployment).

### September 22: model-selected Solana web search

[PR #5](https://github.com/bubon-ik/singit-solana/pull/5) adds semantic search
selection by the user's chosen Venice model. Its first completion either answers
or requests one Exa query; the final completion receives the original question
and retrieved sources. Search no longer depends on freshness keywords. The
separate standing budget, payer/merchant binding, durable holds and one-search
limit remain enforced by the gateway. Both model completions use Venice credit.

Offline coverage includes implicit research questions, translations containing
search keywords, strict control replies, missing consent, expiry/pause between
stages, original-question/model preservation, receipt retention and refusing a
second search. Real funded model/search quality evaluation remains pending;
scripted provider fixtures are not evidence of every model's semantic accuracy.
Local checks passed: 1,319 gateway tests, 423 plugin tests and 52 Solana Node tests.

### September 29: web search and live data from a Solana wallet on the web page

On app.singitai.app a Solana wallet approves an SPL allowance to its agent once; the agent then pays straight
from the owner's USDC account as delegate, within limits the server enforces, with the seller's fee payer
sponsoring the fee.

[`dfa47b7`](https://github.com/bubon-ik/SingItAI/commit/dfa47b7) adds Exa web search to the web chat: a
question about now is searched once and Venice answers from the pages, with the price and links under the
answer. The Exa payment on Solana is built by `buildDelegated` from the owner's account. Verified on mainnet
after deployment: a real 0.007-USDC search, transaction
[`4Lr4rE…Sesd6`](https://solscan.io/tx/4Lr4rECE7GzLjuyf6TZcZdgnXLgyjykQnj52tEHp9knrH6kNzaBdgMv8LMEwDS82SkoySdSRYDC9ajKDeu9Sesd6),
signed by the agent as delegate, paid to Exa's Solana address, fee sponsored; the allowance and the day's limit
fell by the same amount.

[`6334ca4`](https://github.com/bubon-ik/SingItAI/commit/6334ca4) adds live data per question, picked from
Coinbase's Agentic Market and PayAI's Bazaar: weather, exchange rates, token and stock prices, Polymarket, crypto
news and funding rates (Otto AI), reading a link (Exa), a flight's status (FlightAware) and flight prices (Google
Flights) via stabletravel.dev, and Tripadvisor places. The bridge's new `data-pay` pays only listed hosts, only
the address bound for each seller, never above its ceiling, one attempt per request. Unpaid 402 checks confirmed
every source's Base and Solana address and price. Local checks passed: 1,581 gateway tests and 74 Solana Node
tests. No real live-data payment has been made yet.

### September 29: correct phone-call refusals on the web page

[`b8058ca`](https://github.com/bubon-ik/SingItAI/commit/b8058ca) rejects numbers outside StablePhone's
published `+1` format before showing a call card or attempting payment, including drafts saved before
this change. The page shows a call as started only after the provider returns its call ID; refusals and
lost responses no longer show a success checkmark or automatically repeat the request. This follows
[`a1640bc`](https://github.com/bubon-ik/SingItAI/commit/a1640bc), which keeps settlement queries within
the Base RPC's ten-block limit so they no longer hide the provider's refusal.

Verification: 211 web gateway tests and five frontend call-state regression tests passed. The observed
production attempt returned HTTP 400, `Validation failed`. Czech `+420` calls are not supported by this
integration; a successful real call has not been verified. These fixes do not add a new calling provider.

### October 11: authentication and allowance audit fixes (local verification)

Local working-tree changes in the merged SingItAI project, based on
[`e47cb33`](https://github.com/bubon-ik/SingItAI/commit/e47cb33ba3f63e1ff8ceb564d238cb688867f574).
Commit/PR for these fixes: not yet created. This entry records verification, not a deployment.

The Solana allowance now reserves regular and metered payments against current
limits atomically across database connections. Wallet-signed SOL funding checkpoints
its public signature/blockhash before sending and reconciles uncertain outcomes
without resubmission. The shared web app pins each tab to its authenticated payer
and lets a newly connected user select Base or Solana before explicitly signing in.
These are fixes to the existing merged authentication/payment lanes, not a new
wallet provider or a new merchant integration.

Verification: 1,784 gateway, 79 Solana client and 24 website tests passed in the
current working tree. A local Chrome smoke test used generated unfunded signers,
the actual page/API and a mocked wallet connection to verify Solana selection and
cross-tab account changes. The audit's stale-limit, concurrent-payer and stuck-funding
reproductions no longer trigger. No payment, production deployment or full real
social OAuth callback was performed; old uncertain operations without a saved
transaction signature still need investigation. [Detailed evidence and remaining findings](docs/security-audit/2026-10-11-auth-wallet-review.md).

The October 11 follow-up also fixes private Solana allowance database permissions,
adds owner/chain/address binding to managed Base ciphertext with key-preserving
legacy migration, and bounds/rejects malformed web request bodies. A5's setup text
is deferred by the owner. An isolated baseline-plus-fixes release passed 1,786
gateway, 79 Solana and 24 website tests; four migration/installer checks passed
afterwards. A server dry run verified 97 Base and three Solana managed wallets
using a temporary database copy. On the VPS the staged gateway suite passed
(1,790 discovered; one initial Node/PATH skip then covered by a passing 14-test
module), as did all 79 Solana and 24 website tests. The release is staged, not deployed: unattended
sudo is unavailable. Commit/PR: not yet created. [Installation, verification and
limitations](docs/security-audit/2026-10-11-release.md).

### October 24: free models with network, account and budget limits (local verification, SI-69)

Local working-tree changes in the merged SingItAI project, based on
[`535001b`](https://github.com/bubon-ik/SingItAI/commit/535001b). Commit/PR: not yet created. This entry records
verification, not a deployment.

SingIt Ask's free answers (`free/<id>`) are now counted per client network (IPv4 /24, IPv6 /64) instead of per
address, can be held to an optional daily dollar budget (`SINGIT_ASK_FREE_BUDGET_USD_PER_DAY`, unset = no check),
and are listed as `free: true` models in `/v1/models`, `/openapi.json` (`x-free-models`) and the Bazaar input
schema. The gateway gains free models for signed-in wallets on the API-key `/v1`, limited per account, per
network and per day, separate from the paid limits, and **off** unless `SIGN402_WEB_FREE_MODELS` is set. Free
answers on SingIt Ask carry no wallet, so there is no wallet limit there. `scripts/free-model-cost.py` and
[`docs/free-models.md`](docs/free-models.md) give the worst-case cost per free answer for five candidate models
from a saved `/v1/models` snapshot, with the real usage (10 free answers in 30 days) and the owner decisions
needed.

Limits: nothing is deployed and no free model was changed; the gateway part and the budget stay off until the
owner sets them. The Bazaar input-schema change has not been checked against Coinbase's real facilitator.

### October 26: Base and Solana payer reporting (local verification, SI-86)

Extension of the imported Base payer script (PR #90) adds Solana
USDC balance attribution, read-only agent-address database exclusions and configurable
atomic-amount filters. Both filtered and unfiltered metrics are shown per chain and
combined. Branch feat/si86-payers-solana; no deployment.
Verification: `python3 -m unittest discover -s scripts/tests` — 228 tests passed.
Limitations: amount matching cannot identify the purchased endpoint; Solana history
depends on RPC retention and currently discoverable token accounts, and zero-delta
transactions are discarded before aggregation. This is new reporting work in the
merged tree, separate from the imported Base scanning behavior.

## Pending work — not claimed as completed

- Manually verify the deployed wallet commands and refreshed navigation in Telegram.
- A real mainnet Venice payment and paid response through the agent.
- A real Exa search paid through the Solana agent and its sourced Venice response.
- Integration of the verified Bitrefill Solana route into the per-user agent, approvals and durable recovery.
- A custom x402 stock-purchase endpoint.

## Evidence to maintain during development

For each completed feature, add the date, commit or pull-request link, user-visible behavior, verification results and remaining limitations. Keep feature commits focused and push completed milestones regularly. Preserve published history and the baseline tag. Do not change timestamps or describe planned behavior as implemented.

Record mainnet transaction links only after actual execution and add short demo recordings for completed agent flows. Do not publish private keys, auth tokens, payment payloads or redemption data. At submission, link a fixed final commit or release and its comparison with the baseline, and copy the prior-work disclosure into the submission form. Git history, public progress updates, tests and demos provide complementary evidence; commit dates alone do not establish when every line was developed.

## October 27, 2026 — SingIt Ask settlement safety and reasoning controls

Draft pull request on `fix/settle-race-reasoning` (not merged, not deployed):
[permit guard](singit-ask/src/permit-guard.mjs), [payment hooks](singit-ask/src/metered.mjs),
[reasoning controls](singit-ask/src/app.mjs), and [regression tests](singit-ask/test/permit-guard.test.mjs).
This maintains the imported SingIt Ask service; it adds no new Solana wallet or payment lane.

Successful settlements now remember consumed EIP-2612 permit nonces across routes, rejecting stale permits before
verification and inference. Failure hooks redact payment identifiers, overrun diagnostics report token usage and
cost without changing pricing, and reasoning-only models receive the nested effort control with the existing
low-effort retry. Pre-settlement answer logs now describe settlement as pending.

Verification: `npm test` under Node 22: 218 of 219 pass; the one failure (`test/solana-direct.test.mjs`, module
link error) fails the same way on `main` without this change. No live payments were sent. The nonce memory is local to one process, bounded to 10,000 owner/asset pairs and
expires after ten minutes; it does not coordinate concurrent requests or replicas and does not replace chain validation.

### SingIt Ask observed health and numbers

This follow-up to imported, ongoing SingIt Ask functionality adds observed model and payment-rail health
on `GET /health`, settled usage counters on `GET /numbers.json`, and a website status page.
It adds no new Solana transaction functionality.

Verification: `npm test` in `singit-ask` passes 351 tests; website tests pass 115 tests.
Tests use fake facilitators and send no payments. Counters start empty at deployment, with no history
before their creation; hourly windows are retained for 30 days and unique counts are bounded.
This change is not deployed until it is merged and SingIt Ask is restarted.

## October 30, 2026 — Restore the DeepSeek uncensored model page

Uncommitted work on `feat/unhide-deepseek-uncensored` (no commit or PR yet): restores
`deepseek-v4.1-flash-uncensored` to the generated website and discovery files and removes
its temporary redirects. This maintains the imported SingIt website; it adds no Solana
payment functionality. The seller recovered for six hourly checks after `no_healthy_sellers`.

Verification: model-page generation and `--check` pass. Both requested Node test suites
were run; sandbox child-process `EPERM` prevents full passes. Diagnostic runs with test
isolation disabled report website 350 pass / 4 fail and scripts 38 pass / 1 fail / 1 skip;
all failures depend on child processes. No endpoints were refetched or paid calls made;
answerability after the hide remains unverified. The supplied snapshot updates pricing
for 52 other models; DeepSeek's prices are unchanged.

### 31 October 2026 — Ask external-payer and 402 counters (draft PR, not deployed)

Ask's own-payer list now has a tested parser and a fail-closed read at startup, and adding the list removes own
wallets from the historical unique-payer hashes. `/numbers.json` gains `own_payers_configured`. New private counters
record how many 402 responses Ask issued (POST challenges, GET/HEAD discovery probes, refusals without a challenge),
by paid route and in 24 h / 7 d windows; they are reachable only through a read-only CLI or a token-protected
`GET /internal/stats` and are not public. Limits: calls and volume recorded before the own list was configured still
include own payments (payer-level history is not stored), and 402 counts are responses, not unique clients. See
`singit-ask/README.md` and `docs/analytics.md`.

### 31 October 2026 — six free models and a shared daily cost cap (draft PR, not deployed)

SingIt Ask's free tier goes from one model to six (`free/openai-gpt-oss-20b`, `free/gemma-4-e2b`,
`free/gemma-3-27b-it`, `free/mistral-small-3.2-24b-instruct`, `free/qwen3-coder-30b-a3b-instruct`,
`free/deepseek-v4.1-flash`). A shared cap of $0.25 a day on what free answers cost upstream is on by default:
each answer's worst-case cost is reserved before the call and replaced by the reported cost afterwards, and the
day's spend and answer count are kept in a small private state file so they survive a restart. When the cap is
spent, free routes return 429 `free_budget_exhausted` with `Retry-After` until midnight UTC. Per-network limits
are unchanged. Limits: after a crash, answers that were in flight count as spent (stricter, never looser); an invalid state file
fails closed until midnight UTC; per-network counters still reset on restart, and the cap is per process. Details in `docs/free-models.md`.

## October 31, 2026 — Privacy pages on singitai.app

Branch `privacy-singitai` (draft PR): moves the existing
Privacy Policy and data-deletion instructions into the SingIt website's shared
page styling at `/privacy/` and `/data-deletion/`. This maintains imported SingIt
website functionality and adds no Solana payment functionality. Policy substance,
contact details and the July 10, 2026 effective date are preserved; no terms page
was added. Repository links, the shared generator template, sitemap and generated
LLM discovery files point to the new pages.

Verification: both page generators and their `--check` modes pass; a local build
includes both pages and source-content comparisons preserve all original policy
paragraphs and list items. Website and JavaScript script tests with isolation
disabled report 432 pass, 5 fail and 1 skip; the same five child-process output
failures reproduce on unchanged HEAD. All 263 Python script tests pass. All nine
package `npm test` commands were attempted offline: `singit-risk-check` passes;
the remaining packages lack installed dependencies (including viem, express,
@solana/kit and rxjs). No dependencies were downloaded. The final old-host search
returns no matches. Nothing was published, committed or pushed, and no network
requests or payments were made.

### Post-competition maintenance — 2026-11-02

Ask: every reasoning-tagged model now gets a priced 256-token thinking floor, one retry at a larger budget inside the signed ceiling before a 422, a per-model 422 counter in `/health`, and one-sentence examples that answer within 400 tokens. Branch `fix/reasoning-floor`, draft PR #208. This is shared Ask maintenance, not a new Solana contribution. Verification: singit-ask 629 tests, website 437, scripts 46, `bazaar-lint` 22 routes with 0 failures; no paid calls. Limitation: only a paid answer proves a route end to end.

## Daily model audit — 2 November 2026

Operational follow-up in the merged SingItAI tree (branch `feat/daily-model-audit`, draft PR #211): `scripts/singit-model-audit.py` checks the paid-route inventory, unpaid listing prices against max_tokens 400 and 2000 quotes, the `/health` outcome windows, the Surplus order books and one free canary per free model. It sends no payment header and alerts only on changes through the existing health-alert delivery. This is shared service monitoring, not a new Solana payment feature. Verification: 19 audit tests and the existing health-alert tests, plus a read-only dry run against the live service. The systemd units are uninstalled templates; no paid answers were made.

### Post-competition maintenance — 2026-11-05

Shared Ask stages 1a/1b on `feat/x402-agent-chat` (draft PR work; stage 1a committed as [88908f1](https://github.com/SingItAi/SingItAI/commit/88908f1), stage 1b in the same draft PR): paid chat supports tools, tool replies, text/image blocks and larger agent envelopes. Stage 1b adds buffered SSE for chat/Messages/Responses, privacy-bounded client counters and a fake-only SDK session script. This is shared Ask maintenance. Verification uses fake upstreams/facilitators and socket-free HTTP; no live payment or seller acceptance is claimed.

Shared Ask maintenance on `feat/payment-error-codes` (draft PR):
paid routes now expose safe refusal codes, recovery actions and `X-SingIt-Error`,
with optional persisted counters by code. This covers Base and Solana and is not a
new Solana competition contribution. Legacy local 409 bodies remain unchanged.
Verification: 59 focused socket-free payment/error/health tests pass; generated
LLM documentation is current. Full Ask and website/script suites were compared
against unchanged `origin/main` c5d442d using the installed dependencies: the same
31 Ask test files and six website/script tests fail in this sandbox, including
unavailable local listeners, child-process output and missing Solana dependencies.
Limitations: no live facilitator, network requests or real payments were used;
normal listener-based OpenAPI checks remain blocked by the sandbox. All five
OpenAPI schema/example/lint tests pass in a temporary copy using the existing
socket-free request harness in place of the generator's listener.

### API-key readiness follow-up (5 November 2026, post-competition)

Draft PR from `feat/key-path-readiness` in SingItAI: adds a standard-library zero-spend
key-path checker with an opt-in daily workflow (skipped until the owner sets
`KEY_CHECK_ENABLED`), and shares actionable tools-refusal guidance between the free and
fallback gateway routes. This is maintenance of the imported gateway, not new Solana work.
Verification: full gateway suite (2,251 tests), the 12 checker tests (ten scenarios against a
loopback server) and the existing script tests pass. Not verified: the live API, the workflow
on GitHub, the server's paid-proxy setting (only the owner can read it) and the paid tools
scenario, which is opt-in and was never run. A full probe needs eight requests (nine with paid
tools), because balance and usage are read before and after.

Merge verification on `feat/x402-agent-chat` (uncommitted merge of `origin/main`,
5 November 2026): preserves stages 1a/1b alongside payment refusal codes,
key-path readiness and metadata. Five focused persistence checks pass, including
agent traffic and payment refusal counters round-tripping in one state file.
The socket-free Bazaar harness reports no findings across advertised routes;
error vocabulary and generated LLM references are consistent. The LLM generator
now has an offline CLI and a working `--check`. Limitations: full suites were run,
but this sandbox blocks loopback listeners and some child-process output;
no live upstream, network request or real payment was used.
## Media API review hardening — 5 November 2026

Uncommitted worktree follow-up (no commit or PR yet, as requested), after the competition period: image edits and embeddings validate billable output, bound streamed upstream responses and embedding batches, and share process-wide payment reservations. EVM replay identity uses normalized network, asset, signer and nonce; Solana uses the signed transaction or signature. `/pricing.json` includes both services with reference requests and network prices. This hardens the new media routes; existing image generation has not yet adopted the shared reservation store.

Verification: 13 socket-free media tests and 24 OpenAPI, discovery and generated-document tests passed offline. Route snapshots were regenerated offline and confirmed unchanged for these schema changes. The full service suite was attempted but cannot be verified here: the sandbox denies loopback listeners (`EPERM`). No live upstream calls, payments, deployment or commits were made. Reservations remain in memory and are scoped to one process.

Round 6 review (uncommitted, no PR): the cross-route reservation regression now uses equal quoted prices and asserts one upstream call. Media response caps are enforced before diagnostic logging clones the body, so oversized success and error streams cancel their source promptly. Six selected socket-free media tests pass, including a new logger/limiter regression covering both routes at 200 and 500 with fewer than five source pulls. Eleven additional logging/OpenAPI checks pass; 17 listener-dependent checks and the full media-file attempt remain blocked by sandbox loopback restrictions. No network calls or commits were made; the full suite still needs an unrestricted rerun.


PR SingItAI #218 (`feat/images-edits-embeddings`), review fixes after merging main (5 November 2026): billable base64 images now require complete PNG/JPEG/WEBP containers (PNG also checks chunk CRCs and bounded decompression); embeddings must decode to whole finite float32 vectors; replay reservations are normalized (network, asset, signer, nonce), shared by both routes and capped at 10,000 entries without evicting live identities; upstream bodies are read with byte limits; /pricing.json lists embeddings. Verification: singit-ask 723 tests pass (solana-direct needs @solana/kit, not installed locally), website 470/470, scripts 46/46, llms check ok (llms.txt 13,982 bytes). No payment or live upstream call. Limitations: no full JPEG/WEBP pixel decoding or HTTPS URL check; reservations are process-local.

## M1 unified catalog draft — 5 November 2026

Uncommitted local draft on `feat/models-m1` (no commit or PR created; publishing is not approved). This is post-competition discovery work on the merged SingIt service: `/v1/catalog` groups the existing chat, images, edits, embeddings, speech, transcription and search sources, preserving `/v1/models`. It adds static catalog generation and tests for modality filters, payment/kind flags, reference-price agreement and disabled-video discovery. Remote MCP remains unchanged; the proposed parameter is documented in the local draft PR description.

Verification: five new catalog tests pass without payments or upstream calls; catalog, llms and existing model-page generation checks pass. The full service suite was attempted: loopback listeners are denied (`EPERM`) and `@solana/kit` is absent. Website build-based checks also fail in this sandbox; no shared helpers or listener-dependent generators were rewritten. Limitation: the offline catalog snapshot captures chat and search only; a full media capture is required before publication. See `docs/catalog.md` for counts, semantics and regeneration. No network, installs, commits, deployment or publishing.

## M4 music and sound effects — 5 November 2026
Uncommitted local draft on `feat/models-m1` (no commit or PR created; publishing is not approved). This is post-competition discovery work on the merged SingIt service: `/v1/catalog` groups the existing chat, images, edits, embeddings, speech, transcription and search sources, preserving `/v1/models`. It adds static catalog generation and tests for modality filters, payment/kind flags, reference-price agreement and disabled-video discovery. Remote MCP remains unchanged; the proposed parameter is documented in the local draft PR description.

Verification: five new catalog tests pass without payments or upstream calls; catalog, llms and existing model-page generation checks pass. The full service suite was attempted: loopback listeners are denied (`EPERM`) and `@solana/kit` is absent. Website build-based checks also fail in this sandbox; no shared helpers or listener-dependent generators were rewritten. Limitation: the offline catalog snapshot captures chat and search only; a full media capture is required before publication. See `docs/catalog.md` for counts, semantics and regeneration. No network, installs, commits, deployment or publishing.

## M4 music and sound effects — 5 November 2026
Uncommitted local draft on `feat/models-m1` (no commit or PR created; publishing is not approved). This is post-competition discovery work on the merged SingIt service: `/v1/catalog` groups the existing chat, images, edits, embeddings, speech, transcription and search sources, preserving `/v1/models`. It adds static catalog generation and tests for modality filters, payment/kind flags, reference-price agreement and disabled-video discovery. Remote MCP remains unchanged; the proposed parameter is documented in the local draft PR description.

Verification: five new catalog tests pass without payments or upstream calls; catalog, llms and existing model-page generation checks pass. The full service suite was attempted: loopback listeners are denied (`EPERM`) and `@solana/kit` is absent. Website build-based checks also fail in this sandbox; no shared helpers or listener-dependent generators were rewritten. Limitation: the offline catalog snapshot captures chat and search only; a full media capture is required before publication. See `docs/catalog.md` for counts, semantics and regeneration. No network, installs, commits, deployment or publishing.

## M4 music and sound effects — 5 November 2026### Post-competition draft: M2 async speech (5 November 2026)

Local branch `feat/models-m2`, based on `08f53bc`; no commit or PR created (the task prohibits commits and network access). This extends the imported SingIt Ask speech gateway for three Surplus async speech models on its existing Base and Solana payment routes; it is post-competition work, not a new competition-period Solana contribution. See [M2 draft details](docs/m2-speech.md) and [generated draft resources](docs/m2-speech-draft.json) for mappings, prices, verification and limitations. Offline async/OpenAPI/llms checks passed. Listener-based HTTP settlement checks are blocked by sandbox EPERM. The provisional upstream text/voice adapter and provider limits require an explicitly approved paid verification before merge. Draft only; not approved for merge or deployment.


M2 review follow-up, SingItAI #221 (`feat/models-m2`, 5 November 2026): artifact downloads now follow at most three HTTPS redirects, validate literal IPs and every DNS answer on each hop, and omit credentials across origins. Async speech job prices come from validated live catalogue pricing; invalid prices hide the model and return 503 before payment. Ask speech/async tests pass outside the sandbox. Artifact download pins the validated address on the TLS socket so a DNS rebind cannot switch hosts after validation.## Post-competition M3 draft — 5 November 2026

The merged SingIt Ask gateway has a local draft addition for NVIDIA Nemotron 3.5 Lightning on branch `feat/models-m3` (base `08f53bc`). This extends existing Surplus chat functionality; it is not new Solana wallet work or a competition-period claim. [Draft review, offline verification and owner questions](docs/m3-nemotron-review.md) records the public/upstream mapping, paid terms and metadata limitations. Commit/PR link is pending: this task explicitly prohibits commits, pushes and network access. The draft is not approved for merge. Mock payment checks cover Base and Solana; live upstream cap acceptance and full listener-dependent suites remain unverified.## M4 music and sound effects — 5 November 2026
Uncommitted work on `feat/music-sfx-m4` (no commit or PR, as requested), after the
competition period: new SingIt Ask routes `/v1/audio/sound-effects` and
`/v1/audio/generations`, offering exact USDC on Base and Solana. This extends the
imported gateway; it is not part of the original competition implementation.
Five pinned public model aliases map to the supplied offline Surplus catalogue.
The shared media-job runner submits with SingIt's prepaid key, polls, downloads
within 60/180 seconds and 5/25 MiB, checks audio container magic, and returns bytes
before settlement. Artifact redirects require HTTPS and public DNS addresses;
TLS downloads pin the checked address. Failures return 503 without settlement.
OpenAPI, discovery, flat network prices and the sibling generation-model list are
updated; the 27-route Bazaar metadata remains draft, not published. Video visibility
is unchanged. `website/llms.txt` is unchanged at 13,982 bytes.

Verification offline: 13 shared job tests, three direct-handler/discovery tests,
three OpenAPI lint tests, two schema/example tests and 11 validator unit tests pass.
Additionally, 14 Bazaar unit checks and one pricing unit check pass. Listener-based
checks cannot run in this sandbox (confirmed `EPERM` on loopback): four new x402
settlement cases, 11 discovery checks, five OpenAPI error checks, 11 pricing checks
and the app-wide Bazaar lint. Existing shared test helpers and generators were not
rewritten. No network calls, installs, payments, publication, deployment or commits.

Limitations / OPEN QUESTIONS: supplied docs omit the music/effects submission
schema. `surplusAudioRequest` isolates assumed music fields
`model,prompt,lyrics,instrumental,duration_seconds` and effects fields
`model,text,duration_seconds,response_format`, both sent to `/v1/music/generations`.
Confirm the effects endpoint, format support, duration field and flat billing through
240 seconds before rollout. Container checks are not full audio decoding; replay
reservations remain process-local. Solana transaction validity must last through
completion and settlement; the 180-second music deadline may outlast a recent blockhash.


M4 safety follow-up (2026-11-05), commit `M4: fix tests, Solana settle-before-job`
on `feat/music-sfx-m4` (following f2fa755): the new music/effects routes now refuse
Solana rather than retaining a signed transaction across generation. A recent
blockhash lasts about 150 blocks / 60–90 seconds; a 180-second job cannot safely
precede settlement. Future Solana support requires settling before submission and
durable refund/recovery handling. The earlier draft's long-validity requirement
above is superseded, not a supported workaround.

Audio availability now fails closed without an integration readiness snapshot
confirming Surplus credit, routes and pinned prices; standard production startup
has no adapter and leaves this draft unavailable. Unservable models stay hidden.
Base still generates and validates bounded audio before settlement; middleware
buffers delivery until settlement succeeds. OpenAPI bounds share the price helper.
Artifact DNS pinning, HTTPS redirects and credential stripping were reviewed;
reserved address filtering was tightened. Video was not changed.

Verification: full singit-ask suite outside the sandbox after the readiness stub
in openapi-errors: pass except the known solana-direct env failure (@solana/kit
not installed). Listener-based audio settlement tests pass. No external requests,
payments, deployment or secrets. Open rollout questions remain: Surplus submission
schema/effects endpoint, flat billing through 240 s, live readiness integration,
and durable replay protection across processes.

M5 hidden draft (2026-11-05), branch `feat/video-m5-hidden`: video stays off by default
(`SINGIT_ASK_VIDEO_SOLD` / discoverable untouched). Solana offers removed; a Solana payment
header is refused before a job starts (same blockhash rule as M4 music/SFX). Base hold-and-poll,
health gate and fallback unchanged. No paid call, no deploy, no announcement.

M4 audio readiness follow-up (2026-11-05), branch `feat/audio-readiness`: adds opt-in audio sales and separate
x402 discovery, a synchronous readiness adapter backed by a free prepaid balance
snapshot (60-second TTL, refresh every 30 seconds), and catalogue async/job/price
checks (six-minute TTL). Chat seller membership no longer gates music/SFX.
The supplied free API reference and offline catalogue resolve the shared SFX/music
endpoint, official prompt/lyrics_prompt/force_instrumental fields, and flat job
billing through the public music duration cap. README records sources and remaining
format/model-parameter assumptions. This is post-competition SingIt API work;
no Solana enablement, paid call, deployment or environment edit.
Verification: focused audio tests 14/14; full singit-ask 755/756 (known solana-direct
@solana/kit env miss on this worktree, same as main here). Production remains off
pending operator OK, merge/deploy and SINGIT_ASK_AUDIO_SOLD=1.
Post-competition SI-287 L1 draft (2026-11-09), branch `feat/limits-first-discovery`:
WK documentation and MCP descriptions name owner-set limits, allowance checks,
receipts and Base Emergency stop / Revoke. Adds bounded CDP boilerplate for later
propagation; existing route descriptions, prices and payment behavior are preserved.
Verification: 126 Node tests and 105 gateway tests (65 subtests) passed.
Acceptance mapping and draft PR body: `docs/pr-si-287-l1.md`. This is SingIt discovery
metadata work, not new Solana payment functionality. No paid call, external listing
refresh, merge or deployment; gated after R1/R2 and Kostya's Dev/Ops approval.

### November 9: model discovery prices and schema links

Post-competition SingIt API work on `feat/discovery-price-schemas`, recorded by
commit subject `feat(singit-ask): richer model cards with per-token price and schema links`.
Cards and list entries share catalogue token prices, known expected prices and
savings, and route input/output schema links or definitions. OpenAPI documents
reference-request ceilings; the well-known instructions point to free model cards.
Offline model-card, listing-price, discovery, free, catalog, OpenAPI lint/errors
and model-route checks passed: 78/78. No paid calls, Solana execution changes,
deployment or CDP refresh; stale directory descriptions require an owner-run paid
settle refresh after deploy.

Post-competition speech delivery fix (2026-11-09), branch `fix/speech-wav-mp3-transcode`:
synchronous speech requests for default/explicit MP3, including json/b64_json envelopes,
convert upstream WAV to MP3 via system ffmpeg before validation and settlement.
Conversion failure keeps 503/no-charge. Discovery stays b64_json/mp3.
