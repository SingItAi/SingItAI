# singit-examples v0.1.0

First tagged release of the SingIt examples: runnable recipes for using SingIt from agent frameworks.

| Example | Framework | What it shows |
|---|---|---|
| `langchain/` | LangChain.js | SingIt MCP tools through `@langchain/mcp-adapters`, and paid chat through `ChatOpenAI` |
| `vercel-ai-sdk/` | Vercel AI SDK | SingIt MCP tools through the AI SDK's MCP client, and paid chat through an OpenAI-compatible provider |

Each folder is a standalone package with its own `package.json` and lockfile (Node 20 or newer).

## What is in this release

- **Free mode** (`npm start`): needs no key and makes no payment. It loads the live MCP tools, calls the free `get_price` tool, and sends one unpaid request to SingIt Ask to print the payment offers it gets back.
- **Paid mode**: off unless you set every variable, with limits you choose. It signs USDC payments on Base only after checking that the offer is on Base, pays the expected SingIt Ask address in the expected USDC contract, and is within a per-call and a per-day ceiling. The ceilings are client-side and the daily one lives in memory, so it restarts with the process.
- **Offline tests** (`npm test`, against local mocks) and CI for both examples.
- Root README, links that work outside the monorepo, community files, issue and pull request templates, security policy and Dependabot.

## Known limits

- There are no Python or other-language examples here yet. The [Python SDK](https://github.com/SingItAi/singit-python) has its own README.
- The examples carry their own copy of the payment guards instead of depending on `@singitai/sdk`, so an SDK fix has to be copied over by hand.
- Paid mode spends real USDC. Do not run it with a wallet you are not willing to spend from.

See the [integrations guide](https://singitai.app/integrations/), the [TypeScript SDK](https://github.com/SingItAi/singit-js) and the [MCP server docs](https://github.com/SingItAi/singit-mcp).
