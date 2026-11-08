// Solana `exact` answers must complete within SOLANA_EXACT_WINDOW_MS of verification (src/solana-exact-window.mjs).
// Stub facilitator and seller, a scripted clock and a manual timer: no network, keys, payments or real sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "./helpers/http-request.mjs";
import { withFacilitatorHints } from "../src/facilitator-hints.mjs";
import { createApp, BASE, SOLANA } from "../src/app.mjs";
import { parseModels } from "../src/catalogue.mjs";
import { numbersBody } from "../src/health-stats.mjs";
import { SOLANA_EXACT_WINDOW_MS, WindowExceeded, withinWindow } from "../src/solana-exact-window.mjs";

const T = SOLANA_EXACT_WINDOW_MS;
const payer = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const config = { model: "test", payToBase: "0x" + "1".repeat(40), payToSolana: payer, exaKey: "fake-test" };
const encode = v => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = v => JSON.parse(Buffer.from(v, "base64"));
const info = { id: "test", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000001 };
// The production refusal (journalctl, 8 November 2026), sanitized: no payer, transaction or address.
const STALE = { reason: "invalid_exact_svm_payload_transaction_simulation_failed",
  message: "simulation failed: transaction would fail on-chain: BlockhashNotFound" };
const BODY = { model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 };
const supported = async () => ({ kinds: [BASE, SOLANA].flatMap(n => ["upto", "exact"].map(s => ({ x402Version: 2, network: n, scheme: s,
  extra: { feePayer: payer, receiverAuthorizer: payer, facilitatorAddress: "0x" + "2".repeat(40) } }))), extensions: [], signers: {} });

// A clock that answers `now()` from a script (then stays at the last value), and a timer that fires only when told.
function fakeClock(...script) {
  const t0 = Date.now(), times = script.map(d => t0 + d), timers = new Map();
  let last = t0, id = 0;
  return { t0, timers,
    now: () => (last = times.length ? times.shift() : last),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: n => timers.delete(n),
    fire() { for (const [n, t] of [...timers]) { timers.delete(n); t.fn(); } } };
}

function setup({ clock = fakeClock(), verify = "ok", settle = "ok", upstream } = {}) {
  const calls = { model: 0, verify: 0, settle: 0 };
  const facilitatorClient = withFacilitatorHints({ getSupported: supported,
    verify: async () => { calls.verify++;
      if (verify === "throw") throw new Error("facilitator unreachable");
      return verify === "ok" ? { isValid: true, payer } : { isValid: false, invalidReason: verify.reason, invalidMessage: verify.message }; },
    settle: async (_p, req) => { calls.settle++;
      return settle === "ok" ? { success: true, transaction: `tx${calls.settle}`, network: req.network, payer, amount: req.amount }
        : { success: false, errorReason: settle.reason, errorMessage: settle.message, network: req.network }; },
  });
  const app = createApp(config, { facilitatorClient, log() {}, clock,
    catalogue: { resolve: async () => info, list: async () => [info], canAnswer: async () => true },
    upstream: async () => { calls.model++; return upstream ? upstream(calls) : { content: "PRIVATE ANSWER", usage: { buyer_cost_micro: 100 } }; },
    fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const send = async ({ network = SOLANA, scheme = "exact" } = {}) => {
    const post = h => request(app, "/v1/chat/completions", { method: "POST", body: JSON.stringify(BODY), headers: { "content-type": "application/json", ...h } });
    const required = decode((await post({})).headers["payment-required"]);
    const accepted = required.accepts.find(a => a.network === network && a.scheme === scheme);
    return post({ "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted,
      payload: network === SOLANA ? { transaction: "signed" }
        : { signature: "0xsig", authorization: { from: "0x" + "2".repeat(40), nonce: "0x" + "3".repeat(64) } } }) });
  };
  return { app, calls, send, clock };
}
const leaked = res => JSON.stringify(res.body).includes("PRIVATE ANSWER");
const assertWindowRefusal = res => {
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, "no_billable_answer");
  assert.equal(res.headers["retry-after"], "30");
  assert.equal(res.headers["x-singit-error"], "no_billable_answer");
  assert.match(res.body.request_id, /^req_[0-9a-f-]{36}$/);
  assert.equal(res.headers["payment-response"], undefined);
  assert.ok(!leaked(res));
};

test("the window is 20 seconds", () => assert.equal(T, 20_000));

for (const name of ["A-PREMODEL-STALE", "A-VERIFY-BLOCKHASH-STALE"]) {
  test(`${name}: a stale blockhash at verification is a 402 before the model; nothing runs or settles`, async () => {
    const s = setup({ verify: STALE });
    const res = await s.send();
    assert.equal(res.status, 402);
    assert.equal(res.body.code, "payment_blockhash_stale");
    assert.equal(res.body.action, "sign_again");
    assert.equal(s.calls.model, 0);
    assert.equal(s.calls.settle, 0);
  });
}

