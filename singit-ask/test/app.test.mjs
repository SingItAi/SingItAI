// SingIt Ask against a fake CDP facilitator and a fake model: who is charged, when, and for what.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { BASE, SOLANA, ROUTE, LIMITS, THINKING_HEADROOM, RequestError, UpstreamError, readRequest, askSurplus, createApp } from "../src/app.mjs";
import { SOLANA_TERMS, TERMS, ceilingAtomic, billUsage } from "../src/pricing.mjs";
import { ModelCatalogue, UnknownModel } from "../src/catalogue.mjs";

const SOLANA_PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BASE_PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const CONFIG = {
  payToSolana: SOLANA_PAY_TO, payToBase: BASE_PAY_TO, surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash",
};

function fakeFacilitator() {
  const calls = { verify: 0, settle: [] };
  return {
    calls,
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
          { x402Version: 2, scheme: "upto", network: SOLANA, extra: {
            feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
        ],
        extensions: ["bazaar", "eip2612GasSponsoring"],
        signers: {},
      };
    },
    async verify() {
      calls.verify += 1;
      return { isValid: true, payer: PAYER };
    },
    async settle(_payload, requirements) {
      calls.settle.push(requirements.amount);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network, payer: PAYER };
    },
  };
}

const PRICEY = { id: "pro-model", name: "Pro", provider: "X", contextLength: 1e6, promptUsdPerToken: 30e-6, completionUsdPerToken: 180e-6 };
const CHEAP = { id: "cheap-model", name: "Cheap", provider: "X", contextLength: 1e5, promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.3e-6 };
const fakeCatalogue = { async market() { return new Map([["pro-model", { input: 4, output: 20 }]]); }, async resolve(id) { const m = [PRICEY, CHEAP].find((x) => x.id === id); if (!m) throw new UnknownModel("That model is not available."); return m; },
  async list() { return [CHEAP, PRICEY]; } };

async function serve(t, { upstream } = {}) {
  const facilitator = fakeFacilitator();
  const asked = [];
  const answer = upstream ?? (async (_config, messages, maxTokens) => {
    asked.push({ messages, maxTokens });
    return { content: "Try Caffè Propaganda.", finishReason: "stop", usage: { total_tokens: 42, buyer_cost_micro: 100 } };
  });
  const app = createApp(CONFIG, { facilitatorClient: facilitator, upstream: answer, log: () => {}, catalogue: fakeCatalogue });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, asked };
}

const QUESTION = { messages: [{ role: "user", content: "Coffee near the Colosseum?" }], max_tokens: 300 };

function post(url, body, headers = {}) {
  return fetch(`${url}${ROUTE}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

function decode(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

// A Base payment the fake facilitator accepts, echoing the merchant's extensions as a real buyer does.
function baseSignature(required) {
  const accepted = required.accepts.find((a) => a.network === BASE);
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: required.resource, accepted,
    payload: { signature: "0xsigned" }, extensions: required.extensions })).toString("base64");
}

async function offer(url) {
  const unpaid = await post(url, QUESTION);
  assert.equal(unpaid.status, 402);
  return decode(unpaid.headers.get("payment-required"));
}

test("an unpaid question is offered actual-usage payment on Solana and Base over CDP", async (t) => {
  const { url, facilitator, asked } = await serve(t);
  const required = await offer(url);
  const solana = required.accepts.find((a) => a.network === SOLANA);
  const base = required.accepts.find((a) => a.network === BASE);
  assert.deepEqual(required.accepts.map((a) => a.scheme), ["upto", "upto"]);
  assert.equal(solana.amount, "3000");
  assert.equal(solana.payTo, SOLANA_PAY_TO);
  assert.deepEqual(solana.extra.billing, SOLANA_TERMS);
  assert.ok(solana.extra.feePayer, "Solana payers need CDP's fee payer");
  assert.equal(base.amount, "3000");
  assert.equal(base.payTo, BASE_PAY_TO);
  assert.equal(base.maxTimeoutSeconds, 120);
  assert.deepEqual(base.extra.billing, TERMS);
  assert.ok(required.extensions?.bazaar, "listed for discovery");
  assert.ok(required.extensions?.eip2612GasSponsoring, "Base payers need no gas");
  assert.equal(asked.length, 0);
  assert.equal(facilitator.calls.verify, 0);
});

test("the payment resource keeps the public HTTPS URL behind the local tunnel", async (t) => {
  const { url, facilitator, asked } = await serve(t);
  // Native fetch can replace Host; send exactly the headers cloudflared forwards.
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${ROUTE}`, { method: "POST", headers: {
      Host: "ask.singitai.app", "X-Forwarded-Proto": "https", "Content-Type": "application/json",
    } }, (res) => { res.resume(); res.on("end", () => resolve(res)); res.on("error", reject); });
    req.on("error", reject);
    req.end(JSON.stringify(QUESTION));
  });
  assert.equal(response.statusCode, 402);
  assert.equal(decode(response.headers["payment-required"]).resource.url,
               "https://ask.singitai.app/v1/chat/completions");
  assert.equal(asked.length, 0);
  assert.equal(facilitator.calls.verify, 0);
});

