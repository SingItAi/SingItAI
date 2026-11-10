import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, ROUTE, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";

import { CONFIG as FIXTURE_CONFIG, fakeFacilitator, registerApp, request as fetch } from "./fixtures/listing-harness.mjs";
const CONFIG = Object.fromEntries(["payToBase", "payToSolana", "surplusKey", "surplusUrl", "model", "probeShare"].map(key => [key, FIXTURE_CONFIG[key]]));
const decode = header => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
// Fixture prices distinguish cheap, expensive and temporarily unavailable models.
const PRICEY = { id: "claude-opus-5.5", name: "Opus", provider: "anthropic", contextLength: 1e6, promptUsdPerToken: 30e-6, completionUsdPerToken: 180e-6 };
const CHEAP = { id: "glm-5.3-flash", name: "Flash", provider: "google", contextLength: 1e6, promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.3e-6 };
const IDLE = { id: "gemma-4-uncensored", name: "Gemma", provider: "zhipu", contextLength: 1e5, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 };
const KNOWN = [PRICEY, CHEAP, IDLE];
const catalogue = {
  async resolve(id) { const m = KNOWN.find((x) => x.id === id); if (!m) throw new UnknownModel("That model is not available."); return m; },
  async canAnswer(id) { return id !== IDLE.id; },
  async list() { return KNOWN; },
};

