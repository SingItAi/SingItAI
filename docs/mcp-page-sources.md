# MCP page sources

The hand-written page is `website/docs/mcp/index.html`. Run `node scripts/generate-mcp-page.mjs` after editing `website/data/mcp-tools.json`; `--check` detects drift without writing. Cloudflare publishes the checked-in HTML without a build step. Tests require no dependencies.

## Claim sources

| Claim | Source |
| --- | --- |
| Remote Streamable HTTP; JSON only, no SSE or sessions; no local server installation | `llms-install.md:3–6`; `sign402-gateway/sign402_gateway/web_mcp.py:1–5` |
| Endpoint, Registry name, title and version | `server.json:3–6`, remote URL in `server.json:15–17`; `sign402-gateway/sign402_gateway/web_mcp.py:73–80` |
| 16 tools, descriptions, schemas, annotations | Keyless `tools/list` of https://app.singitai.app/mcp, fetched 31 October 2026 at 09:27:44 UTC (see the verification record); fields copied to `website/data/mcp-tools.json` under `result.tools`. |
| Initialize version 0.1.3, protocol 2025-06-18 | Live initialize observation (31 October 2026); corroborated by `sign402-gateway/sign402_gateway/web_mcp.py:73–80`, initialize response at `:557` |
| Three free keyless tools; three free account-read tools requiring a key | `sign402-gateway/sign402_gateway/web_mcp.py:7–9`, `:110–112`, `:617–621`; `sign402-gateway/tests/test_web_mcp.py:170–215` |
| search scope for web_search/read_page; tools scope for the remaining paid tools | Server initialize instructions in `sign402-gateway/sign402_gateway/web_mcp.py:76–80`, module rules `:10–13`; enforcement in `sign402-gateway/sign402_gateway/web_api_keys.py:313–355` |
| Account-read tools do not need the paid tools scope | `sign402-gateway/sign402_gateway/web_mcp.py:617–638`; account reads are dispatched before paid-tool enforcement. `llms-install.md:35–36` says “the rest need tools” too broadly; the page follows the implementation for the free account reads. |
| Web tools: USDC on Base or Solana; paid market/data tools: Base only for now | Snapshot descriptions; `sign402-gateway/README.md:560–562`; `sign402-gateway/sign402_gateway/web_api_keys.py:350–355`; `sign402-gateway/tests/test_web_mcp.py:150–158`. No further Solana limit claims are made. |
| Paid per call from key limits; repeated paid calls bill again; read-only/idempotent hints | Snapshot annotations; `sign402-gateway/README.md:560–569`; `sign402-gateway/sign402_gateway/web_mcp.py:14–17` |
| Charges in get_receipts; key caps and remaining spend in get_limits | Snapshot tool descriptions; `sign402-gateway/tests/test_web_mcp.py:217–244`, `:277–307` |
| Settings → API keys; wallet signs key limits | `website/developers/index.html:134`; signature message and verification in `sign402-gateway/sign402_gateway/web_api_keys.py:89–96`, `:145–167` |
| Daily/per-request caps can refuse a call | `sign402-gateway/sign402_gateway/web_api_keys.py:324–330`, `:356–362`, `:402–409`; `sign402-gateway/tests/test_web_mcp.py:961–965` |
| Generic configuration and Authorization header | Exact JSON block in `llms-install.md:18–27`; header instructions `:15–16` |
| Cursor config path and syntax; exact keyless Add to Cursor link | `sign402-gateway/README.md:579–591`; `website/developers/index.html:225`; `website/tests/developers-mcp.test.mjs:36–43` |
| Claude Code command, checks, shared project type http, env expansion, reconnect | [Claude Code MCP docs](https://code.claude.com/docs/en/mcp), read 31 October 2026: “Option 1: Add a remote HTTP server”, “Managing your servers”, “Project scope”, “Environment variable expansion in .mcp.json”, “Mid-session drops of a remote server”. The root `.mcp.json:1–12` lacks type; left unchanged as requested. Commands were not run here. |
| Codex command flags and exact generated TOML; enabled / Bearer token | Run on 31 October 2026: codex-cli 0.163.0 --help and add/list in a temporary CODEX_HOME. This work does not claim a new client run. Repository corroboration for TOML fields: `sign402-gateway/README.md:593–599`. |
| Windsurf / Devin remote serverUrl or url, headers, config paths and interpolation | [Vendor MCP docs](https://docs.devin.ai/windsurf/plugins/cascade/mcp), read 31 October 2026: “mcp_config.json”, “Remote HTTP MCPs”, “Config Interpolation”. Not run on an install. June 2026 rename is a task-supplied fact. The current vendor page distinguishes the active Devin config from the older/editor discovery path; use its Open MCP config file action. |
| Empty/unexpanded header acts keyless; wrong/revoked key is 401 | `llms-install.md:33–39`; `sign402-gateway/README.md:613–621`; `sign402-gateway/tests/test_web_mcp.py:397–408`, `:417–502` |
| Keyless initialize / tools/list requests and expected output | `sign402-gateway/tests/test_web_mcp.py:89–108`, `:333–347`, `:834–847`; JSON request format and curl headers in `sign402-gateway/README.md:604–608`. Both requests were also run against the live server on 31 October 2026 (verification record); the page adapts this repository request format to the public endpoint with no auth header. Not executed here: network permission allows public GETs only. |
| Restart/refresh after editing; stale discovery recovery | Task-requested client recovery guidance; vendor docs above (“Adding a new MCP plugin”: refresh); Claude Code docs above (“Mid-session drops of a remote server”: /mcp reconnect). Restart advice is an operational recovery step, not a claim that the server returns an empty catalogue. |

## Verification and limitations

`website/tests/mcp-page.test.mjs` checks generator drift, exactly 16 unique names against Python declarations (excluding MCP_HIDDEN_TOOLS) and the llms.txt Start here section, scope/network labels, parameters, metadata, sitemap, local links, content constraints and snippet status labels. Client integration runs and paid calls are outside this work. No keys or wallets are used. No prices are asserted. No bridging command is recommended without verification.

Claims are sourced to repository code, the live checks of 31 October 2026 (keyless initialize, tools/list and a 401 with an invalid key; `codex mcp add` in a temporary CODEX_HOME) and the vendor pages linked above. The Windsurf/Devin Desktop snippet comes from the vendor docs and was not run on an installation.

## Verification record, 31 October 2026 (Europe/Prague)

Free checks run from the build machine:

- `initialize` and `tools/list` against https://app.singitai.app/mcp with no key: initialize returned protocol 2025-06-18 and serverInfo name `singit`, title `SingIt x402`, version `0.1.3`; `tools/list` returned 16 tools (re-run at the time of review: 16).
- `tools/list` with a made-up key: HTTP 401.
- Codex: `codex mcp add singit --url https://app.singitai.app/mcp --bearer-token-env-var SINGIT_API_KEY` in a temporary `CODEX_HOME` with codex-cli 0.163.0 wrote the TOML block shown on the page; `codex mcp list` showed it enabled with Auth "Bearer token".
- Client libraries (not on this page): the 16 tools were listed with `@langchain/mcp-adapters` 2.0.1, `@ai-sdk/mcp` 2.0.88, `langchain-mcp-adapters` 0.3.2 and the OpenAI Agents SDK 0.20.0 MCP client.
- Claude Code: syntax and `${VAR}` header expansion read from https://code.claude.com/docs/en/mcp on 31 October 2026; not run.
- Windsurf / Devin Desktop: read from the vendor docs; not run on an installation.

## Owner-set MCP key guide

The hand-written “Get a key” section now links to `/docs/mcp-key/`. The generated
tool table is unchanged and was regenerated offline with
`node scripts/generate-mcp-page.mjs`. Claims for the linked guide are recorded in
`docs/docs-pages-sources.md` under “MCP key offer and agent onboarding”. No new
live verification was performed. Client snippets reuse this page's existing
repository-verified configurations and environment-variable credentials.
