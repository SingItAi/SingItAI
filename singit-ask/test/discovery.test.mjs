// x402scan, Coinbase's Bazaar and 402 Index probe a paid route with GET and HEAD, not just an empty POST. Every
// route listed for discovery must answer those with the same 402 challenge as an empty, unpaid POST — never a
// different one, and never a reason to verify, settle or call upstream, even carrying a payment header. Routes
// that are not listed for discovery (metered chat; video while its seller is flaky; credit only gives money away
// to anyone but the account's own agent) must keep Express's plain 404.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, ROUTE, createApp } from "../src/app.mjs";
import { FORMAT_ROUTES } from "../src/formats.mjs";
import { IMAGE_ROUTE } from "../src/images.mjs";
import { SPEECH_ROUTE } from "../src/speech.mjs";
import { SEARCH_ROUTES } from "../src/search.mjs";
import { VIDEO_ROUTE } from "../src/video.mjs";
import { CREDIT_ROUTE } from "../src/credit.mjs";
import { METERED_ROUTE } from "../src/pricing.mjs";
import { MODEL_ROUTES, modelRoutePaths, routePath } from "../src/model-routes.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash", videoSold: true };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

// Every discoverable paid route: chat/completions, Anthropic/OpenAI's own formats, images, speech, Exa's three,
// and one per popular model (SI-62). `/v1/chat/completions/metered` and `/v1/video/generations` (unless
// SINGIT_ASK_VIDEO_DISCOVERABLE=1) are paid but not listed; `/v1/credit` is paid and deliberately hidden.
const DISCOVERABLE = [ROUTE, ...Object.keys(FORMAT_ROUTES), IMAGE_ROUTE, SPEECH_ROUTE, ...Object.keys(SEARCH_ROUTES),
  ...modelRoutePaths()];

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

// Every upstream a GET/HEAD discovery request must never reach: the model, Surplus (images/speech/formats) and
// Exa. Throwing, rather than just counting, fails loudly the moment discovery stops being side-effect-free.
const neverAsked = () => { throw new Error("a GET/HEAD discovery probe must never ask upstream"); };
const catalogue = { async resolve() { neverAsked(); }, async canAnswer() { return true; }, async list() { return []; },
  async imageModels() { return new Map(); }, async resolveImage() { neverAsked(); },
  async voiceModels() { return { speech: new Map(), transcription: new Map() }; }, async resolveSpeech() { neverAsked(); },
  async videoModels() { return new Map(); }, async resolveVideo() { neverAsked(); } };

async function serve(t, config = CONFIG) {
  const facilitator = fakeFacilitator();
  const app = createApp(config, { facilitatorClient: facilitator, catalogue, exaKey: "exa_test_key",
    fetchImpl: neverAsked, exaFetch: neverAsked, log: () => {}, upstream: neverAsked });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator };
}

const pay = (required, network, scheme = "upto") => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network && a.scheme === scheme) ?? required.accepts.find((a) => a.network === network),
  payload: { signature: "0xsigned" }, extensions: required.extensions }) });

