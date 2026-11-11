import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { HealthStats, numbersBody, healthBody, HOUR, LATENCY_CAP, MIN_SAMPLES, DEGRADED_RATE, isIndeterminateSettlement } from "../src/health-stats.mjs";
import express from "express";
import { x402ResourceServer } from "@x402/express";
import { createApp } from "../src/app.mjs";
import { addPaymentRoute } from "../src/metered.mjs";
import { BASE, PAY_TO, METERED_ROUTE } from "../src/pricing.mjs";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const own = "0x" + "a".repeat(40), external = "0x" + "b".repeat(40);
const start = Date.UTC(2026, 10, 9, 10, 30);
// What the paid handler and settlement hook pass for one call by `payer` that answered in `ms` (or did not).
function call(s, { payer = external, network = BASE, ms, started = s.now() } = {}) {
  const tally = { network, external: s.isExternal(payer), started };
  s.recordPaidAttempt(tally);
  if (ms !== undefined) s.recordPaidAnswer({ ...tally, ms });
}

test("without an own-payer list success and latency are null, nothing is recorded, no payer leaks", () => {
  const s = new HealthStats({ now: () => start });
  call(s, { ms: 100 }); call(s, { payer: own, ms: 200 });
  assert.equal(s.isExternal(external), false);
  const n = numbersBody(s), json = JSON.stringify(n);
  for (const w of ["last_24h", "last_7d"]) for (const net of ["base", "solana"]) {
    assert.deepEqual(n.paid_call_success[w][net], { attempts: null, answered: null, success_pct: null, reason: "own_payers_not_configured" });
    assert.deepEqual(n.paid_answer_latency_ms[w][net], { samples: null, p50: null, p95: null, reason: "own_payers_not_configured" });
  }
  assert.equal(Object.values(s.state.buckets).some(b => b.paid), false);
  assert.ok(!json.toLowerCase().includes(external.slice(2)) && !json.toLowerCase().includes(own.slice(2)));
  assert.deepEqual(n.payment_overhead_ms, { p50: null, p95: null, reason: "not_measured" });
  assert.deepEqual(n.e2e_ms, { p50: null, p95: null, reason: "not_measured" });
  for (const key of ["paid_call_success", "paid_answer_latency_ms", "payment_overhead_ms", "e2e_ms", "charge_without_answer", "settlement_unknown"])
    assert.equal(typeof n.definitions[key], "string");
  assert.match(n.definitions.paid_call_success, /own_payers_not_configured/);
});

test("own payers are excluded, unknown payers are not external, the rate is answered / attempts", () => {
  const s = new HealthStats({ now: () => start, ownPayers: [own] });
  call(s, { ms: 100 }); call(s, { ms: 300 }); call(s);
  call(s, { payer: own.toUpperCase().replace("0X", "0x"), ms: 5 }); call(s, { payer: own });
  call(s, { payer: null, ms: 7 }); call(s, { payer: " " });
  call(s, { network: SOLANA, ms: 50 }); call(s, { network: "eip155:1", ms: 9 });
  const n = numbersBody(s);
  assert.deepEqual(n.paid_call_success.last_24h.base, { attempts: 3, answered: 2, success_pct: null, reason: "below_minimum_n", suppressed: true });
  assert.deepEqual(n.paid_call_success.last_7d.solana, { attempts: 1, answered: 1, success_pct: null, reason: "below_minimum_n", suppressed: true });
  assert.deepEqual(n.paid_answer_latency_ms.last_24h.base, { samples: 2, p50: null, p95: null, reason: "below_minimum_n", suppressed: true });
  assert.ok(!JSON.stringify(n).toLowerCase().includes(own.slice(2)));
});

