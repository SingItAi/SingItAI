# OpenClaw with SingIt

This is not the official OpenClaw `clawrouter` and not `@blockrun/clawrouter`; it is the one `@singitai/proxy` on 127.0.0.1:8787 plus a merged `singit` provider.

## Install

Production command (live once this change is merged and Cloudflare Pages has deployed, and `@singitai/proxy` has been published to npm, which needs a separate OK):

```sh
curl -fsSL https://singitai.app/singit-openclaw-install | bash
```

It runs `npm i -g @singitai/proxy` and then `singit-openclaw setup`. Node 20+ is required. Options: `--dry-run` (prints the plan; no install, no wallet, no client config), `--default-model` (set `singit/auto` as primary), `--no-mcp` / `--mcp` (skip or keep the MCP entry). If the package is not on npm yet the script exits non-zero and says so.

Test before publish: build tarballs with `scripts/pack-harness-release.sh <dir>` and install one with `SINGIT_PROXY_TARBALL=<dir>/singitai-proxy-0.1.0.tgz bash install/singit-openclaw-install.sh` (or pipe the website script through `bash`). The tarball bundles the SDK and session wallet, so it installs on a machine without the repo.

Developer escape hatch: `SINGIT_OPENCLAW_FROM=checkout bash install/singit-openclaw-install.sh` runs `cd proxy && npm install && node src/openclaw.js setup` from the checkout. It is never the default.

The installer exports `SINGIT_MAX_PER_CALL_USD=0.05` and `SINGIT_MAX_PER_DAY_USD=2` for its `setup` run only when those variables are unset; the launcher applies the same caps whenever you start it. The package defaults stay $0.01/call and $1/day.

Then `singit-openclaw start` (or `start --no-launch`) and `singit-openclaw doctor`.

Install OpenClaw using https://docs.openclaw.ai if missing. `start --no-launch` runs only the existing `@singitai/proxy`; arguments after `--` go to OpenClaw. No second payment process is started. Base and `127.0.0.1` are required. The wallet is `~/.singit/session`; funding instructions show a public address and QR. Never paste a private key into chat or argv.

`setup` merges `$OPENCLAW_HOME/openclaw.json` (default `~/.openclaw/openclaw.json`), backs up an existing file with an exclusive timestamped `.bak`, and replaces only the SingIt provider. Writes use atomic rename and restore the backup on failure. Invalid JSON is rejected without changing it. Other providers and unrelated values remain intact. `start` preserves an existing SingIt block. The primary model stays unchanged unless `--default-model` sets `singit/auto`.

The provider uses `api: "openai-completions"`, `auth: "none"` and `baseUrl: "http://127.0.0.1:8787/v1"` (actual configured port). Keep the trailing `/v1`; path-pinned chat URLs can strip tools upstream. Choose `singit/auto`, `singit/free` or an arbitrary live catalog ID. Free models may reject tools.

MCP defaults to `mcp.servers.singit` with URL `https://app.singitai.app/mcp` and transport `streamable-http`. `--no-mcp` omits adding it; `--mcp` is the default. `SINGIT_API_KEY` is only needed for paid MCP tools. Without a key, only `get_price`, `list_price_symbols`, `list_models`, and `chat_free` are free.

SingIt is a paid third-party service. Paid answers use USDC on Base over x402, signed locally by the existing proxy. Installer defaults are $0.05/call and $2/day, overridable with `SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`. Standalone proxy defaults remain $0.01/$1. Installer defaults also set `SINGIT_CLIENT=openclaw` and `SINGIT_NETWORK=base`; `--client` overrides attribution. HTTP 402 means payment required, never success.

## Uninstall and rollback

```sh
singit-openclaw uninstall
npm uninstall -g @singitai/proxy   # optional, removes the package
```

`uninstall` works on `$OPENCLAW_HOME/openclaw.json` (default `~/.openclaw/openclaw.json`). If a timestamped `openclaw.json.<timestamp>.bak` exists, the newest one that does not already contain a `singit` entry is restored (a repeated `setup` backs up the earlier SingIt config, which is skipped). Without such a backup only `models.providers.singit`, `mcp.servers.singit` and a primary model of `singit/auto` are removed, everything else stays, and the file is deleted only if nothing else is left. Writes are atomic (temporary file and rename), invalid JSON is rejected without changes, and the backups are kept. The wallet in `~/.singit/session` is never removed, and `uninstall` does not run `npm uninstall`.

The repo-only plugin is described in [openclaw/README.md](../openclaw/README.md). ClawHub skill files are in `skills/singit`; publishing has NOT been done and needs Kostya's OK. No default provider or bundled clawrouter is taken over.
