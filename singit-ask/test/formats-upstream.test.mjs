// SI-62 follow-up: /v1/messages and /v1/responses handle Surplus's refusals the way /v1/chat/{model} does (#75):
// the price floor only when needed, parameters a model does not take dropped, 422 when reasoning used the whole
// budget, and every not-charged failure a 503 with Retry-After (never 502, which Cloudflare replaces).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { fitRequest, spentOnReasoning } from "../src/formats.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
const MODELS = {
  "kimi-k3": { promptUsdPerToken: 0.24e-6, completionUsdPerToken: 10.8e-6, params: ["max_tokens", "reasoning_effort", "reasoning"] },
  "claude-opus-5.5": { promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6, params: ["max_tokens", "reasoning_effort"] },
  "gpt-5.5": { promptUsdPerToken: 1.25e-6, completionUsdPerToken: 10e-6 },  // no list: request kept as it came
};
const catalogue = {
  async resolve(id) { const m = MODELS[id]; if (!m) throw new UnknownModel("no"); return { id, name: id, provider: "x", contextLength: 1e6, ...m }; },
  async canAnswer() { return true; }, async list() { return []; },
  guardShare: (id) => ({ "kimi-k3": 0.005, "claude-opus-5.5": 0.4 })[id] ?? null,
};
const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

async function serve(t, answer) {
  const settled = [], calls = [], logs = [];
  const facilitator = {
    async getSupported() { return { kinds: [
      { x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
        receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_p, r) { settled.push(r.amount); return { success: true, transaction: "0x" + "a".repeat(64), network: r.network }; },
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const [status, json, headers = {}] = answer(url);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });
  };
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, fetchImpl, log: (m) => logs.push(m),
    upstream: async () => { throw new Error("the chat route is not asked"); } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, settled, calls, logs };
}

async function payExact(url, route, body) {
  const post = (h = {}) => fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
  const unpaid = await post();
  assert.equal(unpaid.status, 402);
  const required = decode(unpaid.headers.get("payment-required"));
  const accepted = required.accepts.find((a) => a.network === BASE && a.scheme === "exact");
  return post({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource, accepted, payload: { signature: "0xsigned" }, extensions: required.extensions }) });
}

const message = (model, max_tokens = 16, extra = {}) => ({ model, max_tokens, messages: [{ role: "user", content: "Say hi." }], ...extra });
const response = (model, max_output_tokens = 16, extra = {}) => ({ model, input: "Say hi.", max_output_tokens, ...extra });
const MSG_OK = [200, { type: "message", role: "assistant", content: [{ type: "text", text: "Hi there" }], stop_reason: "end_turn", usage: { buyer_cost_micro: 3 } }];
const RESP_OK = [200, { object: "response", status: "completed", error: null, output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }], usage: { buyer_cost_micro: 3 } }];