async function serve(t) {
  const facilitator = fakeFacilitator();
  const asked = [];
  const answer = () => { asked.push(true); throw new Error("Unpaid tests must never invoke inference"); };
  const app = createApp(CONFIG, { facilitatorClient: facilitator, upstream: answer, log: () => {}, catalogue });
  const { url, close } = registerApp(app);
  t.after(close);
  return { url, facilitator, asked };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
// All calls are unpaid. Any attempted upstream request or payment is a test failure.
import { MODEL_ALIAS_ROUTES, aliasPath, aliasDescription } from "../src/model-alias-routes.mjs";
import { readFileSync } from "node:fs";
import { MODEL_ROUTES, routePath } from "../src/model-routes.mjs";
test("wave config and strict discovery copy", () => {
  assert.equal(MODEL_ALIAS_ROUTES.length, 33);
  assert.equal(MODEL_ALIAS_ROUTES.filter(m => m.modality === "chat").length, 23);
  assert.equal(MODEL_ALIAS_ROUTES.filter(m => m.modality === "image").length, 10);
  for (const m of MODEL_ALIAS_ROUTES) {
    const d = aliasDescription(m);
    assert.ok(d.length >= 1 && d.length <= 500);
    assert.ok(d.includes(m.name));
    assert.ok(d.includes(`Pay-per-${m.modality === "image" ? "call" : "answer"} in USDC on Base or Solana, no API key; the max charge is quoted before signing.`));
    assert.doesNotMatch(d, /ceiling|fee|markup|%|0x[a-fA-F0-9]{8,}|growth|on-chain limits/i);
  }
});
test("aliases share the global spend limiter and image payment handler", () => {
  const source = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf("app.use(spendLimitMiddleware") < source.indexOf("if (catalogue) addModelAliasRoutes"));
  const images = readFileSync(new URL("../src/images.mjs", import.meta.url), "utf8");
  assert.ok(images.includes('for (const alias of [null, ...MODEL_ALIAS_ROUTES'));
  assert.equal((images.match(/addPaymentRoute\(app/g) ?? []).length, 1);
});
test("chat alias offers match base atomically and reject mismatches and unavailable models", async t => {
  const { url, facilitator, asked } = await serve(t);
  const body = { model: CHEAP.id, max_tokens: 200, messages: [{ role: "user", content: "Hello" }] };
  const base = await post(url + ROUTE, body);
  const alias = await post(url + `/v1/models/${CHEAP.id}/chat`, body);
  assert.equal(base.status, 402); assert.equal(alias.status, 402);
  const offers = r => decode(r.headers.get("payment-required")).accepts.filter(a => a.network === BASE).map(a => [a.scheme, a.amount]);
  assert.deepEqual(offers(alias), offers(base));
  const { model: omitted, ...unpinnedBody } = body;
  const omittedResponse = await post(url + `/v1/models/${CHEAP.id}/chat`, unpinnedBody);
  assert.equal(omittedResponse.status, 402);
  assert.deepEqual(offers(omittedResponse), offers(base));
  for (const h of ["X-SingIt-Limiter", "RateLimit-Limit", "RateLimit-Remaining", "Retry-After"]) assert.equal(alias.headers.get(h), base.headers.get(h));
  assert.equal((await post(url + `/v1/models/${CHEAP.id}/chat`, { ...body, model: PRICEY.id })).status, 400);
  assert.equal((await post(url + `/v1/models/${IDLE.id}/chat`, { ...body, model: IDLE.id })).status, 503);
  assert.equal((await post(url + "/v1/models/unknown/chat", body)).status, 404);
  assert.equal((await post(url + "/v1/models/unknown/images", { prompt: "Hello" })).status, 404);
  assert.equal(facilitator.calls.verify, 0); assert.equal(facilitator.calls.settle.length, 0); assert.equal(asked.length, 0);
});
test("every configured alias is in well-known, OpenAPI and llms", async t => {
  const { url } = await serve(t);
  const discovery = await (await fetch(url + "/.well-known/x402")).json();
  const openapi = await (await fetch(url + "/openapi.json")).json();
  const llms = await (await fetch(url + "/llms.txt")).text();
  for (const m of MODEL_ALIAS_ROUTES) {
    const path = aliasPath(m);
    assert.ok(discovery.resources.some(r => r.endsWith(path)), path);
    assert.equal(discovery.resourceDetails.find(r => r.resource.endsWith(path)).description, aliasDescription(m));
    assert.equal(openapi.paths[path].post.description, aliasDescription(m));
    assert.ok(llms.includes(path));
  }
});

test("image alias uses the base image quote without payment", async t => {
  const model = MODEL_ALIAS_ROUTES.find(m => m.modality === "image");
  catalogue.resolveImage = async id => {
    if (id !== model.id) throw new UnknownModel("Unknown image");
    return { ...model, metering: "per_image", imageUsd: 0.01, params: [] };
  };
  t.after(() => { delete catalogue.resolveImage; });
  const { url, facilitator } = await serve(t);
  const body = { model: model.id, prompt: "A green robot" };
  const base = await post(url + "/v1/images/generations", body);
  const alias = await post(url + aliasPath(model), { prompt: body.prompt });
  assert.equal(base.status, 402); assert.equal(alias.status, 402);
  const offers = r => decode(r.headers.get("payment-required")).accepts.map(a => [a.scheme, a.network, a.amount]);
  assert.deepEqual(offers(alias), offers(base));
  assert.equal((await post(url + aliasPath(model), { ...body, model: "unknown" })).status, 400);
  assert.equal(facilitator.calls.verify, 0); assert.equal(facilitator.calls.settle.length, 0);
});

test("each SI-62 model keeps one advertised record, its /v1/chat/<id> route", async t => {
  assert.equal(MODEL_ROUTES.length, 19);
  for (const m of MODEL_ROUTES) assert.ok(!MODEL_ALIAS_ROUTES.some(a => a.id === m.id), m.id);
  const { url } = await serve(t);
  const discovery = await (await fetch(url + "/.well-known/x402")).json();
  const openapi = await (await fetch(url + "/openapi.json")).json();
  const llms = await (await fetch(url + "/llms.txt")).text();
  assert.equal(new Set(discovery.resources).size, discovery.resources.length);
  for (const m of MODEL_ROUTES) {
    const alias = `/v1/models/${m.id}/chat`;
    assert.ok(discovery.resources.some(r => r.endsWith(routePath(m.id))), m.id);
    assert.ok(openapi.paths[routePath(m.id)], m.id);
    assert.ok(!discovery.resources.some(r => r.endsWith(alias)), m.id);
    assert.ok(!openapi.paths[alias], m.id);
    assert.ok(!llms.includes(alias), m.id);
    assert.equal((await post(url + alias, { max_tokens: 200, messages: [{ role: "user", content: "Hello" }] })).status, 404, m.id);
  }
});
test("a chat alias matches /v1/chat/completions for the same body: price, model and limits", async t => {
  const { url, facilitator, asked } = await serve(t);
  const path = `/v1/models/${CHEAP.id}/chat`;
  const offers = r => decode(r.headers.get("payment-required")).accepts.map(a => [a.scheme, a.network, a.amount, a.payTo]);
  const hello = [{ role: "user", content: "Hello" }];
  const tool = { type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object", properties: {} } } };
  for (const extra of [{}, { max_tokens: 200 }, { max_tokens: 1200 }, { max_tokens: 4000 }, { max_tokens: 8192 }, { max_tokens: 99999 }, { tools: [tool] }]) {
    const body = { model: CHEAP.id, messages: hello, ...extra };
    const base = await post(url + ROUTE, body), alias = await post(url + path, body), omitted = await post(url + path, { messages: hello, ...extra });
    assert.equal(base.status, 402, JSON.stringify(extra)); assert.equal(alias.status, 402, JSON.stringify(extra));
    assert.deepEqual(offers(alias), offers(base), JSON.stringify(extra));
    assert.deepEqual(offers(omitted), offers(base), JSON.stringify(extra));
  }
  const small = decode((await post(url + path, { messages: hello, max_tokens: 200 })).headers.get("payment-required")).accepts[0].amount;
  const large = decode((await post(url + path, { messages: hello, max_tokens: 8192 })).headers.get("payment-required")).accepts[0].amount;
  assert.ok(BigInt(large) > BigInt(small));
  for (const body of [{ messages: [] }, { messages: Array(201).fill(hello[0]) }, { messages: [{ role: "user", content: "x".repeat(100_001) }] }, { messages: hello, min_tier: "eco" }]) {
    const base = await post(url + ROUTE, { model: CHEAP.id, ...body }), alias = await post(url + path, body);
    assert.equal(alias.status, base.status, JSON.stringify(body).slice(0, 60));
    assert.equal(alias.status, 400);
  }
  assert.equal((await post(url + path, { model: "singit/auto", messages: hello })).status, 400);
  assert.equal((await post(url + path, { model: PRICEY.id, messages: hello })).status, 400);
  const pinnedOnly = await post(url + path, { messages: hello, fallback_models: [PRICEY.id] });
  assert.deepEqual(offers(pinnedOnly), offers(await post(url + path, { messages: hello })));
  assert.equal(facilitator.calls.verify, 0); assert.equal(facilitator.calls.settle.length, 0); assert.equal(asked.length, 0);
});
test("a chat alias advertises the limits it enforces", async t => {
  const { url } = await serve(t);
  const openapi = await (await fetch(url + "/openapi.json")).json();
  const post_ = openapi.paths[`/v1/models/${CHEAP.id}/chat`].post;
  const schema = post_.requestBody.content["application/json"].schema;
  assert.equal(schema.properties.model.const, CHEAP.id);
  assert.equal(schema.properties.messages.maxItems, 200);
  assert.ok(schema.properties.tools);
  assert.ok(!schema.properties.fallback_models); assert.ok(!schema.properties.min_tier);
  assert.doesNotMatch(JSON.stringify(schema.description), /1200/);
  const challenge = decode((await post(url + `/v1/models/${CHEAP.id}/chat`, { messages: [{ role: "user", content: "Hello" }] })).headers.get("payment-required"));
  assert.equal(challenge.resource.description, MODEL_ALIAS_ROUTES.find(m => m.id === CHEAP.id) && aliasDescription(MODEL_ALIAS_ROUTES.find(m => m.id === CHEAP.id)));
});
test("an image alias keeps every image restriction of /v1/images/generations", async t => {
  const model = MODEL_ALIAS_ROUTES.find(m => m.modality === "image");
  catalogue.resolveImage = async id => {
    if (id !== model.id) throw new UnknownModel("Unknown image");
    return { ...model, metering: "per_image", imageUsd: 0.6, params: [] };
  };
  t.after(() => { delete catalogue.resolveImage; });
  const { url, facilitator } = await serve(t);
  const offers = r => decode(r.headers.get("payment-required")).accepts.map(a => [a.scheme, a.network, a.amount, a.payTo]);
  for (const extra of [{ prompt: "Robot" }, { prompt: "Robot", n: 2 }]) {
    const base = await post(url + "/v1/images/generations", { model: model.id, ...extra }), alias = await post(url + aliasPath(model), extra);
    assert.equal(base.status, 402); assert.equal(alias.status, 402);
    assert.deepEqual(offers(alias), offers(base));
  }
  for (const extra of [{ prompt: "Robot", n: 5 }, { prompt: "Robot", n: 4 }, { prompt: "x".repeat(4001) }, { prompt: "" }, { prompt: "Robot", size: "not-a-size" }]) {
    const base = await post(url + "/v1/images/generations", { model: model.id, ...extra }), alias = await post(url + aliasPath(model), extra);
    assert.equal(alias.status, base.status, JSON.stringify(extra).slice(0, 60));
    assert.deepEqual(await alias.json().then(j => j.error?.code), await base.json().then(j => j.error?.code), JSON.stringify(extra).slice(0, 60));
  }
  const mismatch = await post(url + aliasPath(model), { model: "other", prompt: "Robot" });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.type, "invalid_request_error");
  assert.equal(facilitator.calls.verify, 0); assert.equal(facilitator.calls.settle.length, 0);
});
