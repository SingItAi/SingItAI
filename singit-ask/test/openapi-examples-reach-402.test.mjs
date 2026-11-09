import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { FORMAT_ROUTES } from "../src/formats.mjs";
import { IMAGE_ROUTE } from "../src/images.mjs";
import { SPEECH_ROUTE } from "../src/speech.mjs";
import { SEARCH_ROUTES } from "../src/search.mjs";
import { UnknownModel, parseImageModels, parseVoiceModels, parseEditModels, parseEmbeddingModels } from "../src/catalogue.mjs";
import { MODEL_ALIAS_ROUTES, aliasPath } from "../src/model-alias-routes.mjs";
import { MODEL_ROUTES, modelRoutePaths } from "../src/model-routes.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash", probeShare: "live", audioSold: true, audioDiscoverable: true, audioGenerationReady: () => true };

// Resolve every model named by the OpenAPI examples, including the model aliases.
const chatModel = (id) => ({ id, name: id, provider: "test", contextLength: 1e6, promptUsdPerToken: 3e-6, completionUsdPerToken: 12e-6 });
const CHAT_IDS = new Set([CONFIG.model, "claude-sonnet-5.5", "gpt-5.5", ...MODEL_ROUTES.map((m) => m.id), ...MODEL_ALIAS_ROUTES.filter(m => m.modality === "chat").map(m => m.id)]);
const IMAGES = parseImageModels({ data: ["venice-seedream-v5-lite", ...MODEL_ALIAS_ROUTES.filter(m => m.modality === "image").map(m => m.id)].map(id => ({ id, name: id, provider: "venice", metering: "per_image",
  pricing: { image: "0.01" }, sizes: ["1024x1024"],
  architecture: { modality: "text->image", input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: ["prompt", "model", "n", "size", "response_format"] })) });
const VOICE = parseVoiceModels({ data: [{ id: "venice-kokoro-tts", architecture: { modality: "text->audio" },
  pricing: { image: "0.0035", media_unit: "1K characters" }, voices: ["af_heart"] }] });
const edits = parseEditModels({ data: ["gpt-image-2-edit", "qwen-image-2-edit"].map(id => ({ id, metering: "per_image", pricing: { image: "0.01" } })) });
const embeddings = parseEmbeddingModels({ data: [{ id: "venice-embed-1", architecture: { modality: "embedding" }, pricing: { image: "0.1625" }, media_unit: "1M tokens" }] });
const catalogue = {
  async editModels() { return edits; }, async embeddingModels() { return embeddings; },
  async resolveEdit(id) { if (!edits.has(id)) throw new UnknownModel("no"); return edits.get(id); },
  async resolveEmbedding(id) { if (!embeddings.has(id)) throw new UnknownModel("no"); return embeddings.get(id); },
  async resolve(id) { if (!CHAT_IDS.has(id)) throw new UnknownModel("That model is not available."); return chatModel(id); },
  async canAnswer() { return true; }, async list() { return [...CHAT_IDS].map(chatModel); },
  async imageModels() { return IMAGES; },
  async resolveImage(id) { const m = IMAGES.get(id); if (!m) throw new UnknownModel("no"); return m; },
  async voiceModels() { return VOICE; },
  async resolveSpeech(id) { const m = VOICE.speech.get(id); if (!m) throw new UnknownModel("no"); return m; },
  async videoModels() { return new Map(); }, async resolveVideo() { throw new UnknownModel("no"); },
};

function fakeFacilitator() {
  const calls = { verify: 0, settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify() { calls.verify += 1; throw new Error("must never verify"); },
    async settle() { calls.settle.push(true); throw new Error("must never settle"); } };
}

async function serve(t) {
  const facilitator = fakeFacilitator();
  let upstreamCalls = 0;
  const neverAsked = () => { upstreamCalls += 1; throw new Error("an unpaid example must never ask upstream"); };
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, exaKey: "exa_test_key",
    fetchImpl: neverAsked, exaFetch: neverAsked, log: () => {}, upstream: neverAsked });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, upstreamCalls: () => upstreamCalls };
}

test("paid OpenAPI JSON examples reach an unpaid 402 and all paid paths are discoverable", async (t) => {
  const { url, facilitator, upstreamCalls } = await serve(t);
  const doc = await (await fetch(`${url}/openapi.json`)).json();
  const discovery = await (await fetch(`${url}/.well-known/x402`)).json();
  const discoverable = new Set(discovery.resources.map(resource => new URL(resource).pathname));
  assert.equal(discovery.resourceDetails.length, discovery.resources.length);
  for (const detail of discovery.resourceDetails) {
    const path = new URL(detail.resource).pathname;
    assert.ok(discovery.resources.includes(detail.resource), `${path}: resource listed`);
    const price = detail.price;
    assert.ok(price, `${path}: WK price`);
    assert.ok(["dynamic", "fixed"].includes(price.mode), `${path}: price mode`);
    assert.equal(price.currency, "USD");
    for (const key of ["min", "max"]) {
      assert.equal(typeof price[key], "string", `${path}: ${key} string`);
      assert.match(price[key], /^\d+(?:\.\d+)?$/, `${path}: ${key} decimal`);
    }
    assert.ok(Number(price.min) <= Number(price.max), `${path}: price bounds`);
    if (price.mode === "fixed") assert.equal(price.min, price.max, `${path}: fixed price`);
    assert.deepEqual(price, doc.paths[path].post["x-payment-info"].price, `${path}: OpenAPI/WK price parity`);
  }
  const checked = [];
  const skipped = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    const operation = item.post;
    if (!operation?.security?.some(requirement => Object.hasOwn(requirement, "x402"))) continue;
    assert.ok(discoverable.has(path), `${path} must be discoverable`);
    assert.ok(operation["x-payment-info"], `${path} declares payment info`);
    const media = operation.requestBody?.content?.["application/json"];
    if (!media || !Object.hasOwn(media, "example")) { skipped.push(path); continue; }
    const response = await fetch(`${url}${path}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(media.example) });
    assert.equal(response.status, 402, `${path}: OpenAPI example must reach payment`);
    const header = response.headers.get("payment-required");
    assert.ok(header, `${path}: payment challenge header`);
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    for (const key of ["input", "output"]) {
      const value = challenge.extensions?.bazaar?.info?.[key];
      assert.ok(value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length > 0, `${path}: non-empty structured Bazaar ${key}`);
    }
    const price = discovery.resourceDetails.find(detail => new URL(detail.resource).pathname === path).price;
    for (const accept of challenge.accepts) {
      const amount = Number(accept.amount) / 1e6;
      assert.ok(amount >= Number(price.min) && amount <= Number(price.max), `${path}: example amount within WK price`);
    }
    await response.arrayBuffer();
    checked.push(path);
  }
  for (const path of [ROUTE, IMAGE_ROUTE, SPEECH_ROUTE, "/v1/embeddings", "/v1/images/edits",
    "/v1/images/image2image", "/v1/audio/generations", "/v1/audio/sound-effects", ...Object.keys(SEARCH_ROUTES),
    ...Object.keys(FORMAT_ROUTES), ...modelRoutePaths(), ...MODEL_ALIAS_ROUTES.map(aliasPath)]) assert.ok(checked.includes(path), `${path} example checked`);
  assert.deepEqual(skipped, [], "this configuration has JSON examples for every paid operation");
  t.diagnostic(`WK price coverage: ${discovery.resourceDetails.length}/${discovery.resources.length}; paid examples checked: ${checked.length}; example gaps: ${skipped.length}`);
  assert.equal(upstreamCalls(), 0);
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});
