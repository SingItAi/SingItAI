# Codex with singit-codex

`singit-codex` is a thin launcher in `@singitai/proxy`. It uses the same proxy and payment path as `singit-cc`, on Base only. Node 20+ is required. Install Codex using the official guidance at https://developers.openai.com/codex.

## Install

Production command (live once this change is merged and Cloudflare Pages has deployed, and `@singitai/proxy` has been published to npm, which needs a separate OK):

```sh
curl -fsSL https://singitai.app/singit-codex-install | bash
```

It runs `npm i -g @singitai/proxy` and then `singit-codex setup`. Node 20+ is required. Options: `--dry-run` (prints the plan; no install, no wallet, no client config), `--skip-codex` (skip the missing-Codex hint). If the package is not on npm yet the script exits non-zero and says so.

Test before publish: build tarballs with `scripts/pack-harness-release.sh <dir>` and install one with `SINGIT_PROXY_TARBALL=<dir>/singitai-proxy-0.1.0.tgz bash install/singit-codex-install.sh` (or pipe the website script through `bash`). The tarball bundles the SDK and session wallet, so it installs on a machine without the repo.

Developer escape hatch: `SINGIT_CODEX_FROM=checkout bash install/singit-codex-install.sh` runs `cd proxy && npm install && node src/codex.js setup` from the checkout. It is never the default.

The installer exports `SINGIT_MAX_PER_CALL_USD=0.05` and `SINGIT_MAX_PER_DAY_USD=2` for its `setup` run only when those variables are unset; the launcher applies the same caps whenever you start it. The package defaults stay $0.01/call and $1/day.

Then `singit-codex start` (forward arguments with `singit-codex start -- --help`).

`setup` creates or reuses `~/.singit/session` and writes `~/.codex/singit.config.toml`. `SINGIT_HOME` changes the wallet directory; `CODEX_HOME` changes the profile directory. Setup prints only the public address, Base USDC funding hint and QR. The facilitator pays gas; no ETH is needed. Never print a private key or pass it on argv. The launcher strips `SINGIT_WALLET_KEY` from the Codex child environment.

`start` runs the existing proxy, writes the profile only if missing, and launches `codex --profile singit` with arguments after `--`. `start --no-launch` runs the proxy alone. SIGINT/SIGTERM stop the child and proxy. `doctor` checks Node, Codex on PATH, the existing session file, proxy health, profile provider and caps without creating a wallet. `--help`, `--version` and `--client label` are supported. The installer accepts `--skip-codex` to skip the missing-Codex hint.

The profile uses model `singit/auto`, provider `singit`, `wire_api = "responses"`, `requires_openai_auth = false`, and `base_url = "http://127.0.0.1:8787/v1"`. It also defines the remote SingIt MCP at `https://app.singitai.app/mcp`, with `bearer_token_env_var = "SINGIT_API_KEY"` and a 15-second startup timeout. No token values are written. The port comes from `SINGIT_PROXY_PORT`; the host must be `127.0.0.1`. Setup backs up an existing SingIt profile to `*.<timestamp>.bak` before replacing it. Neither setup nor start changes the base `config.toml`. If you change ports after setup, rerun setup to refresh the profile.

Launcher defaults are $0.05 per call and $2 per UTC day, client `codex`, network `base`. Override caps with `SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`, or the client with `SINGIT_CLIENT` / `--client`. Standalone proxy defaults stay $0.01/$1.

`POST /v1/responses` translates onto Ask chat completions. Model mapping runs before catalog resolution: `auto` and `singit/auto` use the free model catalog's default or first chat model. Unknown ids pass through. Catalog failure passes the mapped id through. Responses SSE is translated from Ask's chat stream event by event as it arrives (tool calls included), and `response.completed` carries the final usage and billing. Reasoning items and non-chat input items are dropped; storage and server-side conversation state are unsupported. HTTP 402 is always a JSON payment error, never a completed turn. Other streamed upstream errors emit `response.failed`.

The profile file and invocation follow the requested SingIt installer contract. Loading a separate `singit.config.toml` with the installed Codex version, and the remote MCP authentication behavior, still need a manual compatibility check. Tests use a fake Codex binary and a local merchant only; no live payments or production Codex turn have been run. See the [official configuration reference](https://developers.openai.com/codex/config-reference) for provider settings.

## Uninstall and rollback

```sh
singit-codex uninstall
npm uninstall -g @singitai/proxy   # optional, removes the package
```

`uninstall` looks at `$CODEX_HOME/singit.config.toml` (default `~/.codex/singit.config.toml`). It restores the newest `singit.config.toml.<timestamp>.bak` that is not itself a SingIt profile (a repeated `setup` backs up the earlier SingIt profile, which is skipped); with no such backup it removes the profile file. If no profile exists it does nothing. The base `config.toml` is never read or modified, and the wallet in `~/.singit/session` is never removed. The backups are kept. It does not run `npm uninstall`.
