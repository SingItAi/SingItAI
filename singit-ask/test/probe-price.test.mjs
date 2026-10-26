// vet402 (and any directory that checks a listing against the live route) compares the price CDP's Bazaar recorded
// for a route with what its own empty, unpaid POST is offered, and fails it as price_mismatch when no accept
// carries the recorded amount. Bazaar records the 402 offered for the example body the route declares in its
// discovery extension. So every discoverable route's discovery probes (empty POST, GET, HEAD) must be offered
// exactly what that declared example body is offered — and must still never verify, settle or ask upstream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { FORMAT_ROUTES } from "../src/formats.mjs";
import { IMAGE_ROUTE, IMAGE_TERMS, imagePrice } from "../src/images.mjs";
import { SPEECH_ROUTE, speechPrice } from "../src/speech.mjs";
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
  const amounts = async (route) => {
    const posted = await fetch(`${url}${route}`, { method: "POST" });
    assert.equal(posted.status, 402, route);
    return Object.fromEntries(decode(posted.headers.get("payment-required")).accepts.map((a) => [`${a.scheme} ${a.network}`, a.amount]));
  };
  for (const route of [ROUTE, ...Object.keys(FORMAT_ROUTES), ...modelRoutePaths()]) {
    assert.deepEqual(await amounts(route), { [`exact ${BASE}`]: TERMS.maxChargeAtomic, [`upto ${BASE}`]: TERMS.maxChargeAtomic,
      [`exact ${SOLANA}`]: SOLANA_TERMS.maxChargeAtomic, [`upto ${SOLANA}`]: SOLANA_TERMS.maxChargeAtomic }, route);
  }
  assert.deepEqual(await amounts(IMAGE_ROUTE), { [`exact ${BASE}`]: imagePrice(IMAGE_TERMS.maxListAtomic, BASE).totalAtomic,
    [`exact ${SOLANA}`]: imagePrice(IMAGE_TERMS.maxListAtomic, SOLANA).totalAtomic });
  assert.deepEqual(await amounts(SPEECH_ROUTE), { [`exact ${BASE}`]: speechPrice(1_000_000, BASE).totalAtomic,
    [`exact ${SOLANA}`]: speechPrice(1_000_000, SOLANA).totalAtomic });
  assert.equal(facilitator.calls.verify, 0);
});

test("one probe looks the example up once, however many offers it carries", async (t) => {
  const counts = { resolve: 0, image: 0, speech: 0 };
  const counting = { ...catalogue,
    async resolve(id) { counts.resolve += 1; return catalogue.resolve(id); },
    async resolveImage(id) { counts.image += 1; return catalogue.resolveImage(id); },
    async resolveSpeech(id) { counts.speech += 1; return catalogue.resolveSpeech(id); } };
  const { url } = await serve(t, counting);
  for (const route of [...Object.keys(FORMAT_ROUTES), ...modelRoutePaths()]) {
    counts.resolve = 0;
    await fetch(`${url}${route}`, { method: "POST" });
    assert.equal(counts.resolve, 1, route);
  }
  await fetch(`${url}${IMAGE_ROUTE}`, { method: "GET" });
  await fetch(`${url}${SPEECH_ROUTE}`, { method: "GET" });
  assert.deepEqual([counts.image, counts.speech], [1, 1]);
});

// A body that costs more than the example: what a payer would send to try to pay the cheaper probe price for it.
function pricier(route, example) {
  if (route === SPEECH_ROUTE) return { ...example, input: example.input.repeat(100) };
  if (route === IMAGE_ROUTE) return { ...example, n: 4 };
  if (route === ROUTE) return null;  // default model: clamped to the standing ceiling either way (metered.mjs)
  if ("max_tokens" in example) return { ...example, max_tokens: 8000 };
  if ("max_output_tokens" in example) return { ...example, max_output_tokens: 8000 };
  return null;
}

test("a payment signed for the probe's offer never verifies or settles an empty, invalid or pricier body", async (t) => {
  const { url, facilitator } = await serve(t);
  let pricierChecked = 0;
  for (const route of DISCOVERABLE) {
    const probe = decode((await fetch(`${url}${route}`, { method: "POST" })).headers.get("payment-required"));
    const example = probe.extensions.bazaar.info.input.body;
    const bodies = ["{}", JSON.stringify({ model: 7 }), "[]"];
    const more = pricier(route, example);
    if (more) {
      const quoted = decode((await fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(more) })).headers.get("payment-required"));
      assert.notDeepEqual(terms(quoted), terms(probe), `${route}: the pricier body must be quoted differently`);
      bodies.push(JSON.stringify(more));
      pricierChecked += 1;
    }
    for (const accepted of probe.accepts) {
      const payment = encode({ x402Version: 2, resource: probe.resource, accepted, payload: { signature: "0xsigned" },
        extensions: probe.extensions });
      for (const header of ["PAYMENT-SIGNATURE", "X-PAYMENT"]) {
        for (const body of bodies) {
          const paid = await fetch(`${url}${route}`, { method: "POST",
            headers: { "Content-Type": "application/json", [header]: payment }, body });
          assert.ok(paid.status >= 400, `${route} ${header} ${body.slice(0, 40)}: got ${paid.status}`);
        }
      }
    }
  }
  assert.ok(pricierChecked >= 17, `pricier bodies checked on ${pricierChecked} routes`);
  assert.equal(facilitator.calls.verify, 0, "nothing verified");
  assert.deepEqual(facilitator.calls.settle, [], "nothing settled");
});
