// GET /pricing.json: free, no payment, the same per-model ceilings the 402 challenge offers for one reference
// question (PRICING_REFERENCE in app.mjs), computed by the same chooseModel/ceilings functions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { UnknownModel, ModelCatalogue } from "../src/catalogue.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

const DEFAULT = { id: "deepseek-v4.1-flash", name: "DeepSeek", provider: "deepseek", contextLength: 1e5,
  promptUsdPerToken: 0.14e-6, completionUsdPerToken: 0.28e-6 };
const SONNET = { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic", contextLength: 1e6,
  promptUsdPerToken: 2e-6, completionUsdPerToken: 10e-6 };
const PRICEY = { id: "pro-model", name: "Pro", provider: "x", contextLength: 1e6, promptUsdPerToken: 30e-6, completionUsdPerToken: 180e-6 };
const IDLE = { id: "idle-model", name: "Idle", provider: "x", contextLength: 1, promptUsdPerToken: 1e-6, completionUsdPerToken: 1e-6 };
const MODELS = [DEFAULT, SONNET, PRICEY, IDLE];

const fakeCatalogue = {
  async resolve(id) { const m = MODELS.find((x) => x.id === id); if (!m) throw new UnknownModel("That model is not available."); return m; },
  async list() { return [DEFAULT, SONNET, PRICEY]; }, // IDLE is left off the public list, like a real order-book miss
  async canAnswer(id) { return id !== "idle-model"; },
  async market() { return new Map(); },
};

function fakeFacilitator() {
  return { async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify() { throw new Error("not used by these tests"); },
    async settle() { throw new Error("not used by these tests"); } };
}

const neverAsked = () => { throw new Error("pricing.json must never call the model"); };

async function serve(t, { catalogue = fakeCatalogue } = {}) {
  const app = createApp(CONFIG, { facilitatorClient: fakeFacilitator(), catalogue, fetchImpl: neverAsked,
    upstream: neverAsked, log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return `http://127.0.0.1:${listener.address().port}`;
}

test("free: no PAYMENT-REQUIRED header, no payment needed", async (t) => {
  const url = await serve(t);
  const response = await fetch(`${url}/pricing.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("payment-required"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("top-level shape: generatedAt, currency, referenceRequest, networks, note", async (t) => {
  const url = await serve(t);
  const body = await (await fetch(`${url}/pricing.json`)).json();
  assert.equal(body.currency, "USDC");
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.equal(body.referenceRequest.messages, 1);
  assert.equal(typeof body.referenceRequest.chars, "number");
  assert.equal(typeof body.referenceRequest.inputTokens, "number");
  assert.equal(body.referenceRequest.maxOutputTokens, 800); // LIMITS.defaultTokens: the max_tokens a request gets when it omits the field
  assert.equal(body.networks.base.chain, BASE);
  assert.equal(body.networks.solana.chain, SOLANA);
  assert.equal(body.networks.base.settlementFeeUsd, 0.001);
  assert.equal(body.networks.solana.settlementFeeUsd, 0.002);
  assert.match(body.note, /upto settles actual usage/);
  assert.match(body.note, /exact pays the amount shown, flat/);
});

test("lists every model /v1/models exposes (answerable, or the default), never the idle one", async (t) => {
  const url = await serve(t);
  const body = await (await fetch(`${url}/pricing.json`)).json();
  const ids = body.models.map((m) => m.id).sort();
  assert.deepEqual(ids, ["claude-sonnet-5.5", "deepseek-v4.1-flash", "pro-model", "singit/auto"]);
  assert.equal(Object.hasOwn(body.models.find(m => m.id === "singit/auto"), "perMillion"), false);
});

async function offeredFor(url, modelId) {
  const response = await fetch(`${url}${ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "What is the capital of France?" }] }) });
  assert.equal(response.status, 402, modelId);
  const required = decode(response.headers.get("payment-required"));
  const amount = (scheme, network) => required.accepts.find((a) => a.scheme === scheme && a.network === network)?.amount;
  return { uptoBase: amount("upto", BASE), uptoSolana: amount("upto", SOLANA),
           exactBase: amount("exact", BASE), exactSolana: amount("exact", SOLANA) };
}

test("a priced model's numbers equal the actual 402 offered for the same reference question (Base and Solana)", async (t) => {
  const url = await serve(t);
  const body = await (await fetch(`${url}/pricing.json`)).json();
  for (const modelId of ["claude-sonnet-5.5", "pro-model"]) {
    const priced = body.models.find((m) => m.id === modelId);
    const offered = await offeredFor(url, modelId);
    assert.equal(priced.upto.base.priceAtomic, offered.uptoBase, `${modelId} upto/base`);
    assert.equal(priced.upto.solana.priceAtomic, offered.uptoSolana, `${modelId} upto/solana`);
    assert.equal(priced.exact.base.ceilingAtomic, offered.exactBase, `${modelId} exact/base`);
    assert.equal(priced.exact.solana.ceilingAtomic, offered.exactSolana, `${modelId} exact/solana`);
  }
});

