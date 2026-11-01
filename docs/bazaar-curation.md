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
6. Run mcp-publisher after merge. Restart the gateway to serve serverInfo 0.1.4.
