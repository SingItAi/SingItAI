// SI-62: what /v1/chat/{model} does with Surplus's refusals, seen on 25 October for five models: a price floor that
// excluded every seller (404 minimum_discount_not_met), no healthy seller (503), a parameter the model does not take
// (400 request_rejected on temperature), and a reasoning model that spent max_tokens thinking (200, no text). The
// payer is never charged for any of them, and the "not charged" JSON must survive Cloudflare (503, never 502).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { routePath } from "../src/model-routes.mjs";

const PAYER = "0x2222222222222222222222222222222222222222";
const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
  surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash" };
const CHAT_PARAMS = ["max_tokens", "temperature", "reasoning_effort", "reasoning"];
// Shaped like Surplus's /v1/models rows (catalogue.mjs keeps supported_parameters as `params`).
const MODELS = {
  "kimi-k3": { promptUsdPerToken: 0.24e-6, completionUsdPerToken: 10.8e-6, params: ["max_tokens", "reasoning_effort", "reasoning"] },
  "glm-5.3": { promptUsdPerToken: 0.08e-6, completionUsdPerToken: 1.4e-6, params: CHAT_PARAMS },
  "claude-opus-5.5": { promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6, params: ["max_tokens", "reasoning_effort", "reasoning"] },
  "deepseek-v4-pro": { promptUsdPerToken: 0.21e-6, completionUsdPerToken: 0.42e-6, params: ["max_tokens", "temperature", "reasoning"] },
  "grok-4.7": { promptUsdPerToken: 2e-6, completionUsdPerToken: 10e-6 },  // no params known: sent as before
};
const catalogue = {
  async resolve(id) {
    const m = MODELS[id];
    if (!m) throw new UnknownModel("That model is not available.");
    return { id, name: id, provider: "X", contextLength: 1e6, ...m };
  },
  async list() { return []; }, async canAnswer() { return true; },
  guardShare: (id) => ({ "glm-5.3": 0.0092, "claude-opus-5.5": 0.4 })[id] ?? null,
};

function facilitator() {
  const settled = [];
  return { settled,
    async getSupported() { return { kinds: [
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
      { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
        receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
    async verify() { return { isValid: true, payer: PAYER }; },
    async settle(_p, r) { settled.push(r.amount); return { success: true, transaction: "0x" + "a".repeat(64), network: r.network, payer: PAYER }; },
  };
}

// `surplus(body, headers)` answers one Surplus call: [status, json, headers?].
async function serve(t, surplus) {
  const calls = [], logs = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ headers: init.headers, body });
    const [status, json, headers = {}] = surplus(body, calls.length);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });
  };
  const fac = facilitator();
  const app = createApp(CONFIG, { facilitatorClient: fac, catalogue, fetchImpl, log: (m) => logs.push(m) });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, calls, logs, settled: fac.settled };
}

const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
async function payExact(url, model, maxTokens = 16) {
  const body = { messages: [{ role: "user", content: "Say hi in three words." }], max_tokens: maxTokens };
  const post = (headers = {}) => fetch(`${url}${routePath(model)}`, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const unpaid = await post();
  assert.equal(unpaid.status, 402);
  const required = decode(unpaid.headers.get("payment-required"));
  const accepted = required.accepts.find((a) => a.network === BASE && a.scheme === "exact");
  return post({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "0xsigned" }, extensions: required.extensions })).toString("base64") });
}

const OK = [200, { choices: [{ message: { content: "Hi there friend" }, finish_reason: "stop" }], usage: { buyer_cost_micro: 3 } }];

test("a floor that excludes every seller is a 503 with Retry-After and JSON, and nothing is settled", async (t) => {
  const s = await serve(t, () => [404, { error: { type: "not_found", code: "minimum_discount_not_met", message: "lower the floor" } }]);
  // Big enough that list price does not fit what was paid, so the floor is still sent.
  const paid = await payExact(s.url, "claude-opus-5.5", 30_000);
  assert.equal(paid.status, 503);
  assert.equal(paid.headers.get("retry-after"), "30");
  assert.match(paid.headers.get("content-type"), /application\/json/);
  const body = await paid.json();
  assert.equal(body.error.code, "no_billable_answer");
  assert.match(body.error.message, /not charged/);
  assert.equal(s.calls[0].headers["X-Min-Discount"], "59");
  assert.deepEqual(s.settled, []);
  assert.ok(s.logs.some((l) => /claude-opus-5\.5 no billable answer .*HTTP 404 \(minimum_discount_not_met\)/.test(l)), s.logs.join("\n"));
  assert.ok(!s.logs.filter((l) => /no billable answer/.test(l)).some((l) => /lower the floor/.test(l)), "the 'no billable answer' line stays free of Surplus's text");
  assert.ok(s.logs.some((l) => l.startsWith("singit-ask: surplus_reject ") && /"code":"minimum_discount_not_met"/.test(l)), "the refusal has its own structured line (reject-log.test.mjs)");
});