test("a paid question on Base gets the answer and is charged its actual cost once", async (t) => {
  const { url, facilitator, asked } = await serve(t);
  const response = await post(url, QUESTION, { "PAYMENT-SIGNATURE": baseSignature(await offer(url)) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Try Caffè Propaganda.");
  assert.equal(body.model, "singit-ask");
  assert.equal(body.billing.totalAtomic, "1130"); // 100 model + 30 markup + 1000 Base settlement fee
  assert.equal(asked[0].maxTokens, 300);
  assert.deepEqual(facilitator.calls.settle, ["1130"]);
  assert.equal(decode(response.headers.get("payment-response")).network, BASE);
});

for (const [name, upstream] of [
  ["a model that does not answer", async () => { throw new UpstreamError("model answered HTTP 503"); }],
  ["a model that reports no cost", async () => ({ content: "Hi", finishReason: "stop", usage: { total_tokens: 3 } })],
  ["an answer over the ceiling", async () => ({ content: "Hi", finishReason: "stop", usage: { buyer_cost_micro: 2000 } })],
]) {
  test(`${name} costs the payer nothing`, async (t) => {
    const { url, facilitator } = await serve(t, { upstream });
    const response = await post(url, QUESTION, { "PAYMENT-SIGNATURE": baseSignature(await offer(url)) });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /not charged/);
    assert.deepEqual(facilitator.calls.settle, []);
  });
}

test("a malformed question is refused before any payment is asked for", async (t) => {
  const { url, facilitator, asked } = await serve(t);
  const response = await post(url, { messages: [{ role: "tool", content: "x" }] });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("payment-required"), null);
  assert.equal(asked.length, 0);
  assert.equal(facilitator.calls.verify, 0);
});

test("health and the model list are free, and the old test page is gone", async (t) => {
  const { url, facilitator } = await serve(t);
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.facilitator, "coinbase-cdp");
  assert.deepEqual(health.pricing, { [SOLANA]: SOLANA_TERMS, [BASE]: TERMS });
  const models = await fetch(`${url}/v1/models`);
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "singit-ask");
  assert.equal((await fetch(`${url}/test/`)).status, 404);
  assert.equal((await fetch(`${url}/v1/chat/completions/metered/solana`, { method: "POST" })).status, 404);
  assert.equal(facilitator.calls.verify, 0);
});

test("readRequest keeps the question within what one answer pays for", () => {
  assert.deepEqual(readRequest({ messages: [{ role: "user", content: "hi", name: "x" }] }),
                   { messages: [{ role: "user", content: "hi" }], maxTokens: LIMITS.defaultTokens, chars: 2, model: undefined });
  assert.equal(readRequest({ ...QUESTION, max_tokens: 100_000 }).maxTokens, LIMITS.maxTokens);
  assert.equal(readRequest({ ...QUESTION, max_tokens: -5 }).maxTokens, LIMITS.defaultTokens);
  assert.throws(() => readRequest(null), RequestError);
  assert.throws(() => readRequest({ messages: [] }), RequestError);
  assert.throws(() => readRequest({ ...QUESTION, stream: true }), RequestError);
  assert.throws(() => readRequest({ messages: [{ role: "user", content: 5 }] }), RequestError);
  assert.throws(() => readRequest({ messages: [{ role: "user", content: "x".repeat(LIMITS.chars + 1) }] }), RequestError);
  assert.throws(() => readRequest({ messages: Array(LIMITS.messages + 1).fill({ role: "user", content: "x" }) }), RequestError);
});

test("askSurplus sends the key and model, and turns every failure into an UpstreamError", async () => {
  let sent;
  const ok = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ciao" }, finish_reason: "stop" }],
                                         usage: { total_tokens: 7 } }), { status: 200 });
  };
  const answer = await askSurplus(CONFIG, QUESTION.messages, 300, ok);
  assert.equal(answer.content, "ciao");
  assert.equal(sent.url, "https://surplus.test/v1/chat/completions");
  assert.equal(sent.init.headers.Authorization, "Bearer inf_test");
  assert.equal(JSON.parse(sent.init.body).model, "deepseek-v4.1-flash");
  // Thinking off, and room for it where a seller thinks anyway, so the answer is never cut short.
  assert.equal(JSON.parse(sent.init.body).reasoning_effort, "none");
  assert.deepEqual(JSON.parse(sent.init.body).si_route, { objective: "latency", price_tolerance_pct: 100 });
  assert.equal(JSON.parse(sent.init.body).max_tokens, 300 + THINKING_HEADROOM);

  const failing = [
    async () => { throw new TypeError("fetch failed"); },
    async () => new Response("busy", { status: 503 }),
    async () => new Response("not json", { status: 200 }),
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }), { status: 200 }),
  ];
  for (const fetchImpl of failing) {
    await assert.rejects(askSurplus(CONFIG, QUESTION.messages, 300, fetchImpl), UpstreamError);
  }
});

