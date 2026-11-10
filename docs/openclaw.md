# OpenClaw with SingIt

Not on npm yet. From this checkout:

```sh
bash install/singit-openclaw-install.sh --dry-run
bash install/singit-openclaw-install.sh
cd proxy
node src/openclaw.js start
node src/openclaw.js doctor
```

Install OpenClaw using https://docs.openclaw.ai if missing. `start --no-launch` runs only the existing `@singitai/proxy`; arguments after `--` go to OpenClaw. No second payment process is started. Base and `127.0.0.1` are required. The wallet is `~/.singit/session`; funding instructions show a public address and QR. Never paste a private key into chat or argv.

`setup` merges `$OPENCLAW_HOME/openclaw.json` (default `~/.openclaw/openclaw.json`), backs up an existing file with an exclusive timestamped `.bak`, and replaces only the SingIt provider. Writes use atomic rename and restore the backup on failure. Invalid JSON is rejected without changing it. Other providers and unrelated values remain intact. `start` preserves an existing SingIt block. The primary model stays unchanged unless `--default-model` sets `singit/auto`.

The provider uses `api: "openai-completions"`, `auth: "none"` and `baseUrl: "http://127.0.0.1:8787/v1"` (actual configured port). Keep the trailing `/v1`; path-pinned chat URLs can strip tools upstream. Choose `singit/auto`, `singit/free` or an arbitrary live catalog ID. Free models may reject tools.

MCP defaults to `mcp.servers.singit` with URL `https://app.singitai.app/mcp` and transport `streamable-http`. `--no-mcp` omits adding it; `--mcp` is the default. `SINGIT_API_KEY` is only needed for paid MCP tools. Without a key, only `get_price`, `list_price_symbols`, `list_models`, and `chat_free` are free.

SingIt is a paid third-party service. Paid answers use USDC on Base over x402, signed locally by the existing proxy. Installer defaults are $0.05/call and $2/day, overridable with `SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`. Standalone proxy defaults remain $0.01/$1. Installer defaults also set `SINGIT_CLIENT=openclaw` and `SINGIT_NETWORK=base`; `--client` overrides attribution. HTTP 402 means payment required, never success.

The future `curl -fsSL https://singitai.app/singit-openclaw-install | bash` URL is NOT LIVE. The repo-only plugin is described in [openclaw/README.md](../openclaw/README.md). ClawHub skill files are in `skills/singit`; publishing has NOT been done and needs Kostya's OK. No default provider or bundled clawrouter is taken over.
