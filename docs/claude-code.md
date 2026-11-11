# Claude Code with singit-cc

**Not on npm yet.** `singit-cc` is a thin launcher in the existing `@singitai/proxy` package. It starts that same proxy process; all payments stay there. It supports Base only.

From the repository checkout:

```sh
bash install/singit-cc-install.sh --dry-run
bash install/singit-cc-install.sh
cd proxy
node src/cc.js start
# Forward arguments to Claude:
node src/cc.js start -- -p "say hi"
```

The installer requires Node 20+. Install Claude Code using the official installer at https://claude.ai/install.sh. `--skip-claude` skips its installer hint. `node src/cc.js setup` creates/reuses the wallet without starting a server; `doctor` checks local prerequisites. `start --no-launch` runs just the proxy. SIGINT/SIGTERM stop the launcher’s child and proxy.

The intended future command is **NOT LIVE**:

```sh
curl -fsSL https://singitai.app/singit-cc-install | bash
```

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
