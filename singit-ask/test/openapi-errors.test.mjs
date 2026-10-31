// Every paid path in openapi.json documents its 402 (with the PAYMENT-REQUIRED header) and the error codes its
// handlers really send, in the JSON shape they send them. Directories (Coinbase's Bazaar) read these; a code listed
// here that the route never answers with, or a missing one it does, is a metadata bug. The shared 400/413 come from
// the JSON body parser, which runs before any route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { IMAGE_ROUTE } from "../src/images.mjs";
import { SPEECH_ROUTE } from "../src/speech.mjs";
import { SEARCH_ROUTES } from "../src/search.mjs";
import { VIDEO_ROUTE } from "../src/video.mjs";
import { modelRoutePaths } from "../src/model-routes.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash", videoSold: true };
const unknown = () => { throw new UnknownModel("That model is not available."); };
const never = () => { throw new Error("no upstream in this test"); };
const catalogue = { async resolve() { never(); }, async canAnswer() { return true; }, async list() { return []; },
  async imageModels() { return new Map(); }, async resolveImage() { unknown(); },
  async voiceModels() { return { speech: new Map(), transcription: new Map() }; }, async resolveSpeech() { unknown(); },
  async videoModels() { return new Map(); }, async resolveVideo() { unknown(); } };
const FEE_PAYER = "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88";
const facilitator = { async getSupported() {
  return { kinds: [
    { x402Version: 2, scheme: "exact", network: BASE },
    { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: FEE_PAYER } },
    { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
    { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: FEE_PAYER, receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
  ], extensions: ["bazaar"], signers: {} }; },
  async verify() { never(); }, async settle() { never(); } };

async function serve(t) {
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, exaKey: "exa_test_key", fetchImpl: never,
    exaFetch: never, log: () => {}, upstream: never });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return `http://127.0.0.1:${listener.address().port}`;
}

// The codes each paid route answers with, read from its handlers (app.mjs, formats.mjs, images.mjs, speech.mjs,
// search.mjs, video.mjs, metered.mjs). 413/400 also cover the body parser.
const COMMON = [400, 402, 413, 503];
const EXPECTED = {
  [ROUTE]: [...COMMON, 422, 429],
  "/v1/messages": [...COMMON, 404, 422],
  "/v1/responses": [...COMMON, 404, 422],
  [IMAGE_ROUTE]: [...COMMON, 404, 409],
  [SPEECH_ROUTE]: [...COMMON, 404, 409],
  [VIDEO_ROUTE]: [...COMMON, 404, 409],
  ...Object.fromEntries(Object.keys(SEARCH_ROUTES).map((route) => [route, [400, 402, 409, 413, 503]])),
  // model-routes.mjs chooseModelRoute: 400 model mismatch, 404 unknown model, 503 no trusted seller or no answer,
  // 422 max_tokens spent reasoning (metered.mjs).
  ...Object.fromEntries(modelRoutePaths().map((route) => [route, [...COMMON, 404, 422]])),
};

test("every paid path documents 402 and exactly the error codes its handlers send", async (t) => {
  const url = await serve(t);
  const doc = await (await fetch(`${url}/openapi.json`)).json();
  const paid = Object.entries(doc.paths).filter(([, item]) => item.post?.["x-payment-info"]);
  assert.deepEqual(paid.map(([route]) => route).sort(), Object.keys(EXPECTED).sort());
  for (const [route, item] of paid) {
    const codes = Object.keys(item.post.responses).map(Number).filter((code) => code >= 400).sort();
    assert.deepEqual(codes, [...EXPECTED[route]].sort(), route);
    assert.ok(item.post.responses[200], `${route} documents its success`);
  }
});

test("each error response carries a short JSON schema; 402 describes the PAYMENT-REQUIRED header", async (t) => {
  const url = await serve(t);
  const doc = await (await fetch(`${url}/openapi.json`)).json();
  for (const [route, item] of Object.entries(doc.paths)) {
    if (!item.post?.["x-payment-info"]) continue;
    for (const [code, response] of Object.entries(item.post.responses)) {
      if (Number(code) < 400) continue;
      assert.ok(response.description.length > 10, `${route} ${code}`);
      let schema = response.content?.["application/json"]?.schema;
      while (schema?.$ref) schema = doc.components.schemas[schema.$ref.split("/").at(-1)];
      assert.equal(schema?.type, "object", `${route} ${code} has a JSON schema`);
      if (code === "402") {
        assert.ok(response.headers["PAYMENT-REQUIRED"], route);
      } else {
        assert.deepEqual(schema.required.includes("error"), true, `${route} ${code}`);
      }
    }
  }
  // /v1/messages speaks Anthropic's envelope, the rest OpenAI's.
  assert.deepEqual(doc.components.schemas.AnthropicErrorResponse.required, ["type", "error"]);
  assert.deepEqual(doc.components.schemas.ErrorResponse.required, ["error"]);
  assert.ok(doc.paths[ROUTE].post.responses[429].headers["Retry-After"]);
});

test("the documented 402 is what an unpaid request really gets", async (t) => {
  const url = await serve(t);
  for (const route of Object.keys(EXPECTED)) {
    if (route === VIDEO_ROUTE) continue; // refuses an empty probe with 404 (no model), as documented
    const response = await fetch(`${url}${route}`, { method: "POST" });
    assert.equal(response.status, 402, route);
    assert.ok(response.headers.get("payment-required"), route);
    const challenge = JSON.parse(Buffer.from(response.headers.get("payment-required"), "base64"));
    const body = await response.json();
    assert.deepEqual(body.accepts, challenge.accepts, route);
    assert.equal(body.x402Version, challenge.x402Version);
    assert.equal(body.code, "payment_required");
  }
});

test("unreadable and oversize JSON bodies get the documented 400 and 413, as JSON, on every paid path", async (t) => {
  const url = await serve(t);
  const headers = { "Content-Type": "application/json" };
  for (const route of Object.keys(EXPECTED)) {
    const bad = await fetch(`${url}${route}`, { method: "POST", headers, body: "{not json" });
    assert.equal(bad.status, 400, route);
    assert.match(bad.headers.get("content-type"), /application\/json/, route);
    const body = await bad.json();
    assert.equal(route === "/v1/messages" ? body.error.type : body.error.type, "invalid_request_error", route);
    assert.equal(body.error.code, "invalid_json");
    assert.equal(bad.headers.get("payment-required"), null, route);

    const big = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify({ x: "a".repeat(130 * 1024) }) });
    assert.equal(big.status, 413, route);
    assert.match(big.headers.get("content-type"), /application\/json/, route);
    assert.ok((await big.json()).error.message, route);
  }
  assert.equal((await (await fetch(`${url}/v1/messages`, { method: "POST", headers, body: "{" })).json()).type, "error");
});

test("models and videos with no catalogue entry answer the documented 404", async (t) => {
  const url = await serve(t);
  const headers = { "Content-Type": "application/json" };
  for (const [route, extra] of [[IMAGE_ROUTE, { prompt: "x" }], [SPEECH_ROUTE, { input: "x" }], [VIDEO_ROUTE, { prompt: "x" }]]) {
    const response = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify({ model: "nope", ...extra }) });
    assert.equal(response.status, 404, route);
    assert.equal((await response.json()).error.code, "model_not_found", route);
  }
});
