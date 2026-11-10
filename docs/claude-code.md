# Claude Code through SingIt

**Not on npm yet.** The installer endpoint is **NOT LIVE**. From a SingItAI checkout with Node 20+ and Claude Code installed:

```sh
cd cc
npm ci
node src/index.js setup base
node src/index.js start
```

Setup prints the public funding address; send USDC on Base. No ETH is needed. The shared local wallet is `~/.singit/session`; the key stays on the machine and is never sent to Claude or placed on argv. SingIt billing is separate from your Claude subscription.

Claude Code sends Anthropic Messages to `127.0.0.1:8403/api`. The proxy ignores incoming Authorization, clamps output tokens to 8192, requests non-streaming JSON from Ask, pays using the existing SingIt SDK, and synthesizes buffered Anthropic SSE when needed. HTTP 402 is a refusal, never success. Signed payment attempts are never retried.

Default caps: $0.01/call and $1/UTC day. The SDK cap is per running process; restarting resets it. The local spend ledger is statistics, not a durable or on-chain budget. Base is the default. Solana needs published paid success >=95% and remains unavailable with this EVM-only session wallet.

Use `node src/index.js start --no-launch` for an independently managed proxy. `config install-persistent` backs up `~/.claude/settings.json` and installs proxy environment settings; keep the proxy running and clear conflicting shell auth variables. `doctor`, `models`, `balance`, and `stats --json` help diagnose the setup. See [the package README](../cc/README.md) for flags, environment variables, model mapping, fallback and security limits.

Intended future installer — **NOT LIVE**:

```sh
curl -fsSL https://singitai.app/singit-cc-install | bash
```

For an offline preview today, run `bash install/singit-cc-install.sh --dry-run` from the repository root. No network installation, wallet creation or payment happens in dry-run mode.