test("zero attempts is insufficient_data, never 100%, and windows expire", () => {
  let now = start;
  const s = new HealthStats({ now: () => now, ownPayers: [own] });
  const empty = numbersBody(s);
  assert.deepEqual(empty.paid_call_success.last_24h.base, { attempts: 0, answered: 0, success_pct: null, reason: "insufficient_data", suppressed: false });
  assert.deepEqual(empty.paid_answer_latency_ms.last_7d.solana, { samples: 0, p50: null, p95: null, reason: "insufficient_data", suppressed: false });
  call(s);
  assert.deepEqual(numbersBody(s).paid_call_success.last_24h.base, { attempts: 1, answered: 0, success_pct: null, reason: "below_minimum_n", suppressed: true });
  assert.equal(numbersBody(s).paid_answer_latency_ms.last_24h.base.reason, "insufficient_data");
  now += 25 * HOUR;
  assert.equal(numbersBody(s).paid_call_success.last_24h.base.reason, "insufficient_data");
  assert.equal(numbersBody(s).paid_call_success.last_7d.base.attempts, 1);
});

test("an answer lands in the hour its attempt started, so answers never exceed attempts", () => {
  let now = start + 59 * 60000;
  const s = new HealthStats({ now: () => now, ownPayers: [own] });
  const tally = { network: BASE, external: true, started: now };
  s.recordPaidAttempt(tally); now += 2 * 60000; s.recordPaidAnswer({ ...tally, ms: 120000 });
  assert.equal(Object.keys(s.state.buckets).length, 1);
  assert.equal(numbersBody(s).paid_call_success.last_24h.base.success_pct, null);
  for (const ms of [-1, 1.5, "10", undefined]) s.recordPaidAnswer({ ...tally, ms });
  assert.equal(numbersBody(s).paid_call_success.last_24h.base.answered, 1);
});

test("nearest-rank percentiles over a known list, capped per hour", () => {
  const s = new HealthStats({ now: () => start, ownPayers: [own] });
  for (const ms of [...Array(100).keys()].map(i => 100 - i)) call(s, { ms });
  assert.deepEqual(numbersBody(s).paid_answer_latency_ms.last_24h.base, { samples: 100, p50: 50, p95: 95, reason: null, suppressed: false });
  const t = new HealthStats({ now: () => start, ownPayers: [own] });
  for (const ms of [10, 20, 30, 40]) call(t, { ms });
  assert.deepEqual(numbersBody(t).paid_answer_latency_ms.last_24h.base, { samples: 4, p50: null, p95: null, reason: "below_minimum_n", suppressed: true });
  for (let i = 0; i < LATENCY_CAP; i++) call(t, { ms: 1 });
  const capped = numbersBody(t);
  assert.equal(capped.paid_answer_latency_ms.last_24h.base.samples, LATENCY_CAP);
  assert.equal(capped.paid_call_success.last_24h.base.answered, LATENCY_CAP + 4);
});

test("charge_without_answer counts every payer, by window and network, from its own start", () => {
  let now = start;
  const s = new HealthStats({ now: () => now });
  const n0 = numbersBody(s).charge_without_answer;
  assert.deepEqual(n0, { since: new Date(start).toISOString(), total: 0, last_24h: 0, last_7d: 0, by_network: { base: 0, solana: 0 } });
  s.recordChargeWithoutAnswer(BASE); now += 30 * HOUR; s.recordChargeWithoutAnswer(SOLANA); s.recordChargeWithoutAnswer("eip155:1");
  assert.deepEqual(numbersBody(s).charge_without_answer, { since: new Date(start).toISOString(),
    total: 3, last_24h: 2, last_7d: 3, by_network: { base: 1, solana: 1 } });
  assert.match(numbersBody(s).definitions.charge_without_answer, /only since/);
});

