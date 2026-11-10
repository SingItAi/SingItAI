# @singitai/proxy

A local [OpenAI-compatible](https://platform.openai.com/docs/api-reference/chat) proxy for
[SingIt Ask](https://ask.singitai.app). Point Cursor, Continue, OpenClaw or any client that takes a
`baseURL` at this process. It needs no API key: on first start it creates a wallet on your machine
(the same `~/.singit/session` file as `@singitai/mcp`) and pays each chat call in USDC on Base over
x402, inside per-call and per-day limits you control.

> **Not on npm yet.** Publishing `@singitai/proxy` is a separate step that has not happened. Until it
> does, `npx @singitai/proxy` will not resolve; use [Run from this repo](#run-from-this-repo).

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
| POST | `/v1/chat/completions` | Paid chat, including `tools`. |
| POST | `/v1/chat/<model>` | Rewritten to `/v1/chat/completions` with that model (so agents get tools and the 8192-token cap). |
| POST | `/v1/models/<model>/chat` | Same rewrite. |

JSON answers only: `stream: true` is rejected. The billed amount is read from the JSON invoice after
settlement.

## Environment and flags

| Env / flag | Default | Meaning |
|------------|---------|---------|
| `SINGIT_PROXY_PORT` / `--port` | `8787` | Listen port. |
| `SINGIT_PROXY_HOST` / `--host` | `127.0.0.1` | Listen host (loopback by default). |
| `SINGIT_ASK_URL` / `--ask-url` | `https://ask.singitai.app` | Upstream Ask origin. |
| `SINGIT_NETWORK` / `--network` | `base` | Payment rail. `solana` is accepted only when Ask's `numbers.json` reports paid success of at least 95%. |
| `SINGIT_CLIENT` / `--client` | `singit-proxy` | Product label sent as `x-singit-client` (allowlisted short token, for example `openclaw` or `continue`). |
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
`useResponsesApi: false` keeps the client on `/v1/chat/completions` (this proxy does not serve
`/responses`). Start the proxy with `--client continue` so Ask records those paid calls under
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
