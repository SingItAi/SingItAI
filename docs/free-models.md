# Free models: proposal and cost (SI-69)

Status: **proposal.** The code for it is in the tree, and everything that could spend money is off or unset
until the owner decides (see "What needs the owner's OK"). Nothing here has been deployed.

## What exists

| Where | What | Limits | Default |
|---|---|---|---|
| `singit-ask` (`src/free.mjs`) | `free/<id>` on `POST /v1/chat/completions`, no payment | 20 a day per visitor, 1000 a day for everyone, 4 at once, 400 answer tokens, 4000 characters of question | On, with `free/deepseek-v4.1-flash` (already in production) |
| `sign402-gateway` (`web_free.py`) | `free/<id>` on the API-key `/v1/chat/completions` for signed-in wallets | 20 a day per account, 40 a day per client network, 1000 a day for everyone, 400 answer tokens, 4000 characters | **Off** (`SIGN402_WEB_FREE_MODELS` empty) |

What SI-69 adds on top:

- **singit-ask: a visitor is a network.** Free answers are counted per IPv4 /24 or IPv6 /64 (an IPv4-mapped IPv6
  address counts as its IPv4 /24), so changing address inside one subnet no longer gives a fresh allowance.
- **singit-ask: optional daily dollar budget**, `SINGIT_ASK_FREE_BUDGET_USD_PER_DAY`. **Unset by default: no
  budget is checked.** When set, each free answer is counted at the cost Surplus reports for it, else at the
  model's list price for its worst case; a model with no known price is not answered free (503); once the day's
  spend reaches the budget, answers are refused with 429 and `Retry-After` until midnight UTC.
- **singit-ask: free models are marked.** `GET /v1/models` lists `free/<id>` entries with `free: true` and their
  `limits` (the old top-level `free` object stays); `/openapi.json` documents the prefix on the chat route and
  has an `x-free-models` extension; the Bazaar input schema's `model` field mentions them.
- **Gateway: free models for wallets**, separate from the paid limits (it is not counted in a key's 60 requests a
  minute, its caps or its balance, and spends none of them). OFF unless configured.
- **No wallet limit on singit-ask.** A free answer there is asked without payment, so it carries no wallet. The
  network is the only identity it has. The wallet limit exists only in the gateway version.

## What a free answer can cost

Reproduce with the saved snapshot of `/v1/models` (read 24 October 2026, `docs/data/singit-models-2026-10-24.json`):

```
python scripts/free-model-cost.py docs/data/singit-models-2026-10-24.json
```

Worst case per answer means the question at its longest (4000 characters, counted as 1000 input tokens at 4
characters per token) and the answer at its longest (400 tokens). **List price** is `usdPerMillionTokens`, the
seller's published price. **Expected price** is `expectedUsdPerMillionTokens`, what the snapshot says a call
usually costs; its `basis` is `observed` for `deepseek-v4.1-flash` and `trusted` for the others. A month is 30 days
with the global daily cap used up every day.

```
Worst case per free answer: question 4000 chars (= 1000 input tokens at 4 chars/token), answer 400 tokens.
Month = 30 days with the global daily cap used up every day. USD.

LIST price
model                           in $/M   out $/M  per answer  100/day/mo  300/day/mo  1000/day/mo
------------------------------  ------  --------  ----------  ----------  ----------  -----------
deepseek-v4.1-flash               0.02         1  0.00042000      1.2600      3.7800      12.6000
openai-gpt-oss-20b               0.018      0.09  0.00005400      0.1620      0.4860       1.6200
qwen3.7-flash                     0.03      0.13  0.00008200      0.2460      0.7380       2.4600
glm-5.3-flash                     0.15       0.5  0.00035000      1.0500      3.1500      10.5000
mistral-small-3.2-24b-instruct   0.075  0.200000  0.00015500      0.4650      1.3950       4.6500

EXPECTED price
model                                in $/M      out $/M  per answer  100/day/mo  300/day/mo  1000/day/mo
------------------------------  -----------  -----------  ----------  ----------  ----------  -----------
deepseek-v4.1-flash                       0            0  0.00000000      0.0000      0.0000       0.0000
openai-gpt-oss-20b              0.000158400  0.000792000  0.00000048      0.0014      0.0043       0.0143
qwen3.7-flash                         0.009        0.039  0.00002460      0.0738      0.2214       0.7380
glm-5.3-flash                   0.000240000  0.000800000  0.00000056      0.0017      0.0050       0.0168
mistral-small-3.2-24b-instruct      0.00375         0.01  0.00000775      0.0232      0.0698       0.2325

Expected-price basis in the file: deepseek-v4.1-flash: observed; glm-5.3-flash: trusted; mistral-small-3.2-24b-instruct: trusted; openai-gpt-oss-20b: trusted; qwen3.7-flash: trusted
```