test("old files without the new fields load; new counters round trip; bad new fields reject the file", t => {
  const dir = mkdtempSync(join(tmpdir(), "paid-metrics-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "stats.json");
  let now = start;
  const old = new HealthStats({ now: () => now });
  old.recordSettlement({ route: "/r", network: BASE, ok: true, amount: "1000", payer: external });
  delete old.state.cwaSince; delete old.state.cwa; delete old.state.suSince; delete old.state.su;
  writeFileSync(file, JSON.stringify(old.state));
  now += HOUR;
  const loaded = new HealthStats({ file, now: () => now, ownPayers: [own] });
  assert.equal(loaded.numbers().total.calls, 1);
  assert.equal(numbersBody(loaded).charge_without_answer.since, new Date(now).toISOString());
  assert.equal(numbersBody(loaded).settlement_unknown.since, new Date(now).toISOString());
  loaded.recordSettlementUnknown(BASE);
  call(loaded, { ms: 42 }); call(loaded); loaded.recordChargeWithoutAnswer(SOLANA); loaded.flush();
  assert.ok(!readFileSync(file, "utf8").includes(external));
  const reloaded = new HealthStats({ file, now: () => now, ownPayers: [own] });
  for (const key of ["paid_call_success", "paid_answer_latency_ms", "charge_without_answer", "settlement_unknown"])
    assert.deepEqual(numbersBody(reloaded)[key], numbersBody(loaded)[key]);
  assert.deepEqual(numbersBody(reloaded).paid_call_success.last_24h.base,
    { attempts: 2, answered: 1, success_pct: null, reason: "below_minimum_n", suppressed: true });
  assert.equal(numbersBody(reloaded).paid_answer_latency_ms.last_24h.base.samples, 1);
  const saved = JSON.parse(readFileSync(file, "utf8")), key = Object.keys(saved.buckets).at(-1);
  for (const bad of [{ base: { attempts: -1, answered: 0, ms: [] } }, { base: { attempts: 1, answered: 0, ms: [1.5] } },
    { base: { attempts: 1, answered: 0, ms: Array(LATENCY_CAP + 1).fill(1) } }, { mainnet: { attempts: 0, answered: 0, ms: [] } }]) {
    writeFileSync(file, JSON.stringify({ ...saved, buckets: { ...saved.buckets, [key]: { ...saved.buckets[key], paid: bad } } }));
    assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
  }
  writeFileSync(file, JSON.stringify({ ...saved, buckets: { ...saved.buckets, [key]: { ...saved.buckets[key], su: { base: -1 } } } }));
  assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
  for (const bad of [{ cwa: { base: -1 } }, { cwaSince: "never" }, { su: { base: -1 } }, { su: { mainnet: 1 } }, { suSince: "never" }]) {
    writeFileSync(file, JSON.stringify({ ...saved, ...bad })); assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
  }
});

test("recording failures never throw into an answer", () => {
  const s = new HealthStats({ ownPayers: [own] });
  s.bucket = () => { throw new Error("broken"); };
  assert.doesNotThrow(() => { call(s, { ms: 1 }); s.recordChargeWithoutAnswer(BASE); s.recordSettlementUnknown(BASE); });
});

test("settle hook counts a charge without an answer only when the invariant breaks", () => {
  const app = express(), server = new x402ResourceServer({ getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) });
  const after = [], verified = [];
  server.onAfterSettle = fn => { after.push(fn); return server; };
  server.onAfterVerify = fn => { verified.push(fn); return server; };
  const stats = app.locals.healthStats = new HealthStats({ now: () => start, ownPayers: [own] });
  addPaymentRoute(app, { "POST /chat": { accepts: [] } }, server,
    { discoverable: false, permitGuard: { record() {}, middleware(_q, _s, next) { next(); } }, log() {} });
  const req = {}, ctx = (statusCode, locals, success = true, phase) => {
    const req = { res: { statusCode, locals } };
    return { phase, transportContext: { request: { path: "/chat", adapter: { req } } }, requirements: { network: BASE, scheme: "exact", amount: "1" },
      result: { success, payer: external } };
  };
  for (const fn of verified) fn({ transportContext: { request: { adapter: { req } } }, result: { isValid: true, payer: external } });
  assert.equal(req.singitExternalPayer, true);
  const tally = { network: BASE, external: true, started: start };
  stats.recordPaidAttempt(tally);
  // Answered and settled; a non-chat route with a 2xx; a failed settlement; a Solana deposit or refund: none is a charge without an answer.
  for (const c of [ctx(200, { singitPaid: tally, singitAnswered: 12 }), ctx(201, {}), ctx(500, { singitPaid: tally }, false),
    ctx(200, { singitPaid: tally }, true, "before-handler"), ctx(503, { singitPaid: tally }, true, "cancel")])
    for (const fn of after) fn(c);
  assert.equal(numbersBody(stats).charge_without_answer.total, 0);
  assert.equal(numbersBody(stats).paid_call_success.last_24h.base.answered, 1);
  for (const c of [ctx(200, { singitPaid: tally }), ctx(400, {}), ctx(503, { singitPaid: tally, singitAnswered: 3 })])
    for (const fn of after) fn(c);
  assert.equal(numbersBody(stats).charge_without_answer.total, 3);
  assert.equal(numbersBody(stats).paid_call_success.last_24h.base.answered, 1);
  stats.recordChargeWithoutAnswer = () => { throw new Error("stats offline"); };
  for (const fn of after) assert.doesNotThrow(() => fn(ctx(500, {})));
});

// End to end through the real x402 middleware with a fake facilitator: the verify hook classifies the payer,
// the handler records the attempt, the settle hook records the answer; an unanswered call never settles.
const encode = v => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = v => JSON.parse(Buffer.from(v, "base64").toString());
const account = privateKeyToAccount("0x" + "11".repeat(32)); // Public unfunded test fixture.
const CDP_SIGNER = "0x2A89407a98A0732b7fD578c4E156B7166540EB5A";
const kinds = [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu" } },
  { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: CDP_SIGNER } },
  { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }];
