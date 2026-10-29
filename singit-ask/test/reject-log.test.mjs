// A refusal from Surplus is logged as one structured line: model, status, error code, the share it names as the best
// otherwise-eligible, the floor we sent, and a short sanitized body. No headers, no key, no prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { routePath } from "../src/model-routes.mjs";
import { MAX_BODY, describeReject, parseBestDiscount, sanitizeBody, withRejectLog } from "../src/reject-log.mjs";

const MESSAGE = "No seller met the minimum discount of 59%. Best otherwise-eligible estimated discount is 25.5%. Lower X-Min-Discount to buy.";

test("parseBestDiscount: the percentage from Surplus's message, null when absent", () => {
  assert.equal(parseBestDiscount(MESSAGE), 25.5);
  assert.equal(parseBestDiscount("Best otherwise-eligible estimated discount is 25%"), 25);
  assert.equal(parseBestDiscount("best otherwise-eligible estimated discount is 0%"), 0);
  assert.equal(parseBestDiscount("lower the floor"), null);
  assert.equal(parseBestDiscount(undefined), null);
});

test("describeReject: JSON error bodies and plain text", () => {
  const body = JSON.stringify({ error: { type: "not_found", code: "minimum_discount_not_met", message: MESSAGE } });
  assert.deepEqual(describeReject({ model: "claude-opus-5.5", status: 404, bodyText: body, minDiscountSent: "59" }),
    { model: "claude-opus-5.5", status: 404, code: "minimum_discount_not_met", bestDiscountPct: 25.5, minDiscountSent: 59, body: MESSAGE });
  const typed = describeReject({ model: "m", status: 503, bodyText: JSON.stringify({ error: { type: "service_unavailable", message: "none" } }) });
  assert.equal(typed.code, "service_unavailable");
  const html = describeReject({ model: undefined, status: 502, bodyText: "<html>\n  Bad gateway </html>" });
  assert.deepEqual(html, { model: null, status: 502, code: null, bestDiscountPct: null, minDiscountSent: null, body: "<html> Bad gateway </html>" });
  assert.equal(describeReject({ model: "x y\nz", status: 400, bodyText: "" }).model, null, "an odd model string is not echoed");
  assert.equal(describeReject({ model: "m", status: 404, bodyText: "{}", minDiscountSent: "59; rm" }).minDiscountSent, null);
});

test("sanitizeBody: truncated, one line, and anything shaped like a key or address is replaced", () => {
  assert.equal(sanitizeBody("a".repeat(500)), "[redacted]", "a very long unbroken run looks like a key");
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const cut = sanitizeBody(long);
  assert.equal(cut.length, MAX_BODY + 3);
  assert.ok(cut.endsWith("..."));
  const dirty = sanitizeBody("Authorization: Bearer abc.def-123 key inf_live_0123456789abcdef sk-ABCDEF123456 "
    + "0x" + "ab".repeat(20) + " 4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu\u0000\u001b[31m end");
  for (const secret of ["abc.def-123", "inf_live_0123456789abcdef", "sk-ABCDEF123456", "ab".repeat(20), "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu", "\u0000", "\u001b"])
    assert.ok(!dirty.includes(secret), `${secret} leaked: ${dirty}`);
  assert.match(dirty, /end$/);
});