test("A-PREMODEL-VERIFY-NOT-SUCCESSFUL: a refused or failed verification never reaches the model, and is not called stale", async () => {
  for (const verify of [{ reason: "invalid_payload", message: "unknown refusal detail" }, "throw"]) {
    const s = setup({ verify });
    const res = await s.send();
    assert.ok(res.status >= 400, String(res.status));
    assert.notEqual(res.body?.code, "payment_blockhash_stale");
    assert.equal(s.calls.model, 0);
    assert.equal(s.calls.settle, 0);
  }
  // No recorded successful verification: the gate refuses before running anything.
  let ran = false;
  await assert.rejects(withinWindow({ cutoff: null, clock: fakeClock() }, () => { ran = true; }),
    e => e instanceof WindowExceeded && e.phase === "unverified");
  assert.equal(ran, false);
});

test("A-PREMODEL-BUDGET-EXHAUSTED: the window spent before the model call is a 503; nothing runs or settles", async () => {
  for (const spent of [T, T + 1, T * 3]) {
    const s = setup({ clock: fakeClock(0, spent) });   // verified at t0, the handler gets to the model at t0 + spent
    const res = await s.send();
    assertWindowRefusal(res);
    assert.equal(s.calls.model, 0);
    assert.equal(s.calls.settle, 0);
  }
});

test("A-FAST-SUCCESS: an answer inside the window settles once as before", async () => {
  const s = setup({ clock: fakeClock(0, 1_000) });
  const res = await s.send();
  assert.equal(res.status, 200);
  assert.equal(res.body.choices[0].message.content, "PRIVATE ANSWER");
  assert.equal(res.body.billing.mode, "exact_ceiling");
  assert.equal(s.calls.model, 1);
  assert.equal(s.calls.settle, 1);
  assert.equal(decode(res.headers["payment-response"]).transaction, "tx1");
  assert.ok(res.headers["x-singit-receipt"]);
  assert.equal(s.clock.timers.size, 0, "the cutoff timer is cleared");
});

test("A-BOUNDARY-20S: an answer just inside the window passes; at the cutoff only the refusal applies", async () => {
  const inside = setup({ clock: fakeClock(0, T - 1) });
  const ok = await inside.send();
  assert.equal(ok.status, 200);
  assert.equal(inside.calls.settle, 1);
  const at = setup({ clock: fakeClock(0, T) });
  assertWindowRefusal(await at.send());
  assert.equal(at.calls.model, 0);
  assert.equal(at.calls.settle, 0);
});

test("A-UPSTREAM-TIMEOUT: a model still answering at the cutoff is cut off; 503, one model call, no settlement", async () => {
  const clock = fakeClock(0, 1_000);
  const s = setup({ clock, upstream: () => { queueMicrotask(() => clock.fire()); return new Promise(() => {}); } });
  const res = await s.send();
  assertWindowRefusal(res);
  assert.equal(s.calls.model, 1);
  assert.equal(s.calls.settle, 0);
  const n = numbersBody(s.app.locals.healthStats);
  assert.equal(n.paid_calls.total, 0, "not counted as a settled call");
  assert.equal(n.settlement_failures.last_24h, 0, "not a settlement failure either");
});

test("A-LATE-RESPONSE-RACE: an answer that arrives after the cutoff is not returned and never settles", async () => {
  const clock = fakeClock(0, 1_000);
  let deliver;
  const s = setup({ clock, upstream: () => new Promise(resolve => {
    deliver = () => resolve({ content: "PRIVATE ANSWER", usage: { buyer_cost_micro: 100 } });
    queueMicrotask(() => { clock.fire(); queueMicrotask(deliver); });
  }) });
  const res = await s.send();
  assertWindowRefusal(res);
  await new Promise(r => setImmediate(r));
  assert.equal(s.calls.settle, 0, "no background late settlement");
});

test("A-RESPONSE-AT-CUTOFF: one gate decides; never both an answer and a refusal", async () => {
  for (const order of ["answer-first", "cutoff-first"]) {
    const clock = fakeClock(0, 1_000);
    const s = setup({ clock, upstream: () => new Promise(resolve => {
      const answer = () => resolve({ content: "PRIVATE ANSWER", usage: { buyer_cost_micro: 100 } });
      queueMicrotask(() => { if (order === "answer-first") { answer(); clock.fire(); } else { clock.fire(); answer(); } });
    }) });
    const res = await s.send();
    await new Promise(r => setImmediate(r));
    if (res.status === 200) assert.equal(s.calls.settle, 1, order);
    else { assertWindowRefusal(res); assert.equal(s.calls.settle, 0, order); }
  }
});