test("another model gets a ceiling worked out from its own prices; the default and cheap ones keep 3000", async (t) => {
  const { url, facilitator } = await serve(t);
  const offerFor = async (model) => {
    const unpaid = await post(url, { ...QUESTION, model });
    assert.equal(unpaid.status, 402);
    return decode(unpaid.headers.get("payment-required")).accepts;
  };
  for (const model of [undefined, "deepseek-v4.1-flash", "singit-ask", "cheap-model"]) {
    assert.deepEqual((await offerFor(model)).map((a) => a.amount), ["3000", "3000"], String(model));
  }
  const pro = await offerFor("pro-model");
  const size = { chars: 26, maxTokens: 300, headroom: THINKING_HEADROOM };
  assert.equal(pro.find((a) => a.network === BASE).amount, ceilingAtomic(PRICEY, size, TERMS));
  assert.equal(pro.find((a) => a.network === SOLANA).amount, ceilingAtomic(PRICEY, size, SOLANA_TERMS));
  assert.ok(BigInt(pro[0].amount) > 200_000n, "a dear model is authorized for what it can really cost");
  assert.equal(pro.find((a) => a.network === BASE).extra.billing.maxChargeAtomic, pro.find((a) => a.network === BASE).amount);
  assert.equal(facilitator.calls.verify, 0);
});

test("a model that is not on the list is refused before any payment is asked for", async (t) => {
  const { url, asked } = await serve(t);
  const response = await post(url, { ...QUESTION, model: "no-such-model" });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("payment-required"), null);
  assert.equal((await post(url, { ...QUESTION, model: 7 })).status, 400);
  assert.equal(asked.length, 0);
});

test("a paid question on another model is bought from that model and charged its actual cost under its own ceiling", async (t) => {
  const seen = [];
  const { url, facilitator } = await serve(t, { upstream: async (_c, _m, _t, _f, model) => {
    seen.push(model);
    return { content: "ok", finishReason: "stop", usage: { buyer_cost_micro: 150_000 } };
  } });
  const unpaid = await post(url, { ...QUESTION, model: "pro-model" });
  const required = decode(unpaid.headers.get("payment-required"));
  const paid = await post(url, { ...QUESTION, model: "pro-model" }, { "PAYMENT-SIGNATURE": baseSignature(required) });
  assert.equal(paid.status, 200);
  assert.deepEqual(seen, ["pro-model"]);
  const body = await paid.json();
  assert.equal(body.billing.totalAtomic, String(150_000 + 45_000 + 1_000));
  assert.deepEqual(facilitator.calls.settle, [body.billing.totalAtomic]);
});

