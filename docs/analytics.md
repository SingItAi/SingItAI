# Analytics

Cookieless, privacy-first product analytics: a durable `events` row in `web.db` (the source of
truth, queryable and backfillable) and an optional mirror to a self-hosted Umami instance. No
cookies, no third-party script, no address/email/tx-hash/prompt content ever leaves the server
— see [`sign402_gateway/analytics.py`](../sign402-gateway/sign402_gateway/analytics.py).

## Identity and privacy

- A user is identified only by `uid = sha256(account_id + ANALYTICS_SALT)[:16]`, hex. The raw
  `account_id` (which embeds the wallet address) is never written to the `events` table or sent
  to Umami.
- Props are whitelisted before anything is stored or sent: a key is dropped if any whole
  snake_case word in it is sensitive (`address`, `owner`, `email`, `tx`, `hash`, `prompt`,
  `code`, `key`, `secret`, `token`, `signature`, `invoice`, `recipient`, `phone`), with a small
  explicit allow-list for safe-but-similar-looking keys (`tokens_in`, `tokens_out`, `cost_usd`,
  `amount_usd`, `daily_cap_usd`, `per_purchase_cap_usd`, `key_ref`). A string value is also dropped if it is
  shaped like an EVM address, a tx hash, an email, or a base58 Solana address, regardless of its
  key.
- Amounts are sent as USD decimal strings (USDC atomic / 1e6), never raw atomic integers tied to
  a specific on-chain amount that could be correlated back to a transaction.
- `emit()` never raises into caller code: a broken analytics path must never break a sign-in or
  a payment. It also never blocks one noticeably — the events-table write uses a 1-second sqlite
  busy timeout, and the Umami mirror runs on a background thread with a 1-second timeout.

## Events

| Event | Side | Where |
|---|---|---|
| `landing_visit`, `cta_open_app` | Client | landing pages, once an Umami script tag exists (deferred) |
| `app_open` | Client | `website/app/main.js` `start()` |
| `wallet_connect` | Client | `main.js` `connectInjected()`, and the AppKit account-change handler in `start()` |
| `chat_message_sent` | Client | `main.js` `sendMessage()` |
| `pwa_installed`, `push_enabled` | Client | `main.js` `appinstalled` listener, `enablePush()` |
| `sign_in` | Server | `web_api.py` `POST /auth/verify`, after the session is durably created |
| `limits_set` | Server | `agent_allowance.py` / `solana_allowance.py` `setup()`, after the limiter/limits row is committed |
| `approval_signed` | Server | `agent_allowance.py` `_advance_op`/`advance()`, `solana_allowance.py` `submit_wallet()` — a GRANT operation reaching `DONE`/`FAILED` |
| `revoke` | Server | same choke points as `approval_signed`, for a REVOKE operation |
| `pause` | Server | `agent_allowance.py` `pause()` (`trigger=user` from the API route, `trigger=watcher_auto_pause` from `allowance_watcher.py`) |
| `purchase_completed` | Server | `agent_allowance.py` `count_settlement()` (Base), `solana_allowance.py` `spend()` (Solana) |
| `purchase_failed` | Server | `allowance_bitrefill.py` `buy()` (a refusal before paying), `solana_allowance.py` `spend()` (nothing sent) |
| `chat_answer_paid` | Server | `web_agent.py` `record_usage()` (web chat), `web_balance.py` `bill()` (API-key balance), `ask_metered.py`/`ask_solana.py` `pay()` (x402 metered Ask, Base and Solana) |
| `funds_added` | Server | `web_balance.py` `credit_topup()`, once its ledger row is committed |
| `api_key_created` | Server | `web_api_keys.py`, after the key is created |
| `mcp_call` | Server | `web_mcp.py` `McpServer._tools_call_observed()`, once per MCP `tools/call` after it finishes |

`repeat_purchase` is not a separate event: filter `purchase_completed` by `purchase_n >= 2`.
`purchase_completed` is not emitted for a settlement of `https://ask.singitai.app/v1/credit` (a
balance top-up — `funds_added` covers it) or of a non-metered `.../v1/chat/completions` (would
double-count with `chat_answer_paid`); see `_settlement_category()` in `agent_allowance.py`.

