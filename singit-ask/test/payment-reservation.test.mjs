// One payment, one answer at a time (src/payment-reservation.mjs): identical copies of a signed payment sent while
// the first is in flight are refused before verification. Stub facilitator and seller: no network, keys or payments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "./helpers/http-request.mjs";
import { withFacilitatorHints } from "../src/facilitator-hints.mjs";
import { createApp, BASE, SOLANA } from "../src/app.mjs";
import { parseModels } from "../src/catalogue.mjs";
import { reservations } from "../src/media-payment-replay.mjs";
import { chatPaymentKey, bodyHash } from "../src/payment-reservation.mjs";

const payer = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const config = { model: "test", payToBase: "0x" + "1".repeat(40), payToSolana: payer, exaKey: "fake-test" };
const encode = v => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = v => JSON.parse(Buffer.from(v, "base64"));
const info = { id: "test", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000001 };
const BODY = { model: "test", messages: [{ role: "user", content: "hello" }], max_tokens: 100 };
const supported = async () => ({ kinds: [BASE, SOLANA].flatMap(n => ["upto", "exact"].map(s => ({ x402Version: 2, network: n, scheme: s,
  extra: { feePayer: payer, receiverAuthorizer: payer, facilitatorAddress: "0x" + "2".repeat(40) } }))), extensions: [], signers: {} });

// A seller that answers only when told, so copies can pile up behind the first request.
function gate() { let open; const opened = new Promise(r => { open = r; }); return { opened, open }; }

function setup({ upstream } = {}) {
  const calls = { model: 0, verify: 0, settle: 0 };
  const facilitatorClient = withFacilitatorHints({ getSupported: supported,
    verify: async () => { calls.verify++; return { isValid: true, payer }; },
    settle: async (_p, req) => { calls.settle++; return { success: true, transaction: `tx${calls.settle}`, network: req.network, payer, amount: req.amount }; } });
  const app = createApp(config, { facilitatorClient, log() {},
    catalogue: { resolve: async () => info, list: async () => [info], canAnswer: async () => true },
    upstream: async () => { calls.model++; return upstream ? upstream(calls) : { content: "ANSWER", usage: { buyer_cost_micro: 100 } }; },
    fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const post = (headers, body = BODY) => request(app, "/v1/chat/completions", { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers } });
  const sign = async ({ network = SOLANA, scheme = "exact", tx = "signed-1", body = BODY } = {}) => {
    const required = decode((await post({}, body)).headers["payment-required"]);
    const accepted = required.accepts.find(a => a.network === network && a.scheme === scheme);
    return { "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted,
      // The payload shape test/payment-codes.test.mjs uses for both Base schemes.
      payload: network === SOLANA ? { transaction: tx }
        : { signature: "fake", authorization: { from: "0x" + "2".repeat(40), nonce: "0x" + "3".repeat(64) }, transaction: "fake" } }) };
  };
  return { app, calls, post, sign };
}
const assertDuplicate = res => {
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "payment_duplicate");
  assert.equal(res.body.action, "retry_same_payment");
  assert.match(res.body.request_id, /^req_[0-9a-f-]{36}$/);
  assert.equal(res.headers["x-singit-error"], "payment_duplicate");
  assert.equal(res.headers["retry-after"], "1");
  assert.match(String(res.headers["cache-control"]), /no-store/);
  assert.equal(res.headers["payment-response"], undefined);
};

for (const n of [2, 20, 100]) {
  test(`B1-CONCURRENT-${n}: identical copies of one payment reach the model once; the others get 409 before verification`, async () => {
    const g = gate();
    const s = setup({ upstream: async () => { await g.opened; return { content: "ANSWER", usage: { buyer_cost_micro: 100 } }; } });
    const header = await s.sign();
    const results = Array.from({ length: n }, () => s.post(header));
    const settledEarly = [];
    for (const p of results) p.then(r => settledEarly.push(r));
    while (settledEarly.length < n - 1) await new Promise(r => setImmediate(r));   // the copies are refused while the first waits
    assert.equal(s.calls.model, 1);
    g.open();
    const all = await Promise.all(results);
    assert.equal(all.filter(r => r.status === 200).length, 1);
    for (const r of all.filter(r => r.status !== 200)) assertDuplicate(r);
    assert.equal(s.calls.model, 1, "one model call");
    assert.equal(s.calls.verify, 1, "duplicates add no verification");
    assert.equal(s.calls.settle, 1, "duplicates add no settlement");
    assert.equal(reservations.size, 0, "released once answered");
  });
}

