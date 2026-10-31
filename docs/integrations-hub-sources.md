# Integrations hub sources

## Verification record

Live verification run on the build machine, 31 October 2026 (Europe/Prague), Node 24.22.1 / Python 3.13.5. Model calls used the REAL `https://ask.singitai.app/v1/chat/completions` free route, `free/deepseek-v4.1-flash`, dummy key `unused`, no payment. MCP used the REAL `https://app.singitai.app/mcp`, keyless. These runs were not repeated by the page author. Commands below are the per-file invocation corresponding to the supplied snippets, not a captured shell transcript. The original working directory and exact shell transcript were not supplied.

| Snippet | Library + version | Command run (per-file invocation) | Result | Date |
| --- | --- | --- | --- | --- |
| `langchain-py.py` | langchain-openai 1.7.3; openai 2.54.0 | `python langchain-py.py` | pong | 2026-10-31 |
| `langchain-js.mjs` | @langchain/openai 1.8.0; @langchain/core 1.3.2 | `node langchain-js.mjs` | pong | 2026-10-31 |
| `langchain-py-mcp.py` | langchain-mcp-adapters 0.3.2; mcp 1.30.0 | `python langchain-py-mcp.py` | 16 MCP tools | 2026-10-31 |
| `langchain-js-mcp.mjs` | @langchain/mcp-adapters 2.0.1; @langchain/core 1.3.2 | `node langchain-js-mcp.mjs` | 16 MCP tools | 2026-10-31 |
| `vercel-ai-sdk.mjs` | ai 7.0.159; @ai-sdk/openai-compatible 3.0.82 | `node vercel-ai-sdk.mjs` | pong | 2026-10-31 |
| `vercel-ai-sdk-mcp.mjs` | @ai-sdk/mcp 2.0.88 | `node vercel-ai-sdk-mcp.mjs` | 16 MCP tools | 2026-10-31 |
| `openai-agents-py.py` | openai-agents 0.20.0; openai 2.54.0 | `python openai-agents-py.py` | pong | 2026-10-31 |
| `openai-agents-js.mjs` | @openai/agents 0.21.0; openai 7.47.0 | `node openai-agents-js.mjs` | pong | 2026-10-31 |
| `openai-agents-py-mcp.py` | openai-agents 0.20.0; mcp 1.30.0 | `python openai-agents-py-mcp.py` | 16 MCP tools | 2026-10-31 |
| `litellm_example.py` | litellm 1.106.6; openai 2.54.0 | `python litellm_example.py` (run from a directory with the packages installed; the file is not named litellm.py because that would shadow the package) | pong | 2026-10-31 |

The key-authenticated variant and paid x402 calls were not tested. Source copies: `website/data/integration-snippets/`; HTML preserves every byte after entity decoding.

## Vendor URLs

Each URL returned HTTP 200 when fetched on 31 October 2026.

| Vendor documentation | URL |
| --- | --- |
| LangChain Python ChatOpenAI | https://docs.langchain.com/oss/python/integrations/chat/openai |
| LangChain JS | https://docs.langchain.com/oss/javascript/integrations/chat/openai |
| LangChain MCP Python | https://docs.langchain.com/oss/python/langchain/mcp |
| LangChain MCP JS | https://docs.langchain.com/oss/javascript/langchain/mcp |
| AI SDK compatible providers | https://ai-sdk.dev/providers/openai-compatible-providers |
| AI SDK MCP | https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools |
| Agents Python models | https://openai.github.io/openai-agents-python/models/ |
| Agents Python MCP | https://openai.github.io/openai-agents-python/mcp/ |
| Agents JS models | https://openai.github.io/openai-agents-js/guides/models/ |
| LiteLLM | https://docs.litellm.ai/docs/providers/openai_compatible |
| AgentKit repository | https://github.com/coinbase/agentkit |
| AgentKit Python README | https://github.com/coinbase/agentkit/blob/master/python/coinbase-agentkit/README.md |
| ElizaOS | https://docs.elizaos.ai/ |

## Claim sources

| Claim | Source |
| --- | --- |
| SDK wiring, pong results, 16 keyless MCP tools, date and versions | Verification record above; exact source files copied from `/workspace/singit/prompts/integ7-snippets/` to `website/data/integration-snippets/` (each file, line 1 onward) |
| Keyed base URL and free vs paid MCP | `website/developers/index.html:86`–88 (keyed URL), `website/developers/index.html:135` (MCP access) |
| AgentKit action names, confirmation behavior, Python x402 <2 constraint | coinbase-agentkit 0.7.4 PyPI README read on 2026-10-31; not run against SingIt |
| TypeScript discover_x402_services, active Bazaar chat listing | Free Bazaar `validate_endpoint` check, 2026-10-31 (see docs/quickstart-sources.md in the quickstart PR); `docs/first-paid-call.md:113` onward for discovery recipe (older not-run status there is not today's evidence) |
| SingIt chat route offers x402 v2 | `docs/first-paid-call.md:56` (decoded challenge shows `x402Version 2`); live unpaid POST to `https://ask.singitai.app/v1/chat/completions` on 2026-10-31 returned a challenge with `x402Version` 2 |
| ElizaOS plugin name, unpublished status, installation | `docs/integrations/elizaos.md:3` onward |
| Existing examples and SDKs | `integrations/examples/langchain/README.md:1`, `integrations/examples/vercel-ai-sdk/README.md:1`, `sdk/typescript/README.md:1`, `sdk/python/README.md:1` |
| Limits apply to allowance-granting wallets | `docs/trezor-allowance-v1.md:17`–20; no Solana limit behavior is claimed on this page |

## Local checks and limitations

- The LangChain recipe (`docs/integrations/langchain.md`) and the runnable example (`integrations/examples/langchain/src/free-mcp-tools.mjs`) agree: both use `MCPAdapter` with `servers`/`listTools`. With `npm ci` in the example, `npm test` passed on 31 October 2026 (11 of 11). The hub uses the `MultiServerMCPClient` form, which was run live against the real server. The recipe was left unchanged.
- ElizaOS: `npm ci && npm test` in `integrations/elizaos-plugin` passed on 31 October 2026 (43 of 43). Not run inside a live ElizaOS agent.
- Website: `node --test website/tests/*.test.mjs` and `node scripts/generate-model-pages.mjs --check` pass on the build machine (Node 24.22.1).
- Not tested: the key-authenticated variant (`https://app.singitai.app/v1` with an `sk_singit_` key), any paid x402 call from these libraries, AgentKit.
