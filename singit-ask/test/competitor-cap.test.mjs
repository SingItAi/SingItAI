// SI-102 follow-up: `exact` capped at the competitor's price for the same question, never below the cost floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, TERMS, SOLANA_TERMS, ceilingAtomic } from "../src/pricing.mjs";
import { ceilings } from "../src/metered.mjs";
import { createApp, ROUTE } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { DEFAULT_COMPETITOR_CAP, competitorCapFor, competitorExactAtomic, capExact, resetFloorLog,
  FLOOR_LOG_EVERY_MS } from "../src/competitor-cap.mjs";

const OPUS = { id: "claude-opus-5.5", name: "Claude Opus 5.5", promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
const UNLISTED = { id: "some-other-model", name: "Other", promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
// 45 characters, one message, max_tokens 500: the question BlockRun's 402 was probed with (competitor-ceilings.json).
const Q = { chars: 45, messageCount: 1, maxTokens: 500 };

test("competitor-ceilings.json: documented source, Base rule, no Solana rule, every model has both prices", () => {
  const cap = DEFAULT_COMPETITOR_CAP;
  assert.match(cap.source, /blockrun\.ai/);
  assert.match(cap.source, /competitors\/blockrun-vs-singit\.md/);
  assert.deepEqual(cap.networks[BASE], { exactOutputFraction: 0.1, feeAtomic: 1000, minAtomic: 2000 });
  assert.equal(cap.networks[SOLANA], null);
  for (const [id, m] of Object.entries(cap.models)) {
    assert.ok(m.inputUsdPerMillion > 0 && m.outputUsdPerMillion > 0, id);
    assert.ok(m.competitorId.endsWith(`/${id}`), id);
  }
  assert.equal(competitorCapFor({}), DEFAULT_COMPETITOR_CAP);
  assert.equal(competitorCapFor({ competitorCap: null }), null);
});

test("competitorExactAtomic reproduces BlockRun's probed 402 on Base (at their ~38 input tokens) to 1 micro-USDC", () => {
  // 136 characters -> ceil(136/4) + 4 = 38 input tokens, BlockRun's own count for the probe question.
  const at38 = { chars: 136, messageCount: 1, maxTokens: 500 };
  for (const [id, m] of Object.entries(DEFAULT_COMPETITOR_CAP.models)) {
    const ours = competitorExactAtomic(DEFAULT_COMPETITOR_CAP, id, BASE, at38);
    assert.ok(Math.abs(Number(ours) - m.probedExactBaseAtomic) <= 1, `${id}: ${ours} vs ${m.probedExactBaseAtomic}`);
  }
  // With this service's own, smaller input estimate the cap is never above what BlockRun asks.
  for (const [id, m] of Object.entries(DEFAULT_COMPETITOR_CAP.models)) {
    assert.ok(Number(competitorExactAtomic(DEFAULT_COMPETITOR_CAP, id, BASE, Q)) <= m.probedExactBaseAtomic, id);
  }
  // It scales with max_tokens the way theirs does (10% of it priced as output), and is null where nothing is set.
  assert.equal(competitorExactAtomic(DEFAULT_COMPETITOR_CAP, OPUS.id, BASE, { ...Q, maxTokens: 8192 }), 64n + 820n * 20n + 1000n);
  assert.equal(competitorExactAtomic(DEFAULT_COMPETITOR_CAP, OPUS.id, SOLANA, Q), null);
  assert.equal(competitorExactAtomic(DEFAULT_COMPETITOR_CAP, UNLISTED.id, BASE, Q), null);
  assert.equal(competitorExactAtomic(null, OPUS.id, BASE, Q), null);
});

test("ceilings: a cheap market lets the competitor's price cap exact on Base; Solana and upto are untouched", () => {
  resetFloorLog();
  const logs = [];
  const input = { ...Q, share: 0.27, cheapestShare: 0.26 };
  const plain = ceilings(OPUS, input, 0.3);
  const capped = ceilings(OPUS, input, 0.3, DEFAULT_COMPETITOR_CAP, (l) => logs.push(l));
  const competitor = competitorExactAtomic(DEFAULT_COMPETITOR_CAP, OPUS.id, BASE, Q);
  const floor = BigInt(ceilingAtomic(OPUS, { chars: 45, messageCount: 1, maxTokens: 150 }, TERMS, 0.26));
  assert.ok(BigInt(plain.exact[BASE]) > competitor, "uncapped exact is dearer than the competitor here");
  assert.ok(floor <= competitor, "the cost floor is below the competitor here");
  assert.equal(capped.exact[BASE], competitor.toString());
  assert.equal(capped.exact[SOLANA], plain.exact[SOLANA]);
  assert.deepEqual(capped.upto, plain.upto);
  assert.deepEqual(logs, []);
});

test("ceilings: when the competitor's price is below the cost floor the floor is kept, and logged once per window", () => {
  resetFloorLog();
  const logs = [];
  // Today's market (27.10): the cheapest trusted Opus 5.5 offer is about 0.62 of list.
  const input = { ...Q, share: 0.63, cheapestShare: 0.62 };
  const plain = ceilings(OPUS, input, 0.3);
  const floor = ceilingAtomic(OPUS, { chars: 45, messageCount: 1, maxTokens: 150 }, TERMS, 0.62);
  const capped = ceilings(OPUS, input, 0.3, DEFAULT_COMPETITOR_CAP, (l) => logs.push(l));
  assert.equal(capped.exact[BASE], floor);
  assert.ok(BigInt(capped.exact[BASE]) <= BigInt(plain.exact[BASE]));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /claude-opus-5\.5 on eip155:8453 .*below the cost floor/);
  ceilings(OPUS, input, 0.3, DEFAULT_COMPETITOR_CAP, (l) => logs.push(l));
  assert.equal(logs.length, 1, "throttled");
});

test("capExact: never above the uncapped price, floor at list price without a known share, off without a cap or model", () => {
  resetFloorLog();
  const base = { info: OPUS, network: BASE, terms: TERMS, size: Q, exactTokens: 150, log: () => {} };
  assert.equal(capExact({ ...base, cap: DEFAULT_COMPETITOR_CAP, uncapped: "1600", share: 0.1 }), "1600");
  assert.equal(capExact({ ...base, cap: null, uncapped: "9999", share: 0.1 }), "9999");
  assert.equal(capExact({ ...base, cap: DEFAULT_COMPETITOR_CAP, info: UNLISTED, uncapped: "9999", share: 0.1 }), "9999");
  assert.equal(capExact({ ...base, cap: DEFAULT_COMPETITOR_CAP, network: SOLANA, terms: SOLANA_TERMS, uncapped: "9999", share: 0.1 }), "9999");
  // No share known: the floor is bought at list price (share 1), which here is above the uncapped price itself.
  assert.equal(capExact({ ...base, cap: DEFAULT_COMPETITOR_CAP, uncapped: "4000", share: undefined }), "4000");
  // The floor's markup is configurable (floorMarkupBps); 0 is a break-even floor.
  resetFloorLog();
  let t = 0;
  const logs = [];
  const zero = { ...DEFAULT_COMPETITOR_CAP, floorMarkupBps: 0 };
  const at0 = capExact({ ...base, cap: zero, uncapped: "9999", share: 0.62, log: (l) => logs.push(l), now: () => t });
  assert.equal(at0, ceilingAtomic(OPUS, { chars: 45, messageCount: 1, maxTokens: 150 }, { ...TERMS, markupBps: 0 }, 0.62));
  t += FLOOR_LOG_EVERY_MS;
  capExact({ ...base, cap: zero, uncapped: "9999", share: 0.62, log: (l) => logs.push(l), now: () => t });
  assert.equal(logs.length, 2, "logged again after the window");
});

test("402 offer: exact on Base is the competitor's price for a capped model; an exact payer is settled that amount", async (t) => {
  resetFloorLog();
  const PRO = { id: "pro-model", name: "Pro", provider: "X", contextLength: 1e6, promptUsdPerToken: 30e-6, completionUsdPerToken: 180e-6 };
  // Market at 0.03 of list (guard 0.04 with the 1pp buffer): uncapped exact 3830 > competitor 2842 > break-even floor 2633.
  const cap = { competitor: "Test", floorMarkupBps: 0,
    networks: { [BASE]: { exactOutputFraction: 0.1, feeAtomic: 1000, minAtomic: 2000 }, [SOLANA]: null },
    models: { "pro-model": { competitorId: "x/pro-model", inputUsdPerMillion: 3, outputUsdPerMillion: 18 } } };
  const catalogue = { async market() { return new Map(); }, guardShare: () => 0.03,
    async resolve(id) { if (id !== "pro-model") throw new UnknownModel("no"); return PRO; },
    async list() { return [PRO]; }, async canAnswer() { return true; } };
  const settled = [];
  const facilitator = {
    async getSupported() { return { kinds: [
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
      { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
        receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }],
      extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
    async verify() { return { isValid: true, payer: "0x" + "2".repeat(40) }; },
    async settle(_p, req) { settled.push(req.amount); return { success: true, transaction: "0x" + "a".repeat(64), network: req.network, payer: "0x" + "2".repeat(40) }; },
  };
  const config = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x" + "1".repeat(40),
    surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash", competitorCap: cap };
  const upstream = async () => ({ content: "ok", finishReason: "stop", usage: { total_tokens: 5, buyer_cost_micro: 100 } });
  const app = createApp(config, { facilitatorClient: facilitator, upstream, log: () => {}, catalogue });
  const listener = await new Promise((r) => { const l = app.listen(0, "127.0.0.1", () => r(l)); });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}${ROUTE}`;
  const body = JSON.stringify({ model: "pro-model", max_tokens: 1000, messages: [{ role: "user", content: "x".repeat(40) }] });
  const unpaid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(unpaid.status, 402);
  const required = JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString());
  const exactBase = required.accepts.find((a) => a.scheme === "exact" && a.network === BASE);
  const exactSol = required.accepts.find((a) => a.scheme === "exact" && a.network === SOLANA);
  const expected = competitorExactAtomic(cap, "pro-model", BASE, { chars: 40, messageCount: 1, maxTokens: 1000 });
  assert.equal(exactBase.amount, expected.toString());
  assert.equal(exactBase.extra.billing.maxChargeAtomic, expected.toString());
  const uncappedSol = ceilings(PRO, { chars: 40, messageCount: 1, maxTokens: 1000, share: 0.04 }, 0.3).exact[SOLANA];
  const uncappedBase = ceilings(PRO, { chars: 40, messageCount: 1, maxTokens: 1000, share: 0.04 }, 0.3).exact[BASE];
  assert.ok(BigInt(uncappedBase) > expected, `uncapped ${uncappedBase} is dearer than the competitor ${expected}`);
  assert.equal(exactSol.amount, uncappedSol);
  const signature = Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted: exactBase,
    payload: { signature: "0xsigned" }, extensions: required.extensions })).toString("base64");
  const paid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": signature }, body });
  assert.equal(paid.status, 200);
  assert.deepEqual(settled, [expected.toString()]);
});