async function paidApp(t, { ownPayers, payer = account.address, settleSuccess = true, upstreamGate }) {
  let fail = false;
  const facilitator = { getSupported: async () => ({ kinds, extensions: ["eip2612GasSponsoring"], signers: {} }),
    verify: async () => ({ isValid: true, payer }),
    settle: async () => ({ success: settleSuccess, network: BASE, transaction: "0x" + "aa".repeat(32), payer }) };
  const app = createApp({ payToBase: PAY_TO, payToSolana: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu", model: "test", ownPayers },
    { facilitatorClient: facilitator, log: () => {}, upstream: async () => {
      if (upstreamGate) await upstreamGate();
      if (fail) throw new Error("model answered HTTP 503");
      return { content: "Hello", finishReason: "stop", usage: { buyer_cost_micro: 100 } };
    } });
  const listener = await new Promise(resolve => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); }); t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send = headers => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) });
  const pay = async () => {
    const q = decode((await send({})).headers.get("payment-required"));
    const exact = q.accepts.find(a => a.scheme === "exact" && a.network === BASE);
    return send({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: q.resource, accepted: exact, payload: { signature: "0xsigned" }, extensions: q.extensions }) });
  };
  return { stats: app.locals.healthStats, pay, send, failNext: v => { fail = v; } };
}

test("paid route: an unsigned 402 does not count an attempt", async t => {
  const { stats, send } = await paidApp(t, { ownPayers: [own] });
  assert.equal((await send({})).status, 402);
  for (const w of ["last_24h", "last_7d"])
    assert.deepEqual(numbersBody(stats).paid_call_success[w].base,
      { attempts: 0, answered: 0, success_pct: null, reason: "insufficient_data", suppressed: false });
});

test("paid route: an in-flight payment_duplicate does not count another attempt", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const { stats, pay } = await paidApp(t, { ownPayers: [own], upstreamGate: () => { entered(); return gate; } });
  const first = pay();
  try {
    await ready;
    assert.equal(numbersBody(stats).paid_call_success.last_24h.base.attempts, 1);
    const duplicate = await pay();
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, "payment_duplicate");
    for (const w of ["last_24h", "last_7d"])
      assert.equal(numbersBody(stats).paid_call_success[w].base.attempts, 1);
  } finally {
    release();
    assert.equal((await first).status, 200);
  }
  assert.equal(numbersBody(stats).paid_call_success.last_24h.base.attempts, 1);
});

test("paid route: external answered and unanswered calls retain counts below the gate, no charge without answer", async t => {
  const { stats, pay, failNext } = await paidApp(t, { ownPayers: [own] });
  assert.equal((await pay()).status, 200);
  failNext(true); assert.equal((await pay()).status, 503);
  const n = numbersBody(stats);
  assert.deepEqual(n.paid_call_success.last_24h.base, { attempts: 2, answered: 1, success_pct: null, reason: "below_minimum_n", suppressed: true });
  assert.equal(n.paid_answer_latency_ms.last_24h.base.samples, 1);
  assert.equal(n.charge_without_answer.total, 0);
  assert.ok(!JSON.stringify(n).toLowerCase().includes(account.address.slice(2).toLowerCase()));
});

