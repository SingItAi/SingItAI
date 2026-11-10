# SingIt for Claude Code

**Not on npm yet.** `@singitai/cc` is a draft local Anthropic Messages proxy. SingIt billing is separate from any Claude subscription.

From the SingItAI repository (Node 20+ and Claude Code on PATH):

```sh
cd cc
npm ci
node src/index.js setup base
node src/index.js start
```

Setup prints a public address. Send USDC on Base; the facilitator pays gas, so no ETH is needed. The key stays local in `~/.singit/session` (0600, directory 0700), shared with `@singitai/proxy` and `@singitai/mcp`. `SINGIT_HOME` changes the directory. The advanced `SINGIT_WALLET_KEY` environment override is available for isolated testing; prefer a dedicated low-balance wallet. Never pass a key on the command line.

Intended installer — **NOT LIVE**, do not run this URL yet:

```sh
curl -fsSL https://singitai.app/singit-cc-install | bash
```

The repository script supports `bash install/singit-cc-install.sh --dry-run` and `--skip-claude`. It requires Node 20+ and prints checkout instructions until publication.

`start` listens on **127.0.0.1:8403** and launches `claude` with `ANTHROPIC_BASE_URL=http://127.0.0.1:8403/api`, placeholder auth, and model environment variables. It removes inherited Anthropic/OAuth credentials and wallet-key overrides from the child environment. Incoming Authorization is ignored. Use `--no-launch` for a separately managed proxy, `--port N`, `--model ID`, or `--no-fallback`; arguments after `--` go to Claude Code.

The native `/v1/messages` and `/api/v1/messages` routes pay Ask using the SDK's x402 guards. Ask receives `stream:false`, without `stream_options`. For clients requesting streaming, the completed JSON answer is replayed as Anthropic SSE; this is buffered output, not live token streaming. Text, tools, images and thinking fields pass through, but upstream model support varies. **HTTP 402 is an error, never a successful message.** Signed requests are never retried. Only unsigned model-not-found failures or daily-cap refusals may fall back once to `freeModel`; free-tier limits still apply.

Default limits are **$0.01/call and $1/UTC day** (`SINGIT_MAX_PER_CALL_USD`, `SINGIT_MAX_PER_DAY_USD`). The SDK daily limiter is in memory per proxy process and resets on restart; it is not an on-chain spending limit. Keep a low wallet balance as a hard limit. `max_tokens` defaults to and is clamped at 8192 (`SINGIT_CC_MAX_TOKENS`, never over 32000). Local statistics in `~/.singit/cc-ledger.json` record `billing.totalAtomic`; they do not enforce a persistent budget.

Base is the default. Solana requires published success >=95% (last 7 days, falling back to last 24 hours) and is **still refused** in this version because the session wallet only holds an EVM key. It never silently pays on Base instead.

`auto` uses the catalogue's default, with `deepseek-v4.1-flash` as the offline fallback. `sonnet`, `opus` and `haiku` map through configuration; their defaults are `auto`. The default free fallback is `free/deepseek-v4.1-flash`. Requests carry `x-singit-client: singit-cc/0.1.0`.

Commands:

```sh
node src/index.js models
node src/index.js balance
node src/index.js stats --json
node src/index.js stats --clear
node src/index.js config list
node src/index.js config set sonnet-model deepseek-v4.1-flash
node src/index.js config set fallback false
node src/index.js doctor
node src/index.js config install-persistent
node src/index.js start --no-launch
```

Configuration lives at `~/.singit/config.json`, containing only validated settings, no keys. `config list` lists the available settings. Environment overrides include `SINGIT_ASK_URL`, `SINGIT_NETWORK`, `SINGIT_CC_PORT`, `SINGIT_CC_MODEL`, `SINGIT_CC_MAX_TOKENS`, `SINGIT_RPC_URL` and the spending caps above. Only loopback listening is allowed.

`config install-persistent` backs up existing `~/.claude/settings.json` and adds the proxy environment. Keep `start --no-launch` running (use your own supervisor if desired), and remove conflicting authentication environment variables from shells launching Claude directly. Existing settings are preserved. Doctor reports health, wallet-file presence, Node version and Claude availability without reading out keys.

Free HTTP endpoints: `GET /` or `/health` (no address), `GET`/`POST /wallet` (public funding address), and `GET /v1/models` or `/api/v1/models`. This local proxy provides no authentication; keep it on loopback and use trusted local clients. No paid calls are made by tests.
