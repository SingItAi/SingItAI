# Your first paid x402 call in 60 seconds

One paid answer from SingIt Ask, paid per call in USDC over x402: no account and no API key.

**Status: End-to-end paid run of these snippets: not yet done; needs Kostya's OK for one paid test call (~$0.0015).**

The unpaid half (Step 1: the 402 and its offers) was checked live on 27.10.2026. Variants B and C rely on Coinbase
tooling and were checked against Coinbase's docs and package types, not run.

Endpoint: `POST https://ask.singitai.app/v1/chat/completions` (OpenAI chat completions format).

Request used throughout (model `deepseek-v4.1-flash`, `max_tokens` 200, so the ceiling stays at the 0.0015 USDC
minimum on Base):

```json
{"model":"deepseek-v4.1-flash","max_tokens":200,"messages":[{"role":"user","content":"Say hello in five words."}]}
```

Want to try before paying? Model `free/deepseek-v4.1-flash` on the same endpoint answers with no payment: 20 answers a
day per network (IPv4 /24, IPv6 /64), up to 400 tokens each, resetting at midnight UTC. See
[free-models.md](free-models.md).

## What you need

- **Variant A (x402 fetch, Node):** Node 20+ and a wallet private key holding a little USDC on Base (0.01 to 1 USDC is
  plenty). No ETH: the `upto` offer uses Permit2 with EIP-2612 gas sponsoring, so the facilitator pays the gas.
- **Variant B (Bazaar MCP):** a Coinbase Developer Platform account (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
  `CDP_WALLET_SECRET`) and USDC on Base in the CDP-managed wallet.
- **Variant C (agentic wallet CLI):** Node 24+ and a Coinbase agentic wallet (`awal`) signed in by email and funded with
  USDC on Base.

## Step 1: see the 402

```sh
curl -i https://ask.singitai.app/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":200,"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

Expect `HTTP/2 402` and a `payment-required:` header: base64 JSON, `x402Version: 2`. Decode it and print the offers:

```sh
curl -s -o /dev/null -D - https://ask.singitai.app/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":200,"messages":[{"role":"user","content":"Say hello in five words."}]}' \
  | awk 'tolower($1)=="payment-required:"{print $2}' | tr -d '\r' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(Buffer.from(s.trim(),"base64"));
      console.log("x402Version", r.x402Version);
      for (const a of r.accepts) console.log(a.scheme.padEnd(6), a.network.padEnd(40), a.amount, "atomic USDC")})'
```

Expected shape (amounts are in USDC micro-units, 1500 = 0.0015 USDC; the Solana amounts are higher because its fee is
0.002):

```text
x402Version 2
upto   eip155:8453                              1500 atomic USDC
upto   solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp  ...  atomic USDC
exact  eip155:8453                              ...  atomic USDC
exact  solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp  ...  atomic USDC
```

- **`upto` is listed first** (Base, then Solana). You sign a ceiling; SingIt settles only what the answer used: the
  model's actual cost + 30% + a 0.001 USDC fee on Base (0.002 on Solana). A failed answer is not settled.
- **`exact`** is a flat price: the cost of an answer about 30% of `max_tokens` long, + 30% + the fee, with no metering
  and no refund. For buyers whose wallet signs only `exact`.
- Base asset: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## Step 2: pay

Pick one. Each signs the offer from Step 1 and retries the same request with a `PAYMENT-SIGNATURE` header.

### A. x402 fetch (Node, your own key)

The same client as the "x402 · no key" tab on [singitai.app/developers](https://singitai.app/developers/), with the
default model and a short answer.

```sh
npm install @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
```

```js
// first-paid-call.mjs — run with: AGENT_KEY=0x... node first-paid-call.mjs
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// A wallet holding a little USDC on Base. No ETH: the facilitator pays the gas.
const account = privateKeyToAccount(process.env.AGENT_KEY);
const chain = createPublicClient({ chain: base, transport: http() });
const client = x402Client.fromConfig({ schemes: [{ network: "eip155:8453",
  client: new UptoEvmScheme({ address: account.address, signTypedData: account.signTypedData,
                              readContract: chain.readContract.bind(chain) }) }] });
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay("https://ask.singitai.app/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "deepseek-v4.1-flash", max_tokens: 200,
                         messages: [{ role: "user", content: "Say hello in five words." }] }),
});
const answer = await res.json();
console.log(res.status, answer.choices?.[0]?.message?.content);
console.log("charged (atomic USDC):", answer.billing?.totalAtomic);
console.log("PAYMENT-RESPONSE:", res.headers.get("payment-response"));
```

### B. Coinbase Bazaar MCP (CDP wallet)

Not run; checked against Coinbase's docs and the `@x402/mcp` / `@coinbase/cdp-sdk` package types.

Coinbase's x402 Bazaar has an MCP endpoint, `https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp` (no auth),
with the tools `search_resources`, `proxy_tool_call` and `validate_endpoint`. SingIt is not curated there yet, so
`search_resources` must be called with `curatedOnly: false` (its default is `true`, and then SingIt does not appear).
The `toolName` for SingIt's route looks like
`x402_post_https___ask_singitai_app_v1_chat_completions_<hash>_<token>`: always take it from a fresh search result,
never hard-code it.

```sh
npm install @coinbase/cdp-sdk @modelcontextprotocol/sdk @x402/core @x402/evm @x402/mcp
```

```js
// Needs CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET in the environment.
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wrapMCPClientWithPayment } from "@x402/mcp";

