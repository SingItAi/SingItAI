---
name: singit
description: Pay-per-answer AI chat and free price/model tools via SingIt. Free models with no wallet; paid answers in USDC on Base over x402, signed locally by a proxy the user funds and caps.
metadata:
  openclaw:
    requires:
      bins:
        - node
        - curl
    envVars:
      - name: SINGIT_API_KEY
        required: false
        description: Only for paid MCP tools (web search / page reading); free MCP tools and x402 chat need no key.
    homepage: https://singitai.app
---

## When to activate

Use for SingIt model discovery, price tools, free chat or user-requested paid AI answers. SingIt is a paid third-party service. These are repository skill files only; ClawHub publication has NOT been done and needs Kostya's OK.

## Free tier

Without a key, only four MCP tools are free: `get_price`, `list_price_symbols`, `list_models`, `chat_free`. Use remote MCP for wallet-free chat. Free proxy model IDs use `free/`; free models may reject tool calls.

## Paid answers

Paid answers use USDC on Base over x402 through a user-funded local `@singitai/proxy`. Point OpenClaw at `http://127.0.0.1:8787/v1` using `openai-completions`, auth `none`. Use `singit/auto`, `singit/free`, or live model IDs. A 402 is payment required, never a successful answer.

## Setup

Not on npm yet. From a SingItAI checkout run `bash skills/singit/scripts/setup.sh --dry-run`, then the same command without `--dry-run`. This calls `singit-openclaw` (`node proxy/src/openclaw.js setup`) and creates/reuses `~/.singit/session`, merges OpenClaw config with backup and rollback, and prints a public funding hint and QR. `--default-model` opts into setting primary to `singit/auto`; otherwise the primary remains unchanged. Start with `cd proxy && node src/openclaw.js start`. Install OpenClaw via https://docs.openclaw.ai if missing.

MCP uses `mcp.servers.singit`, URL `https://app.singitai.app/mcp`, transport `streamable-http`. `SINGIT_API_KEY` is only for paid MCP tools. Never write API keys into config.

## Payment and limits

The installer caps spend at $0.05/call and $2/day; override with `SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`. Standalone proxy defaults are $0.01/call and $1/day. Fund the local proxy with USDC on Base. Never ask the user to paste a private key into chat or argv. There is one local payment process, with keys kept locally.

## Troubleshooting

Run `bash skills/singit/scripts/doctor.sh`. Check Node 20+, proxy health, wallet file presence, config and catalog. Keep `/v1` in the provider base URL. A missing wallet requires setup. An unpaid 402 requires funding or a free model; do not report it as success. Setup rejects invalid JSON without replacing it. Backups are `openclaw.json.<timestamp>.bak`.