test("GET on every discoverable route gets the exact 402 an empty, unpaid POST gets", async (t) => {
  const { url, facilitator } = await serve(t);
  for (const route of DISCOVERABLE) {
    const posted = await fetch(`${url}${route}`, { method: "POST" });
    assert.equal(posted.status, 402, route);
    const postedRequired = decode(posted.headers.get("payment-required"));

    const got = await fetch(`${url}${route}`, { method: "GET" });
    assert.equal(got.status, 402, route);
    const gotRequired = decode(got.headers.get("payment-required"));
    assert.deepEqual(gotRequired, postedRequired, `${route}: GET must offer exactly what the empty POST probe offers`);
    assert.equal(gotRequired.resource.url, `${url}${route}`, route);
    assert.ok(gotRequired.extensions?.bazaar?.info, `${route} needs the input schema for x402scan to index it`);
    // The extension and resource always describe the route as POST, which is how it is actually called.
    assert.equal(gotRequired.extensions.bazaar.info.input.method, "POST", route);
    const challengeBody = await got.json();
    assert.deepEqual(challengeBody.accepts, gotRequired.accepts, route);
    assert.equal(challengeBody.x402Version, gotRequired.x402Version);
    assert.equal(challengeBody.code, "payment_required");
  }
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("HEAD on every discoverable route gets the same 402, with no body", async (t) => {
  const { url, facilitator } = await serve(t);
  for (const route of DISCOVERABLE) {
    const got = await fetch(`${url}${route}`, { method: "GET" });
    const gotRequired = decode(got.headers.get("payment-required"));

    const headed = await fetch(`${url}${route}`, { method: "HEAD" });
    assert.equal(headed.status, 402, route);
    assert.deepEqual(decode(headed.headers.get("payment-required")), gotRequired, `${route}: HEAD must match GET`);
    assert.equal(await headed.text(), "", `${route}: HEAD must not carry a body`);
  }
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("a payment header on GET or HEAD changes nothing: still the challenge, never verified or settled", async (t) => {
  const { url, facilitator } = await serve(t);
  for (const route of DISCOVERABLE) {
    const unpaidRequired = decode((await fetch(`${url}${route}`, { method: "GET" })).headers.get("payment-required"));
    for (const method of ["GET", "HEAD"]) {
      const paid = await fetch(`${url}${route}`, { method, headers: pay(unpaidRequired, BASE) });
      assert.equal(paid.status, 402, `${route} ${method}`);
      assert.deepEqual(decode(paid.headers.get("payment-required")), unpaidRequired, `${route} ${method}: still the standing offer`);
    }
  }
  // Not one of these GET/HEAD requests, paid or not, ever reached the facilitator or the model/Exa (`neverAsked`
  // would have thrown and failed the test outright if any upstream call had happened).
  assert.equal(facilitator.calls.verify, 0);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("routes not listed for discovery keep Express's plain 404 on GET and HEAD", async (t) => {
  const { url } = await serve(t);
  for (const route of [VIDEO_ROUTE, CREDIT_ROUTE, METERED_ROUTE]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${url}${route}`, { method });
      assert.equal(response.status, 404, `${route} ${method}`);
      assert.equal(response.headers.get("payment-required"), null, `${route} ${method}`);
    }
  }
});

test("free GET routes are unaffected", async (t) => {
  const { url } = await serve(t);
  for (const route of ["/health", "/numbers.json", "/v1/models", "/openapi.json", "/.well-known/x402", "/v1/images/models",
    "/v1/audio/models", "/v1/video/models"]) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("payment-required"), null, route);
  }
});

test("a GET that arrives before any POST still gets the full challenge, facilitator kinds included", async (t) => {
  for (const route of DISCOVERABLE) {
    const { url } = await serve(t);
    const got = await fetch(`${url}${route}`);
    assert.equal(got.status, 402, route);
    const gotRequired = decode(got.headers.get("payment-required"));
    const posted = decode((await fetch(`${url}${route}`, { method: "POST" })).headers.get("payment-required"));
    assert.deepEqual(gotRequired, posted, route);
  }
});

test("a browser opening a discoverable route with GET gets the same paywall page an empty POST gets", async (t) => {
  const { url } = await serve(t);
  const headers = { accept: "text/html", "user-agent": "Mozilla/5.0" };
  const posted = await fetch(`${url}${ROUTE}`, { method: "POST", headers });
  const got = await fetch(`${url}${ROUTE}`, { headers });
  assert.equal(got.status, posted.status);
  assert.equal(got.headers.get("content-type"), posted.headers.get("content-type"));
  assert.equal(await got.text(), await posted.text());
});

// Coinbase's Bazaar ranks listings by metadata completeness; a description that spends half its budget on billing
// reads as incomplete on what the endpoint does. Every discoverable route's resource description must stay short
// and billing-free (billing lives in openapi.json and /.well-known/x402 instead).
// CDP rejects over 500; only /v1/chat/completions spends past 300, on singit/auto and the free/ models.
const limit = (route) => (route === ROUTE ? 500 : 300);
const BILLING_WORDS = /\b(fee|markup|ceiling|settlement)\b|%/i;

test("every discoverable route's 402 resource description is short and billing-free", async (t) => {
  const { url } = await serve(t);
  for (const route of DISCOVERABLE) {
    const required = decode((await fetch(`${url}${route}`, { method: "GET" })).headers.get("payment-required"));
    const description = required.resource.description;
    assert.ok(description.length <= limit(route), `${route}: description is ${description.length} chars, over ${limit(route)}`);
    assert.doesNotMatch(description, BILLING_WORDS, `${route}: description mentions billing (${description})`);
  }
});

test("every discoverable route's resource carries a PNG icon and a service name", async (t) => {
  const { url } = await serve(t);
  for (const route of DISCOVERABLE) {
    const required = decode((await fetch(`${url}${route}`, { method: "GET" })).headers.get("payment-required"));
    assert.match(required.resource.iconUrl ?? "", /\.png$/, route);
    assert.ok(required.resource.serviceName, route);
  }
});

// SI-90: CDP's Bazaar search is semantic, and its top results for a generic query ("chat completions", "web search",
// "text to speech") have a serviceName that says what the service is and a description that opens with those words.
// Bazaar keeps only the first 5 tags, so the category tag has to be among them. Video is checked too, with its
// discovery switched on.
const EXPECTED = {
  [ROUTE]: { serviceName: "SingIt LLM Chat Completions", category: "chat-completions", opens: /^LLM chat completions\b/ },
  "/v1/messages": { serviceName: "SingIt Anthropic Messages API", category: "anthropic-messages", opens: /^Anthropic Messages API\b/ },
  "/v1/responses": { serviceName: "SingIt OpenAI Responses API", category: "openai-responses", opens: /^OpenAI Responses API\b/ },
  "/v1/exa/search": { serviceName: "SingIt Web Search (Exa)", category: "web-search", opens: /^Web search\b/ },
  "/v1/exa/answer": { serviceName: "SingIt Web Answers (Exa)", category: "web-search", opens: /^Web answers\b/ },
  "/v1/exa/contents": { serviceName: "SingIt Web Page Contents (Exa)", category: "web-page-contents", opens: /^Web page contents\b/ },
  [SPEECH_ROUTE]: { serviceName: "SingIt Text to Speech", category: "text-to-speech", opens: /^Text to speech\b/ },
  [IMAGE_ROUTE]: { serviceName: "SingIt Image Generation", category: "image-generation", opens: /^Image generation\b/ },
  [VIDEO_ROUTE]: { serviceName: "SingIt Video Generation", category: "video-generation", opens: /^Video generation\b/ },
  ...Object.fromEntries(MODEL_ROUTES.map((m) => [routePath(m.id), { serviceName: `SingIt ${m.name} Chat`,
    category: "chat-completions", also: [m.id], opens: new RegExp(`^${m.name.replace(/[.]/g, "\\.")} \\(`) }])),
};

test("every discoverable route is named and described by what it is, with its category among the first 5 tags", async (t) => {
  const { url } = await serve(t, { ...CONFIG, videoSold: true, videoDiscoverable: true });
  const routes = [...DISCOVERABLE, VIDEO_ROUTE];
  assert.deepEqual(new Set(routes), new Set(Object.keys(EXPECTED)), "every discoverable route has an expectation");
  for (const route of routes) {
    const required = decode((await fetch(`${url}${route}`, { method: "GET" })).headers.get("payment-required"));
    const { serviceName, description, tags } = required.resource;
    const expected = EXPECTED[route];
    assert.equal(serviceName, expected.serviceName, route);
    assert.ok(serviceName.length <= 60, `${route}: serviceName is ${serviceName.length} chars`);
    assert.ok(description.length <= limit(route), `${route}: description is ${description.length} chars, over ${limit(route)}`);
    assert.ok(!description.startsWith("SingIt "), `${route}: description opens with the brand (${description})`);
    assert.match(description, expected.opens, route);
    assert.match(description, /SingIt/, `${route}: the brand is named once, later`);
    assert.ok(tags.length <= 10, `${route}: ${tags.length} tags`);
    assert.equal(new Set(tags).size, tags.length, `${route}: duplicate tags`);
    for (const tag of [expected.category, ...(expected.also ?? [])]) {
      assert.ok(tags.slice(0, 5).includes(tag), `${route}: "${tag}" is not among the first 5 tags (${tags})`);
    }
  }
});

test("every discoverable route leads with upto on Base when it offers upto, else exact on Base, over both discovery and the empty POST probe", async (t) => {
  const { url } = await serve(t);
  for (const route of DISCOVERABLE) {
    for (const method of ["GET", "POST"]) {
      const required = decode((await fetch(`${url}${route}`, { method })).headers.get("payment-required"));
      const first = required.accepts[0];
      const metered = required.accepts.some((a) => a.scheme === "upto");
      // SI-102: a token-metered route's actual-cost `upto` offer leads; fixed-price routes offer only `exact`.
      assert.equal(first.scheme, metered ? "upto" : "exact", `${route} ${method}`);
      assert.equal(first.network, BASE, `${route} ${method}`);
      const firstExact = required.accepts.findIndex((a) => a.scheme === "exact");
      assert.ok(!metered || required.accepts.slice(firstExact).every((a) => a.scheme === "exact"),
        `${route} ${method}: every upto offer comes before every exact offer`);
    }
  }
});
