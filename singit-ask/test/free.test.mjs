// Free answers ("free/<model>") and the prices in the model list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { FreeAllowance, freeAnswerCost, freeTerms, networkOf } from "../src/free.mjs";
import { UnknownModel } from "../src/catalogue.mjs";

const CONFIG = {
  payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
  surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash",
  freeModels: ["deepseek-v4.1-flash"], freeLimits: { perVisitorPerDay: 2, perDay: 3 },
};
const DEFAULT = { id: "deepseek-v4.1-flash", name: "DeepSeek", provider: "deepseek", contextLength: 1e5, promptUsdPerToken: 0.3e-6, completionUsdPerToken: 1.2e-6 };
const PRICEY = { id: "pro-model", name: "Pro", provider: "X", contextLength: 1e6, promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
const catalogue = {
  async list() { return [DEFAULT, PRICEY]; },
  async resolve(id) { const m = [DEFAULT, PRICEY].find((x) => x.id === id); if (!m) throw new UnknownModel("no"); return m; },
  async canAnswer() { return true; },
  async market() { return new Map([["pro-model", { trustedShare: 0.2 }]]); },
};

function facilitator() {
  const calls = { verify: 0, settle: 0 };
  return { calls,
    async getSupported() { return { kinds: [
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "exact", network: BASE },
          { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
          { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
        receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } } ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
    async verify() { calls.verify += 1; return { isValid: true }; },
    async settle() { calls.settle += 1; return { success: true }; } };
}

async function serve(t, { config = CONFIG, upstream } = {}) {
  const fac = facilitator();
  const asked = [];
  const answer = upstream ?? (async (_c, messages, maxTokens, _f, model) => {
    asked.push({ messages, maxTokens, model });
    return { content: "Hi!", finishReason: "stop", usage: { total_tokens: 5, buyer_cost_micro: 1 } };
  });
  const app = createApp(config, { facilitatorClient: fac, upstream: answer, log: () => {}, catalogue,
                                  observed: { share: () => null, record() {} } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, fac, asked };
}

const ask = (url, body, ip = "203.0.113.7") => fetch(`${url}${ROUTE}`, { method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) });
const FREE_Q = { model: "free/deepseek-v4.1-flash", messages: [{ role: "user", content: "Hello" }], max_tokens: 1000 };

test("a free/ question is answered with no payment, short, from the free model", async (t) => {
  const { url, fac, asked } = await serve(t);
  const response = await ask(url, FREE_Q);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-singit-free"), "true");
  assert.equal(response.headers.get("x-singit-free-remaining"), "1");
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Hi!");
  assert.equal(body.model, "free/deepseek-v4.1-flash");
  assert.deepEqual(body.billing, { free: true });
  assert.equal(asked[0].model, "deepseek-v4.1-flash");
  assert.equal(asked[0].maxTokens, 400, "free answers are kept short");
  assert.equal(fac.calls.verify, 0);
  assert.equal(fac.calls.settle, 0);
});

test("a question without the free/ prefix is still offered payment", async (t) => {
  const { url, asked } = await serve(t);
  const response = await ask(url, { messages: [{ role: "user", content: "Hello" }] });
  assert.equal(response.status, 402);
  assert.equal(asked.length, 0);
});

test("each visitor gets a few free answers a day, and everyone together a ceiling", async (t) => {
  const { url } = await serve(t);
  assert.equal((await ask(url, FREE_Q, "198.51.100.1")).status, 200);
  assert.equal((await ask(url, FREE_Q, "198.51.100.1")).status, 200);
  const third = await ask(url, FREE_Q, "198.51.100.1");
  assert.equal(third.status, 429);
  assert.match((await third.json()).error.message, /drop the free\/ prefix/);
  assert.ok(Number(third.headers.get("retry-after")) > 0);
  assert.equal((await ask(url, FREE_Q, "198.51.101.2")).status, 200, "another network still has answers");
  const fourth = await ask(url, FREE_Q, "198.51.102.3");
  assert.equal(fourth.status, 429, "today's ceiling for everyone is reached");
  assert.match((await fourth.json()).error.message, /used up/);
});

test("a free answer that does not come back is not counted", async (t) => {
  let fail = true;
  const { url } = await serve(t, { upstream: async () => {
    if (fail) { fail = false; throw new Error("down"); }
    return { content: "ok", finishReason: "stop", usage: {} };
  } });
  assert.equal((await ask(url, FREE_Q)).status, 503);
  const next = await ask(url, FREE_Q);
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("x-singit-free-remaining"), "1");
});

test("free answers refuse other models, long questions, and are off when no model is free", async (t) => {
  const { url, asked } = await serve(t);
  const other = await ask(url, { ...FREE_Q, model: "free/pro-model" });
  assert.equal(other.status, 400);
  assert.match((await other.json()).error.message, /free\/deepseek-v4\.1-flash/);
  const long = await ask(url, { ...FREE_Q, messages: [{ role: "user", content: "x".repeat(4_001) }] });
  assert.equal(long.status, 400);
  const bad = await ask(url, { ...FREE_Q, messages: [{ role: "tool", content: "x" }] });
  assert.equal(bad.status, 400);
  const { url: offUrl } = await serve(t, { config: { ...CONFIG, freeModels: [] } });
  const off = await ask(offUrl, FREE_Q);
  assert.equal(off.status, 400);
  assert.match((await off.json()).error.message, /not offered/);
  assert.equal(asked.length, 0);
});

test("the model list shows our price, the saving against list price, the fees and the free offer", async (t) => {
  const { url } = await serve(t);
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const list = await response.json();
  assert.deepEqual(list.fees, { markupPct: 30, perAnswerUsd: { [BASE]: 0.001, [SOLANA]: 0.002 } });
  assert.deepEqual(list.free, { models: ["free/deepseek-v4.1-flash"], endpoint: ROUTE, perVisitorPerDay: 2,
    maxTokens: 400, maxChars: 4000 });
  const pro = list.data.find((m) => m.id === "pro-model");
  assert.deepEqual(pro.usdPerMillionTokens, { input: 4, output: 20 });
  // Trusted sellers ask 20% of list; we add 30%: 26% of list, 74% below it.
  assert.ok(Math.abs(pro.singitUsdPerMillionTokens.output - 5.2) < 1e-9);
  assert.ok(Math.abs(pro.singitUsdPerMillionTokens.input - 1.04) < 1e-9);
  assert.equal(pro.savingsVsListPct, 74);
  const plain = list.data.find((m) => m.id === "deepseek-v4.1-flash");
  assert.equal(plain.singitUsdPerMillionTokens, undefined, "no price is claimed before one is known");
  const listedFree = list.data.filter((m) => String(m.id).startsWith("free/"));
  assert.deepEqual(listedFree, [{ id: "free/deepseek-v4.1-flash", object: "model", owned_by: "singit", free: true,
    limits: { perVisitorPerDay: 2, maxTokens: 400, maxChars: 4000 } }]);
  assert.ok(!list.data.some((m) => m.free && !String(m.id).startsWith("free/")), "paid models are not marked free");
});

test("the discovery documents mention the free offer and are readable from a browser", async (t) => {
  const { url } = await serve(t);
  const openapi = await fetch(`${url}/openapi.json`);
  assert.equal(openapi.headers.get("access-control-allow-origin"), "*");
  assert.match((await openapi.json()).info.description, /free\/deepseek-v4\.1-flash/);
  const wellKnown = await fetch(`${url}/.well-known/x402`);
  assert.equal(wellKnown.headers.get("access-control-allow-origin"), "*");
  assert.match((await wellKnown.json()).instructions, /Free to try/);
});

test("FreeAllowance starts each UTC day afresh and never counts below zero", () => {
  let now = Date.UTC(2026, 9, 14, 23, 59);
  const allowance = new FreeAllowance(freeTerms({ freeModels: ["m"], freeLimits: { perVisitorPerDay: 1, perDay: 5 } }), () => now);
  assert.equal(allowance.take("a").ok, true);
  allowance.done();
  assert.equal(allowance.take("a").reason, "visitor");
  now = Date.UTC(2026, 9, 15, 0, 1);
  assert.equal(allowance.take("a").ok, true);
  allowance.done();
  allowance.giveBack("b");
  assert.equal(allowance.total, 0);
});

test("networkOf counts an IPv4 /24 and an IPv6 /64 as one visitor, and an IPv4-mapped address as its IPv4 network", () => {
  assert.equal(networkOf("203.0.113.7"), "203.0.113.0/24");
  assert.equal(networkOf("203.0.113.250"), "203.0.113.0/24");
  assert.notEqual(networkOf("203.0.114.7"), networkOf("203.0.113.7"));
  assert.equal(networkOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(networkOf("2001:db8:1:2::1"), networkOf("2001:DB8:1:2:ffff::9"));
  assert.notEqual(networkOf("2001:db8:1:3::1"), networkOf("2001:db8:1:2::1"));
  assert.equal(networkOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(networkOf("::ffff:203.0.113.7"), "203.0.113.0/24");
  assert.equal(networkOf("::ffff:cb00:7107"), "203.0.113.0/24");
  assert.equal(networkOf("[2001:db8:1:2::5]"), "2001:db8:1:2::/64");
  assert.equal(networkOf("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(networkOf(undefined), "unknown");
  assert.equal(networkOf("not-an-ip"), "not-an-ip");
});

test("rotating addresses inside one network does not multiply the free allowance", async (t) => {
  const { url } = await serve(t, { config: { ...CONFIG, freeLimits: { perVisitorPerDay: 2, perDay: 50 } } });
  assert.equal((await ask(url, FREE_Q, "198.51.100.1")).status, 200);
  assert.equal((await ask(url, FREE_Q, "198.51.100.200")).status, 200);
  assert.equal((await ask(url, FREE_Q, "198.51.100.77")).status, 429);
  assert.equal((await ask(url, FREE_Q, "::ffff:198.51.100.9")).status, 429, "an IPv4-mapped address is the same network");
  assert.equal((await ask(url, FREE_Q, "198.51.101.1")).status, 200, "the next /24 is another network");
  assert.equal((await ask(url, FREE_Q, "2001:db8:5:5::1")).status, 200);
  assert.equal((await ask(url, FREE_Q, "2001:db8:5:5::2")).status, 200);
  assert.equal((await ask(url, FREE_Q, "2001:db8:5:5:9::2")).status, 429, "same /64, third answer");
  assert.equal((await ask(url, FREE_Q, "2001:db8:5:6::1")).status, 200, "the next /64 is another network");
});

const BUDGET_CONFIG = { ...CONFIG, freeLimits: { perVisitorPerDay: 50, perDay: 50 }, freeBudgetUsdPerDay: 0.000003 };

test("with no budget configured, nothing about spending is checked", async (t) => {
  assert.equal(freeTerms(CONFIG).budgetUsdPerDay, undefined);
  const { url } = await serve(t, { upstream: async () => ({ content: "x", finishReason: "stop", usage: null }) });
  assert.equal((await ask(url, FREE_Q)).status, 200, "an answer with no usage is fine without a budget");
});

test("a daily budget counts each answer's reported cost and refuses with Retry-After once it is spent", async (t) => {
  const { url, asked } = await serve(t, { config: BUDGET_CONFIG, upstream: async () =>
    ({ content: "x", finishReason: "stop", usage: { buyer_cost_micro: 2 } }) });
  assert.equal((await ask(url, FREE_Q, "198.51.100.1")).status, 200);
  assert.equal((await ask(url, FREE_Q, "192.0.2.1")).status, 200, "4 micro-USDC spent of 3: the budget was reached by this answer");
  const refused = await ask(url, FREE_Q, "203.0.113.1");
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.match((await refused.json()).error.message, /used up/);
  assert.equal(asked.length, 0);
});

test("without a reported cost, an answer counts at the model's list price for its worst case", () => {
  const input = { chars: 400, messages: [{}] };
  // One token per character (the loosest bound): (400 + 4) input tokens at 0.3e-6 and 400 output tokens at 1.2e-6
  // = 0.0006012 USD, rounded up to micro-units.
  assert.equal(freeAnswerCost(null, DEFAULT, input, 400), 602);
  assert.equal(freeAnswerCost({ buyer_cost_micro: 7 }, DEFAULT, input, 400), 7, "a reported cost wins");
  assert.equal(freeAnswerCost({ buyer_cost_micro: -1 }, DEFAULT, input, 400), 602, "an invalid report is not trusted");
  assert.equal(freeAnswerCost(null, null, input, 400), null, "no price at all");
});

test("with a budget and a model whose price is unknown, nothing is answered or spent", async (t) => {
  const unpriced = { ...catalogue, async resolve() { throw new UnknownModel("no"); } };
  const fac = facilitator();
  let called = 0;
  const app = createApp(BUDGET_CONFIG, { facilitatorClient: fac, upstream: async () => { called += 1; return { content: "x", usage: null }; },
    log: () => {}, catalogue: unpriced, observed: { share: () => null, record() {} } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const response = await ask(`http://127.0.0.1:${listener.address().port}`, FREE_Q);
  assert.equal(response.status, 503);
  assert.equal(called, 0);
});

test("the OpenAPI document and the discovery listing say the free/ prefix is accepted", async (t) => {
  const { url } = await serve(t);
  const doc = await (await fetch(`${url}/openapi.json`)).json();
  const post = doc.paths[ROUTE].post;
  assert.match(post.description, /free\/deepseek-v4\.1-flash/);
  assert.deepEqual(post["x-free-models"], [{ id: "free/deepseek-v4.1-flash", object: "model", owned_by: "singit", free: true,
    limits: { perVisitorPerDay: 2, maxTokens: 400, maxChars: 4000 } }]);
  assert.match(post.requestBody.content["application/json"].schema.properties.model.description, /free\/deepseek-v4\.1-flash/);
  const off = await (await fetch(`${(await serve(t, { config: { ...CONFIG, freeModels: [] } })).url}/openapi.json`)).json();
  assert.equal(off.paths[ROUTE].post["x-free-models"], undefined);
  assert.doesNotMatch(off.paths[ROUTE].post.requestBody.content["application/json"].schema.properties.model.description, /Free/);
});