test("B1-UPSTREAM-NO-CHARGE-FAIL: a no-charge failure releases the payment; the documented retry is not a duplicate", async () => {
  let fail = true;
  const s = setup({ upstream: async () => { if (fail) { fail = false; throw Object.assign(new Error("model answered HTTP 503"), { name: "UpstreamError", status: 503, code: "upstream_error" }); }
    return { content: "ANSWER", usage: { buyer_cost_micro: 100 } }; } });
  const header = await s.sign();
  const first = await s.post(header);
  assert.equal(first.status, 503);
  assert.equal(s.calls.settle, 0);
  assert.equal(reservations.size, 0);
  const retry = await s.post(header);
  assert.notEqual(retry.status, 409);
  assert.equal(retry.status, 200);
  assert.equal(s.calls.model, 2);
});

test("B1-SAME-PAYMENT-DIFFERENT-BODY: no shared reservation between different requests", async () => {
  const g = gate();
  const s = setup({ upstream: async () => { await g.opened; return { content: "ANSWER", usage: { buyer_cost_micro: 100 } }; } });
  const header = await s.sign();
  // Same length, so the same price: the one signed payment fits both, and only the reservation could tell them apart.
  const other = { ...BODY, messages: [{ role: "user", content: "jello" }] };
  const a = s.post(header), b = s.post(header, other);
  while (s.calls.model < 2) await new Promise(r => setImmediate(r));
  g.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.notEqual(ra.status, 409);
  assert.notEqual(rb.status, 409);
  assert.equal(s.calls.model, 2);
});

test("B1-SAME-PAYMENT-DIFFERENT-ROUTE/NETWORK: the key binds the route, the network and the canonical body", () => {
  const payment = { x402Version: 2, accepted: { network: SOLANA, scheme: "exact" }, payload: { transaction: "signed-1" } };
  const k = chatPaymentKey(payment, "/v1/chat/completions", BODY);
  assert.notEqual(chatPaymentKey(payment, "/v1/messages", BODY), k);
  assert.notEqual(chatPaymentKey(payment, "/v1/chat/claude-haiku-5.5", BODY), k);
  assert.notEqual(chatPaymentKey({ ...payment, accepted: { network: BASE, scheme: "exact" } }, "/v1/chat/completions", BODY), k);
  assert.notEqual(chatPaymentKey(payment, "/v1/chat/completions", { ...BODY, max_tokens: 101 }), k);
  assert.equal(chatPaymentKey(payment, "/v1/chat/completions", { max_tokens: 100, messages: BODY.messages, model: "test" }), k,
    "object key order does not matter (RFC 8785)");
  assert.notEqual(bodyHash({ a: [1, 2] }), bodyHash({ a: [2, 1] }), "array order does");
  assert.ok(!k.includes("signed-1") && /^chat:[0-9a-f]{64}$/.test(k), "only a hash is kept");
});

test("B1-TOPOLOGY: one process shares one reservation table across app instances", async () => {
  // deploy/singit-ask.service runs one process; this is the guarantee claimed. Multiple processes would each have
  // their own table and are not protected.
  const g = gate();
  const one = setup({ upstream: async () => { await g.opened; return { content: "ANSWER", usage: { buyer_cost_micro: 100 } }; } });
  const two = setup();
  const header = await one.sign();
  const first = one.post(header);
  while (one.calls.model < 1) await new Promise(r => setImmediate(r));
  const copy = await two.post(header);
  assertDuplicate(copy);
  assert.equal(two.calls.verify, 0);
  g.open();
  assert.equal((await first).status, 200);
});

