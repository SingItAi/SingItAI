# Claude Code with singit-cc

`singit-cc` is a thin launcher in the existing `@singitai/proxy` package. It starts that same proxy process (127.0.0.1:8787); all payments stay there. It supports Base only.

## Install

Production command (live once this change is merged and Cloudflare Pages has deployed, and `@singitai/proxy` has been published to npm, which needs a separate OK):

```sh
curl -fsSL https://singitai.app/singit-cc-install | bash
```

It runs `npm i -g @singitai/proxy` and then `singit-cc setup`. Node 20+ is required. Options: `--dry-run` (prints the plan; no install, no wallet, no client config), `--skip-claude` (skip the Claude Code installer hint). If the package is not on npm yet the script exits non-zero and says so.

Test before publish: build tarballs with `scripts/pack-harness-release.sh <dir>` and install one with `SINGIT_PROXY_TARBALL=<dir>/singitai-proxy-0.1.0.tgz bash install/singit-cc-install.sh` (or pipe the website script through `bash`). The tarball bundles the SDK and session wallet, so it installs on a machine without the repo.

Developer escape hatch: `SINGIT_CC_FROM=checkout bash install/singit-cc-install.sh` runs `cd proxy && npm install && node src/cc.js setup` from the checkout. It is never the default.

The installer exports `SINGIT_MAX_PER_CALL_USD=0.05` and `SINGIT_MAX_PER_DAY_USD=2` for its `setup` run only when those variables are unset; the launcher applies the same caps whenever you start it. The package defaults stay $0.01/call and $1/day.

Then:

```sh
singit-cc start
# Forward arguments to Claude:
singit-cc start -- -p "say hi"
```

Install Claude Code using the official installer at https://claude.ai/install.sh. `singit-cc setup` creates/reuses the wallet without starting a server; `doctor` checks local prerequisites. `start --no-launch` runs just the proxy. SIGINT/SIGTERM stop the launcher’s child and proxy.

## Uninstall and rollback

```sh
singit-cc uninstall            # nothing to revert; says so
npm uninstall -g @singitai/proxy   # optional, removes the package
```

`singit-cc` never writes `~/.claude/settings.json` or `~/.claude.json`; it only sets environment variables for the Claude child process. So there is no backup to restore and `uninstall` changes no file. It does not run `npm uninstall` itself. The wallet in `~/.singit/session` is never removed; delete it by hand only after moving any USDC out.

The launcher uses port 8787 by default (`SINGIT_PROXY_PORT` overrides it). Claude receives `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, without `/api`, and dummy `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` values of `singit-proxy-handles-auth`. Inherited Anthropic credentials and `CLAUDE_CODE_OAUTH*` variables are removed from the child environment. Start and setup do not write global Claude settings.

The wallet lives in `~/.singit/session` (`SINGIT_HOME` overrides its directory). Setup/start print its public address and terminal QR. Top up with USDC on Base, network `eip155:8453`: the facilitator pays gas, so no ETH is needed. Never print the private key or pass it on argv. `SINGIT_WALLET_KEY` is an env-only override for the proxy and is stripped from Claude’s environment.

Installer caps are $0.05 per call and $2 per UTC day; override them with `SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`. The standalone proxy defaults remain $0.01/$1. The default client label is `claude-code` (override with `SINGIT_CLIENT` or `--client`). HTTP 402 is always a payment error, never a successful message.

Model defaults (catalog mapping supplied for 10 November 2026); existing values for these variables are preserved:

| Variable | Model |
| --- | --- |
| `ANTHROPIC_MODEL` | `deepseek-v4.1-flash` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `claude-opus-5.5` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `claude-sonnet-5.5` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-haiku-5.5` |
| `ANTHROPIC_SMALL_FAST_MODEL` | `deepseek-v4.1-flash` |

Claude Code may warn that it does not recognize a SingIt model id and assume a 200k context window; the request still goes to the local proxy. Set the window as described in the official model-config docs if you want a different value.
