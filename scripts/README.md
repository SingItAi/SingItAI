# Operations scripts

For service setup and tests, see [operations](../docs/operations.md).
The original local demo launcher and dashboard have been retired.

## Backup Sign402 State

Before opening the Telegram bot to public beta testers or changing production
env files, take a local VPS backup:

Set `SIGN402_BACKUP_ROOT`, `SIGN402_STATE_DIR`, `SIGN402_HERMES_ENV`, and
`SIGN402_SYSTEM_ENV` from private ops notes, then:

```bash
cd <APP_CHECKOUT>
./scripts/backup-sign402-state.sh
```

The backup is written to `<BACKUP_ROOT>/<timestamp>/` and may contain
wallet databases, API tokens, and the wallet master key. Keep it private.
`<APP_CHECKOUT>` and `<BACKUP_ROOT>` are placeholders.

## Sign402 Operator Diagnostics

Use the local operator CLI on the VPS when a public tester gets stuck. It reads
local state without printing private keys, encrypted values, or API tokens.

```bash
cd <APP_CHECKOUT>
python3 scripts/sign402-operator.py users
python3 scripts/sign402-operator.py users --search alice
python3 scripts/sign402-operator.py user --telegram-id <telegram-id>
python3 scripts/sign402-operator.py find-imessage <e164-phone>
python3 scripts/sign402-operator.py pending --telegram-id <telegram-id>
python3 scripts/sign402-operator.py last-purchase --telegram-id <telegram-id>
```

Telegram does not expose a user's phone number to the bot. Use `users` or ask
the user for the Support ID shown by `/start`.

To remove a broken iMessage link, use the authenticated localhost gateway
endpoint through the CLI:

```bash
python3 scripts/sign402-operator.py unlink-imessage --telegram-id <telegram-id>
# or
python3 scripts/sign402-operator.py unlink-imessage --phone <e164-phone>
```

The unlink command needs `SIGN402_PHOTON_API_TOKEN` and
`SIGN402_GATEWAY_URL` available from the environment or standard Sign402 env
files.

## Hosted Hermes Telegram Wallet Plugin

The VPS deployment can expose the managed Base wallet endpoints through
deterministic Hermes Telegram commands without giving the LLM control of a
Telegram user ID.

Configure `SIGN402_GATEWAY_URL` and `SIGN402_WALLET_API_TOKEN` in the
Hermes gateway environment, then install the repository plugin:

```bash
cd <APP_CHECKOUT>
./scripts/install-hermes-wallet-plugin.sh
hermes gateway restart
```

See `hermes-plugins/sign402-wallet/README.md` for the secure configuration,
allowlist-first test flow, and diagnostics.

## Health Alerts

Probes the public endpoints and Base RPC, and alerts an operator (Telegram, a webhook, or stdout -
whichever is configured) when one is down. Read-only; no deploy, no channel chosen by default.

```bash
python3 scripts/singit-health-alert.py --dry-run
python3 scripts/singit-health-alert.py --rpc-url "$SIGN402_BASE_RPC_URL" --journal-unit sign402-web
```

See the script's own docstring for every check, env var, and a sample systemd user timer /
crontab line (every 5 minutes). Tests: `python3 -m unittest discover -s scripts/tests`.

## BlockRun Prices Snapshot

The website's `/pricing/` page (SingIt vs BlockRun) compares SingIt's live `GET
https://ask.singitai.app/pricing.json` against BlockRun's prices in the browser. BlockRun has no
CORS promise for the page to call it directly, so its side is a committed, static snapshot that
this script refreshes:

```bash
node scripts/blockrun-prices-snapshot.mjs
```

Fetches `https://blockrun.ai/api/v1/models`, keeps only paid chat models (`id`, `name`, input/output
USD per million tokens), adds BlockRun's published flat per-request fee for chat ($0.001, pinned in
the script since no endpoint in `/api/v1/models` exposes it), and writes
`website/data/blockrun-prices.json`. Re-run it and commit the result whenever BlockRun's prices
move; `--out`, `--models-url`, `--fetched-at` and `--input <file>` (read a previously fetched
response instead of the network) override the defaults.

## Free model cost

`scripts/free-model-cost.py` reads a saved `/v1/models` JSON file and prints, per model, the worst-case cost
of one free answer (4000 characters of question at 4 characters per token, 400 answer tokens) at the list and
the expected price, and the month's cost at daily caps of 100, 300 and 1000 answers. It is offline and
read-only. See [free models](../docs/free-models.md).

```bash
python scripts/free-model-cost.py docs/data/singit-models-2026-10-24.json
python scripts/free-model-cost.py MODELS.json --models deepseek-v4.1-flash --caps 100,300 --json
```

## Daily Metrics and Dashboard

