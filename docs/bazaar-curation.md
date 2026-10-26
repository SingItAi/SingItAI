# Bazaar curation readiness

Coinbase's Bazaar lists x402 services that pass its curation rules
([Get discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered)).
This page checks `ask.singitai.app` against those rules, says what the code and
CI now prove, and marks what only the owner can do.

Status as of 24 October 2026. **No uptime figure appears here: none has been
measured yet.** The probe in this change has not been installed anywhere, so the
30-day number is empty, not 100%. Nothing below was verified against live
Coinbase systems by this change; the CDP validator ran only against fakes.

## Checklist

| # | CDP requirement | Status | Evidence / next step |
| --- | --- | --- | --- |
| 1 | Live mainnet payments | **Owner** | Base agent-paid settlement is recorded in [CHECKS.md](../singit-ask/CHECKS.md); Solana settlement and Bazaar registration are listed there as unverified. Indexing needs one real paid call through CDP's facilitator against a listed route. That spends money and signs a payment, so it is not done here. |
| 2 | 30-day availability at least 99% (99.5% for priority) | **Not measured** | [`scripts/singit-uptime.py`](../scripts/singit-uptime.py) records unpaid probes and reports 24h/7d/30d availability, `null` when a window has no data. Install is **Owner** (see below); the 30-day window only counts as covered after 30 days of recorded history. |
| 3 | Health probe: the endpoint keeps returning 402 | **Done in code, offline** | `GET`, `HEAD` and an empty `POST` on all 8 listed routes answer 402 with the same challenge. [`scripts/bazaar-lint.mjs`](../scripts/bazaar-lint.mjs) asserts this in CI. The uptime probe also treats a 402 without a valid `accepts` list as down. |
| 4 | Complete input schema | **Done** | Every listed route declares a Bazaar input schema with a type and a description per field; the lint fails on a missing or undescribed field and on examples that use fields the schema lacks. Gaps the lint found were fixed in `formats.mjs` and `search.mjs`. |
| 5 | Description says when to use it, at most 500 characters | **Done** | The lint fails over 500. The wording was written for agents choosing a service; whether it says "when to use" well enough is a judgement for the owner to re-read. |
| 6 | Per-call pricing and supported networks | **Done** | Each challenge lists Base and Solana offers with `scheme`, `asset`, `payTo` and an integer-string `amount`; the lint checks them, including `payTo` against the configured address. |
| 7 | Documented error responses | **Done** | `openapi.json` documents 402 (with the `PAYMENT-REQUIRED` header), 400, 413 and 503 (with `Retry-After`; never 502, which Cloudflare replaces with its own HTML page) on every paid path, 422 on `/v1/chat/completions` and `/v1/chat/{model}` (a reasoning model spent `max_tokens` thinking), 429 on `/v1/chat/completions`, 404 where a model can be unknown (messages, responses, images, speech, video) and 409 where a payment can be replayed (images, speech, video, Exa), only where the handlers send them. [`singit-ask/test/openapi-errors.test.mjs`](../singit-ask/test/openapi-errors.test.mjs) checks each code against the real response. |
| 8 | No instruction-like text in metadata | **Done, heuristic** | The lint screens every published string (description, tags, schema text) against 15 patterns such as "ignore previous", "you must", "always call", "system prompt". It caught one real hit (the Messages `system` field) which was reworded. CDP's own screening is not public, so passing here is not a guarantee. |
| 9 | Validation passes: `valid: true`, `simulation.outcome: "accepted"` | **Not run** | [`scripts/cdp-validate.mjs`](../scripts/cdp-validate.mjs) calls CDP's free validator for the 8 resources in [`scripts/bazaar-resources.json`](../scripts/bazaar-resources.json) and exits 1 on `valid: false`, a non-accepted simulation or a required preflight failure. It runs only from the manual/weekly workflow `bazaar-validate.yml`. The deployed service must carry the metadata changes in this PR first (**Owner**: deploy). |
| 10 | `iconUrl` is PNG, JPG, WebP or GIF, never SVG | **Gap** | No route sets an `iconUrl`; the lint reports one warning per route. It fails on `.svg` or plain `http`. Needs an owner-supplied raster icon at an https URL. |

## What CI checks

- `security-gate.yml`, job `bazaar-lint`, on every push and PR: installs
  `singit-ask` with `npm ci --ignore-scripts`, boots the app in-process with a
  fake facilitator and fake catalogue, probes each listed route, then runs
  `node --test scripts/tests/*.test.mjs`. No network, no payment, no secrets.
  Run it locally with `node scripts/bazaar-lint.mjs` (`--strict` makes warnings
  fail, `--json` for a machine report).
- `bazaar-validate.yml`: manual dispatch and a weekly schedule only. It never
  runs on `pull_request` or `push`, so forks and PRs do not reach Coinbase. It
  sends only `{resource, method}` to the free endpoint: no API key, no payment
  header, `permissions: contents: read`, a 5 minute timeout.

## Current lint result

Against the code in this branch: 8 routes, 0 failures, 8 warnings. Every warning
is the missing `iconUrl`.

Known, deliberate differences:

- `/v1/audio/speech` returns audio, so its challenge carries no JSON output
  example; the lint allows that when `mimeType` is not JSON.
- `/v1/chat/completions/metered` and `/v1/credit` are paid but not listed.
- `/v1/video/generations` is sold but listed only with `SINGIT_ASK_VIDEO_DISCOVERABLE=1`.
  It is off: Surplus's video sellers come and go (a clip went through on 25 October
  2026, then three paid attempts met `no_healthy_sellers`). To list it, set the flag,
  add it to `scripts/bazaar-lint.mjs` and `bazaar-resources.json`, and make one paid call.
- Per-model `/v1/chat/{model}` routes (PR #66) are not covered; add them to the
  lint and to `bazaar-resources.json` when that PR lands.

## What needs the owner

1. **One live paid call** for indexing (row 1): a real, funded x402 payment to a
   listed route. This change never sends a payment header or signs anything.
2. **Deploy** the metadata changes (rows 4, 5, 8, 10) to the VPS and tunnel.
   Until then the live service still serves the old metadata and the validator
   would be judging that.
3. **Install the uptime timer** (row 2). `deploy/systemd/singit-uptime.service`
   and `.timer` are templates, not installed or enabled. The timer needs to run
   for 30 days before a 30-day figure is real.
4. **Publish a status page**, if wanted. `--status-json` and `--html` write
   public-safe files (no IPs, no error bodies); where and whether to serve them
   is the owner's call.
5. **Choose an alert channel.** None is enabled. Operator health alerts are a
   separate script (PR #61) and are not duplicated here.
6. **Provide a PNG/JPG/WebP/GIF icon** and decide its URL (row 10).
7. **Trigger `bazaar-validate.yml`** once after deploy and read the report; the
   validator's reading of CDP's `preflight` field names is untested against the
   real reply, so check that the output looks sensible on the first run.
