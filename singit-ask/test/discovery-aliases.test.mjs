// SI-297: alternate model names (vendor prefixes, undated ids) resolve to the canonical catalog card and chat model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, ROUTE, createApp } from "../src/app.mjs";
import { UnknownModel, parseImageModels } from "../src/catalogue.mjs";
import { DISCOVERY_ALIASES, aliasCandidates, aliasesFor, resolveDiscoveryId } from "../src/discovery-aliases.mjs";
import { MODEL_ROUTES, routePath } from "../src/model-routes.mjs";
import { MODEL_ALIAS_ROUTES, aliasPath } from "../src/model-alias-routes.mjs";
import { CONFIG, fakeFacilitator, registerApp, serve, request as fetch } from "./fixtures/listing-harness.mjs";

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = header => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const IMAGES = parseImageModels({ data: [{ id: "venice-grok-imagine", name: "Grok Imagine", provider: "venice", metering: "per_image",
  pricing: { image: "0.04" }, sizes: ["1024x1024"],
  architecture: { modality: "text->image", input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: ["prompt", "model", "n", "size", "response_format"] }] });
const images = { async imageModels() { return IMAGES; },
  async resolveImage(id) { const m = IMAGES.get(id); if (!m) throw new UnknownModel("no"); return m; } };

const CASES = {
  "gemini-4-argon": ["gemini-4-argon", "google/gemini-4-argon", "GOOGLE/Gemini-4-Argon"],
  "gpt-6-luna": ["openai/gpt-6-luna"],
  "kimi-k3.1-pro": ["moonshot/kimi-k3.1-pro"],
  "minimax-m3": ["minimax/minimax-m3"],
  "qwen3.8-max-0902": ["qwen3.8-max", "qwen/qwen3.8-max"],
  "venice-grok-imagine": ["grok-imagine-image", "xai/grok-imagine-image"],
};

test("GET /v1/models/<alias> (raw and encoded) returns the canonical card", async t => {
  const { url, facilitator } = await serve(t, images);
  const card = async path => {
    const response = await fetch(url + "/v1/models/" + path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  for (const [id, names] of Object.entries(CASES)) {
    const canonical = await card(id);
    assert.equal(canonical.id, id);
    assert.deepEqual(canonical.aliases, aliasesFor(id), id);
    assert.ok(!canonical.aliases.includes(id));
    for (const name of names) {
      for (const path of [name, encodeURIComponent(name)]) assert.deepEqual(await card(path), canonical, path);
    }
  }
  const list = await (await fetch(url + "/v1/models")).json();
  assert.deepEqual(list.data.find(m => m.id === "gemini-4-argon").aliases, ["google/gemini-4-argon"]);
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("unknown names and reserved prefixes still 404", async t => {
  const { url } = await serve(t, images);
  for (const path of ["unknown", "openai/unknown", "openai%2Funknown", "free/gemini-4-argon", "singit/gemini-4-argon",
    "kimi-k3.1", "gemini-4-argon/", "/gemini-4-argon"]) {
    const response = await fetch(url + "/v1/models/" + path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, "not_found");
  }
});

test("an exact catalog id with a slash wins over its tail", async t => {
  const tail = { id: "model", name: "Tail", contextLength: 8192, promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 };
  const slashed = { ...tail, id: "vendor/model", name: "Slashed" };
  const known = new Map([tail, slashed].map(m => [m.id, m]));
  const { url } = await serve(t, { list: async () => [...known.values()],
    resolve: async id => { if (!known.has(id)) throw new UnknownModel("no"); return known.get(id); } });
  for (const path of ["vendor/model", "vendor%2Fmodel"]) {
    assert.equal((await (await fetch(url + "/v1/models/" + path)).json()).id, "vendor/model", path);
  }
  assert.equal((await (await fetch(url + "/v1/models/other%2Fmodel")).json()).id, "model");
  assert.equal(resolveDiscoveryId("vendor/model", ["model", "vendor/model"]), "vendor/model");
  assert.equal(resolveDiscoveryId("Vendor/Model", ["model", "vendor/model"]), "vendor/model");
});

test("D4 paid alias paths still reach their unpaid GET discovery", async t => {
  const { url } = await serve(t, images);
  for (const m of MODEL_ALIAS_ROUTES.filter(a => a.modality === "chat").slice(0, 3)) {
    const response = await fetch(url + aliasPath(m));
    assert.equal(response.status, 402, aliasPath(m));
    assert.ok(response.headers.get("payment-required"));
  }
  assert.deepEqual(aliasCandidates("gemma-4-uncensored/chat"), []);
  assert.deepEqual(aliasCandidates("gemma-4-uncensored/images"), []);
});

test("the table never maps kimi-k3 or an SI-62/D4 id, and targets are canonical", () => {
  const routed = new Set([...MODEL_ROUTES, ...MODEL_ALIAS_ROUTES].map(m => m.id));
  for (const [alias, id] of Object.entries(DISCOVERY_ALIASES)) {
    assert.ok(!routed.has(alias), alias);
    assert.ok(!Object.hasOwn(DISCOVERY_ALIASES, id), id);
  }
  assert.ok(!Object.hasOwn(DISCOVERY_ALIASES, "kimi-k3"));
  assert.ok(!Object.values(DISCOVERY_ALIASES).includes("kimi-k3"));
  assert.equal(resolveDiscoveryId("moonshot/kimi-k3", ["kimi-k3", "kimi-k3.1-pro"]), "kimi-k3");
  assert.equal(resolveDiscoveryId("kimi-k3", ["kimi-k3", "kimi-k3.1-pro"]), "kimi-k3");
});

test("new SI-62 ids are URL-safe and listed in well-known as /v1/chat/<id>", async t => {
  const { url } = await serve(t, images);
  const known = await (await fetch(url + "/.well-known/x402")).json();
  for (const id of ["gpt-6-luna", "gemini-4-argon", "minimax-m3", "kimi-k3.1-pro"]) {
    assert.ok(MODEL_ROUTES.some(m => m.id === id), id);
    assert.match(id, /^[a-z0-9.-]+$/);
    assert.ok(known.resources.includes(url + routePath(id)), id);
    assert.ok(!MODEL_ALIAS_ROUTES.some(m => m.id === id), id);
  }
  assert.ok(!known.resources.some(r => r.endsWith("/v1/models/gpt-6-luna/chat")));
});

test("POST /v1/chat/completions answers and bills an alias as its canonical model", async t => {
  const known = new Set(["gpt-6-luna", "qwen3.8-max-0902", CONFIG.model]);
  const catalogue = {
    async resolve(id) { if (!known.has(id)) throw new UnknownModel("That model is not available.");
      return { id, name: id, provider: "test", contextLength: 1e6, promptUsdPerToken: 3e-6, completionUsdPerToken: 12e-6 }; },
    async canAnswer() { return true; }, async list() { return [...known].map(id => ({ id })); },
  };
  const asked = [];
  const upstream = async (_config, _messages, _maxTokens, _fetchImpl, model) => {
    asked.push(model);
    return { content: "Hi.", finishReason: "stop", usage: { total_tokens: 42, buyer_cost_micro: 100 } };
  };
  const facilitator = fakeFacilitator();
  const app = createApp({ ...CONFIG, defaultFallbacks: false }, { facilitatorClient: facilitator, catalogue, upstream, log: () => {} });
  const { url, close } = registerApp(app);
  t.after(close);
  const post = (body, headers = {}) => fetch(url + ROUTE, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const messages = [{ role: "user", content: "Hi" }];
  for (const [name, id] of [["openai/gpt-6-luna", "gpt-6-luna"], ["qwen3.8-max", "qwen3.8-max-0902"], ["GPT-6-Luna", "gpt-6-luna"]]) {
    const required = decode((await post({ model: name, messages })).headers.get("payment-required"));
    const canonical = decode((await post({ model: id, messages })).headers.get("payment-required"));
    assert.deepEqual(required.accepts.map(a => a.amount), canonical.accepts.map(a => a.amount), name);
    const accepted = required.accepts.find(a => a.network === BASE && a.scheme === "upto");
    const paid = await post({ model: name, messages }, { "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
      accepted, payload: { signature: "0xsigned" }, extensions: required.extensions }) });
    assert.equal(paid.status, 200, name);
    assert.equal((await paid.json()).model, "singit-ask", name);
    assert.equal(asked.at(-1), id, name);
  }
  for (const name of ["openai/unknown", "free/gpt-6-luna-x", "kimi-k3.1-pro"]) {
    const response = await post({ model: name, messages });
    assert.ok([400, 404].includes(response.status), name);
    assert.equal(response.headers.get("payment-required"), null, name);
  }
});