### `mcp_call`

One event per MCP `tools/call` on `POST /mcp`, emitted after the call has finished, whether it
succeeded or not. `initialize`, `tools/list` and `ping` are not recorded. A failure anywhere in
building or storing the event is logged and swallowed: it never reaches the request.

| Prop | Value |
|---|---|
| `tool` | The tool's name if it is one of ours (`get_price`, `web_search`, `get_token_price`, …), otherwise `"unknown"`: a caller-chosen name is never stored. |
| `status` | `ok`, `error`, `refused` (a scope, spend-limit or allowance refusal) or `rate_limited`. |
| `error_kind` | Only when `status` is not `ok`. A short class, never a message: `auth`, `scope`, `limit`, `upstream`, `bad_args` (an unknown tool or invalid arguments), `internal`. |
| `latency_ms` | Integer milliseconds from the start of the call to its result. |
| `paid` | `true` when the tool is a paid one (`web_search`, `read_page`, or a `tools`-scope tool), whether or not this call was charged. |
| `cost_usd` | USD decimal string of what the key was charged (at least 2 places, sub-cent kept: `"0.003"`). Present only when the result reports an actual charge; otherwise omitted, never `0`. |
| `key_ref` | The first 12 hex characters of `sha256(ANALYTICS_SALT + key_id)`, where `key_id` is the key's public id (`key_…`) — never the secret, its prefix or its hash. It lets one key's calls be grouped without naming it. |
| `client` | **Never set today.** The server is stateless, and a client's name only travels in `initialize`, which is not recorded. The prop is reserved (40 characters at most, dropped if it looks like an address or an email) for the day a session exists. |

The user is the usual `uid`, from the key's `account_id`. Tool arguments (queries, URLs, symbols,
prompts) are never read into the event, and neither are the API key, a wallet address, an account
id or a transaction hash. `rate_limited` covers both the key's own 60-a-minute limit and a
`rate_limit_exceeded` from the shop behind it; the two are not told apart.

## Environment variables

| Variable | Purpose |
|---|---|
| `ANALYTICS_SALT` | Salts the account-id hash. **Must be set in production** — without it, `uid` is still one-way but guessable from a known account_id. A warning is logged once per process if it is missing. |
| `UMAMI_URL` | Base URL of the self-hosted Umami instance (e.g. `http://127.0.0.1:3000`). Leave unset to disable the Umami mirror entirely (no network calls, no background thread). |
| `UMAMI_WEBSITE_ID` | The Umami website id to send events under. Required alongside `UMAMI_URL`. |
| `UMAMI_HOSTNAME` | Optional override for the `hostname` field Umami receives (default `app.singitai.app`). |
| `SIGN402_ANALYTICS_DISABLED` | Set to `1` to turn `emit()` into a complete no-op (events table and Umami both skipped). |
| `SIGN402_WEB_DB` | Same variable the web account store already reads; `events` lives in this database. |

Server-side events carry the real client IP and User-Agent to Umami only (as `X-Forwarded-For`
/ `X-Real-IP` and `User-Agent` request headers) — never as stored props, and never into the
`events` table — so a sign-in from a browser does not collapse into one Umami session with every
other server event from the gateway's own loopback address. Payment-internal code never passes
these; only request handlers that already have them (e.g. `POST /auth/verify`) do.

## Running `daily-metrics.py`

```sh
.venv/bin/python scripts/daily-metrics.py --day 2026-10-17
.venv/bin/python scripts/daily-metrics.py --out ~/.sign402/metrics       # writes DIR/YYYY-MM-DD.json too
.venv/bin/python scripts/daily-metrics.py --text                        # short text summary
```

