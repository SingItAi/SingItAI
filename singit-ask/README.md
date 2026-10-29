# SingIt Ask

OpenAI-compatible model answers with USDC payments over x402, settled by
[Coinbase CDP](https://docs.cdp.coinbase.com/x402/seller/facilitator). Every answer is paid for
what it actually cost; nothing is charged without an answer.

- **Price:** actual Surplus token cost + 30% markup (rounded up to one USDC micro-unit)
  + the network's settlement fee: **0.001 USDC on Base**, **0.002 USDC on Solana**
  for public x402 agents (its `upto` escrow takes two CDP transactions), **0.001 USDC**
  on the web agent's direct Solana path. The most any answer can cost is **0.003 USDC**:
  a ceiling, not a price.
- **Example:** a short answer, 0.0001 USDC model cost + 0.00003 markup + 0.001 fee =
  **0.00113 USDC** on Base.
- **Public API:** `POST /v1/chat/completions`. Any x402 agent pays with `upto`: on Base
  a bounded, gas-sponsored Permit2 signature; on Solana a 0.003 USDC escrow from which
  CDP settles the actual amount and refunds the rest. Listed for discovery (Bazaar).
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
  is priced at that model's own ceiling.
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
- **Pricing transparency:** free `GET /pricing.json` lists, for every chat model `GET /v1/models`
  offers, what a single reference question (one short message, the `max_tokens` a request gets when
  it omits the field) is offered over `upto` and `exact` on Base and Solana — computed by the exact
  `chooseModel`/`ceilings` functions the 402 challenge itself calls, never a separate estimate. No
  payment, no model call. 503 with `Retry-After` while the model catalogue has never loaded, instead
  of an empty or invented list. Linked from `openapi.json` as a free path. CORS is open (`*`), same as
  `/v1/models`, so `singitai.app/pricing/` can fetch it straight from the browser.

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
Clips have a $0.20 list floor: with 30% markup and settlement fee the minimum is $0.261 on Base or $0.262 on Solana.
The paid response waits for a finished clip: up to about 85 seconds on Base, 35 seconds on Solana to leave
time for settlement before the signed transaction blockhash expires. Failed or late jobs return 503 `video_failed`
or `video_timeout` without settlement; late jobs are canceled best effort. Polling and downloads stay free.
Every job that does not deliver a clip writes one server-log line `video job not delivered {…}` with the Surplus job id, HTTP status,
Surplus's error code/type/message (truncated, token- and key-shaped text blanked), elapsed seconds and a `reason`:
`upstream_failed`, `poll_timeout`, `window_cutoff` (job failed with under 20 s left, so no next model starts) or `no_result_file`
(job `succeeded` without a file). Nothing is stored in a database: video keeps no state.
By default, failed submissions or retryable jobs can try up to two compatible healthy models at the same or lower list quote;
`fallback:false` refuses substitution. Billing always uses the signed requested quote. The response's `model` is
what ran; substitutions also include `requested_model` and `substituted: true`. Uncensored models are never sold.

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

## Run

```bash
npm ci
npm test
# Configure the Git-ignored .env with the variables below, then:
node --env-file=.env src/server.mjs
```

| Variable | Meaning |
| --- | --- |
| `SINGIT_ASK_PAY_TO_SOLANA` | Wallet that receives Solana payments. Its USDC token account must already exist. |
| `SINGIT_ASK_PAY_TO_BASE` | Address that receives Base payments. |
| `SIGN402_BASE_BUILDER_CODE` | Optional. Base Builder Code (base.dev). When set, every Base-payable 402 declares it as the x402 `builder-code` app code (`a`), and the CDP facilitator appends it to the settlement calldata as an ERC-8021 suffix. Unset or invalid: no extension. Keep it in the service env, never in git. |
| `SURPLUS_API_KEY` | Surplus buyer key (`inf_…`) with access to the configured model. Fund its workspace's deposited USDC balance; USDC in the linked wallet alone is not a prepaid balance. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Coinbase CDP facilitator credentials, required. The service reuses the `cdp-x402-service` installation of `@coinbase/x402`. |
| `SINGIT_ASK_DIRECT_SOLANA` | Set `1` to enable the private direct Solana route with CDP metering. |
| `SINGIT_ASK_VIDEO_SOLD` | Set `1` to sell `/v1/video/generations`. Unset (default): video is off. `POST` answers 503 `video_disabled` with no payment offer, `GET /v1/video/models` answers 503, and video is left out of openapi, discovery and `llms.txt`. Jobs that were already paid can still be polled. Off since the provider failures on 27.10.2026; enabling sales remains an operator decision. |
| `SINGIT_ASK_VIDEO_DISCOVERABLE` | Only with `SINGIT_ASK_VIDEO_SOLD=1`: set `1` to list `/v1/video/generations` for x402 discovery (402 on GET/HEAD and the empty probe, `/.well-known/x402`, `llms.txt`). Unset (default): sold (if on), but not listed. |
| `SINGIT_ASK_QUOTE_TOKEN` | Dedicated server-only authentication secret, shared by merchant and gateway (at least 32 characters). |
| `SINGIT_ASK_QUOTE_DB` | Private writable SQLite path for prepared answers and settlement claims. |
| `SINGIT_ASK_MODEL` | Upstream model. Default: `deepseek-v4.1-flash`. |
| `SINGIT_ASK_PORT` | Loopback port. Default: `8140`. |
| `SINGIT_ASK_REASONING_EFFORT` | Measurement only; unset (default) changes nothing. `model=effort,...` (`none`, `minimal`, `low`, `medium`, `high`) asks that model for that reasoning effort instead of `none`, e.g. `claude-opus-5.5=low`. A value that cannot be read stops the process at start. |
| `SINGIT_ASK_REASONING_HEADROOM` | Measurement only; unset (default) changes nothing. `model=tokens,...` replaces the model's thinking headroom (`REASONING_HEADROOM` in `src/pricing.mjs`: 256 for Opus) in both the ceiling the 402 offers and the `max_tokens` sent upstream, e.g. `claude-opus-5.5=128`. Use only on a temporary loopback process for a paid test; it does not change the price formula. |
| `SINGIT_ASK_WALLET_REPORT_ORIGIN` | Public origin of the sign402 gateway's web API, named in `/openapi.json` for the free `GET /v1/wallet/{address}/reconciliation` (served by the gateway, not here). Default: `https://app.singitai.app`. |
| `SINGIT_ASK_ANSWER_LOG` | Optional file. Unset (default): nothing is recorded. When set, every settled chat answer (`/v1/chat/*`, `/v1/messages`, `/v1/responses`) appends one JSON line: UTC hour, route, model, scheme, network, `maxTokens`, prompt/completion/reasoning tokens, `upstreamMicro` (model cost), `billedAtomic`, `ceilingAtomic`, `overrunAtomic`. Never the question, the answer, the payer, a transaction, a header, an address or a finer time. File mode `0600`; logging stops at 50 MB. Its purpose: the real p50/p90/p99 of output tokens against `max_tokens`, which decides an `exact` ceiling. |
| `SINGIT_ASK_FREE_MODELS` | Models answered free as `free/<id>` on the public route, comma-separated. Unset: the default model. Empty: free answers off. |
| `SINGIT_ASK_FREE_PER_VISITOR`, `SINGIT_ASK_FREE_PER_DAY` | Free answers a day per visitor and for everyone together. Defaults: 20 and 1000. A visitor is a network, not an address: the Cloudflare client address's IPv4 /24 or IPv6 /64 (an IPv4-mapped IPv6 address counts as its IPv4 network), so rotating addresses in one subnet does not multiply the allowance. Free answers are capped at 400 tokens and 4000 characters of question. |
| `SINGIT_ASK_FREE_BUDGET_USD_PER_DAY` | Optional daily dollar budget for free answers. Unset (default): no budget is checked. When set, each free answer is counted at the model cost Surplus reports for it (`usage.buyer_cost_micro`, validated like a paid answer's, with no markup or fee); with no usable report it counts at the model's list price for its worst case (400 output tokens, input at 4 characters per token). Once the day's spend reaches the budget, free answers are refused with `429` and `Retry-After` until midnight UTC. While a budget is set, a model whose price is not known is not answered free (`503`). Counters are in memory and restart with the service. |

Free answers have no wallet, so there is no per-wallet limit here: the network above is the only identity they carry. Free models are listed in `GET /v1/models` as `free/<id>` entries (`free: true`, with their `limits`) next to the paid ones, and in `/openapi.json` under the chat route's `x-free-models`. Wallet-based limits belong to the gateway's free models (`sign402-gateway/README.md`).

The service listens on 127.0.0.1 only. Configure a Cloudflare tunnel hostname to publish it. Only loopback proxies are trusted for the forwarded HTTPS scheme.

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
