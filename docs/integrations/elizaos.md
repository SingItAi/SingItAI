# ElizaOS recipe

Package: [`integrations/elizaos-plugin`](../../integrations/elizaos-plugin) (`@singit/plugin-singit`).
Full reference is in that package's [README](../../integrations/elizaos-plugin/README.md); this
page is the short recipe.

**Not published.** Install from a local path or Git checkout — see the plugin README for why (the
elizaOS community registry is retired) and the exact commands.

## Add it to a character

```ts
import { singitPlugin } from "@singit/plugin-singit";

export const character = {
  name: "MyAgent",
  plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap", singitPlugin],
  settings: {
    secrets: {
      SINGIT_API_KEY: process.env.SINGIT_API_KEY,               // optional: paid MCP tools
      SINGIT_EVM_PRIVATE_KEY: process.env.SINGIT_EVM_PRIVATE_KEY, // optional: x402 paid chat
    },
    SINGIT_MAX_PER_CALL_USD: "0.01",
    SINGIT_MAX_PER_DAY_USD: "1",
  },
};
```

## What it adds

| Always on (no key) | With `SINGIT_API_KEY` | With a wallet key + both caps |
| --- | --- | --- |
| `SINGIT_GET_PRICE`, `SINGIT_LIST_PRICE_SYMBOLS`, `SINGIT_LIST_MODELS` | `SINGIT_WEB_SEARCH`, `SINGIT_READ_PAGE` | `SINGIT_PAID_CHAT` (x402, Base) |

The `SINGIT_TOOLS` provider tells the agent which of these are actually available, so it does not
try a paid action that is not configured — each gated action's `validate()` also returns `false`
without its required settings, so it is absent rather than failing loudly.

## x402-paid chat, in brief

`SINGIT_PAID_CHAT` needs `SINGIT_EVM_PRIVATE_KEY` (funded with USDC on Base),
`SINGIT_MAX_PER_CALL_USD` and `SINGIT_MAX_PER_DAY_USD`, all three. Before signing anything it
checks the merchant's offer is on Base, pays SingIt Ask's pinned address in the pinned USDC
contract, and is within both ceilings — the same guards as [`sdk/typescript`](../../sdk/typescript),
vendored and trimmed to Base only (no Solana support in this plugin yet; use the SDK directly for
that).

## Tests

```bash
cd integrations/elizaos-plugin
npm ci --ignore-scripts
npm test
```

Offline: a local mock MCP server and a local mock x402 merchant (real EIP-712 signature
verification, no facilitator or chain).