The report also carries an `mcp` section, built from the `events` table (`null` when that table
is missing), and a `revenue` section; both are described below. Read-only: every database is opened as `file:PATH?mode=ro` (same pattern as
`scripts/sign402-operator.py`'s `_connect_readonly`), and never written to. A missing database,
or a table an older deploy does not have yet, is reported as `null` for the fields it would have
answered rather than crashing the run. Output is aggregate counts and sums only — it never prints
a wallet address or an account id. The day defaults to yesterday in Europe/Prague (the cron below
runs at 00:10 there); `--day YYYY-MM-DD` overrides it.

DB paths default to `$SIGN402_STATE_DIR/<file>` (falling back to `~/.sign402/<file>`), each
overridable by the same environment variable the gateway itself reads, or by a `--*-db` flag —
see `--help`. The Telegram Bitrefill orders database (a separate demo-dashboard host path on
deployments that have it at all) has **no default**: it is only read when `--bitrefill-orders-db`
or `SIGN402_BITREFILL_COMMERCE_STORE_PATH` names it, and its section reports `null` otherwise.

A few fields need a reporting note, because the underlying tables were not designed for this:

- **`signed_in_today`** is counted from the `events` table (`sign_in`, distinct `uid`), not the
  `sessions` table — session rows are deleted once they expire, so a `sessions` count is only
  ever a lower bound for "today". When the `events` table is not there yet,
  `signed_in_today` is `null` and `signed_in_today_source` says `"unavailable"` rather than
  silently reporting the unreliable `sessions` count as truth (that count is still included, as
  `sessions_rows_today_unreliable`, for debugging).
- **Settlement categories** (`purchases`, `usdc_volume.base`, `active_spenders`,
  `first_purchases`, `repeat_buyers`, `settlements_by_lane`) all exclude the
  `https://ask.singitai.app/v1/credit` resource: it is a balance top-up, already counted in
  web.db's own `credit_topups`/`balance_ledger`, and would double-count as a "purchase"
  otherwise. It is reported on its own as `credit_topup_settlements`. A non-metered
  `.../v1/chat/completions` settlement counts as `chat_answer`, same as the metered one;
  anything else (`bitrefill:invoice:…`, `api.exa.ai/search`, a Bitrefill/tool/data-seller URL,
  …) is `data_tool`.
- **`settlements_by_lane`** splits Base settlements into `web` (`user_id` starts with
  `wallet:`, matching web.db's accounts) and `telegram` (a bare numeric id — the legacy
  Telegram-bot lane, which shares `allowance.db` with the web lane).
- **`abandoned_solana_setups`** (`today` / `total_outstanding`) counts Solana `ops` rows that
  are `GRANT`+`PREPARED` and more than an hour old: the owner never came back to sign the
  wallet transaction. These are not counted as `errors.ops_failed`/`ops_expired` — nothing
  failed, the setup was simply abandoned.
- **`errors.ops_failed`/`ops_expired`/`ops_uncertain`** only sum kinds that table actually has:
  Base's `operations.kind` is `GRANT`/`REVOKE`/`PAUSE` (no `FUND_GAS`, no `UNCERTAIN` state);
  Solana's `ops.kind` adds `FUND_GAS` and has no `PAUSE`.
- **`bitrefill_orders`** reports both the raw `by_state` counts and a `by_bucket` grouping
  (`delivered`, `user_rejected`, `pending`, `needs_reconciliation`, `failed`, `expired`); any
  state this script does not recognize yet lands under `other` instead of being dropped or
  raising.

Suggested cron (00:10 Europe/Prague, from the repo root):

```
10 0 * * * cd /path/to/SingItAI && .venv/bin/python scripts/daily-metrics.py --out ~/.sign402/metrics >/dev/null
```

### The `mcp` section

Counted from `mcp_call` events in the day's window:

```json
{
  "calls_total": 6,
  "by_tool": {"get_price": 1, "get_token_price": 1, "list_models": 1, "unknown": 1, "web_search": 2},
  "by_status": {"error": 2, "ok": 4},
  "distinct_uids": 3,
  "distinct_keys": 3,
  "latency_ms": {"p50": 300, "p95": 1000},
  "paid_calls": 2,
  "cost_usd": "0.010"
}
```

`p50`/`p95` are nearest-rank percentiles of `latency_ms` (`null` on a day with no calls).
`cost_usd` sums the events' own `cost_usd`. A day with no calls is zeros with `null` latencies;
a missing `events` table is `mcp: null`.

### Excluding your own accounts

Test and operator accounts distort the counts. Name their `uid` hashes (the 16-hex `uid`, never an
address) in `SIGN402_METRICS_EXCLUDE_UIDS` (comma-separated), and/or in a file passed as
`--exclude-uids-file PATH` (one uid per line; blank lines and `#` comments are allowed). The
two are merged. Keep the file out of git. Events from those uids are removed from every
count that comes from the `events` table (`signed_in_today`, `pauses`, `events`, `mcp`), and the
report says how many were excluded as `excluded_uids_count`. The settlement and allowance
tables are keyed by account, not by `uid`, and are not filtered. An unreadable file is an error,
not a silent no-filter.

### `api_keys` and `revenue`

- **`api_keys.active`** is the number of API keys with a billed call that UTC day, from
  `api_key_spend`. It does not count a key that only used free tools (those never write a usage
  row), so it is a floor, and it is `null` when the table is missing. The store's day is UTC, not
  Europe/Prague: it is offset from the other figures by one or two hours. `api_keys.created` is the
  keys created in the window.
- **`revenue.usdc_volume`, `chat_answers`, `credit_topups_usd`** repeat the figures above in one place.
- **`revenue.margin` is `null`, on purpose.** Gross is known everywhere; what it cost us is
  recorded in one lane only, so a total margin would be a guess. `revenue.margin_note` names the
  tables that lack a cost: `allowance.db` `settlements` (amount and resource only),
  `web.db` `chat_usage` (`cost_atomic` is what the user paid), `solana-allowance.db` `spends`
  (amount only). Paid-tool settlements are pass-through and carry no markup.
- **`revenue.balance_lane`** is the exception: `web.db` `balance_ledger` stores `cost_atomic`
  ("what the model cost, before the markup") beside each charge. It reports `charges`,
  `gross_usd`, `refunds_usd`, `provider_cost_usd`, `margin_usd`, and `charges_without_cost` (charges
  with no recorded cost, counted and left out of the margin rather than guessed).

To make margin real everywhere, a payment-path change is needed (not done here): record
`provider_cost_atomic` and `markup_atomic` next to the amount in `count_settlement()`
(`allowance.db` `settlements`), in `chat_usage`, and in the Solana `spends`, taking them from
`ask_metered`'s `cost` and `markup` when it validates the result; and have the paid-tool path
(`web_data.search` and the `PAID_TOOLS` calls) record its base price.

## The dashboard (`metrics-dashboard.py`)

```sh
.venv/bin/python scripts/metrics-dashboard.py                  # ~/.sign402/metrics -> ~/.sign402/metrics/dashboard.html
.venv/bin/python scripts/metrics-dashboard.py --dir DIR --days 14 --out /tmp/dashboard.html
```

It reads the `DIR/YYYY-MM-DD.json` files that `daily-metrics.py --out DIR` writes (the last
`--days`, default 30, ending at the newest file) and writes one self-contained HTML file: inline
CSS and inline SVG sparklines, no script, font or image from anywhere, and no JavaScript. Sections:
wallets (new, signed in, active spenders), transactions and purchases, revenue (USDC volume, chat
answers, credit top-ups, margin where it is known), active API keys, and MCP calls (total, by
tool, by status, latency). A figure that was not recorded, or a day with no file, is shown as
"—" and is a gap in the sparkline; it is never drawn as `0`. A real recorded zero is a `0`. The
file is written mode 0600.

**It is operator-only.** The dashboard is a local file: copy it with `scp` or open it over `ssh`.
It must never be served on a public route, and it is not wired into the web app or the landing
page. Serving it, behind auth, is a later decision for the owner. It holds only the aggregates
`daily-metrics.py` already prints, and every value is scrubbed of `0x` addresses on the way out.

Suggested cron (not installed; a few minutes after `daily-metrics.py`):

```
# 15 0 * * *  cd /path/to/SingItAI && .venv/bin/python scripts/metrics-dashboard.py >/dev/null
```

## What is deferred to server-side ops

Setting up Umami itself (Docker container, Postgres, the Cloudflare tunnel hostname, the
`<script>` tag on the landing pages and in `website/app/index.html`, and configuring goals/funnels
in the Umami UI) is VPS/ops work, not code in this repository, and is not done here. Until then:
`UMAMI_URL`/`UMAMI_WEBSITE_ID` are unset, so the Umami mirror is a no-op and every event still
lands durably in the `events` table, queryable today and ready to backfill into Umami later.