test("after the answer, the payment is released: a later replay is the facilitator's to refuse, as before", async () => {
  const s = setup();
  const header = await s.sign();
  assert.equal((await s.post(header)).status, 200);
  assert.equal(reservations.size, 0);
  const again = await s.post(header);
  assert.notEqual(again.status, 409, "payment_duplicate only means in flight");
});

test("Base exact and upto copies are refused the same way", async () => {
  for (const scheme of ["exact", "upto"]) {
    const g = gate();
    const s = setup({ upstream: async () => { await g.opened; return { content: "ANSWER", usage: { buyer_cost_micro: 100 } }; } });
    const header = await s.sign({ network: BASE, scheme });
    const first = s.post(header);
    while (s.calls.model < 1) await new Promise(r => setImmediate(r));
    assertDuplicate(await s.post(header));
    g.open();
    assert.equal((await first).status, 200, scheme);
    assert.equal(s.calls.settle, 1);
  }
});

const nemotron = parseModels({ data: [JSON.parse(readFileSync(new URL("./fixtures/surplus-nemotron-3-5-lightning.json", import.meta.url)))] });
const nid = "nemotron-3.5-lightning";
for (const route of ["/v1/messages", "/v1/responses"]) {
  test(`B1-CONCURRENT on ${route}: one seller call; the copy gets 409 in this format's envelope`, async () => {
    const g = gate(), calls = { seller: 0, verify: 0, settle: 0 };
    const facilitatorClient = withFacilitatorHints({ getSupported: supported, verify: async () => { calls.verify++; return { isValid: true, payer }; },
      settle: async (_p, req) => { calls.settle++; return { success: true, transaction: "tx", network: req.network, payer }; } });
    const catalogue = { models: nemotron, list: async () => [...nemotron.values()], resolve: async () => nemotron.get(nid), canAnswer: async () => true };
    const app = createApp({ ...config, model: "deepseek-v4.1-flash", surplusUrl: "https://surplus.invalid", surplusKey: "test" }, {
      catalogue, facilitatorClient, log() {},
      fetchImpl: async () => { calls.seller++; await g.opened; return Response.json({ ...(route === "/v1/messages"
        ? { type: "message", content: [{ type: "text", text: "hello" }] }
        : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] }), usage: { buyer_cost_micro: 1 } }); } });
    const body = JSON.stringify(route === "/v1/messages" ? { model: nid, max_tokens: 300, messages: [{ role: "user", content: "Hi" }] }
      : { model: nid, input: "Hi", max_output_tokens: 300 });
    const post = h => request(app, route, { method: "POST", body, headers: { "content-type": "application/json", ...h } });
    const required = decode((await post({})).headers["payment-required"]);
    const accepted = required.accepts.find(a => a.network === SOLANA && a.scheme === "exact");
    const header = { "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted, payload: { transaction: "signed" } }) };
    const first = post(header);
    while (calls.seller < 1) await new Promise(r => setImmediate(r));
    const copy = await post(header);
    assert.equal(copy.status, 409);
    assert.equal(copy.body.error.code, "payment_duplicate");
    if (route === "/v1/messages") assert.equal(copy.body.type, "error", "Anthropic envelope");
    assert.equal(copy.headers["x-singit-error"], "payment_duplicate");
    assert.equal(copy.body.action, "retry_same_payment");
    g.open();
    assert.equal((await first).status, 200);
    assert.deepEqual(calls, { seller: 1, verify: 1, settle: 1 });
  });
}

test("a payment that cannot be keyed (malformed network) gets the middleware's usual 402, not a reservation error", async () => {
  const s = setup();
  const required = decode((await s.post({})).headers["payment-required"]);
  const accepted = { ...required.accepts.find(a => a.network === BASE && a.scheme === "exact"), network: "eip155:not-a-chain-id" };
  const header = { "payment-signature": encode({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "fake", authorization: { from: "0x" + "2".repeat(40), nonce: "0x" + "3".repeat(64) }, transaction: "fake" } }) };
  const res = await s.post(header);
  assert.equal(res.status, 402);
  assert.notEqual(res.body?.error?.code, "upstream_unavailable");
  assert.deepEqual([s.calls.verify, s.calls.model, s.calls.settle], [0, 0, 0]);
  assert.equal(reservations.size, 0, "nothing reserved");
});
