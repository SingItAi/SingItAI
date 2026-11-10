# SingIt Ask

OpenAI-compatible model answers with USDC payments over x402, settled by
[Coinbase CDP](https://docs.cdp.coinbase.com/x402/seller/facilitator). Every answer is paid for
what the answer actually used; nothing is charged without an answer.

- **Price:** you pay the price shown for each model, metered by what the answer actually used (rounded up to one USDC micro-unit),
  plus the network's settlement fee: **0.001 USDC on Base**, **0.002 USDC on Solana**
  for public x402 agents (its `upto` escrow takes two CDP transactions), **0.001 USDC**
  on the web agent's direct Solana path. The most any answer can cost is **0.003 USDC**:
  a ceiling, not a price.
- **Example:** a short answer settled at **0.00113 USDC** on Base, including the 0.001 USDC settlement fee.
- **Public API:** `POST /v1/chat/completions`. Any x402 agent pays with `upto`: on Base
  a bounded, gas-sponsored Permit2 signature; on Solana a 0.003 USDC escrow from which
  CDP settles the actual amount and refunds the rest. Listed for discovery (Bazaar) and on
  [PayAPI Market](https://payapi.market/provider/llm-chat-completions-api-openai-compatible-one-endpoint-for-100-models)
  (e.g. the [Claude Haiku 5.5 listing](https://payapi.market/api/claude-haiku-5)).
- **Discovery probes:** `GET` and `HEAD` on every route listed for discovery
  (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/images/generations`,
  `/v1/audio/speech`, `/v1/exa/search`, `/v1/exa/contents`, `/v1/exa/answer`) answer
  with the same 402 challenge an empty, unpaid `POST` gets — same offers, same Bazaar
  extension, same resource URL — instead of Express's default 404, which is how
  x402scan, Coinbase's Bazaar and 402 Index find a route in the first place. Neither
  verb ever verifies or settles, even if the request carries a payment header.
  `/v1/chat/completions/metered` is a paid route that is not listed for discovery, so `GET`/`HEAD`
  on it still 404. `/v1/video/generations` is the same unless `SINGIT_ASK_VIDEO_DISCOVERABLE=1`:
  Surplus's video sellers come and go, so video stays unlisted (but still sold) until they are steady.
- **Listing metadata:** every discoverable route's 402 resource description stays under
  300 characters and says only what the route does and when to call it; Coinbase's Bazaar
  ranks listings by metadata completeness, and billing talk crowds that out, so it stays in
  `openapi.json` and `/.well-known/x402`'s instructions instead. Each resource also carries
  `serviceName` ("SingIt Ask") and a PNG `iconUrl`. On the token-metered model routes (chat
  completions, `/v1/chat/{model}`, Messages, Responses) `accepts` leads with `upto` (Base, then
  Solana), the actual-cost offer, followed by `exact` on Base and Solana; routes sold only at a
  fixed price (images, speech, search, video) offer `exact` alone, Base first.
  For Claude Opus the recommended offer is `upto`: Opus's thinking cannot be switched off, so its `exact` price
  carries `max_tokens`' share plus 256 tokens of thinking headroom at the purchase price, which is usually well
  above what the answer used. `GET /pricing.json` and `GET /v1/models` mark such a model with
  `recommendedScheme: "upto"` (and `recommendedSchemeWhy`). Both offers stay in the 402 and no price changes;
  this only says which to sign. If the cheapest trusted Opus offer on Surplus rises above 0.29 of list, the
  health-alert timer sends one price alert (`scripts/README.md`).
- **Per-model routes:** when a catalogue is configured, `POST /v1/chat/{model}` is a
  separate x402 resource for each of 14 popular models (`claude-opus-5.5`,
  `claude-sonnet-5.5`, `claude-haiku-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`,
  `gemini-3.1-pro-preview`, `gemini-3.8-flash`, `grok-4.7`, `kimi-k3`, `deepseek-v4-pro`,
  `deepseek-v4.1-flash`, `qwen3.8-max-0902`, `glm-5.3`; list in `src/model-routes.mjs`), so
  a directory search for a model name finds its own listing, description and price. Each
  behaves like `/v1/chat/completions` (same offers, billing and request body) with the
  model fixed by the path: a body `model` that differs is refused 400 before payment, an
  absent one uses the path model, and a model the catalogue cannot answer right now is
  refused 404/503 before payment. `free/` models are not available there. The 402 probe
  is priced at that model's own ceiling. The price cap follows `max_tokens` (clamped at
  1200); the 402 carries the exact amount.
- **`GET /` and `GET /llms.txt`:** a small JSON service index and an
  [llms.txt](https://llmstxt.org) document, generated from the same enabled-route list as
  discovery so neither can drift from it.
- **Bazaar curation:** [docs/bazaar-curation.md](../docs/bazaar-curation.md) checks these routes against
  Coinbase's curation rules. `node ../scripts/bazaar-lint.mjs` lints the advertised metadata offline (run in CI);
  every paid path's error responses in `/openapi.json` are covered by `test/openapi-errors.test.mjs`.
- **Web agent, Base:** `POST /v1/chat/completions/metered`, the same Base `upto` offer
  at an address the gateway's buyer pins. Its limiter funding path is unchanged;
  that separate funding leg still uses the existing gas policy.
- **Web agent, Solana:** authenticated `POST /v1/chat/completions/quoted/solana/prepare`
  prepares an answer and a measured invoice. `POST .../quoted/solana/:id`
  requires one CDP `exact` payment for that invoice before releasing the answer.
  The user's agent signs as the existing SPL delegate; USDC moves directly from
  the owner's token account to the merchant. CDP supplies the network fee payer.
  No agent USDC/SOL top-up, agent token account, escrow or refund is needed.
- **Cost source:** Surplus `usage.buyer_cost_micro`, including its actual
  input/output/cache pricing. Missing, invalid or over-ceiling cost is refused, uncharged.
- **Model:** `deepseek-v4.1-flash` via the merchant's private Surplus API key.
- **Settlement fee:** charged consistently, also while CDP's free allowance lasts;
  it does not assert that CDP invoices every individual transaction during that allowance.
Zero-list-price models are sold only through the reviewed allowlist in `src/reference-prices.mjs`. Each zero side uses the greater of the static reference floor and the dearest trusted live book price times a 1.10 margin, regardless of seller health. Discovery marks this as `priceBasis: "reference"`: a conservative per-token estimate, not Surplus's list price (which is 0), with no claimed list-price savings. To add a model, add a `REFERENCE_PRICES` entry with a source and check date, then run `node scripts/check-zero-list-prices.mjs` from the repository root.

- **Pricing transparency:** free `GET /pricing.json` lists, for every chat model `GET /v1/models`
  offers, what a single reference question (one short message, the `max_tokens` a request gets when
  it omits the field) is offered over `upto` and `exact` on Base and Solana — computed by the exact
  `chooseModel`/`ceilings` functions the 402 challenge itself calls, never a separate estimate. No
  payment, no model call. 503 with `Retry-After` while the model catalogue has never loaded, instead
  of an empty or invented list. Linked from `openapi.json` as a free path. CORS is open (`*`), same as
  `/v1/models`, so `singitai.app/pricing/` can fetch it straight from the browser.

Chat models are offered as `GET /v1/models` lists them, including some whose names
contain uncensored, heretic or role-play. Uncensored image, speech, transcription
and video-catalogue models are offered like chat models, on the same terms,
including the network settlement fee. Only model IDs matching `/edit|remover|upscale/i` are
excluded by name from image, speech, transcription and video lists: these take an
image in and belong to another service. Video remains disabled by default
(`video_disabled`).

## Automatic web-agent payments

Select **DeepSeek V4.1 Flash · SingIt Ask** with an existing approved allowance.
The account's own network agent pays automatically within its limits. There is
no cross-network fallback or per-answer wallet confirmation. Existing Venice
and Telegram selections remain independent.

Solana users keep their USDC in their own wallet. They need SOL there for wallet
operations they explicitly sign, such as approving/revoking the SPL allowance;
ordinary Ask payments require no additional SOL funding. Existing agent SOL or
USDC from earlier flows is preserved, but the new Ask path does not use it.
The existing funding APIs remain for compatibility, without a funding prompt in
Ask's allowance UI. Unresolved older payments still require reconciliation.

The preparation route uses a dedicated server-only secret, never browser code.
It does not expose the answer. Request IDs bind owner, agent and normalized input;
a repeated preparation returns the same quote without invoking the model again.
Only one live quote per owner/agent exists: a new preparation replaces an unpaid
one, which can then no longer be paid. Quotes expire after five minutes. A
settlement is never resubmitted; an uncertain one stays as `unresolved` for review.
The merchant pays for inference before collecting payment on this private path:
a failed/abandoned quote therefore leaves that model cost with the merchant.
Do not expose the preparation secret to untrusted clients.

A private SQLite database records the generated answer, exact invoice and durable
settlement claim before settlement is requested. Concurrent/replayed requests
cannot settle again. A failed or unreachable verification marks the quote `failed`:
verification submits nothing. The buyer pins the merchant URL, native USDC mint, receiver,
owner, delegate, price, fee payer and request memo. Both the buyer and gateway
independently check the confirmed transaction's owner debit, merchant credit,
agent authority and memo before counting the actual charge.

The local allowance ledger reserves at most 0.003 USDC while a request runs,
then records actual spend and releases the difference. This reservation does not
move funds on Solana. A payment without a confirmed answer keeps its hold and a
private checkpoint in `~/.sign402/ask-metered/`, also after restarts, and blocks
further Ask and search payments for that account until the chain settles it up.
The next request does that automatically, and moves the files with their proof
to `reconciled/`:

- **No checkpoint:** no signature reached the merchant, so the hold is released.
- **Merchant refusal before settlement** (verification refused or unavailable, changed
  terms, replaced quote): the hold is released at once.
- **Solana:** the owner's USDC account is searched for the request memo at finalized
  commitment. A verified transfer is counted at its actual amount. Once the
  transaction's blockhash is past its last valid height without one, it is released.
  Until then, the user is asked to try again in a minute.
- **Base:** Permit2 decides. A nonce still unused after its deadline (120 s after
  signing) can never be spent, so the reservation is released. A used nonce means
  the payment went through without an answer: that one stays blocked for review.

**Deployment status, October 3:** the Base actual-usage payment was verified at
0.001055 USDC for 833 tokens; see [CHECKS.md](CHECKS.md). The previous user-funded
Solana implementation was activated at 11:25:35 UTC. The direct-payment update
was activated at 12:08:02 UTC with private rollback snapshot
`20261003T120802Z-before-direct-solana`. All nine deployed hashes match, all
three services are active, and the public Node client receives the new pricing
and updated UI. Wallet identities were preserved; no pending Solana Ask journal
remained at inspection. The activation manifest is now historical.

Verification for this update: 43 Node tests and 294 isolated web tests passed on
the VPS, including the real delegated transaction builder with simulated
facilitator settlement. CDP's live `verify` accepted a delegated owner-USDC exact
payment without submitting it. The owner subsequently completed a direct Solana payment: 0.001069 USDC for
1081 tokens, independently verified at finalized commitment. Its receipt and
allowance ledger agree; CDP paid the network fee. See [CHECKS.md](CHECKS.md).
Automated tests send no payments. The chat-context correction was activated at 12:20:36 UTC to prevent obsolete
agent-funding advice in generated answers; both deployed source hashes and all
three service health checks were verified.

Historical activation scripts have version-specific manifests; refresh them
against production before reusing them. Do not run old activation commands over
this update.

When video is enabled, a free order-book read checks seller health (cached for 60 seconds). A model with no
qualifying seller and no compatible healthy substitute returns 503 `no_healthy_sellers` before any 402; unhealthy models are hidden from
`/v1/video/models`. Unreadable books keep the last known health; unknown health is allowed for the requested model.
Clips have a $0.20 list floor: with the settlement fee the minimum listed price is $0.261 on Base.
Video is Base only: Solana is refused (`unsupported_network`) because a recent blockhash (~60–90 s) can expire
during the hold and settlement. Future Solana needs settle-before-submit plus durable refund/recovery.
The paid response waits for a finished clip: up to about 85 seconds on Base. Failed or late jobs return 503 `video_failed`
or `video_timeout` without settlement; late jobs are canceled best effort. Polling and downloads stay free.
Every job that does not deliver a clip writes one server-log line `video job not delivered {…}` with the Surplus job id, HTTP status,
Surplus's error code/type/message (truncated, token- and key-shaped text blanked), elapsed seconds and a `reason`:
`upstream_failed`, `poll_timeout`, `window_cutoff` (job failed with under 20 s left, so no next model starts) or `no_result_file`
(job `succeeded` without a file). Nothing is stored in a database: video keeps no state.
By default, failed submissions or retryable jobs can try up to two compatible healthy models at the same or lower list quote;
`fallback:false` refuses substitution. Billing always uses the signed requested quote. The response's `model` is
what ran; substitutions also include `requested_model` and `substituted: true`.

## Your spend limit in the 402, and a receipt (plan item 3)

Both are headers only: no price, offer or settlement changes, and nothing is added to x402's `extensions`.

- **Limit before you sign.** Send `X-SingIt-Limiter: 0x<your AgentAllowance on Base>` on an unpaid request. The 402 then
  carries `X-SingIt-Spend-Limit` (JSON, also in the 402's body as `singitSpendLimit`): `paused`, `expired`,
  `expiresAt`, `dailyCapAtomic`, `perPurchaseCapAtomic`, `remainingTodayAtomic`, `allowanceLeftAtomic`,
  `spendableNowAtomic` (the smaller of the three limits) and, for every offer, `fits` (`true`, `false` with a `reason`,
  or `null` for Solana, which is not checked). The owner's USDC balance is not read. Read from Base (cached 15 s,
  at most 60 fresh reads a minute); an address that is not an AgentAllowance on USDC gets an `error` instead.
  The address is never logged.
- **Receipt.** Every answer that settled carries `X-SingIt-Receipt` (JSON): `ref` (the answer's id), `tx`, `network`,
  `scheme`, `payer`, `chargedAtomic`, `ceilingAtomic` and, when the same limiter header was sent, a `limit` block with
  the figures read just before (`remainingTodayBeforeAtomic`). An unsettled answer (>= 400) has none.

```sh
curl -si https://ask.singitai.app/v1/chat/completions -H 'Content-Type: application/json' \
  -H 'X-SingIt-Limiter: 0xYourLimiter' -d '{"model":"deepseek-v4.1-flash","max_tokens":200,"messages":[{"role":"user","content":"Hi"}]}' \
  | grep -i x-singit-spend-limit
```

## SINGIT-holder pricing on Base

Payment stays USDC over x402. A buyer that holds SINGIT on Base can be quoted a lower USDC amount; Solana offers are
never discounted and nothing is staked.

- **Tiers.** At least 20 million SINGIT: 5% off; 50 million: 10%; 150 million: 15% (this top tier also raises the daily
  limit in the gateway). The tiers are configuration (`SINGIT_ASK_HOLDER_TIERS`) and every Base offer lists them in
  `extra.holderDiscount`, with `appliedBps` set to the discount in that quote (0 on a full-price quote).
- **Telling us who pays.** A 402 is issued before anything is signed, so send the paying Base address on the unpaid
  request: header `X-SingIt-Payer: 0x…` (or `?payer=0x…`). Anything that is not a valid address is ignored and the full
  price is quoted. Without the hint the quote is the full price; the tiers are still shown.
- **Never below cost.** A discounted price is the list price less the tier's share, but never less than what the
  upstream charges plus the settlement fee. A route with nothing above that (Exa search while its margin is 0) costs a
  holder the same as anyone.
- **Flash-loan guard.** The balance that counts is the lower of the balance now and the balance about 24 hours ago
  (`eth_call` at an older block, so the Base RPC must serve that state). Any RPC error, missing historical state,
  wrong chain or bad address means no discount, and a failed lookup is cached for a short time so a failing RPC is not
  hammered. A lookup failure is never an error to the buyer; the full price is quoted.
- **The hint is not trusted.** When a payment arrives the price is computed again for the address that signed it, not
  the hint, and checked again before verification and against the facilitator's own payer afterwards. A payment that
  signed a discounted amount for an address that does not qualify is refused before anything is charged (a 402 with
  the full price); ask again without the hint and pay in full. Paying more than the quote, up to the list price, is
  accepted. For `upto`, the answer is billed with the same discount and floor as the ceiling it was signed under.

## Run

```bash
npm ci
npm test
# Configure the Git-ignored .env with the variables below, then:
node --env-file=.env src/server.mjs
```

| Variable | Meaning |
| --- | --- |
| `SINGIT_ASK_UNSERVABLE_TTL_MINUTES` | Seller rejection cache in minutes; default 15, 0 disables, invalid values use 15. |
| `SINGIT_ASK_NOHUMANS_ALERT_SECRET_FILE` | Optional path to the nohumans.directory hook signing secret for `POST /webhooks/nohumans`. The file lives outside git, mode 600, and is read on each request, so it can be written after hook registration without a restart. If both are set, the file wins. Unset and no inline secret: signed deliveries get 503 (retried later); the registration test is still answered 2xx. |
| `SINGIT_ASK_NOHUMANS_ALERT_SECRET` | Optional inline secret, used only when the file variable is unset (tests / fallback). |
| `SINGIT_ASK_NOHUMANS_ALERT_WEBHOOK_URL` | Optional. A new `listing.purchase` alert POSTs `{"text": "..."}` here (fire-and-forget, 3 s timeout). Unset: watch the journal for `singit-ask: nohumans.listing.purchase`. |
| `SINGIT_ASK_PAY_TO_SOLANA` | Wallet that receives Solana payments. Its USDC token account must already exist. |
| `SINGIT_ASK_PAY_TO_BASE` | Address that receives Base payments. |
| `SIGN402_BASE_BUILDER_CODE` | Optional. Base Builder Code (base.dev). When set, every Base-payable 402 declares it as the x402 `builder-code` app code (`a`), and the CDP facilitator appends it to the settlement calldata as an ERC-8021 suffix. Unset or invalid: no extension. Keep it in the service env, never in git. |
| `SURPLUS_API_KEY` | Surplus buyer key (`inf_…`) with access to the configured model. Fund its workspace's deposited USDC balance; USDC in the linked wallet alone is not a prepaid balance. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Coinbase CDP facilitator credentials, required. The service reuses the `cdp-x402-service` installation of `@coinbase/x402`. |
| `SINGIT_ASK_DIRECT_SOLANA` | Set `1` to enable the private direct Solana route with CDP metering. |
| `SINGIT_ASK_AUDIO_SOLD` | Set exactly `1` to sell music/SFX when ready. Unset/default: 503 before payment and empty audio generation models/prices/discovery. |
| `SINGIT_ASK_AUDIO_DISCOVERABLE` | Set exactly `1`, together with audio sold and ready, to list music/SFX x402 resources. Unset/default: direct paid POST and known model-list URL still work when ready, but discovery omits the routes. |
| `SINGIT_ASK_AUDIO_MODELS` | Optional comma-separated public or upstream music/SFX ids. Unset permits all pinned models; set empty permits none. Unknown ids never become ready. |
| `SINGIT_ASK_VIDEO_SOLD` | Set `1` to sell `/v1/video/generations`. Unset (default): video is off. `POST` answers 503 `video_disabled` with no payment offer, `GET /v1/video/models` answers 503, and video is left out of openapi, discovery and `llms.txt`. Jobs that were already paid can still be polled. Off since the provider failures on 27.10.2026; enabling sales remains an operator decision. |
| `SINGIT_ASK_VIDEO_DISCOVERABLE` | Only with `SINGIT_ASK_VIDEO_SOLD=1`: set `1` to list `/v1/video/generations` for x402 discovery (402 on GET/HEAD and the empty probe, `/.well-known/x402`, `llms.txt`). Unset (default): sold (if on), but not listed. |
| `SINGIT_ASK_QUOTE_TOKEN` | Dedicated server-only authentication secret, shared by merchant and gateway (at least 32 characters). |
| `SINGIT_ASK_QUOTE_DB` | Private writable SQLite path for prepared answers and settlement claims. |
| `SINGIT_ASK_DEFAULT_FALLBACKS` | `off` disables reviewed pinned defaults; any other value enables them. |
| `SINGIT_ASK_MODEL` | Upstream model. Default: `deepseek-v4.1-flash`. |
| `SINGIT_ASK_PORT` | Loopback port. Default: `8140`. |
| `SINGIT_ASK_REASONING_EFFORT` | `model=effort,...` (`none`, `minimal`, `low`, `medium`, `high`) overrides the model default: `claude-opus-5.5` defaults to `low`, other models to `none`. Set `claude-opus-5.5=none` to restore the old behaviour. A value that cannot be read stops the process at start. |
| `SINGIT_ASK_REASONING_HEADROOM` | Measurement only; unset (default) changes nothing. `model=tokens,...` replaces the model's thinking headroom (the reasoning-tag floor plus explicit overrides in `src/pricing.mjs`) in both the ceiling the 402 offers and the `max_tokens` sent upstream, e.g. `claude-opus-5.5=128`. Use only on a temporary loopback process for a paid test; it does not change the price formula. |
| `SINGIT_ASK_EXA_MARKUP_BPS` | Exa markup in basis points: integer 0..10000, default `0`. Invalid values use the default. |
| `SINGIT_ASK_EXA_FEE_ATOMIC` | Exa settlement fee in atomic USDC: `N` for both networks or `base,solana`, default `1000,1000` (a flat $0.001 on both networks). Non-negative integers; invalid values use the default. Set markup to `3000` and fee to `1000,2000` to restore the former pricing; fee `0` with the default zero markup gives no-fee pass-through pricing. |
| `SINGIT_ASK_SINGIT_TOKEN_ADDRESS` | The SINGIT ERC-20 on Base read for the holder discount. Falls back to `SIGN402_SINGIT_TOKEN_ADDRESS`, then to the gateway's built-in SINGIT contract (18 decimals). |
| `SINGIT_ASK_HOLDER_TIERS` | Holder discount tiers, `minWholeTokens:discountBps` comma-separated, with `+daily` on the tier that raises the gateway's daily limit. Default `20000000:500,50000000:1000,150000000:1500+daily`. An unreadable value is logged once and the default is used. |
| `SINGIT_ASK_HOLDER_LOOKBACK_SECONDS` | How far back the second balance reading is taken, `3600`..`2592000`, default `86400`. Invalid values use the default. |
| `SINGIT_ASK_HOLDER_CACHE_MS` | How long one address's tier is kept, `1000`..`3600000`, default `60000`. A failed lookup is kept for 30 s. |
| `SINGIT_ASK_EXACT_RESERVE` | Default `0.25,32,256`. How many thinking tokens an `exact` offer for Claude Opus prices: `clamp(round(factor × max_tokens), min, max)` (125 at `max_tokens` 500), never more than the model's headroom. The whole headroom (256) is still added to `max_tokens` sent upstream, and `upto` still authorizes it. `full` restores pricing all 256 tokens (the behaviour before 29.10.2026). A value that cannot be read stops the process at start. |
| `SINGIT_ASK_WALLET_REPORT_ORIGIN` | Public origin of the sign402 gateway's web API, named in `/openapi.json` for the free `GET /v1/wallet/{address}/reconciliation` (served by the gateway, not here). Default: `https://app.singitai.app`. |
| `SINGIT_ASK_ANSWER_LOG` | Optional file. Unset (default): nothing is recorded. When set, every settled chat answer (`/v1/chat/*`, `/v1/messages`, `/v1/responses`) appends one JSON line: UTC hour, route, model, scheme, network, `maxTokens`, prompt/completion/reasoning tokens, `upstreamMicro` (model cost), `billedAtomic`, `ceilingAtomic`, `overrunAtomic`. Never the question, the answer, the payer, a transaction, a header, an address or a finer time. File mode `0600`; logging stops at 50 MB. Its purpose: the real p50/p90/p99 of output tokens against `max_tokens`, which decides an `exact` ceiling. |
| `SINGIT_ASK_GUARD_SHARES_FILE` | Default `$HOME/.config/singit-ask/guard-shares.json`. Private copy of the cheapest share of list price per model from the last order-book pass (only the model id, the share and when its book was read), read back at start so a restart keeps its prices instead of quoting list price for the two minutes the first pass takes. A share is used with its `X-Min-Discount` floor like one just read, so one that is out of date can only get a paid question refused, uncharged. A share older than 30 minutes, or a missing or corrupt file, means list price until the first pass ends. Startup logs `price guards restored: N`. Delete the file while the service is stopped to start from list price. |
| `SINGIT_ASK_FREE_MODELS` | Models answered free as `free/<id>` on the public route, comma-separated. Unset: openai-gpt-oss-20b, gemma-4-e2b, gemma-3-27b-it, mistral-small-3.2-24b-instruct, qwen3-coder-30b-a3b-instruct, deepseek-v4.1-flash. Empty: free answers off. |
| `SINGIT_ASK_FREE_PER_VISITOR`, `SINGIT_ASK_FREE_PER_DAY` | Free answers a day per visitor and for everyone together. Defaults: 20 and 1000. A visitor is a network, not an address: the Cloudflare client address's IPv4 /24 or IPv6 /64 (an IPv4-mapped IPv6 address counts as its IPv4 network), so rotating addresses in one subnet does not multiply the allowance. Free answers are capped at 400 tokens and 4000 characters of question. |
| `SINGIT_ASK_FREE_BUDGET_USD_PER_DAY` | Default 0.25 USD/day; 0 disables; invalid or negative uses 0.25. Reserves worst-case upstream cost before answering, including reasoning headroom; settles reported cost or list-price fallback (one input token per character). Unknown price pauses free answers with 503 when the budget is enabled. |
| `SINGIT_ASK_FREE_STATE_FILE` | Default `$HOME/.config/singit-ask/free-budget.json`. Atomic private state for daily spend and total answers; in-flight reservations are saved as pending and counted as spent after a restart; an unreadable or invalid file for today is treated as a spent budget until midnight UTC; visitor networks remain in memory. |

6 free models, up to 20 answers a day per network, with a shared daily cost cap of $0.25. The shared free tier may run out for the day (free_budget_exhausted); it resets at midnight UTC.

Each free answer reports `billing.remainingToday`; when used up, drop the `free/` prefix to pay. The response also includes `billing.resetsAt` (next UTC midnight), `billing.hint` (`drop the free/ prefix to pay`), and `X-SingIt-Free-Remaining` (the same count of answers left today for this network). The count is the lower of the network and whole-day answer allowances; the shared cost budget may end free answers sooner.

Free answers have no wallet, so there is no per-wallet limit here: the network above is the only identity they carry. Free models are listed in `GET /v1/models` as `free/<id>` entries (`free: true`, with their `limits`) next to the paid ones, and in `/openapi.json` under the chat route's `x-free-models`. Wallet-based limits belong to the gateway's free models (`sign402-gateway/README.md`).

The service listens on 127.0.0.1 only. Configure a Cloudflare tunnel hostname to publish it. Only loopback proxies are trusted for the forwarded HTTPS scheme.

## Surplus refusals in the log

Every non-2xx answer to a POST to Surplus (any route) is logged once as `singit-ask: surplus_reject {...}`, a JSON object with `model`, `status`, `code` (Surplus's error code, e.g. `minimum_discount_not_met`, kept only when it looks like an identifier), `bestDiscountPct` (the number from "Best otherwise-eligible estimated discount is X%" when the message has it, else `null`), `minDiscountSent` (the `X-Min-Discount` floor this request carried, a number), `bodyChars` (the length of the body, at most the 4096 bytes read) and `body`. `body` is Surplus's error message (whitespace squeezed, anything shaped like a key, token or address replaced, cut to 240 characters) only for `minimum_discount_not_met` and `no_healthy_sellers`; for any other code it is `null`, because an upstream error can echo the question. Never logged: headers, the Surplus key, the question, the payer. The line is written after the answer has gone back to the caller, from a bounded read of a copy of the response. Read it with `journalctl --user -u singit-ask | grep surplus_reject`. It is how the price guard is compared with the share Surplus can really buy at.

## Catalogue check (pay-skills)

`node scripts/generate-openapi.mjs > openapi.json` prints the `openapi.json` this service serves, built offline
(a stub facilitator and a catalogue of the 14 pinned models stand in for Coinbase and Surplus). Put it next to a
`PAY.md` and run `npx @solana/pay catalog check <PAY.md>` to see what the Solana Foundation's catalogue linter says;
`test/openapi-lint.test.mjs` holds its offline rules (verb-first summaries of 24 to 63 characters, documented
request bodies) so a change to a summary or a schema cannot silently break a listing.

## On the VPS

Use the dedicated user service in `deploy/singit-ask.service`. It runs as
`<DEPLOY_USER>`, independently of the gateway, from `<APP_CHECKOUT>/singit-ask`.
The private configuration is `<ASK_CONFIG_DIR>/service.env`
(directory mode `0700`, file mode `0600`). It contains only this service's settings.
Host, account, and paths are placeholders; real values live in private ops notes.
Substitute them in the unit file before installing it.

```bash
export PATH=<AGENT_HOME>/node/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd <APP_CHECKOUT>/singit-ask
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm test
install -m 0644 deploy/singit-ask.service ~/.config/systemd/user/singit-ask.service
systemctl --user daemon-reload
systemctl --user enable --now singit-ask
curl --fail http://127.0.0.1:8140/health
```

The user manager requires lingering for startup after reboot. Verify it with
`loginctl show-user <DEPLOY_USER> -p Linger`; this VPS already has `Linger=yes`.

Node is the v22 build bundled with Hermes. In the existing Cloudflare tunnel, add:

- Hostname: `ask.singitai.app` (published; external health and unpaid x402 challenge verified).
- Service: `HTTP`, URL: `127.0.0.1:8140`.
- Leave the HTTP Host Header override empty to preserve the public hostname.

Public checks once the route exists:

```bash
curl --fail https://ask.singitai.app/health
curl -i https://ask.singitai.app/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":32}'
```

The second request must return `402` and `PAYMENT-REQUIRED`, advertising two `upto`
offers with a 3000 micro-USDC ceiling and their billing terms (fee 2000 on Solana,
1000 on Base), the configured recipient addresses and the public HTTPS resource URL.
It does not call the model or pay anything. Real signed payment and settlement
require a separately approved live test; `src/solana-buyer-cli.mjs` and
`src/buyer-cli.mjs` are buyers for that.

Stop or roll back only this service with `systemctl --user disable --now singit-ask`.
Keep its private configuration out of Git, command output and published logs.

### Observed health and usage


Reasoning headroom is priced into every ceiling and added to the upstream token limit: 256 tokens for
catalogue entries tagged `reasoning`, with explicit overrides of 1024 for Gemini 3.1 Pro and 256 for
Opus 5.5 and GPT OSS 20B. The audit also measured thinking on untagged `qwen3.5-plus` (about 193 tokens)
and `qwen3.5-flash` (about 146); both explicitly receive 256. Process overrides take precedence, including
zero. Untagged models without an explicit entry keep their previous prices. Only Opus has a reduced
exact reserve; every other reasoning model's exact price carries the whole headroom.

Paid chat, Messages, Responses and Solana quoted requests retry an empty length-limited answer once,
when more than eight seconds remain. The second upstream budget is `min(2 * B1, B1 + 2048)` where B1
includes headroom. The successful answer carries `retried: true`; settlement never exceeds the original
ceiling, even for upto. The service eats the first attempt and absorbs any retry overrun, bounded by one
extra call at no more than twice the first budget. A second exhaustion returns 422 without charging.
Free requests never retry, preserving the shared dollar cap; a near-deadline request may also return
422 without retrying. Other upstream errors do not trigger a reasoning retry.

`GET /health` retains `ok: true` and the existing service fields, and adds observed text-model results,
payment-rail status, a cached read-only facilitator check, measurement start and generation timestamps.
Model and settlement rates cover UTC hourly buckets in the last 24 hours; idle models are omitted.
Each model exposes `reasoning422` and `reasoningRetries` for that window. Reasoning exhaustion counts
neither success nor failure and leaves the last outcome unchanged; a successful retried answer counts
as one success and one retry. At least three reasoning 422s and a ratio
`reasoning422 / (attempts + reasoning422) > 0.2` make status at least `degraded`, while `down` and
`unavailable` remain worse. Old persisted files without these counters load with zero values.
`GET /numbers.json` publishes settled public x402 calls, known USDC volume and distinct payer wallets for
all recorded history, 24 hours and 7 days, with definitions. Internal web-app payments inform rail health
but are excluded from usage. Own payers are excluded only once an own-payer list is configured (see `counts_basis`). History before these counters existed
is not included. Missing amounts are never estimated; unique counts become null when their bounded sets fill.
Payers are stored only as salted HMAC hashes, never exposed. Availability is measured separately by the
external prober at https://app.singitai.app/status.json.

`SINGIT_ASK_STATS_FILE` defaults to `~/.config/singit-ask/health-stats.json`; it holds private counters and
salt, written atomically with mode 0600, with a roughly ten-second debounce and a shutdown flush.
`SINGIT_ASK_OWN_PAYERS_FILE` optionally names a private file of excluded own payer addresses, one per line
with `#` comments, read once at startup; only the count is logged. Keep these files outside version control.

### Own payers and private counters

`SINGIT_ASK_OWN_PAYERS_FILE` optionally names a private file containing one payer per
line. Blank lines and `#` comments are ignored; duplicates are removed, EVM case is
normalised and Solana case is preserved. Set permissions to `chmod 600`, keep the
file out of git, and restart after changing it. An unreadable configured file stops
startup; logs contain only the exclusion count. No own addresses are built in.

`/numbers.json` reports `own_payers_configured`, true only for a non-empty list.

`counts_basis` is `including_own_payments` until a non-empty own-payer list is configured:
these counts include our own payments and are not external-only. Once configured it is
`excluding_configured_own_payers`. `counts_label` explains this coverage in plain text.
Exclusions apply from configuration onward for calls and volume; earlier calls and volume
still include our own payments. Historical matching unique-payer hashes are removed.

Adding the list removes matching historical unique-payer hashes. Calls and USDC
volume recorded before configuration still include own test payments: payer-level
payment history is not stored, so those totals cannot be corrected retroactively.
Capped unique counts remain null even after exclusions.

`SINGIT_ASK_STATS_TOKEN` enables `GET /internal/stats` when at least 32 characters
long. Short tokens disable registration and produce a log line. Send
`Authorization: Bearer <token>`; responses are private, use `Cache-Control: no-store`
and have no CORS allow-origin header. Keep the token secret. This endpoint is
excluded from discovery and OpenAPI.

The private report includes external payer/call/USDC windows and issued 402 counts:
`post` means a POST with PAYMENT-REQUIRED, `probe` means GET/HEAD discovery with
that header, and `refused` means a 402 without it. These count responses, not unique
clients or conversions. Known paid routes (including hidden payment routes) are
counted separately, with unknown/overflow paths in `other`; at most 100 keys are
stored. Dynamic private quote-payment paths use `other`, so quote IDs are never
recorded. No prompts, addresses, IPs or header values are recorded. Hourly buckets
retain 720 hours; lifetime totals remain. Windows include the current UTC hour and
the preceding 23 or 167 hourly buckets. The 402 report is not public.

For daily-metrics cron, run this read-only command from `singit-ask` with the same
stats and own-payer environment as the server:

```sh
node scripts/ask-counters.mjs          # private JSON
node scripts/ask-counters.mjs --text   # short summary
```

`SINGIT_ASK_STATS_FILE` defaults to `~/.config/singit-ask/health-stats.json`.
The CLI applies exclusions in memory without writing or scheduling a flush. It
prints no payer hashes or addresses. Missing/invalid stats files follow HealthStats'
empty-counter fallback; check the report's `since` before interpreting it as history.

### Seller down: gate, learned price, hide

Models are made to work first. A `minimum_discount_not_met` reply with a valid
`bestDiscountPct` raises the next quote to at least the seller's deliverable share,
plus the usual rounding and price buffer. This learned guard lasts ten minutes;
a successful answer clears it, and expiry returns pricing to the order book.
The payer signs the new quote as their ceiling; billing never raises that ceiling.
A stale cheap book alone is no reason to hide a model.

Real seller failures close a gate before payment: `no_healthy_sellers` immediately;
`minimum_discount_not_met`, `unreachable`, and upstream HTTP 5xx after three
consecutive seller failures within 24 hours without an answer. Input errors,
reasoning exhaustion, empty answers and ceiling refusals do not count. A closed
gate returns 503 `no_healthy_sellers`, Retry-After, and no payment challenge on
chat, pinned, Messages, Responses and discovery probes. Health publishes only
the gate reason (`recent_failures` or `no_healthy_sellers`) and retry time.

The initial gate lasts 15 minutes. Failed recovery trials double the wait to at
most two hours. A successful answer clears the failure streak, learned guard and
suspension. A fresh qualifying seller in an accepted book refresh also reopens
all kinds of gate without traffic. Identical healthy-looking offers do not prove
recovery. After the gate expires an explicit request can make a half-open trial.

Only the configured default, automatic-tier and free-list models never suspend:
they remain listed as router backbone models, but still return 503 when gated.
Other models hide after repeated gate-closing rejections and return after a
successful trial or fresh seller. `NEVER_HIDE` remains exported as an empty list.
`SINGIT_ASK_SUSPENSIONS_FILE` selects the private persistence file (default
`~/.config/singit-ask/model-suspensions.json`). Health retains suspended models
between trials; explicit requests can still make recovery trials.

### Reviewed pinned defaults

On `POST /v1/chat/completions`, an explicitly pinned `gpt-6-luna` can use
`gpt-6-luna-pro` before payment if the pin cannot be served or priced safely.
This reviewed pair shares the underlying model; pro reasoning uses independent
sellers. `claude-haiku-4.5` also has the reviewed `claude-haiku-5.5` fallback. Omitted/default models
and other API routes stay pinned. There is no substitution after payment.

An explicit `fallback_models` list takes precedence. The substitute uses its own
quote, and none of its amounts (upto or exact, on Base or Solana) may exceed the pinned model's for the same request, otherwise the request is refused as before. The 402 and 200 disclose
`X-SingIt-Model`, `X-SingIt-Fallback-From`, and
`X-SingIt-Fallback-Policy: default` (or `request` for an explicit list).
The answer's `model` and `singit_fallback_from` also identify the substitution.
Send `X-SingIt-Fallback: off` to disable defaults for one request; explicit lists
still work. Operators can disable defaults globally with `SINGIT_ASK_DEFAULT_FALLBACKS=off`.

The free GET/HEAD routes `/SKILL.md`, `/.well-known/agent-card.json`,
`/llms-models.txt` and `/llms-full.txt` serve the original bytes from `../website`
through a fixed, case-sensitive allowlist. Agents can fetch them on Ask without
the browser check on singitai.app. Files are read on every request, with open
CORS, a five-minute public cache and strong ETags for conditional requests.

Discovery probes (GET, HEAD, and empty unpaid POST) for chat, Messages and Responses quote the example at list price by default. This bounds a later quote for the same example across seller discounts. Real POSTs keep their tight seller guard; `upto` settles actual usage. The default model still has its standing 0.003 USDC cap and all quotes retain the minimum ceiling.

`SINGIT_ASK_PROBE_SHARE=list` is the default; `live` restores the previous seller snapshot for discovery only, which can become stale. `SINGIT_ASK_PROBE_MAX_TOKENS` is an optional positive integer: unset uses the example's own output budget; set quotes discovery as if it requested `min(value, 1200)` tokens. It changes neither the published example body nor real requests. Invalid values leave the example budget unchanged.

A larger output budget or longer prompt can exceed the listed example price. Paid `/v1/chat/completions` clamps `max_tokens` at 8192. Per-model routes retain their 1200 token clamp. Set the probe budget to 1200 when listing the chat clamp for verifiers. Messages and Responses allow up to 32000 output tokens; Responses defaults to 4096 when `max_output_tokens` is omitted.

Reviewed against the local 2026-11-02 audit, q400/q2000 quotes (micro-USDC):
Haiku 4.5 → 5.5 has Solana upto 2236/2704 → 2077/2228 and exact
2072/2212 → 2024/2069; Base upto 1500/1704 → 1500/1500, exact 1500
throughout. List input/output per million falls from $1/$5 to $0.10/$0.50.
No GLM default is configured: Flashx Solana upto 2336/2999 and GLM 5.3
2038/2114 exceed Flash 2003/2008. No DeepSeek default is configured:
V4 Flash Solana upto 2078/2232 exceeds V4.1 Flash 2007/2017 (and the
latter is an eco-tier model, while V4 Flash is not). The existing Luna → Pro
entry is retained, but the audit's Pro quotes are dearer; the runtime comparison
will refuse that substitution at those prices. Every fallback is checked again
on every scheme/network for the actual request, including tier membership.

`GET /v1/audio/models` lists speech and transcription models with their prices.
Speech entries carry `x402: true` and `route: "/v1/audio/speech"`.
Transcription entries carry `x402: false`, `route: null` and `access: "api-key"`:
they are priced here for API-key use, not payable on `/v1/audio/speech` over x402.
The top-level note explains this distinction; existing model IDs, kinds and price
fields remain available to the key gateway and MCP consumers.

## Agent conversations and buffered SSE

Paid `/v1/chat/completions` accepts system/developer/user/assistant/tool roles,
function tools and text/image blocks: 200 messages, 100000 estimated characters
(including tools and 8000 per image), 64 tools/calls, four images, 8192 output
tokens (default 800), within the 128 kB JSON body limit. Model capabilities may
refuse tools or images. Legacy plain text, stream:false, max_tokens<=1200 requests
keep their behavior. Messages and Responses already supported tools and 32000
output tokens before this change.

Chat (including free and per-model routes), Messages and Responses accept
`stream:true`. This is buffered SSE: the seller answer is produced as for JSON,
then the complete SSE body is sent together after successful settlement. It is
not token-by-token streaming. The pricing, ceilings, billing object, model/tier/
fallback headers and PAYMENT-RESPONSE are unchanged. Errors remain JSON and do
not expose SSE answers. Chat ends with `[DONE]`, Messages with `message_stop`,
and Responses with `response.completed`. Chat `stream_options` accepts only
`{include_usage: boolean}`, only with `stream:true`. Free/per-model routes keep
their existing text-only limits and free routes still refuse tools/images.

`numbers.json` adds `agent_traffic`: total, last_24h and last_7d each contain
calls, with_tools, with_stream, with_images, and by_source. Calls count served
paid and free answers; failed settlements are excluded. Sources are fixed product
labels (openai-python, openai-node, langchain, litellm, vercel-ai, cursor,
claude-code, continue, openclaw, curl, browser, other), derived from User-Agent
product tokens or a lowercase `X-SingIt-Client` matching `[a-z0-9._-]{1,32}`.
Unknown/invalid labels become other. These counters store no raw headers,
addresses or prompts, persist with health stats, and use UTC hourly windows.

For a local fake-only official Python SDK session, in an environment permitting
loopback listeners, run from the repository root:

```sh
PORT=8787 node singit-ask/scripts/agent-session-server.mjs
# In another terminal, after READY:
BASE_URL=http://127.0.0.1:8787/v1 /workspace/venv-oai/bin/python singit-ask/scripts/openai_sdk_session.py
```

The session performs 20 steps with a free model and prints a PASS/FAIL table.
No upstream or payment network is used. A paid-path version cannot use the
OpenAI SDK alone: it needs an x402 payment client and a payment authorization.
The server provides deterministic fake tool calls for paid-handler exercises;
free models continue to refuse tools.
### Music and sound effects (M4 draft)

`POST /v1/audio/sound-effects` accepts `{model?, text, duration_seconds?, response_format?}`.
Text is required (1–1000 characters); duration is 0.5–22 seconds. Formats: mp3, wav,
ogg, flac, aac, m4a. Default model: `elevenlabs/sound-effects-v2`.

`POST /v1/audio/generations` accepts `{model?, prompt, lyrics?, instrumental?, duration_seconds?}`.
Prompt is required (1–2000 characters); duration is 5–240 seconds (default 60).
Default `minimax/music-2` requires nonempty lyrics and does not accept `instrumental`.
Music 2.5 and 2.6 accept instrumental mode; instrumental requests cannot include lyrics.
Lyrics are capped at 5000 characters. Invalid requests return 422 before payment.

Both routes offer **exact only on Base**. Solana is refused for both routes: a recent
blockhash lasts roughly 150 blocks (about 60–90 seconds), shorter than the 180-second
music job plus download/settlement. `maxTimeoutSeconds` does not extend blockhash
validity. No signed Solana transaction is held across generation. Supporting Solana
requires settlement **before** job submission and a durable refund/recovery design;
that flow is not implemented here.

The draft is disabled unless `SINGIT_ASK_AUDIO_SOLD=1`. The standard server installs
`config.audioGenerationReady(upstreamModelId, { listAtomic })`, returning exactly `true`
only for a pinned model/price, the optional allowlist, and sufficient prepaid credit.
A free authenticated `GET /v1/payments/balance` refresh runs immediately after app creation
when sold, then every 30 seconds (10-second timeout). Only a nonnegative integer string
`credit_balance_usdc` is accepted, in micro-USDC. Missing, failed, unreadable or older
than 60 seconds fails closed; failed refreshes clear the previous snapshot. Discovery
and list paths never await this network read. Snapshot credit is not a reservation:
concurrent jobs may exhaust credit and then fail without buyer settlement.

The standard catalogue's background five-minute refresh also confirms the upstream
entry still supports async music/SFX and has `media_unit: job` at the pinned price;
missing metadata or metadata older than six minutes fails closed. Catalogue rejection
and suspension checks remain, but its chat-only `served` set does not gate audio.
The supported endpoint/schema and initial route support come from the offline official
docs/catalogue, not a paid submission probe; transient seller failures remain possible.
Integrations supplying their own adapter must uphold these readiness checks too.

Without `SINGIT_ASK_AUDIO_DISCOVERABLE=1`, ready models remain visible at the known
models/pricing URLs and direct POST works, but x402 resource lists omit both routes.

| Public model | Surplus model | Draft Base USDC |
| --- | --- | ---: |
| elevenlabs/sound-effects-v2 | venice-elevenlabs-sound-effects-v2 | 0.027 |
| sonilo/sound-effects-1.0 | sonilo-sound-effects-v1-0 | 0.003691 |
| minimax/music-2 | venice-minimax-music-v2 | 0.053 |
| minimax/music-2.5 | venice-minimax-music-v25 | 0.313 |
| minimax/music-2.6 | venice-minimax-music-v26 | 0.313 |

These are offline reference SingIt prices (rounded upward to micro-USDC) plus the
0.001 Base settlement fee, not a live price feed. OpenAPI bounds are derived from
the same calculation. Do not enable a model when its price or duration billing is
unconfirmed or changed. `GET /v1/audio/generation-models`, `/v1/models` and
`/pricing.json` expose only ready models, with Base prices only. Bazaar entries and
OpenAPI remain draft API definitions, not a promise of current availability.

Like `/v1/audio/speech`, successful responses contain **audio bytes**, with detected
`Content-Type`, `Cache-Control: no-store`, `X-SingIt-Charged-Atomic` and
`X-SingIt-List-Atomic`. The server submits using its own prepaid Surplus key, polls
and downloads within one deadline (60 seconds for effects, 180 for music), and enforces
5 MiB / 25 MiB streaming caps. HTTPS artifact redirects are checked at every hop;
private/loopback addresses are refused and DNS addresses are pinned for TLS downloads.
Container magic is checked for MP3/WAV/OGG/FLAC/AAC/M4A; this is not full audio decoding.
No credit, failed jobs, timeout, invalid audio and oversized artifacts return 503;
x402 does not settle. No retries submit a second job. Payment replay reservations
are process-local and shared with edits/embeddings.

**RESOLVED (free docs fetched 2026-11-05):**
- Submission uses `model,prompt,duration_seconds?,lyrics_prompt?,force_instrumental?`.
  Public SFX `text` maps to `prompt`; public `lyrics`/`instrumental` map to the official names.
  Music prompt over 2000 or lyrics over 5000 characters returns 422 before payment;
  SFX retains its stricter 1000-character public limit. No input is truncated.
- Music and SFX both use `POST /v1/music/generations`; polling/artifacts are unchanged.
- Flat billing through the public 240-second music cap is confirmed by catalogue
  `media_unit: "job"` and market per-job benchmark prices. Duration is a generation
  parameter, not a billing dimension; pins stay unchanged.

Sources: [API reference](https://www.surplusintelligence.ai/docs/api-reference/music-generations),
market pages for [ElevenLabs SFX](https://www.surplusintelligence.ai/markets/venice-elevenlabs-sound-effects-v2),
[MiniMax 2](https://www.surplusintelligence.ai/markets/venice-minimax-music-v2) and
[MiniMax 2.6](https://www.surplusintelligence.ai/markets/venice-minimax-music-v26),
and owner-provided offline `surplus-m4-music-sfx.json` / `surplus-music-generations-docs-2026-11-05.md`
in `/workspace/singit/catalogs`.
Remaining assumptions: the SFX public text-to-prompt translation preserves buyer intent;
MiniMax market pages advertise only model+prompt, so lyrics/instrumental support relies
on the API reference and offline model capabilities. Requested SFX `response_format`
is accepted publicly but not sent upstream (not in the official schema); selection is
unconfirmed and returned Content-Type follows actual bytes. No live or paid call was made.

There is no prepayment or refund on these Base routes: failed generation/download
returns an error before settlement; the x402 middleware buffers successful bytes
until settlement succeeds. A settlement failure must not release the artifact.
D4 adds pinned resources at `POST /v1/models/<id>/chat` and
`POST /v1/models/<id>/images`. The first wave is configured in
`config/model-aliases-wave1.json`; these routes reuse the existing chat/image
pricing and payment handlers and the shared spend-limit middleware. Omit body
`model` or set it to the path id. Each alias has its own x402 discovery resource
and OpenAPI entry. Website examples are unpaid requests, generated offline.
The draft wave contains 24 chat and 10 image aliases. `gemini-3.1-pro` is
excluded because the offline hidden-models record marks it unavailable. The 15
SI-62 models keep `POST /v1/chat/<id>` as their one advertised record and have
no alias. A chat alias reads a request as `POST /v1/chat/completions` does, with
the model pinned, so the same body gets the same price and limits.
