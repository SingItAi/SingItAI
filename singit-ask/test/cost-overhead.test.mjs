// SI-110: per-model cost overhead in the ceiling. grok-4.7 bills a hidden system prompt (about 1220 tokens) and
// thinking beyond max_tokens; at the old ceiling a paid upto answer ran past it and was refused (1561 > 1500).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_COST_OVERHEAD, TERMS, SOLANA_TERMS, billUsage, ceilingAtomic, costOverhead, worstModelCostMicro }
  from "../src/pricing.mjs";

const GROK = { id: "grok-4.7", promptUsdPerToken: 2e-6, completionUsdPerToken: 6e-6 };
const PLAIN = { ...GROK, id: "some-other-model" };
// The paid test of 27 October: 22 characters, one message, max_tokens 32, upto (one token per character).
const TEST_CALL = { chars: 22, maxTokens: 32, messageCount: 1, charsPerToken: 1 };

test("grok-4.7 carries its hidden prompt and reasoning headroom; others carry none", () => {
  assert.deepEqual(MODEL_COST_OVERHEAD["grok-4.7"], { promptTokens: 1300, reasoningTokens: 64 });
  assert.deepEqual(costOverhead(GROK), { promptTokens: 1300, reasoningTokens: 64 });
  for (const model of [PLAIN, { promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 }, null, { id: "toString" }, { id: "__proto__" }])
    assert.deepEqual(costOverhead(model), { promptTokens: 0, reasoningTokens: 0 });
  // (22 + 4 + 1300) * 2e-6 + (32 + 64) * 6e-6 = 0.003228 USD at list.
  assert.equal(worstModelCostMicro(GROK, TEST_CALL), 3228);
  assert.equal(worstModelCostMicro(PLAIN, TEST_CALL), 244);
  assert.equal(worstModelCostMicro(GROK, TEST_CALL, 0.5), 1614, "the share scales the overhead too");
});

test("the refused grok-4.7 answer now fits its ceiling; upto still bills actual usage", () => {
  const usage = { prompt_tokens: 1248, completion_tokens: 56, completion_tokens_details: { reasoning_tokens: 51 },
    buyer_cost_micro: 431 };
  assert.equal(ceilingAtomic(PLAIN, TEST_CALL, TERMS), "1500", "before: the floor");
  assert.throws(() => billUsage(usage, { ...TERMS, maxChargeAtomic: "1500" }), { code: "ceiling_exceeded", totalAtomic: "1561" });
  const ceiling = ceilingAtomic(GROK, TEST_CALL, TERMS);
  assert.equal(ceiling, "5197"); // 3228 + 969 markup + 1000 fee
  const billed = billUsage(usage, { ...TERMS, maxChargeAtomic: ceiling });
  assert.equal(billed.totalAtomic, "1561", "settled at actual usage, not at the ceiling");
  assert.equal(ceilingAtomic(GROK, TEST_CALL, SOLANA_TERMS), "6197");
});

test("a model without overhead keeps exactly the old ceiling", () => {
  for (const size of [TEST_CALL, { chars: 64, maxTokens: 500, messageCount: 1 }, { chars: 900, maxTokens: 1200, messageCount: 3, charsPerToken: 1 }]) {
    const inputTokens = Math.ceil(size.chars / (size.charsPerToken ?? 4)) + 4 * size.messageCount;
    assert.equal(worstModelCostMicro(PLAIN, size), Math.ceil((inputTokens * 2e-6 + size.maxTokens * 6e-6) * 1e6));
  }
});