for (const [route, body, ok] of [["/v1/messages", message, MSG_OK], ["/v1/responses", response, RESP_OK]]) {
  test(`${route}: no price floor when list price fits what was paid; the floor stays for a large request`, async (t) => {
    const s = await serve(t, () => ok);
    assert.equal((await payExact(s.url, route, body("kimi-k3"))).status, 200);
    assert.equal(s.calls.at(-1).headers["X-Min-Discount"], undefined);
    assert.equal((await payExact(s.url, route, body("claude-opus-5.5", 30_000))).status, 200);
    assert.equal(s.calls.at(-1).headers["X-Min-Discount"], "59");
  });

  test(`${route}: a floor that excludes every seller is a 503 with Retry-After and JSON, nothing settled`, async (t) => {
    const s = await serve(t, () => [404, { error: { type: "not_found", code: "minimum_discount_not_met", message: "lower it" } }]);
    const paid = await payExact(s.url, route, body("claude-opus-5.5", 30_000));
    assert.equal(paid.status, 503);
    assert.equal(paid.headers.get("retry-after"), "30");
    assert.match(JSON.stringify(await paid.json()), /not charged/);
    assert.deepEqual(s.settled, []);
    assert.ok(s.logs.some((l) => l.includes(`${route} claude-opus-5.5 no billable answer`) && l.includes("(minimum_discount_not_met)")), s.logs.join("\n"));
    assert.ok(!s.logs.filter((l) => l.includes("no billable answer")).some((l) => l.includes("lower it")));
    assert.ok(s.logs.some((l) => l.startsWith("singit-ask: surplus_reject ") && l.includes('"status":404')), s.logs.join("\n"));
  });

  test(`${route}: HTTP 200 with an error body is a 503, not an answer that gets charged`, async (t) => {
    const s = await serve(t, () => [200, route === "/v1/messages"
      ? { type: "error", error: { type: "overloaded_error", message: "x" } }
      : { error: { type: "service_unavailable", code: "no_healthy_sellers", message: "x" } }]);
    const paid = await payExact(s.url, route, body("kimi-k3"));
    assert.equal(paid.status, 503);
    assert.deepEqual(s.settled, []);
  });

  test(`${route}: a network error or timeout answers 503 with Retry-After, never 502, nothing settled`, async (t) => {
    const s = await serve(t, () => { throw Object.assign(new Error("fetch failed"), { name: "AbortError" }); });
    const paid = await payExact(s.url, route, body("kimi-k3"));
    assert.equal(paid.status, 503);
    assert.equal(paid.headers.get("retry-after"), "30");
    assert.match(JSON.stringify(await paid.json()), /not charged/);
    assert.deepEqual(s.settled, []);
  });

  test(`${route}: parameters the model does not list are dropped; a model with no list keeps them`, async (t) => {
    const s = await serve(t, () => ok);
    assert.equal((await payExact(s.url, route, body("kimi-k3", 16, { temperature: 0.4, top_p: 0.9 }))).status, 200);
    assert.equal("temperature" in s.calls.at(-1).body, false);
    assert.equal("top_p" in s.calls.at(-1).body, false);
    assert.equal((await payExact(s.url, route, body("gpt-5.5", 16, { temperature: 0.4 }))).status, 200);
    assert.equal(s.calls.at(-1).body.temperature, 0.4);
  });
}

test("/v1/messages: thinking that used every token is a 422 in Anthropic's envelope, not charged", async (t) => {
  const s = await serve(t, () => [200, { type: "message", content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { buyer_cost_micro: 1 } }]);
  const paid = await payExact(s.url, "/v1/messages", message("kimi-k3"));
  assert.equal(paid.status, 422);
  const j = await paid.json();
  assert.equal(j.type, "error");
  assert.equal(j.error.type, "invalid_request_error");
  assert.deepEqual(s.settled, []);
});

test("/v1/responses: incomplete on max_output_tokens with no text is a 422 max_tokens_too_small, not charged", async (t) => {
  const s = await serve(t, () => [200, { object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "reasoning", summary: [] }], usage: { buyer_cost_micro: 1 } }]);
  const paid = await payExact(s.url, "/v1/responses", response("kimi-k3"));
  assert.equal(paid.status, 422);
  assert.equal((await paid.json()).error.code, "max_tokens_too_small");
  assert.deepEqual(s.settled, []);
});

test("a cut-off answer that has some text is still an answer", () => {
  assert.equal(spentOnReasoning("/v1/messages", { stop_reason: "max_tokens", content: [{ type: "text", text: "Hi th" }] }), false);
  assert.equal(spentOnReasoning("/v1/responses", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }] }), false);
  assert.deepEqual(fitRequest({ model: "m", temperature: 1 }, undefined), { model: "m", temperature: 1 });
});

test("/v1/messages: a completed tool call with no text and max_tokens is still a billable answer", async (t) => {
  const s = await serve(t, () => [200, { type: "message", role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Lyon" } }],
    stop_reason: "max_tokens", usage: { buyer_cost_micro: 3 } }]);
  const paid = await payExact(s.url, "/v1/messages", message("kimi-k3"));
  assert.equal(paid.status, 200);
  assert.ok(s.settled.length > 0);
});

test("/v1/responses: a completed function_call with no output_text and incomplete is still a billable answer", async (t) => {
  const s = await serve(t, () => [200, { object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Lyon\"}" }],
    usage: { buyer_cost_micro: 3 } }]);
  const paid = await payExact(s.url, "/v1/responses", response("kimi-k3"));
  assert.equal(paid.status, 200);
  assert.ok(s.settled.length > 0);
});
