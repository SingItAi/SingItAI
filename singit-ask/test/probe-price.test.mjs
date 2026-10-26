// vet402 (and any directory that checks a listing against the live route) compares the price CDP's Bazaar recorded
// for a route with what its own empty, unpaid POST is offered, and fails it as price_mismatch when no accept
// carries the recorded amount. Bazaar records the 402 offered for the example body the route declares in its
// discovery extension. So every discoverable route's discovery probes (empty POST, GET, HEAD) must be offered
// exactly what that declared example body is offered — and must still never verify, settle or ask upstream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { FORMAT_ROUTES } from "../src/formats.mjs";
import { IMAGE_ROUTE } from "../src/images.mjs";
import { SPEECH_ROUTE } from "../src/speech.mjs";
import { SEARCH_ROUTES } from "../src/search.mjs";
import { UnknownModel, parseImageModels, parseVoiceModels } from "../src/catalogue.mjs";
import { MODEL_ROUTES, modelRoutePaths } from "../src/model-routes.mjs";
import { TERMS, SOLANA_TERMS } from "../src/pricing.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

const DISCOVERABLE = [ROUTE, ...Object.keys(FORMAT_ROUTES), IMAGE_ROUTE, SPEECH_ROUTE, ...Object.keys(SEARCH_ROUTES),
  ...modelRoutePaths()];

// Every chat model the examples name resolves, priced so that the example's ceilings are well clear of both the
// floor and the standing ceiling (the old probe price), so a probe still quoting the standing ceiling would fail.
const chatModel = (id) => ({ id, name: id, provider: "test", contextLength: 1e6, promptUsdPerToken: 3e-6, completionUsdPerToken: 12e-6 });
const CHAT_IDS = new Set([CONFIG.model, "claude-sonnet-5.5", "gpt-5.5", ...MODEL_ROUTES.map((m) => m.id)]);
const IMAGES = parseImageModels({ data: [{ id: "venice-seedream-v5-lite", name: "Seedream", provider: "venice", metering: "per_image",
  pricing: { image: "0.01" }, sizes: ["1024x1024"],
  architecture: { modality: "text->image", input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: ["prompt", "model", "n", "size", "response_format"] }] });
const VOICE = parseVoiceModels({ data: [{ id: "venice-kokoro-tts", architecture: { modality: "text->audio" },
  pricing: { image: "0.0035", media_unit: "1K characters" }, voices: ["af_heart"] }] });
const neverAsked = () => { throw new Error("a discovery probe must never ask upstream"); };
const catalogue = {
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
    async verify() { calls.verify += 1; return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

async function serve(t, cat = catalogue) {
  const facilitator = fakeFacilitator();
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue: cat, exaKey: "exa_test_key",
    fetchImpl: neverAsked, exaFetch: neverAsked, log: () => {}, upstream: neverAsked });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator };
}

const terms = (required) => required.accepts.map((a) => [a.scheme, a.network, a.asset, a.amount, a.payTo]);
const STANDING = new Set([TERMS.maxChargeAtomic, SOLANA_TERMS.maxChargeAtomic]);

test("every discoverable route's probes are offered exactly what its declared Bazaar example is offered", async (t) => {
  const { url, facilitator } = await serve(t);
  for (const route of DISCOVERABLE) {
    const posted = await fetch(`${url}${route}`, { method: "POST" });
    assert.equal(posted.status, 402, route);
    const probe = decode(posted.headers.get("payment-required"));
    const example = probe.extensions?.bazaar?.info?.input?.body;
    assert.ok(example && typeof example === "object", `${route} declares an example body`);

    const real = await fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(example) });
    assert.equal(real.status, 402, `${route}: its own example is a valid, unpaid question`);
    const quoted = decode(real.headers.get("payment-required"));
    assert.deepEqual(terms(probe), terms(quoted), `${route}: empty POST must carry the example's amounts (vet402 price_mismatch)`);
    for (const method of ["GET", "HEAD"]) {
      const got = await fetch(`${url}${route}`, { method });
      assert.deepEqual(terms(decode(got.headers.get("payment-required"))), terms(quoted), `${route} ${method}`);
    }
    // vet402 compares amounts only; every accept's billing ceiling must agree with its amount, like a real quote.
    for (const a of probe.accepts) {
      if (a.extra?.billing) assert.equal(a.extra.billing.maxChargeAtomic, a.amount, `${route} ${a.scheme} ${a.network}`);
    }
  }
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("the chat probes are no longer the standing ceiling once the example can be priced", async (t) => {
  const { url } = await serve(t);
  // Not /v1/chat/completions: its default model's ceiling is clamped to the standing maximum by design (metered.mjs),
  // so with these test prices it is the standing ceiling either way; the test above still checks it matches.
  for (const route of [...Object.keys(FORMAT_ROUTES), ...modelRoutePaths()]) {
    const probe = decode((await fetch(`${url}${route}`, { method: "POST" })).headers.get("payment-required"));
    assert.ok(probe.accepts.some((a) => !STANDING.has(a.amount)), `${route}: ${probe.accepts.map((a) => a.amount)}`);
  }
});

test("a catalogue that cannot price the example right now keeps the old standing probe price", async (t) => {
  const down = { ...catalogue, async resolve() { throw new Error("catalogue down"); },
    async resolveImage() { throw new Error("down"); }, async resolveSpeech() { throw new Error("down"); } };
  const { url, facilitator } = await serve(t, down);
  for (const route of [...Object.keys(FORMAT_ROUTES), ...modelRoutePaths()]) {
    const posted = await fetch(`${url}${route}`, { method: "POST" });
    assert.equal(posted.status, 402, route);
    const amounts = decode(posted.headers.get("payment-required")).accepts.map((a) => a.amount);
    assert.ok(amounts.every((a) => STANDING.has(a)), `${route}: ${amounts}`);
  }
  for (const route of [IMAGE_ROUTE, SPEECH_ROUTE]) {
    assert.equal((await fetch(`${url}${route}`, { method: "POST" })).status, 402, route);
  }
  assert.equal(facilitator.calls.verify, 0);
});

test("paying the probe's offer with an empty body is still refused before verify or settle", async (t) => {
  const { url, facilitator } = await serve(t);
  for (const route of DISCOVERABLE) {
    const probe = decode((await fetch(`${url}${route}`, { method: "POST" })).headers.get("payment-required"));
    for (const accepted of probe.accepts) {
      const paid = await fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: probe.resource, accepted, payload: { signature: "0xsigned" },
          extensions: probe.extensions }) }, body: "{}" });
      assert.ok(paid.status >= 400, `${route}: an empty paid body must never be answered (got ${paid.status})`);
    }
  }
  assert.deepEqual(facilitator.calls.settle, [], "nothing settled");
});