test("the default model's numbers are clamped the same way the real 402 clamps them", async (t) => {
  const url = await serve(t);
  const body = await (await fetch(`${url}/pricing.json`)).json();
  const priced = body.models.find((m) => m.id === "deepseek-v4.1-flash");
  const offered = await offeredFor(url, "deepseek-v4.1-flash");
  assert.equal(priced.upto.base.priceAtomic, offered.uptoBase);
  assert.equal(priced.exact.base.ceilingAtomic, offered.exactBase);
});

test("503 with Retry-After while the catalogue has never loaded; no invented numbers", async (t) => {
  const catalogue = new ModelCatalogue({ url: "https://surplus.test", fetchImpl: async () => { throw new Error("down"); } });
  const url = await serve(t, { catalogue });
  const response = await fetch(`${url}/pricing.json`);
  assert.equal(response.status, 503);
  assert.ok(response.headers.get("retry-after"));
  const body = await response.json();
  assert.equal(body.error.type, "upstream_error");
});

test("openapi.json lists /pricing.json as a free path", async (t) => {
  const url = await serve(t);
  const spec = await (await fetch(`${url}/openapi.json`)).json();
  assert.ok(spec.paths["/pricing.json"]);
  assert.deepEqual(spec.paths["/pricing.json"].get.security, []);
});

// Claude Opus: upto is the scheme to sign (28 October). Advice only; the offers and the price formula do not move.
const OPUS = { id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "anthropic", contextLength: 1e6,
  promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
const withOpus = { ...fakeCatalogue,
  async resolve(id) { return id === OPUS.id ? OPUS : fakeCatalogue.resolve(id); },
  async list() { return [DEFAULT, SONNET, OPUS]; } };

test("isUptoPrimary: Claude Opus models only", async () => {
  const { isUptoPrimary } = await import("../src/pricing.mjs");
  assert.equal(isUptoPrimary("claude-opus-5.5"), true);
  assert.equal(isUptoPrimary("claude-opus-4.8"), true);
  for (const id of ["claude-sonnet-5.5", "claude-haiku-5.5", "gpt-5.6-sol", "opus", "my-claude-opus-5.5", "", undefined, null, 5])
    assert.equal(isUptoPrimary(id), false, String(id));
});

test("/pricing.json marks Opus recommendedScheme upto and nothing else, with the same numbers as the 402", async (t) => {
  const url = await serve(t, { catalogue: withOpus });
  const body = await (await fetch(`${url}/pricing.json`)).json();
  const opus = body.models.find((m) => m.id === OPUS.id);
  assert.equal(opus.recommendedScheme, "upto");
  assert.match(opus.recommendedSchemeWhy, /upto.*actual|what the answer really cost/s);
  assert.match(opus.recommendedSchemeWhy, /exact is a flat price/);
  for (const m of body.models.filter((x) => x.id !== OPUS.id)) {
    assert.equal(m.recommendedScheme, undefined, m.id);
    assert.equal(m.recommendedSchemeWhy, undefined, m.id);
  }
  assert.match(body.note, /recommendedScheme upto \(Claude Opus\)/);
  // The price formula is untouched: the advertised amounts still equal the 402's.
  const offered = await offeredFor(url, OPUS.id);
  assert.equal(opus.upto.base.priceAtomic, offered.uptoBase);
  assert.equal(opus.exact.base.ceilingAtomic, offered.exactBase);
  assert.equal(opus.exact.solana.ceilingAtomic, offered.exactSolana);
});

test("the Opus 402 still leads with upto on Base and keeps exact offers", async (t) => {
  const url = await serve(t, { catalogue: withOpus });
  const response = await fetch(`${url}${ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPUS.id, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(response.status, 402);
  const { accepts } = decode(response.headers.get("payment-required"));
  assert.deepEqual(accepts.map((a) => `${a.scheme}:${a.network === BASE ? "base" : "solana"}`),
    ["upto:base", "upto:solana", "exact:base", "exact:solana"]);
});

test("/v1/models carries the same recommendation on the Opus entry only", async (t) => {
  const url = await serve(t, { catalogue: withOpus });
  const body = await (await fetch(`${url}/v1/models`)).json();
  const entry = (id) => body.data.find((m) => m.id === id);
  assert.equal(entry(OPUS.id).recommendedScheme, "upto");
  assert.equal(entry("claude-sonnet-5.5").recommendedScheme, undefined);
  assert.equal(entry("deepseek-v4.1-flash").recommendedScheme, undefined);
});

test("llms.txt and openapi.json tell Opus buyers to sign upto", async (t) => {
  const url = await serve(t, { catalogue: withOpus });
  const llms = await (await fetch(`${url}/llms.txt`)).text();
  assert.match(llms, /For Claude Opus, sign `upto`/);
  const spec = await (await fetch(`${url}/openapi.json`)).json();
  assert.match(spec.paths["/pricing.json"].get.description, /recommendedScheme upto \(Claude Opus\)/);
});
