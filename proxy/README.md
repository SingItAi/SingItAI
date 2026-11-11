# @singitai/proxy

A local [OpenAI-compatible](https://platform.openai.com/docs/api-reference/chat) proxy for
[SingIt Ask](https://ask.singitai.app). Point Cursor, Continue, OpenClaw, Codex or any client that
takes a `baseURL` at this process. The same process also speaks the Anthropic Messages API at
`/v1/messages` (Claude Code can set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`) by translating those
calls to Ask's `/v1/chat/completions`. It needs no API key: on first start it creates a wallet on
your machine (the same `~/.singit/session` file as `@singitai/mcp`) and pays each chat call in USDC
on Base over x402, inside per-call and per-day limits you control.

> **Not on npm yet.** Publishing `@singitai/proxy` is a separate step that has not happened. Until it
> does, `npx @singitai/proxy` will not resolve; use [Run from this repo](#run-from-this-repo), or install a
> packed tarball (see [Installers](#installers-uninstall-and-rollback)).

An HTTP 402 from SingIt Ask is a payment demand, never a chat completion. If the wallet cannot pay,
the proxy returns an error and does not retry the signed request.

## Run from this repo

```sh
cd proxy
npm install
node src/index.js        # or: npx .
```

Then open `http://127.0.0.1:8787/wallet` for the Base USDC address to fund, and point your client at
`http://127.0.0.1:8787/v1/` (the trailing `/v1/` matters).

`@singitai/sdk` and the shared wallet module are installed from this checkout (see `.npmrc`), so run
`npm install` again after changing either.

The default listen address is `127.0.0.1:8787`. That port is this proxy's own default; it is not
copied from another product.

## What it exposes

| Method | Path | What it does |
|--------|------|----------------|
| GET | `/` or `/health` | Process status (no wallet address, no keys). |
| GET or POST | `/wallet` | Public address, Base network and a funding hint. Never returns the private key. |
| GET | `/v1/models` | The upstream catalogue (free). |
| POST | `/v1/chat/completions` | Paid chat, including `tools` and `stream: true`. |
| POST | `/v1/chat/<model>` | Rewritten to `/v1/chat/completions` with that model (so agents get tools and the 8192-token cap). |
| POST | `/v1/models/<model>/chat` | Same rewrite. |
| POST | `/v1/messages` | Anthropic Messages API, translated to Ask `/v1/chat/completions` (including `tools` / `tool_use` and `stream: true`). |
| POST | `/v1/responses` | OpenAI Responses API translated to Ask chat completions, including function calls and Responses SSE. |
| POST | `/v1/messages/count_tokens` | Local token estimate (`input_tokens`); does not call Ask or pay. |

`stream: true` is accepted. When Ask streams (`text/event-stream`) the proxy passes those SSE chunks
through (and translates them to Anthropic `message_start` / `content_block_delta` / `message_stop`
on `/v1/messages`, or Responses events on `/v1/responses`). After a paid settlement the SingIt SDK still requires a JSON invoice with
`billing.totalAtomic`, so the proxy requests `stream: false` from Ask, then emits the correct SSE
chunks plus `[DONE]` (OpenAI), the Anthropic event sequence, or Responses events ending in `response.completed` with usage. Responses output items are added before text or function argument deltas; streamed errors emit `response.failed`. HTTP 402 is never a successful
completion or `type: "message"`.

## Environment and flags

| Env / flag | Default | Meaning |
|------------|---------|---------|
| `SINGIT_PROXY_PORT` / `--port` | `8787` | Listen port. |
| `SINGIT_PROXY_HOST` / `--host` | `127.0.0.1` | Listen host (loopback by default). |
| `SINGIT_ASK_URL` / `--ask-url` | `https://ask.singitai.app` | Upstream Ask origin. |
| `SINGIT_NETWORK` / `--network` | `base` | Payment rail. `solana` is accepted only when Ask's `numbers.json` reports paid success of at least 95%. |
| `SINGIT_CLIENT` / `--client` | `singit-proxy` | Product label sent as `x-singit-client` (allowlisted short token, for example `openclaw`, `continue` or `codex`). |
| `SINGIT_MODEL_MAP` | unset | Optional `source=target` pairs (comma-separated) that rewrite Anthropic and Responses `model` ids before they are sent to Ask. Unmapped ids are passed through. |
| `SINGIT_MAX_PER_CALL_USD` | `0.01` | Per-call ceiling in USD. Required by the SDK; the proxy will not start without a ceiling. |
| `SINGIT_MAX_PER_DAY_USD` | `1` | Per-UTC-day ceiling in USD. |
| `SINGIT_HOME` | `~/.singit` | Directory for the `session` wallet file. |
| `SINGIT_WALLET_KEY` | unset | Optional existing key; otherwise one is created on first start. |
| `SINGIT_RPC_URL` | SDK default | Optional Base RPC. |

The proxy always sends `x-singit-client`. The default value is `singit-proxy/<version>`. If you set
`--client openclaw` or `--client continue`, that exact allowlisted token is sent instead, so
`numbers.json` can attribute traffic to that product. Anything that is not a short allowlisted token
is rejected at startup; raw User-Agent strings and other PII are never forwarded as the client label.

## Continue

Continue already speaks OpenAI-compatible endpoints. After the proxy is running, add this to
`~/.continue/config.yaml` (the `apiBase` **must** end with `/v1/`):

```yaml
name: My Config
version: 0.0.1
schema: v1

models:
  - name: SingIt Auto
    provider: openai
    model: singit/auto
    apiBase: http://localhost:8787/v1/
    apiKey: x402
    useResponsesApi: false
    capabilities:
      - tool_use
    roles:
      - chat
      - edit
      - apply
```

`apiKey` is only a non-empty stub Continue expects; the proxy signs x402 and ignores that value.
`useResponsesApi: false` keeps this Continue configuration on `/v1/chat/completions`. Start the proxy with `--client continue` so Ask records those paid calls under
`continue`.

A native `provider: singit` in Continue itself would be a separate upstream PR, only after an
explicit OK.

## OpenClaw

OpenClaw can use any OpenAI-compatible chat provider. Point the provider's `baseUrl` at
`http://127.0.0.1:8787/v1` and start the proxy with `--client openclaw` so Ask attributes the traffic
correctly. The model to use is `singit/auto` (or any id from `GET /v1/models`).

This package is not the official OpenClaw `clawrouter` plugin and does not replace it. A dedicated
`@singitai/openclaw` plugin (ClawHub / `npm:@singitai/openclaw`) is a separate piece of work, only
after an explicit OK to publish.

## The wallet

- The same file as `@singitai/mcp`: `~/.singit/session`, mode `0600`, directory `0700`.
- Created when the proxy starts (or when you call `/wallet` if it was deleted).
- The private key never leaves your machine. It signs x402 authorizations locally; only the
  signature is sent. The process does not print, log or return it.
- Back the file up if you fund it: whoever has the file has the funds, and a lost file cannot be
  recovered. A damaged file is reported as an error and is never overwritten.

Only send USDC on Base. Other tokens or networks will not be spent.

## Limits

Ceilings are always on. The defaults are $0.01 per call and $1 per UTC day, matching the public
`@singitai/sdk` examples. You can raise the numbers; you cannot start the proxy without both.

## Network

New installs pay on **Base**. Solana is available only as an explicit `--network solana`, and only
once Ask publishes a paid-success rate of at least 95% in `numbers.json`. Below that (or if the
figure is missing) the proxy refuses to start on Solana.

## Installers, uninstall and rollback

Three launchers share this one package and one proxy (127.0.0.1:8787, wallet in `~/.singit/session`): `singit-cc` (Claude Code), `singit-codex` (Codex) and `singit-openclaw` (OpenClaw; not the official OpenClaw clawrouter, not `@blockrun/clawrouter`).

| Client | One-liner (live after merge + Pages deploy + npm publish) |
| --- | --- |
| Claude Code | `curl -fsSL https://singitai.app/singit-cc-install \| bash` |
| Codex | `curl -fsSL https://singitai.app/singit-codex-install \| bash` |
| OpenClaw | `curl -fsSL https://singitai.app/singit-openclaw-install \| bash` |

Each script checks Node 20+, runs `npm i -g @singitai/proxy` and then `<launcher> setup`. If the package is not on npm yet it exits non-zero and says so. Flags: `--dry-run` (no install, no wallet, no client config), `--skip-claude` / `--skip-codex`, and for OpenClaw `--default-model`, `--mcp`, `--no-mcp`.

- **Tarball (test before publish):** `scripts/pack-harness-release.sh <dir>` writes an installable `singitai-proxy-<version>.tgz` (the monorepo `file:` deps are bundled) and `singitai-openclaw-<version>.tgz`. Install with `SINGIT_PROXY_TARBALL=<dir>/singitai-proxy-0.1.0.tgz bash install/singit-cc-install.sh`, or `npm i -g <tarball>` directly. Nothing is published.
- **Checkout (developers):** `SINGIT_CC_FROM=checkout` (`SINGIT_CODEX_FROM`, `SINGIT_OPENCLAW_FROM`) runs `cd proxy && npm install && node src/<launcher>.js setup`. It is never the default. `install/*.sh` in the repo are thin wrappers around the scripts in `website/`.
- **Caps:** the installers export `SINGIT_MAX_PER_CALL_USD=0.05` and `SINGIT_MAX_PER_DAY_USD=2` only when unset, and the launchers apply the same values. The package defaults stay $0.01/call and $1/day.
- **Uninstall:** `singit-cc uninstall` (changes nothing; Claude settings are never written), `singit-codex uninstall` (restores the newest `singit.config.toml.<ts>.bak` that is not a SingIt profile, else removes the profile; `config.toml` is untouched), `singit-openclaw uninstall` (restores the newest `openclaw.json.<ts>.bak` that has no SingIt entry, else removes only `models.providers.singit`, `mcp.servers.singit` and a `singit/auto` primary; invalid JSON is rejected unchanged). Backups are kept. None of them runs `npm uninstall` or removes the wallet; use `npm uninstall -g @singitai/proxy` separately. `~/.singit/session` stays until you delete it yourself.

## Claude Code / singit-cc

`singit-cc` is a second CLI in this same package and wraps the existing `startProxy` process. It supports Base only; it adds no payment proxy. Install as above (or from a checkout: `bash install/singit-cc-install.sh --dry-run`), then run `singit-cc start`. Use `setup` to create/reuse a wallet, `doctor` for local checks, `start --no-launch` for the proxy alone, and `start -- -p "say hi"` to forward Claude arguments. Node 20+ and Claude Code are required; the official Claude installer is https://claude.ai/install.sh.

The launcher defaults to port 8787 and gives Claude `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (no `/api` suffix). Both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are the dummy value `singit-proxy-handles-auth`. Inherited credentials/OAuth variables are removed from the child; no global Claude settings are written. Model defaults and overrides are documented in [the Claude Code guide](../docs/claude-code.md).

Launcher caps are $0.05/call and $2/day, overridable with `SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`. The proxy’s own defaults remain $0.01/call and $1/day. The wrapper sets `SINGIT_CLIENT=claude-code` unless overridden.

The wallet is `~/.singit/session` (or under `SINGIT_HOME`). Only the public address, a Base USDC funding hint, and a terminal QR are printed. Fund with USDC on Base (`eip155:8453`); the facilitator pays gas, no ETH needed. Never print or pass the private key on argv. `SINGIT_WALLET_KEY` is env-only for the proxy and is removed from Claude’s child environment. HTTP 402 is never success.

## Codex / singit-codex

The `singit-codex` bin lives in this package and wraps the same `startProxy` and payment path. Install as above, then run `singit-codex start`. Install Codex from https://developers.openai.com/codex; Node 20+ is required.

Use `setup`, `doctor`, `start --no-launch`, `--help`, `--version`, `--client label`, or `start -- ...codex arguments`. Start launches `codex --profile singit`. Setup writes `$CODEX_HOME/singit.config.toml` (default `~/.codex/singit.config.toml`), backing up an existing profile; start writes only when missing. The base `config.toml` is never modified. The profile uses provider `singit`, model `singit/auto`, Responses wire format, and `http://127.0.0.1:8787/v1` with the configured port. Separate profile loading by real Codex remains a manual compatibility check.

The launcher is Base only and requires host `127.0.0.1`. Defaults are $0.05/call, $2/day and client `codex`, with user env overrides. The shared wallet remains `~/.singit/session`; only its public funding data and QR are printed. `SINGIT_WALLET_KEY` is removed from the child environment. Standalone proxy and MCP defaults are unchanged.

Responses translation is stateless and buffered; reasoning and non-chat input items are dropped. Function calls and usage are preserved. Auto models resolve against a cached free catalog; on catalog failure the mapped id passes through. HTTP 402 remains a JSON payment error. See [the Codex guide](../docs/codex.md) for profile, MCP and compatibility limits.

## OpenClaw

`singit-openclaw setup` merges the SingIt provider and MCP config; `start` runs this same proxy with client `openclaw` and launches OpenClaw. `doctor` checks without creating a wallet. Defaults for this installer are $0.05/call and $2/day (user-overridable), while standalone proxy defaults stay $0.01/$1. Primary is unchanged unless `--default-model` is passed. See [OpenClaw setup](../docs/openclaw.md) for backups, `--no-mcp`, `--no-launch`, and local plugin/skill status.
