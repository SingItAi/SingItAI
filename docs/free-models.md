# Free models in SingIt Ask

31 October 2026 (draft PR, not deployed). The free tier offers six models on `POST /v1/chat/completions` with no wallet or key:

- `free/openai-gpt-oss-20b`
- `free/gemma-4-e2b`
- `free/gemma-3-27b-it`
- `free/mistral-small-3.2-24b-instruct`
- `free/qwen3-coder-30b-a3b-instruct`
- `free/deepseek-v4.1-flash`

Use `free/deepseek-v4.1-flash` for a single working example. Requests without `free/` retain the paid x402 flow on Base or Solana.

The shared free tier allows up to 20 answers a day per network (IPv4 /24 or IPv6 /64), 1000 answers a day overall, four concurrent answers, 400 output tokens and 4000 question characters. A shared upstream cost cap of **$0.25/day** is enabled by default. This bounds the configured daily spend at $0.25, approximately **$7.50 per 30-day month**. The free tier may run out before a visitor uses their allowance.

Before calling upstream, the service reserves the answer's worst-case cost at the model's list price, with one input token per character, message framing, and all reasoning headroom sent upstream. Reservations count against the cap concurrently. A completed answer replaces its reservation with the validated reported upstream cost; missing or invalid usage uses the worst-case fallback. A failed upstream call releases the reservation and returns the answer count. Unknown model prices pause free answers with 503 while the budget is enabled.

A budget refusal returns 429, `free_budget_exhausted`, and `Retry-After` in seconds until midnight UTC, without per-visitor X-RateLimit headers. Visitor and shared answer-count exhaustion retain `free_tier_exhausted` and their existing headers; concurrency retains `free_tier_busy`.

The `sign402-gateway` API-key route has its own separate free path (`web_free.py`, `SIGN402_WEB_FREE_MODELS`); it is off unless configured, is not part of this change, and has its own counters and limits.

## Persistence and configuration

`SINGIT_ASK_FREE_MODELS` defaults to the six models above; an explicitly empty value turns free answers off. `SINGIT_ASK_FREE_BUDGET_USD_PER_DAY` defaults to 0.25; positive values override it, 0 disables the dollar cap, and invalid or negative values use the default. Network and daily answer limits remain configurable as before.

`SINGIT_ASK_FREE_STATE_FILE` defaults to `$HOME/.config/singit-ask/free-budget.json`. Atomic mode-0600 JSON stores only the version, UTC day number, spent micro-USDC, pending (in-flight) micro-USDC and total answers. Valid state for today survives restarts; yesterday's state starts fresh; an invalid file fails closed (see below). Visitor network identifiers are never persisted. Tests without a configured state file use memory only.

Limitations: in-flight reservations are saved with the state and, after a crash or restart, counted as spent (the cap can only get stricter). An unreadable or invalid state file for today is treated as a spent budget until midnight UTC (fail closed). Visitor limits reset on restart. Persistence errors are logged once and never fail an answer; a failed write cannot guarantee restart continuity. This is a single-process allowance, not a distributed lock across replicas. The cap relies on upstream costs staying within the advertised worst-case model pricing. SingIt's gateway free lane is separate from this public Ask tier.

## Offline cost reference

Generated from the saved 24 October catalogue with `python3 scripts/free-model-cost.py docs/data/singit-models-2026-10-24.json`. These are list-price worst cases for **one message**, 4000 characters plus four framing tokens and 400 output tokens; more messages add framing. These six models have no configured reasoning headroom. Runtime reservations round up to whole micro-USDC; the table shows the unrounded estimate. Live catalogue prices may change. Expected seller prices are not guarantees.

| Model | Worst-case upstream USD per answer |
| --- | ---: |
| openai-gpt-oss-20b | 0.000108072 |
| gemma-4-e2b | 0.00019216 |
| gemma-3-27b-it | 0.00040032 |
| mistral-small-3.2-24b-instruct | 0.00038030 |
| qwen3-coder-30b-a3b-instruct | 0.00039228 |
| deepseek-v4.1-flash | 0.00048008 |

No real upstream calls or paid calls were made while preparing this change; the tests use fake upstreams and fake addresses. Before enabling on a server, check each of the six models once with a short free question (they answer at most 400 tokens): a model that returns no text within that budget answers 503 `no_billable_answer` and is not counted.