test("no floor is sent when the model's worst case at list price fits what was paid", async (t) => {
  const s = await serve(t, () => OK);
  const paid = await payExact(s.url, "glm-5.3", 16);
  assert.equal(paid.status, 200);
  assert.equal(s.calls[0].headers["X-Min-Discount"], undefined);
  assert.equal(s.settled.length, 1);
});

test("temperature and reasoning_effort go only to models that list them; unknown params keep the old request", async (t) => {
  const s = await serve(t, () => OK);
  assert.equal((await payExact(s.url, "kimi-k3")).status, 200);
  assert.equal("temperature" in s.calls.at(-1).body, false);
  assert.equal(s.calls.at(-1).body.reasoning_effort, "none");
  assert.equal((await payExact(s.url, "deepseek-v4-pro")).status, 200);
  assert.equal(s.calls.at(-1).body.temperature, 0.4);
  assert.equal("reasoning_effort" in s.calls.at(-1).body, false);
  assert.equal((await payExact(s.url, "grok-4.7")).status, 200);
  assert.equal(s.calls.at(-1).body.temperature, 0.4);
  assert.equal(s.calls.at(-1).body.reasoning_effort, "none");
});

test("HTTP 200 carrying an error body (a long request) is a failure, not an answer", async (t) => {
  const s = await serve(t, () => [200, { error: { type: "service_unavailable", code: "no_healthy_sellers", message: "x" } }]);
  const paid = await payExact(s.url, "glm-5.3");
  assert.equal(paid.status, 503);
  assert.equal(paid.headers.get("retry-after"), "30");
  assert.deepEqual(s.settled, []);
});

test("a reasoning model that spent max_tokens thinking is a 422 asking for more max_tokens, not charged", async (t) => {
  const s = await serve(t, () => [200, { choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { buyer_cost_micro: 0 } }]);
  const paid = await payExact(s.url, "deepseek-v4-pro");
  assert.equal(paid.status, 422);
  const error = (await paid.json()).error;
  assert.equal(error.code, "max_tokens_too_small");
  assert.match(error.message, /reasoning.*Raise max_tokens.*1000.*not charged/);
  assert.deepEqual(s.settled, []);
});

test("the cost is read from x-si-buyer-cost-micro when the body's usage lacks it", async (t) => {
  const s = await serve(t, () => [200, { choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: { total_tokens: 9 } },
    { "x-si-buyer-cost-micro": "7" }]);
  const paid = await payExact(s.url, "glm-5.3");
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).usage.buyer_cost_micro, "7");
  assert.equal(s.settled.length, 1);
});

test("no route answers an upstream failure with 502 (Cloudflare would replace its body)", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    const code = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(code, /status\(\s*(?:[^()]*\?\s*)?502\b|:\s*502\)/, file);
  }
});

test("ModelCatalogue keeps each model's supported_parameters as params", async () => {
  const { ModelCatalogue } = await import("../src/catalogue.mjs");
  const row = { id: "kimi-k3", name: "Kimi K3", provider: "Moonshot", context_length: 1e6,
    pricing: { prompt: "0.00000024", completion: "0.0000108" }, architecture: { modality: "text->text" },
    supported_parameters: ["max_tokens", "reasoning_effort"] };
  const c = new ModelCatalogue({ url: "https://surplus.test", fetchImpl: async () => new Response(JSON.stringify({ data: [row] })) });
  assert.deepEqual((await c.resolve("kimi-k3")).params, ["max_tokens", "reasoning_effort"]);
});

test("a normally stopped empty chat answer remains 503 and is not settled", async (t) => {
  const s = await serve(t, () => [200, { choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { buyer_cost_micro: 1 } }]);
  const paid = await payExact(s.url, "deepseek-v4-pro");
  assert.equal(paid.status, 503);
  assert.equal((await paid.json()).error.code, "no_billable_answer");
  assert.deepEqual(s.settled, []);
});
