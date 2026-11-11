# @singitai/mcp

A local MCP server (stdio) for [SingIt Ask](https://ask.singitai.app). It needs no API key: on first use it
creates a wallet on your machine and pays each chat call in USDC on Base over x402, inside per-call and
per-day limits you control.

> **Not on npm yet.** Publishing `@singitai/mcp` is a separate step that has not happened. Until it does, the
> `npx -y @singitai/mcp` lines below will not resolve; use [Run from this repo](#run-from-this-repo).

The remote server at `https://app.singitai.app/mcp` (see [`llms-install.md`](../llms-install.md)) is the other
path: more tools, billed to a SingIt API key sent as a Bearer header. This package is the no-key wallet path.

## Install

Claude Code:

```sh
claude mcp add singit -s user -- npx -y @singitai/mcp
```

Cursor (`~/.cursor/mcp.json`), and any other client that takes a stdio command:

```json
{
  "mcpServers": {
    "singit": {
      "command": "npx",
      "args": ["-y", "@singitai/mcp"]
    }
  }
}
```

Run it by hand: `npx -y @singitai/mcp` (it then waits for MCP messages on stdin).

### Run from this repo

```sh
cd mcp
npm install
node src/index.js        # or: npx .
```

From the repo root that is `node mcp/src/index.js`. To point a client at the checkout:

```sh
claude mcp add singit -s user -- node /absolute/path/to/SingItAI/mcp/src/index.js
```

`@singitai/sdk` is installed from `../sdk/typescript` as a copy (see `.npmrc`), so run `npm install` again
after changing the SDK.

## Tools

| Tool | Cost | What it does |
|------|------|--------------|
| `singit_wallet` | free | `action: "status"` reports the wallet address, network and funding hint; `"setup"` also creates the wallet if there is none. Never returns the private key. |
| `singit_models` | free | `GET /v1/models`: the models on sale and their prices. |
| `singit_chat` | paid | `POST /v1/chat/completions` with `model` (default `deepseek-v4.1-flash`), `messages` and optional `max_tokens`. Returns the completion plus what was paid. |

`singit_chat` returns an answer only when SingIt Ask answers 2xx. An HTTP 402 is a payment demand, never an
answer: if the payment is refused (for example an empty wallet) the tool returns an error with the wallet
address to fund, and the request is not repeated.

Requests to Ask send `x-singit-client: singit-mcp/<version>` (a fixed product token, not a user identifier)
so `numbers.json` can attribute the traffic.

## The wallet

- Created on the first `singit_chat` call or by `singit_wallet` with `action: "setup"`.
- Stored as JSON at `~/.singit/session`, file mode `0600`, directory mode `0700`. Set `SINGIT_HOME` to use
  another directory.
- The private key never leaves your machine. It signs x402 payment authorizations locally; only the
  signature is sent. No tool prints, logs or returns it.
- Back the file up if you fund it: whoever has the file has the funds, and a lost file cannot be recovered.
  A damaged file is reported as an error and is never overwritten.

### Funding

Ask the agent to call `singit_wallet` to get the address, then send **USDC on Base** (`eip155:8453`) to it
from an exchange or another wallet. Payments are signed authorizations (a gasless USDC permit plus the x402
payment) settled by the facilitator, so the wallet needs no ETH for gas. Prices per model are in
`singit_models`. Only send USDC on Base: other tokens or networks will not be spent.

To build the permit the server reads the wallet's USDC permit nonce from a Base RPC (`https://mainnet.base.org`
by default; set `SINGIT_RPC_URL` to use your own). That read and the requests to SingIt Ask are the only
network calls it makes.

### Spending limits

Checked on your machine before anything is signed; an offer above a limit is refused, never renegotiated.

- Per call: `SINGIT_MAX_PER_CALL_USD`, default `0.5`. With the default `upto` scheme this is the ceiling of
  one authorization; you are billed the actual usage, which is usually far less.
- Per day (UTC): `SINGIT_MAX_PER_DAY_USD`, default `5`. Counted in memory by the running server, so it starts
  from zero when the client restarts the server.

The payee and token are pinned too: the server signs only for SingIt's own address and Base USDC.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `SINGIT_HOME` | `~/.singit` | Directory holding the `session` wallet file. |
| `SINGIT_WALLET_KEY` | none | A `0x`-prefixed EVM private key to use instead of the file. Takes precedence over it; nothing is written. |
| `SINGIT_MAX_PER_CALL_USD` | `0.5` | Most one call may authorize, in USD. |
| `SINGIT_MAX_PER_DAY_USD` | `5` | Most the server may spend per UTC day, in USD. |
| `SINGIT_ASK_URL` | `https://ask.singitai.app` | SingIt Ask base URL (wallet / x402 path). |
| `SINGIT_APP_URL` | `https://app.singitai.app` | Key-billed API base (used only when `SINGIT_API_KEY` is set). |
| `SINGIT_RPC_URL` | `https://mainnet.base.org` | Base RPC used for read-only calls while signing. |
| `SINGIT_API_KEY` | none | Use an API key instead of a wallet (below). |

Example with tighter limits:

```sh
claude mcp add singit -s user -e SINGIT_MAX_PER_CALL_USD=0.05 -e SINGIT_MAX_PER_DAY_USD=1 -- npx -y @singitai/mcp
```

## Optional: API key instead of a wallet

Set `SINGIT_API_KEY` and the server sends `Authorization: Bearer <key>` to the key-billed API at
`https://app.singitai.app/v1` (override with `SINGIT_APP_URL`) instead of paying ask.singitai.app over x402.
It takes priority: no wallet is created or read, `singit_wallet` says so, and the tools stay the same.
ask.singitai.app itself is x402-only, so a Bearer key there would get HTTP 402; this path uses the app
endpoint that already accepts SingIt API keys. If that endpoint still answers 402, `singit_chat` returns an
error rather than falling back to a wallet.

## Not in this version

- Solana. `@singitai/sdk` can already pay SingIt Ask in USDC on Solana; a follow-up can add a
  `SINGIT_SOLANA_WALLET_KEY` and a second key in the session file.
- A balance readout or funding QR in `singit_wallet`.
- Streaming, images, search and the other SingIt Ask routes.

## Development

```sh
cd mcp
npm ci --ignore-scripts
npm test
```

The tests are offline: a real MCP client talks to the server, which pays a local mock merchant that issues an
x402 challenge and verifies the signature.

Publishing to npm is out of scope here. Before a publish, the `@singitai/sdk` dependency must change from
`file:../sdk/typescript` to a released version.

## License

MIT