How to read it:

- At list price, even the current cap of 1000 free answers a day on the current model is **12.60 USD a month at
  the very most**, and only if every answer is the longest allowed.
- The expected price of `deepseek-v4.1-flash` in the snapshot is 0 (`observed`). That is what Surplus reported when
  the snapshot was taken, not a promise that it stays 0; the list price is the number to plan the ceiling on.
- The prices are as of the snapshot. Re-run the script on a fresh `/v1/models` before deciding.
- The script uses the same chars/4 input bound as singit-ask's pricing. It does not include the 30% markup or
  settlement fee, because a free answer pays neither.

## What is actually used

From the VPS journal, last 30 days, read 24 October: **10 free answers in total** on singit-ask: 4 on 14 October,
1 on 16 October, 2 on 17 October and 3 on 24 October. That is about 0.3 a day on average against a cap of 1000.
The gateway free path is off, so it has none. Ten answers at the worst-case list price of the current model is
0.0042 USD (10 x 0.00042).

So the caps are not what limits cost today; demand is. The caps and the budget exist for the day someone finds
the endpoint and scripts it.

## Recommendation

1. **Keep `deepseek-v4.1-flash` as the free model on singit-ask.** It is the model already live and the one
   free answers are tested against. Its worst case is the highest of the five at list price (12.60 USD a month at
   1000 a day), but that is a ceiling that real usage (10 answers in 30 days) is nowhere near, and it needs no
   change and no new approval.
2. **If a second free model is wanted, add `openai-gpt-oss-20b`.** It has the lowest worst case of the five at list price
   (1.62 USD a month at 1000 a day, about 8 times below deepseek's 12.60) and 0.0143 at expected price (deepseek's
   expected is 0, observed). It also protects the budget if deepseek's observed price of 0 stops holding. `qwen3.7-flash` is the
   alternative if a model with vision and reasoning tags and a 1M context is wanted: 2.46 USD a month at list and
   1000 a day.
3. **Not recommended now:** `glm-5.3-flash` (10.50 USD a month at list, close to deepseek) and
   `mistral-small-3.2-24b-instruct` (4.65), which cost more than the options above without a reason in these
   numbers to prefer them.

This compares prices only. I did not run any model for answer quality; that is not in this task's data. For the
gateway, if it is turned on, start with the same single model.

## What needs the owner's OK

Nothing below has been done; each is a switch the owner flips.

1. **Turn on the gateway part.** `SIGN402_WEB_FREE_MODELS=deepseek-v4.1-flash` on the web API (with its Surplus key
   and internal token already set). Defaults: 20 per account, 40 per network, 1000 a day, 400 tokens. This is new free
   spending that does not exist today. Its counters are separate from singit-ask's: with both on, the worst case
   is up to 1000 + 1000 answers a day, not 1000 in total.
2. **The budget value** for `SINGIT_ASK_FREE_BUDGET_USD_PER_DAY` (unset now, so no budget is checked). Reference
   points from the table, worst case at deepseek's list price: 100 answers a day is 0.042 USD, 300 is 0.126,
   1000 is 0.42. A budget below 0.42 USD a day makes the budget, not the 1000 cap, the limit; one at or above it
   never binds. The number is the owner's choice.
3. **Change or add a free model.** `SINGIT_ASK_FREE_MODELS` (singit-ask) and `SIGN402_WEB_FREE_MODELS` (gateway).
   See the recommendation above.
4. **Lower or keep the caps** (`SINGIT_ASK_FREE_PER_VISITOR`, `SINGIT_ASK_FREE_PER_DAY`, the gateway's
   `SIGN402_WEB_FREE_*`). The defaults were left as they were.

## Limits of this design

- **Counters are in memory** in both services; a restart starts the day over, which can give out one more day's
  allowance at most, bounded by the daily ceiling (and the budget, if set).
- **A network is not a person.** A shared office or mobile carrier network shares one allowance; someone with many
  networks (VPN, many IPv6 /64s) can still collect more. The daily ceiling and the budget are what bound that.
- **Gateway accounts are cheap to make** (any wallet that signs in), so on the gateway the network limit, not the
  account limit, is the real brake against many wallets from one place.
- **Discovery text:** the task asked for the Bazaar description to stay within 300 characters. The bound the
  discovery tests enforce is 500 (`singit-ask/test/app.test.mjs`), and the top-level description was not touched.
  Free models are named only in the Bazaar input schema's `model` field. The test sizes only
  `resource.description`; I have not checked whether Coinbase's facilitator limits the input schema. Check
  discovery against the real facilitator before deploying, or drop the schema change (`inputSchema` in
  `singit-ask/src/app.mjs`) if it objects.