const payment = new CdpX402Client();
console.log("Fund with USDC on Base:", (await payment.getAddresses()).evmAddress);
const mcp = wrapMCPClientWithPayment(new Client({ name: "first-paid-call", version: "1.0.0" }), payment,
                                     { autoPayment: true });
await mcp.connect(new StreamableHTTPClientTransport(
  new URL("https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp")));

const found = await mcp.callTool("search_resources", { query: "SingIt Ask chat completions", curatedOnly: false });
// The result's first text item is JSON: { tools: [{ name, description, ... }], nextStep, ... } (seen live 27.10).
const { tools = [] } = JSON.parse(found.content?.[0]?.text ?? "{}");
const toolName = tools.map((t) => t.name).find((n) => n.startsWith("x402_post_https___ask_singitai_app_v1_chat_completions_"));
if (!toolName) throw new Error("SingIt's chat route not in the search result");

const result = await mcp.callTool("proxy_tool_call", { toolName, parameters: { body: {
  model: "deepseek-v4.1-flash", max_tokens: 200,
  messages: [{ role: "user", content: "Say hello in five words." }] } } });
console.log(JSON.stringify(result, null, 2));
```

### C. Coinbase agentic wallet CLI (`awal`)

Not run; checked against Coinbase's docs. Needs Node 24+.

```sh
npx skills add coinbase/agentic-wallet-skills   # optional: the same commands as agent skills
npx awal@2.12.1 auth login you@example.com      # then: npx awal@2.12.1 auth verify
npx awal@2.12.1 status
npx awal@2.12.1 balance                         # needs USDC on Base
npx awal@2.12.1 x402 details https://ask.singitai.app/v1/chat/completions
npx awal@2.12.1 x402 pay https://ask.singitai.app/v1/chat/completions -X POST \
  -d '{"model":"deepseek-v4.1-flash","max_tokens":200,"messages":[{"role":"user","content":"Say hello in five words."}]}' \
  --max-amount 2000
```

`--max-amount` is in USDC micro-units (1000000 = $1); 2000 = $0.002 leaves room above the 0.0015 ceiling. Discovery
from the same CLI: `npx awal@2.12.1 x402 bazaar search "SingIt Ask"`.

## Step 3: the 200

A paid answer comes back as `HTTP 200` with an OpenAI-style body. Check:

- `choices[0].message.content`: the answer.
- `billing.totalAtomic`: what was settled, in USDC micro-units (for `upto`, the actual cost + 30% + the fee; at most
  the ceiling you signed).
- The `PAYMENT-RESPONSE` header: base64 JSON from the facilitator's settlement (transaction, network, payer).

Decode it the same way as Step 1:

```sh
echo "$PAYMENT_RESPONSE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(Buffer.from(s.trim(),"base64"))))'
```

## Links

- Live prices and models: https://ask.singitai.app/v1/models, https://ask.singitai.app/openapi.json
- SingIt Ask llms.txt: https://ask.singitai.app/llms.txt
- With an API key instead of a wallet (OpenAI/Anthropic SDKs, Claude Code, MCP): https://singitai.app/developers/