`daily-metrics.py` prints one day of aggregate counts as JSON (`--out DIR` also
writes `DIR/YYYY-MM-DD.json`); `metrics-dashboard.py` turns the last N of those
files into one static HTML page. Both are read-only and print no address,
account id or key. `SIGN402_METRICS_EXCLUDE_UIDS` / `--exclude-uids-file PATH`
drop your own test accounts (uid hashes, one per line in the file; keep the file
out of git) from the events-based counts.

```bash
cd <APP_CHECKOUT>
python3 scripts/daily-metrics.py --out ~/.sign402/metrics
python3 scripts/metrics-dashboard.py            # -> ~/.sign402/metrics/dashboard.html
```

The dashboard is operator-only: view it over `ssh`/`scp`, never serve it on a
public route. See [analytics](../docs/analytics.md) for every field, the
margin caveat and the suggested cron lines.

## SingIt Uptime

`scripts/singit-uptime.py` measures how often SingIt's public endpoints answer
as expected. Each run sends plain, unpaid `GET` requests (never a payment
header, never a body, 10 s timeout, redirects are not followed) to the
`ask.singitai.app` routes `/v1/responses`, `/v1/chat/completions`,
`/openapi.json` and `/health`, and to `app.singitai.app` `/app/` and `/mcp`.
The two paid routes must answer `402` with a well-formed x402 challenge (a
`402` without one counts as down). The web API has no `/health`, so `/app/`
stands in for it. Every probe is one row in a local SQLite table
`probes(ts, endpoint, ok, status, latency_ms, error)`; `error` is only a class
(`timeout`, `connection`, `tls`, `http_status`, `bad_challenge`, `bad_body`),
never a response body or message.

```bash
cd <APP_CHECKOUT>
python3 scripts/singit-uptime.py                         # one probe round, recorded
python3 scripts/singit-uptime.py --report                # JSON: 24h/7d/30d availability, p50/p95, failures
python3 scripts/singit-uptime.py --report-file report.json
python3 scripts/singit-uptime.py --status-json status.json   # small public-safe summary
python3 scripts/singit-uptime.py --html status.html          # static status page
python3 scripts/singit-uptime.py --prune-days 90         # optional, after a probe round
```

The database is `~/.sign402/uptime.db`, or `$SINGIT_UPTIME_DB`, or `--db PATH`.
`--endpoints FILE` replaces the endpoint list with a JSON list of
`{name, url, expect, kind}`. Probe mode is a recorder and exits 0 even when
endpoints are down. Availability is `null` for a window with no probes, never
100%, and each window carries a `covered` flag: it is false until the recorded
history reaches back over the whole window, so a 30-day figure built from a
few hours of data is visibly partial.

`deploy/systemd/singit-uptime.service` and `singit-uptime.timer` are user-unit
templates that run one round every minute. They are not installed or enabled.

Installing the timer, publishing any status page or status JSON, and enabling
any alert channel need the owner's OK and are not done by this change. Operator
alerts are a separate script and are out of scope here.

## Bazaar Metadata Lint and CDP Validator

Both are Node 22 scripts; the checklist they serve is in
[bazaar-curation](../docs/bazaar-curation.md).

`scripts/bazaar-lint.mjs` is offline. It boots `singit-ask` in-process with a
fake facilitator and catalogue (so `singit-ask/node_modules` must be installed),
requests every route listed for discovery with `GET`, `HEAD` and an empty
`POST`, and checks the 402 challenge: `x402Version`, offers with
scheme/network/asset/payTo/amount, an https resource URL, a description of at
most 500 characters, no instruction-like phrases, a Bazaar input schema and
examples, and an `iconUrl` that is not SVG. It also cross-checks
`bazaar-resources.json` against the routes the code advertises. It sends no
payment and makes no network call. CI runs it in `security-gate.yml` (job
`bazaar-lint`).

```bash
node scripts/bazaar-lint.mjs            # exit 1 on any FAIL; warnings (e.g. no iconUrl) exit 0
node scripts/bazaar-lint.mjs --strict   # warnings fail too
node scripts/bazaar-lint.mjs --json
node --test scripts/tests/*.test.mjs    # lint and validator unit tests
```

`scripts/cdp-validate.mjs` sends `{resource, method}` for each entry of
`scripts/bazaar-resources.json` to Coinbase's free validate endpoint (no API
key, no payment header) and prints `valid`, `simulation.outcome`, preflight
failures and recommendations. Exit 0: all valid and accepted; 1: a resource
failed validation; 2: the check could not run (bad config, network error,
timeout). It calls an external API, so it is not part of the offline gate: only
`.github/workflows/bazaar-validate.yml` runs it, on manual dispatch and weekly.

```bash
node scripts/cdp-validate.mjs           # needs network access to api.cdp.coinbase.com
node scripts/cdp-validate.mjs --json
```