test("paid route: our own payer and an unconfigured list record nothing", async t => {
  for (const ownPayers of [[account.address], []]) {
    const { stats, pay } = await paidApp(t, { ownPayers });
    assert.equal((await pay()).status, 200);
    assert.equal(Object.values(stats.state.buckets).some(b => b.paid), false);
    assert.equal(numbersBody(stats).charge_without_answer.total, 0);
  }
});

test("paid route: a failed settlement records an attempt but no answer", async t => {
  const { stats, pay } = await paidApp(t, { ownPayers: [own], settleSuccess: false });
  assert.notEqual((await pay()).status, 200);
  assert.deepEqual(numbersBody(stats).paid_call_success.last_24h.base, { attempts: 1, answered: 0, success_pct: null, reason: "below_minimum_n", suppressed: true });
  assert.equal(numbersBody(stats).charge_without_answer.total, 0);
});


test("success and latency publish only at MIN_SAMPLES in each network and window", () => {
  for (const [network, name, other] of [[BASE, "base", "solana"], [SOLANA, "solana", "base"]]) {
  let now = start;
  const s = new HealthStats({ now: () => now, ownPayers: [own] });
  for (let i = 1; i < MIN_SAMPLES; i++) call(s, { network, ms: i });
  for (const w of ["last_24h", "last_7d"]) {
    const n = numbersBody(s);
    assert.deepEqual(n.paid_call_success[w][name], { attempts: MIN_SAMPLES - 1, answered: MIN_SAMPLES - 1,
      success_pct: null, reason: "below_minimum_n", suppressed: true });
    assert.deepEqual(n.paid_answer_latency_ms[w][name], { samples: MIN_SAMPLES - 1,
      p50: null, p95: null, reason: "below_minimum_n", suppressed: true });
  }
  call(s, { network }); // Attempts reach the gate before latency samples do.
  assert.equal(numbersBody(s).paid_call_success.last_24h[name].success_pct, Math.round((MIN_SAMPLES - 1) / MIN_SAMPLES * 1000) / 10);
  assert.equal(numbersBody(s).paid_answer_latency_ms.last_24h[name].p50, null);
  s.recordPaidAnswer({ network, external: true, started: now, ms: MIN_SAMPLES });
  for (const w of ["last_24h", "last_7d"]) {
    const n = numbersBody(s);
    assert.deepEqual(n.paid_call_success[w][name], { attempts: MIN_SAMPLES, answered: MIN_SAMPLES, success_pct: 100, reason: null, suppressed: false });
    assert.deepEqual(n.paid_answer_latency_ms[w][name], { samples: MIN_SAMPLES,
      p50: Math.ceil(MIN_SAMPLES * .5), p95: Math.ceil(MIN_SAMPLES * .95), reason: null, suppressed: false });
    assert.equal(n.paid_call_success[w][other].reason, "insufficient_data");
    assert.equal(n.paid_call_success[w][other].suppressed, false);
    assert.equal(n.paid_answer_latency_ms[w][other].reason, "insufficient_data");
    assert.equal(n.paid_answer_latency_ms[w][other].suppressed, false);
  }
  now += 24 * HOUR;
  assert.equal(numbersBody(s).paid_call_success.last_24h[name].attempts, 0);
  assert.equal(numbersBody(s).paid_call_success.last_7d[name].success_pct, 100);
  }
});

test("settlement_unknown counts every payer with its own windows and network totals", () => {
  for (const ownPayers of [[], [own]]) {
    let now = start;
    const s = new HealthStats({ now: () => now, ownPayers });
    assert.deepEqual(numbersBody(s).settlement_unknown, { since: new Date(start).toISOString(),
      total: 0, last_24h: 0, last_7d: 0, by_network: { base: 0, solana: 0 } });
    s.recordSettlementUnknown(BASE); now += 30 * HOUR;
    s.recordSettlementUnknown(SOLANA); s.recordSettlementUnknown("other");
    assert.deepEqual(numbersBody(s).settlement_unknown, { since: new Date(start).toISOString(),
      total: 3, last_24h: 2, last_7d: 3, by_network: { base: 1, solana: 1 } });
    now += 168 * HOUR;
    assert.equal(numbersBody(s).settlement_unknown.last_7d, 0);
  }
});

