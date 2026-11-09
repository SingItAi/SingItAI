# Bazaar curation readiness

Status as of 1 November 2026. The directory observations below were read from
the public CDP, x402scan, nohumans.directory, agentic.market and MCP Registry
endpoints on that day; the code checks run offline. No uptime figure has been
measured here.

## Checklist

| # | CDP requirement | Status | Evidence / next step |
| --- | --- | --- | --- |
| 1 | Live paid payments / indexing | **Done** | CDP's catalog lists all 22 ask.singitai.app routes, each with Base and Solana offers: 5 generic, 14 per-model and 3 Exa routes (observed 1 November). |
| 2 | 30-day availability at least 99% (99.5% for priority) | **Not measured** | Install the uptime timer; a 30-day window needs 30 days of recorded history. No uptime figure is claimed. |
| 3 | Health probe: endpoint returns 402 | **Done in code, offline** | The lint probes GET, HEAD and empty POST on all 22 listed routes and requires matching 402 challenges. |
| 4 | Complete input schema | **Done in code** | The lint checks field types, descriptions and examples. Pinned model schemas exclude fallback_models and min_tier; generic chat retains its applicable fields. Catalog schemas can lag the live challenge. |
| 5 | Description says when to use it, at most 500 characters | **Done in code** | The lint enforces the limit; other routes stay at 300 or less. Generic chat keeps its "call it when" sentence and also describes singit/auto tiers and the free/ daily allowance. |
| 6 | Per-call pricing and supported networks | **Done in code** | The lint checks offers and configured recipients for Base and Solana. Catalog prices can lag live quotes. |
| 7 | Documented error responses | **Done in code** | singit-ask/test/openapi-errors.test.mjs checks documented errors against handlers. |
| 8 | No instruction-like metadata | **Done, heuristic** | The lint screens descriptions, tags and schema text. CDP's own screening is not public. |
| 9 | Validation passes | **Done** | CDP's free validator returned valid:true and simulation outcome "accepted" for all 22 routes on 1 November 2026. Re-run bazaar-validate.yml after each metadata deploy. |
| 10 | Raster iconUrl | **Done** | ICON_URL is set on every route; CDP's catalog shows an icon for all 22 (1 November observation). |

## What CI checks

- security-gate.yml runs the offline Bazaar lint with a fake facilitator and
  catalogue, probing all 22 listed routes, and scripts/tests. No payments or
  external requests are needed. Run node scripts/bazaar-lint.mjs locally;
  --strict makes warnings fail and --json emits a machine report.
- bazaar-resources.json lists the same 22 routes; tests compare the URL sets
  and require every MODEL_ROUTES entry.
- bazaar-validate.yml runs manually and weekly, never on push or pull_request.
  It sends resource and method to CDP's free validator without payment or
  credentials. Re-run after each metadata deploy.

## Catalog freshness and deliberate omissions

CDP shows its own probe of our 402 at the last settle it indexed per route.
Schemas and prices can therefore lag the live challenge. On 1 November, the
14 model routes were last refreshed on 27 October and /v1/chat/completions on
31 October; 12 of the 22 catalog prices differed from the live challenge as
upstream prices moved.

Refreshing requires another successful settle through CDP's facilitator
carrying paymentPayload.resource and paymentPayload.extensions.bazaar.
CDP's maintainers say a testnet payment is enough. This is a paid call and
remains an owner action. CDP keeps only resources active in the last 30 days;
the model routes' last indexed call was 27 October.

The five generic routes are /v1/chat/completions, /v1/messages, /v1/responses,
/v1/images/generations and /v1/audio/speech. Exa lists /v1/exa/search,
/v1/exa/contents and /v1/exa/answer; the 14 pinned routes come from MODEL_ROUTES.
Per-model routes are covered by the lint and bazaar-resources.json.
/v1/chat/completions/metered and /v1/credit stay unlisted by design.
Video stays unlisted with SINGIT_ASK_VIDEO_DISCOVERABLE off.

## Other directories

Observations as of 1 November 2026:

- x402scan: origin registered once on 13 October, one route with an old schema.
  Re-registration is a free wallet-signed step in the owner's x402scan UI.
- nohumans.directory: auto-indexed 6 of 22 routes.
- agentic.market: shows 20 endpoints, reading CDP's catalog.
- MCP Registry: latest version 0.1.4, published 31 October from
  SingItAi/singit-mcp. See [manifest ownership](mcp-page-sources.md#mcp-registry-manifest).

## What needs the owner

1. Paid settles to refresh the 14 stale model routes with resource and Bazaar metadata.
2. Free wallet-signed x402scan re-registration.
3. Deploy this PR's singit-ask changes and re-run bazaar-validate.yml.
4. Install deploy/systemd/singit-uptime.service and .timer; collect history.
5. Keep the canonical singit-mcp manifest and this repository's server.json
   byte-identical, changing both and bumping both versions together.
6. Run mcp-publisher after merge. Restart the gateway to serve serverInfo 0.1.5 after owner approval.

Registry still has 0.1.4 until the owner approves publishing 0.1.5; the live server reports 0.1.3 until the gateway is restarted with this code. No publishing or restart was performed.

## Spending-limits wording (5 November 2026)

Where the "limits" fact is published, and what each place can say:

- **Route descriptions are capability-first and at most 160 characters.** `listing-copy.mjs` bans
  ceiling, fee and percentage wording. Aliases use "owner-set USDC limits"; billing and limits
  details live in OpenAPI, `/.well-known/x402` and `/llms.txt`, not in listing descriptions.
- **`/llms.txt` on ask.singitai.app** has a "Spending limits" section: the 402 quotes the most you can be charged before
  you sign; `@singitai/sdk` and `singit` take required `maxPerCallUsd` and `maxPerDayUsd` (client-side, checked in the
  buyer's process before signing); through the MCP server or a SingIt API key the owner sets the key's limits and
  SingIt's server enforces them. `website/llms.txt` and `llms-full.txt` carry the same SDK sentence.
- **Nothing here says the limits are enforced on-chain.** The Base AgentAllowance contract limits only SingIt's own agent
  (see the site's limits pages); SDK ceilings are client-side and key limits are server-side.
- **agentic.market** reads CDP's catalog: its card for ask.singitai.app shows `description: ""`, `category: ""` and
  `enriched: false`, so the text cannot be set from this repository. It is a provider-side step; proposed text
  (258 characters): "Pay-per-answer LLM chat (OpenAI, Anthropic and Responses formats), images, speech and Exa web search over x402 in USDC on Base or Solana, with no API key. The max charge is quoted before signing; the SingIt SDK adds client-side ceilings per call and per day.". Category: Inference.

### L1 draft boilerplate (SI-287)

`bazaarLimitsBoilerplate()` in `singit-ask/src/listing-copy.mjs` exports capability-first
CDP description copy (at most 160 characters), mentioning owner-set USDC limits via
MCP/API keys. It rejects ceiling, fee and percentage wording. Existing route and
pinned alias descriptions remain unchanged: long names leave little room; WK
`documentation`/`instructions` and MCP carry the limits message. Direct wallet
payments are not covered by the owner's agent limits.

This is draft metadata only, gated after R1/R2 reliability work. Growth listings
are a separate later step. CDP refresh still needs paid settles after deploy,
performed by Kostya; this change makes no calls or submissions. Merge/deploy
requires Kostya's own OK in Dev/Ops chat.

Stale CDP rows with "you sign a price cap" or the old long Grok text need a paid
settle refresh after deploy (Kostya OK). No paid refresh is performed by this change.
