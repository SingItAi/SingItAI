# Integration pages: verification, 2 November 2026

Evidence transcribed from “Dev/Ops answers” in Dev/Ops' internal notes of 2 November 2026. Gateway paths below are relative to `sign402-gateway/sign402_gateway/`; source line numbers refer to revision `2be6464`, as recorded in that draft. These are recorded findings, not new production checks. No live request was made for this page work.

| Claim on the pages | Source file and line or test (internal note) | Status |
|---|---|---|
| Key daily and per-request caps include running requests, are per key rather than per model, and are enforced by the server on both chains | `web_api_keys.py:401-411`, `web_accounts.py:192-221` (8, 10) | verified in code |
| The owner signs key caps and expiry; the key cannot move funds or change limits; revocation needs no signature and is immediate | `website/docs/mcp-key/index.html`, internal source S1 | verified in code |
| Settings, API keys is the key and balance setup location; `/v1` is OpenAI-compatible | `website/docs/mcp-key/index.html`, `website/openapi-keys.json`, sources S1/S2 | verified in code |
| Model calls on the balance route use prepaid credit; the owner tops up in the app; automatic top-ups use the owner's limits | `web_api_proxy.py:321-350`, `web_internal.py:238-242`; `tests/test_balance.py:199` (8) | verified in code |
| A refused call costs nothing; a prior automatic top-up is retained as credit if a call fails | `tests/test_api_keys.py:177,218`; `web_api_proxy.py:450-468,321-350`; `tests/test_balance.py:512,521,798,530` (5) | verified in code |
| Daily exhaustion returns 429 `insufficient_quota`; exact balance-route message includes “counting requests still running” and the 00:00 UTC reset | `web_api_keys.py:407-410`; `tests/test_api_keys.py:167` checks status/code, message read from source (4) | verified in code |
| Per-minute cap is 60, 429 `rate_limit_exceeded`; wrong, revoked or expired key is 401 `invalid_api_key` | `web_api_keys.py:232-241`, `website/openapi-keys.json` (4, 8) | verified in code |
| Per-request ceiling is 400 `over_request_limit`; smaller output, input or tools, a cheaper model or a higher cap may help | `web_api_proxy.py:52-53,123-134,420-428`; `tests/test_balance.py:530` (9) | verified in code |
| Low balance returns 402 `balance_low`; globally paused payments return 503 `payments_paused` | `web_api_proxy.py:345`; `web_api_keys.py:526-527`; `tests/test_api_keys.py:225` (6) | verified in code |
| LangChain retry disabling and RateLimitError subclass/code behavior | Internal note 11, local mock with langchain-openai 1.7.3: one request with `max_retries=0`, retry with default settings | checked against a local test server |
| LiteLLM RateLimitError, BadRequestError, AuthenticationError and ServiceUnavailableError mappings; `num_retries=0`; router fallback makes another request | Internal note 10, a local mock-server probe (not kept in this repository), litellm 1.106.6; same-key cap separately established in server code | checked against a local test server |
| Agents mid-run 429 raises `openai.RateLimitError` after one tool already ran, without undoing its effects | Internal note 11, a local mock-server probe (not kept in this repository), openai-agents 0.20.0 | checked against a local test server |
| Agents tracing exports to OpenAI with `OPENAI_API_KEY`; without it export is skipped; disable tracing and do not put a SingIt key there | openai-agents 0.20.0 `agents/tracing/processors.py:45,107-125`, `agents/tracing/provider.py:348` (11) | verified in code |
| Tools are forwarded only with the proxy; without it 400 `tools_unsupported`; LangChain `bind_tools` sends tools | `web_api_proxy.py:123-134`; `tests/test_balance.py:295`; `web_api_keys.py:451`; `tests/test_api_keys.py:177`; draft Page 1 (2) | verified in code |
| Real streaming requires the proxy; fallback sends a finished answer as SSE; all refusals precede stream start | `web_api_proxy.py:411-450,532-553`; `tests/test_balance.py:474`; `web_api_keys.py:499`; `tests/test_api_keys.py:194` (3) | verified in code |
| A broken or timed-out stream just ends; charge uses cost or the hold within the per-request cap | `web_api_proxy.py:501-510,528,551`; `tests/test_balance.py:436` (3) | verified in code |
| How each framework handles a truncated stream | Internal note 3: no client test reads a truncated stream | not verified live |
| Base allowance limits purchases such as balance top-ups and search, rather than each balance-funded model call; contract limits are fixed | `web_internal.py:215-242`; `tests/test_balance.py:199,835`; draft S3 and answer 8 | verified in code |
| Solana server checks daily/per-purchase/expiry, chain checks total delegation; stopping prevents new purchases, including top-ups; revoking delegation removes approval | `solana_allowance.py:73,322,753`; `tests/test_solana_allowance.py:434`; draft S3 (6, 8) | verified in code |
| Python wallet x402 guards run client-side with an in-memory daily counter; no Python framework adapter exists | Draft source S5: singit 0.1.1 published README; open question 2 package checks and adapter statement | verified in code |
| The three key examples, model tools, streaming and daily-cap message against today's production | Internal notes 1–4, 9–11 and proxy route check: no live framework key request | not verified live |
| Embedded snippets exactly match the supplied files; metadata, link rules and hub/sitemap wiring | `website/tests/integration-pages.test.mjs` | verified in code |

Proxy route: SIGN402_WEB_SURPLUS_API_KEY is present in the running web-api and gateway processes; no request was sent

That line records the read-only process check of that day at 18:12 Prague. The shop configuration was not read directly. Key presence does not establish end-to-end production behavior. The runnable example folder links await the examples PR merge; no publication or deployment is part of this work.
