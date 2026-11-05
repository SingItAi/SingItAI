import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, ROUTE, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";

import { CONFIG as FIXTURE_CONFIG, fakeFacilitator, registerApp, request as fetch } from "./fixtures/listing-harness.mjs";
const CONFIG = Object.fromEntries(["payToBase", "payToSolana", "surplusKey", "surplusUrl", "model", "probeShare"].map(key => [key, FIXTURE_CONFIG[key]]));
const decode = header => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
// Fixture prices distinguish cheap, expensive and temporarily unavailable models.
const PRICEY = { id: "claude-opus-5.5", name: "Opus", provider: "anthropic", contextLength: 1e6, promptUsdPerToken: 30e-6, completionUsdPerToken: 180e-6 };
const CHEAP = { id: "gemini-3.8-flash", name: "Flash", provider: "google", contextLength: 1e6, promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.3e-6 };
const IDLE = { id: "glm-5.3", name: "GLM", provider: "zhipu", contextLength: 1e5, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 };
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
test("wave config and strict discovery copy", () => {
  assert.equal(MODEL_ALIAS_ROUTES.length, 49);
  for (const m of MODEL_ALIAS_ROUTES) {
    const d = aliasDescription(m);
    assert.ok(d.length <= 160);
    assert.ok(d.includes(m.name));
    assert.ok(d.includes("within owner-set USDC limits"));
    assert.doesNotMatch(d, /ceiling|fee|%|0x[a-fA-F0-9]{8,}|growth|on-chain limits/i);
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