test("indeterminate settlement detection follows causes and facilitator uncertainty", () => {
  for (const error of [{ name: "FacilitatorTimeoutError" }, { cause: { name: "FacilitatorTimeoutError" } },
    { name: "FacilitatorResponseError" }, { message: "request timed out" }, { errorReason: "timeout" },
    { transaction: "test-transaction" }, { transactionHash: "test-transaction" },
    ...["pending", "transport error", "unavailable", "unexpected", "settlement failed", "unknown reason"].map(errorReason => ({ errorReason }))])
    assert.equal(isIndeterminateSettlement(error), true);
  for (const error of [null, undefined, {}, { errorReason: "insufficient_funds" }])
    assert.equal(isIndeterminateSettlement(error), false);
  const cyclic = {}; cyclic.cause = cyclic;
  assert.equal(isIndeterminateSettlement(cyclic), false);
});

// SI-294: /health shows paid_call_success per rail, and a well-sampled low rate degrades that rail and the service.
const calls = (s, network, attempts, answered, started = s.now()) => {
  for (let i = 0; i < attempts; i++) call(s, { network, started, ...(i < answered ? { ms: 100 } : {}) });
};
test("/health: paid_call_success per rail, same figures as numbers.json, degrades only with enough samples", () => {
  assert.equal(MIN_SAMPLES, 20); assert.equal(DEGRADED_RATE, 0.1);
  let now = start;
  const s = new HealthStats({ now: () => now, ownPayers: [own] });
  // The 10.11 13:22 baseline: Base 61/62 = 98.4%, Solana 20/38 = 52.6%.
  calls(s, BASE, 62, 61); calls(s, SOLANA, 38, 20);
  let h = healthBody(s, null, "m");
  assert.deepEqual(h.payments.networks.solana.paid_call_success, { window: "last_24h", attempts: 38, answered: 20,
    success_pct: 52.6, reason: null, suppressed: false, status: "degraded" });
  assert.deepEqual(h.payments.networks.base.paid_call_success, { window: "last_24h", attempts: 62, answered: 61,
    success_pct: 98.4, reason: null, suppressed: false, status: "up" });
  for (const n of ["base", "solana"]) {
    const { window, status, ...published } = h.payments.networks[n].paid_call_success;
    assert.deepEqual(published, numbersBody(s).paid_call_success.last_24h[n]);
  }
  assert.equal(h.payments.networks.solana.status, "degraded");
  assert.equal(h.payments.networks.solana.basis, "paid_call_success");
  assert.equal(h.payments.networks.base.status, "unknown");
  assert.equal(h.status, "degraded");
  assert.ok(!JSON.stringify(h).includes(external) && !JSON.stringify(h).includes(own));

  // Base-like 98.4% alone does not degrade; exactly 90% is the bar, not below it.
  const base = new HealthStats({ now: () => now, ownPayers: [own] });
  calls(base, BASE, 62, 61); calls(base, SOLANA, 20, 18);
  h = healthBody(base, null, "m");
  assert.equal(h.status, "ok");
  assert.equal(h.payments.networks.solana.paid_call_success.status, "up");

  // Fewer than MIN_SAMPLES with a poor ratio: visible as raw counts, never degraded by itself.
  const few = new HealthStats({ now: () => now, ownPayers: [own] });
  calls(few, SOLANA, MIN_SAMPLES - 1, 1);
  h = healthBody(few, null, "m");
  assert.deepEqual(h.payments.networks.solana.paid_call_success, { window: "last_24h", attempts: 19, answered: 1,
    success_pct: null, reason: "below_minimum_n", suppressed: true, status: "unknown" });
  assert.equal(h.payments.networks.solana.status, "unknown");
  assert.equal(h.status, "ok");
  assert.equal(h.payments.networks.base.paid_call_success.reason, "insufficient_data");

  // The failing hour leaves the rolling 24h window; healthy later samples bring the status back to ok.
  now += 3 * HOUR; calls(s, SOLANA, 25, 25);
  assert.equal(healthBody(s, null, "m").status, "degraded");
  now = start + 24 * HOUR;
  h = healthBody(s, null, "m");
  assert.deepEqual(h.payments.networks.solana.paid_call_success, { window: "last_24h", attempts: 25, answered: 25,
    success_pct: 100, reason: null, suppressed: false, status: "up" });
  assert.equal(h.payments.networks.solana.status, "unknown");
  assert.equal(h.status, "ok");
});