test("withRejectLog logs a refused POST to Surplus once, hands the response back readable, and skips successes and other hosts", async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const answers = [
    new Response(JSON.stringify({ error: { code: "minimum_discount_not_met", message: MESSAGE } }), { status: 404 }),
    new Response("{}", { status: 200 }),
    new Response("nope", { status: 500 }),
    new Response("nope", { status: 500 }),
  ];
  const f = withRejectLog(async () => answers.shift(), { surplusUrl: "https://surplus.test", log });
  const init = { method: "POST", headers: { Authorization: "Bearer inf_secretsecretsecret", "X-Min-Discount": "59" },
    body: JSON.stringify({ model: "claude-opus-5.5", messages: [{ role: "user", content: "my private question" }] }) };
  const first = await f("https://surplus.test/v1/chat/completions", init);
  assert.equal(first.status, 404);
  assert.equal((await first.json()).error.code, "minimum_discount_not_met", "the caller can still read the body");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^singit-ask: surplus_reject \{/);
  assert.deepEqual(JSON.parse(lines[0].slice("singit-ask: surplus_reject ".length)),
    { model: "claude-opus-5.5", status: 404, code: "minimum_discount_not_met", bestDiscountPct: 25.5, minDiscountSent: 59, body: MESSAGE });
  assert.ok(!/inf_secret|Authorization|private question|Bearer/.test(lines[0]));
  await f("https://surplus.test/v1/chat/completions", init);                         // 200: nothing
  await f("https://other.test/v1/chat/completions", init);                           // another host: nothing
  await f("https://surplus.test/v1/video/generations/abc", { method: "GET" });        // a GET (polling): nothing
  assert.equal(lines.length, 1);
  assert.equal(withRejectLog(fetch, { surplusUrl: "", log }), fetch, "no Surplus URL: nothing to wrap");
});

test("a logging failure never reaches the caller", async () => {
  const f = withRejectLog(async () => ({ ok: false, status: 500, clone() { throw new Error("boom"); } }),
    { surplusUrl: "https://surplus.test", log: () => { throw new Error("log down"); } });
  const response = await f("https://surplus.test/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(response.status, 500);
});

// End to end: a paid Opus question whose floor excludes every seller.
const PAYER = "0x2222222222222222222222222222222222222222";
const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
  surplusKey: "inf_test_key_value", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash" };
const catalogue = {
  async resolve(id) {
    if (id !== "claude-opus-5.5") throw new UnknownModel("That model is not available.");
    return { id, name: id, provider: "X", contextLength: 1e6, promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6, params: ["max_tokens", "reasoning_effort", "reasoning"] };
  },
  async list() { return []; }, async canAnswer() { return true; }, guardShare: () => 0.4,
};
const facilitator = { async getSupported() { return { kinds: [
    { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
    { x402Version: 2, scheme: "exact", network: BASE },
    { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
    { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
      receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
  async verify() { return { isValid: true, payer: PAYER }; },
  async settle(_p, r) { return { success: true, transaction: "0x" + "a".repeat(64), network: r.network, payer: PAYER }; } };

test("end to end: a 404 minimum_discount_not_met on a paid Opus question logs model, status, code and the best discount", async (t) => {
  const logs = [];
  const fetchImpl = async () => new Response(JSON.stringify({ error: { type: "not_found", code: "minimum_discount_not_met", message: MESSAGE } }),
    { status: 404, headers: { "content-type": "application/json" } });
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, fetchImpl, log: (m) => logs.push(m) });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}${routePath("claude-opus-5.5")}`;
  const body = JSON.stringify({ messages: [{ role: "user", content: "a private question" }], max_tokens: 30_000 });
  const post = (headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  const unpaid = await post();
  const required = JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString());
  const accepted = required.accepts.find((a) => a.network === BASE && a.scheme === "exact");
  const paid = await post({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "0xsigned" }, extensions: required.extensions })).toString("base64") });
  assert.equal(paid.status, 503);
  const line = logs.find((l) => l.startsWith("singit-ask: surplus_reject "));
  assert.ok(line, logs.join("\n"));
  const entry = JSON.parse(line.slice("singit-ask: surplus_reject ".length));
  assert.equal(entry.model, "claude-opus-5.5");
  assert.equal(entry.status, 404);
  assert.equal(entry.code, "minimum_discount_not_met");
  assert.equal(entry.bestDiscountPct, 25.5);
  assert.equal(entry.minDiscountSent, 59);
  assert.ok(!logs.some((l) => /inf_test_key_value|a private question|Bearer|Authorization/.test(l)));
});