test("an answer dearer than the ceiling of its own model is still not charged", async (t) => {
  const { url, facilitator } = await serve(t, { upstream: async () => ({ content: "ok", usage: { buyer_cost_micro: 10_000_000 } }) });
  const required = decode((await post(url, { ...QUESTION, model: "pro-model" })).headers.get("payment-required"));
  const paid = await post(url, { ...QUESTION, model: "pro-model" }, { "PAYMENT-SIGNATURE": baseSignature(required) });
  assert.equal(paid.status, 502);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("the model list is free and carries Surplus's prices", async (t) => {
  const { url } = await serve(t);
  const list = await (await fetch(`${url}/v1/models`)).json();
  assert.equal(list.default, "deepseek-v4.1-flash");
  assert.deepEqual(list.data.map((m) => m.id), ["singit-ask", "cheap-model", "pro-model"]);
  assert.equal(list.data[2].usdPerMillionTokens.output, 180);
});

test("ModelCatalogue reads text models with prices, caches them, and survives a failed refresh", async () => {
  let calls = 0, fail = false, clock = 0;
  const entry = (id, modality = "text->text", params = ["max_tokens"]) => ({ id, name: id, provider: "P", context_length: 1000,
    architecture: { modality }, supported_parameters: params, pricing: { prompt: "0.000001", completion: "0.000002" } });
  const fetchImpl = async () => { calls++; if (fail) throw new Error("down");
    return new Response(JSON.stringify({ data: [entry("a"), entry("img", "text->image"), entry("nocap", "text->text", []),
      { ...entry("free"), pricing: { prompt: "0", completion: "0" } }, { ...entry("bad"), pricing: {} },
      { ...entry("sees"), architecture: { modality: "text+image+file->text", input_modalities: ["text", "image", "file"], output_modalities: ["text"] } },
      { ...entry("draws"), architecture: { modality: "text->image", input_modalities: ["text"], output_modalities: ["image"] } },
      { ...entry("listens"), architecture: { modality: "audio->text", input_modalities: ["audio"], output_modalities: ["text"] } }] })); };
  const catalogue = new ModelCatalogue({ url: "https://x", fetchImpl, now: () => clock });
  assert.deepEqual((await catalogue.list()).map((m) => m.id).sort(), ["a", "free", "sees"], "multimodal in, text out, is offered; image or audio-only is not");
  assert.equal((await catalogue.resolve("a")).completionUsdPerToken, 0.000002);
  await assert.rejects(catalogue.resolve("img"), UnknownModel);
  assert.equal(calls, 1);
  fail = true; clock = 7 * 3600_000;
  assert.equal((await catalogue.resolve("a")).id, "a", "a failed refresh keeps the last list");
});

test("ceilingAtomic never drops below the standing ceiling", () => {
  assert.equal(ceilingAtomic({ promptUsdPerToken: 0, completionUsdPerToken: 0 }, { chars: 10, maxTokens: 100, headroom: 1000 }, TERMS), "3000");
  assert.equal(billUsage({ buyer_cost_micro: 100 }, { ...TERMS, maxChargeAtomic: "50000" }).totalAtomic, "1130");
});

test("the model list carries the live market price where there is one", async (t) => {
  const { url } = await serve(t);
  const list = await (await fetch(`${url}/v1/models`)).json();
  assert.deepEqual(list.data.find((m) => m.id === "pro-model").marketUsdPerMillionTokens, { input: 4, output: 20 });
  assert.equal(list.data.find((m) => m.id === "cheap-model").marketUsdPerMillionTokens, undefined);
});

test("ModelCatalogue.market reads the cheapest live offers in USD, caches them, and keeps the last on failure", async () => {
  let calls = 0, fail = false, clock = 0;
  const fetchImpl = async (url) => { calls++; assert.ok(String(url).endsWith("/api/marketplace")); if (fail) throw new Error("down");
    return new Response(JSON.stringify({ data: { markets: [
      { model: "claude-opus-5.5", best_input_per_1m: 599996, best_output_per_1m: 2999980 },
      { model: "free", best_input_per_1m: 0, best_output_per_1m: 0 },
      { model: "broken", best_input_per_1m: null, best_output_per_1m: "x" }] } })); };
  const catalogue = new ModelCatalogue({ url: "https://x", fetchImpl, now: () => clock });
  const prices = await catalogue.market();
  assert.deepEqual(prices.get("claude-opus-5.5"), { input: 0.599996, output: 2.99998 });
  assert.deepEqual(prices.get("free"), { input: 0, output: 0 });
  assert.equal(prices.has("broken"), false);
  await catalogue.market();
  assert.equal(calls, 1);
  fail = true; clock = 11 * 60_000;
  assert.equal((await catalogue.market()).get("claude-opus-5.5").output, 2.99998, "a failed refresh keeps the last prices");
  assert.equal(calls, 2);
});

test("ModelCatalogue serves what it has at once, refreshes once in the background, and warm() reads both lists", async () => {
  let clock = 0, release, calls = { models: 0, market: 0 };
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url) => {
    const kind = String(url).endsWith("/api/marketplace") ? "market" : "models";
    calls[kind]++;
    if (calls[kind] > 1) await gate;  // every refresh after the first is slow
    return new Response(JSON.stringify(kind === "market"
      ? { data: { markets: [{ model: "a", best_input_per_1m: 1_000_000, best_output_per_1m: 2_000_000 }] } }
      : { data: [{ id: "a", name: "A", provider: "P", context_length: 1, architecture: { modality: "text->text" },
          supported_parameters: ["max_tokens"], pricing: { prompt: "0.000001", completion: "0.000002" } }] }));
  };
  const catalogue = new ModelCatalogue({ url: "https://x", fetchImpl, now: () => clock });
  await catalogue.warm(3_600_000);
  clearInterval(catalogue.timer);
  assert.deepEqual([calls.models, calls.market], [1, 1]);
  clock = 7 * 3600_000;
  const started = Date.now();
  assert.equal((await catalogue.list())[0].id, "a");           // the old list, without waiting for the slow refresh
  assert.equal((await catalogue.market()).get("a").input, 1);  // likewise the old prices
  await catalogue.list(); await catalogue.market();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([calls.models, calls.market], [2, 2], "one refresh each, however many reads");
  release();
});