test("/health: without an own-payer list rail paid success is unpublished and changes no status", () => {
  const s = new HealthStats({ now: () => start });
  calls(s, SOLANA, 38, 0);
  const h = healthBody(s, null, "m");
  for (const n of ["base", "solana"]) assert.deepEqual(h.payments.networks[n].paid_call_success,
    { window: "last_24h", attempts: null, answered: null, success_pct: null, reason: "own_payers_not_configured", status: "unknown" });
  assert.equal(h.status, "ok");
});

test("/health: a rail already down or degraded by settlements keeps its settlement basis", () => {
  const s = new HealthStats({ now: () => start, ownPayers: [own] });
  calls(s, SOLANA, 30, 3);
  for (let i = 0; i < 3; i++) s.recordSettlement({ route: "/r", network: SOLANA, ok: false });
  const rail = healthBody(s, null, "m").payments.networks.solana;
  assert.equal(rail.status, "down"); assert.equal(rail.basis, "settlements");
  assert.equal(rail.paid_call_success.status, "degraded");
});

test("per-model paid success: external only, per network, follows a fallback, ages out and round trips", t => {
  let now = start;
  const s = new HealthStats({ now: () => now, ownPayers: [own] });
  const tally = { network: SOLANA, external: true, started: now, model: "a" };
  s.recordPaidAttempt(tally);
  s.recordPaidModelAttempt({ ...tally, model: "b" });
  s.recordPaidAnswer({ ...tally, model: "b", ms: 10 });
  s.recordPaidAttempt({ ...tally, external: s.isExternal(own) });
  s.recordPaidAttempt({ ...tally, network: BASE });
  assert.deepEqual(s.paidModelSuccess("a", SOLANA), { attempts: 1, answered: 0 });
  assert.deepEqual(s.paidModelSuccess("b", "solana"), { attempts: 1, answered: 1 });
  assert.deepEqual(s.paidModelSuccess("a", BASE), { attempts: 1, answered: 0 });
  assert.deepEqual(s.paidModelSuccess("constructor", SOLANA), { attempts: 0, answered: 0 });
  // The network figure counts the call once, whatever model answered it.
  assert.deepEqual(numbersBody(s).paid_call_success.last_24h.solana.attempts, 1);
  assert.deepEqual(numbersBody(s).paid_call_success.last_24h.solana.answered, 1);
  const unconfigured = new HealthStats({ now: () => now });
  unconfigured.recordPaidAttempt(tally);
  assert.deepEqual(unconfigured.paidModelSuccess("a", SOLANA), { attempts: 0, answered: 0 });

  const dir = mkdtempSync(join(tmpdir(), "paid-models-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "stats.json");
  const saved = new HealthStats({ file, now: () => now, ownPayers: [own] });
  saved.recordPaidAttempt(tally); saved.flush();
  assert.deepEqual(new HealthStats({ file, now: () => now, ownPayers: [own] }).paidModelSuccess("a", SOLANA), { attempts: 1, answered: 0 });
  const state = JSON.parse(readFileSync(file, "utf8")), key = Object.keys(state.buckets)[0];
  state.buckets[key].paid.solana.models.a.attempts = -1;
  writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(new HealthStats({ file, now: () => now, ownPayers: [own] }).paidModelSuccess("a", SOLANA), { attempts: 0, answered: 0 });

  now += 24 * HOUR;
  assert.deepEqual(s.paidModelSuccess("b", SOLANA), { attempts: 0, answered: 0 });
});