test("A-POST-MODEL-BLOCKHASH-NOT-FOUND: a refusal after the answer stays a visible failure, with no recovery and no new payment", async () => {
  const s = setup({ clock: fakeClock(0, 1_000), settle: STALE });
  const res = await s.send();
  assert.equal(res.status, 402);
  assert.equal(res.body.code, "payment_blockhash_stale");
  assert.equal(res.headers["x-singit-recovered"], undefined);
  assert.equal(res.body.response_held, undefined);
  assert.ok(!leaked(res));
  assert.equal(s.calls.model, 1);
  assert.equal(s.calls.settle, 1, "no automatic second settlement");
  const n = numbersBody(s.app.locals.healthStats);
  assert.equal(n.settlement_failures.last_24h, 1);
  assert.equal(n.settlement_failures_by_code.last_24h.payment_blockhash_stale, 1);
  assert.equal(n.paid_calls.total, 0);
});

test("A-PHASE-METRICS: a verification refusal is not a settlement failure; a settlement refusal is", async () => {
  const atVerify = setup({ verify: STALE });
  await atVerify.send();
  const v = numbersBody(atVerify.app.locals.healthStats);
  assert.equal(v.settlement_failures_by_code.last_24h.payment_blockhash_stale, 1);
  assert.equal(v.settlement_failures.last_24h, 0);
  const atSettle = setup({ clock: fakeClock(0, 1_000), settle: STALE });
  await atSettle.send();
  assert.equal(numbersBody(atSettle.app.locals.healthStats).settlement_failures.last_24h, 1);
  for (const n of [v, numbersBody(atSettle.app.locals.healthStats)])
    assert.ok(!JSON.stringify(n).includes(payer) && !JSON.stringify(n).includes("BlockhashNotFound"));
});

test("A-NON-SCOPE-REGRESSION: Base exact, Base upto and Solana upto do not use the window", async () => {
  for (const [network, scheme] of [[BASE, "exact"], [BASE, "upto"], [SOLANA, "upto"]]) {
    const s = setup({ clock: fakeClock(0, T * 3) });
    const res = await s.send({ network, scheme });
    assert.equal(res.status, 200, `${network} ${scheme}`);
    assert.equal(s.calls.model, 1);
    assert.equal(s.clock.timers.size, 0, "no cutoff timer");
  }
});

// The other two formats call the seller through fetchImpl (src/formats.mjs): the same window applies.
const nemotron = parseModels({ data: [JSON.parse(readFileSync(new URL("./fixtures/surplus-nemotron-3-5-lightning.json", import.meta.url)))] });
const nid = "nemotron-3.5-lightning";
for (const route of ["/v1/messages", "/v1/responses"]) {
  test(`${route}: inside the window it answers; at or past the cutoff it is a 503 without settlement`, async () => {
    for (const mode of ["fast", "spent", "timeout"]) {
      const clock = fakeClock(0, mode === "spent" ? T : 1_000);
      const calls = { seller: 0, settle: 0 };
      const facilitatorClient = withFacilitatorHints({ getSupported: supported, verify: async () => ({ isValid: true, payer }),
        settle: async (_p, req) => { calls.settle++; return { success: true, transaction: "tx", network: req.network, payer }; } });
      const catalogue = { models: nemotron, list: async () => [...nemotron.values()], resolve: async () => nemotron.get(nid), canAnswer: async () => true };
      const app = createApp({ ...config, model: "deepseek-v4.1-flash", surplusUrl: "https://surplus.invalid", surplusKey: "test" }, {
        catalogue, facilitatorClient, log() {}, clock,
        fetchImpl: async () => { calls.seller++;
          if (mode === "timeout") { queueMicrotask(() => clock.fire()); return new Promise(() => {}); }
          return Response.json({ ...(route === "/v1/messages" ? { type: "message", content: [{ type: "text", text: "hello" }] }
            : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] }), usage: { buyer_cost_micro: 1 } }); } });
      const body = JSON.stringify(route === "/v1/messages" ? { model: nid, max_tokens: 300, messages: [{ role: "user", content: "Hi" }] }
        : { model: nid, input: "Hi", max_output_tokens: 300 });
      const post = h => request(app, route, { method: "POST", body, headers: { "content-type": "application/json", ...h } });
      const required = decode((await post({})).headers["payment-required"]);
      const accepted = required.accepts.find(a => a.network === SOLANA && a.scheme === "exact");
      const res = await post({ "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted, payload: { transaction: "signed" } }) });
      if (mode === "fast") { assert.equal(res.status, 200, mode); assert.equal(calls.settle, 1); continue; }
      assert.equal(res.status, 503, mode);
      assert.equal(res.headers["x-singit-error"], "no_billable_answer");
      assert.equal(res.headers["retry-after"], "30");
      assert.match(res.body.request_id, /^req_/);
      assert.equal(calls.seller, mode === "spent" ? 0 : 1, mode);
      assert.equal(calls.settle, 0, mode);
    }
  });
}
