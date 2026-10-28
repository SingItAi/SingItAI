// SingIt video: the list price per clip + 30% + the fee, charged once Surplus accepted the job; polling and the file
// free with the job's token, which Surplus itself checks; no seller shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel, parseVideoModels } from "../src/catalogue.mjs";
import { VIDEO_ROUTE, publicJob, readVideoRequest, videoPrice, videoListAtomic, pickFallbacks, isSoldVideoModel } from "../src/video.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash", videoSold: true };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const VIDEOS = parseVideoModels({ data: [
  { id: "venice-seedance-2-fast-t2v", architecture: { modality: "video" }, pricing: { image: "0.08", media_unit: "job" },
    supported_parameters: ["video", "async", "text-to-video", "audio"], resolutions: ["720p", "480p"], aspect_ratios: ["16:9", "9:16"] },
  { id: "ovi-image-to-video", architecture: { modality: "video" }, pricing: { image: "0.044", media_unit: "job" },
    supported_parameters: ["video", "async", "image-to-video"] },
  { id: "uncensored-t2v-turbo", architecture: { modality: "video" }, pricing: { image: "0.12", media_unit: "job" },
    supported_parameters: ["video", "async", "text-to-video"] },
] });
const catalogue = { async videoModels() { return VIDEOS; }, async imageModels() { return new Map(); },
  async resolveVideo(id) { const m = VIDEOS.get(id); if (!m) throw new UnknownModel("That video model is not available."); return m; },
  async resolveImage() { throw new UnknownModel("no"); }, async list() { return []; }, async resolve() { throw new Error("no"); } };

function fakeFacilitator() {
  const calls = { settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar"], signers: {} };
    },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

// Surplus's video API: submit with the key, poll and download with the job token, as its docs describe.
function fakeSurplus({ submitStatus = 202, jobStatus = "running" } = {}) {
  const calls = [];
  const job = (status) => ({ id: "vj_123456", object: "video.generation", status, model: "venice-seedance-2-fast-t2v",
    provider: "venice", usage: { seller_cost_usdc: 60000, buyer_cost_usdc: 62000 },
    results: status === "succeeded" ? [{ url: "/v1/video/generations/vj_123456/artifacts/0", mime_type: "video/mp4" }] : [] });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "POST") {
      if (submitStatus !== 202) return new Response('{"error":{"code":"insufficient_balance"}}', { status: submitStatus });
      return new Response(JSON.stringify({ ...job("queued"), job_token: "tok_secret", estimated_cost_usdc: 80000 }), { status: 202 });
    }
    if (init.headers?.["X-Job-Token"] !== "tok_secret") return new Response('{"error":"forbidden"}', { status: 403 });
    if (u.pathname.endsWith("/artifacts/0")) return new Response("MP4DATA", { headers: { "content-type": "video/mp4" } });
    return new Response(JSON.stringify(job(jobStatus)), { status: jobStatus === "succeeded" ? 200 : 202 });
  };
  return { calls, fetchImpl };
}

async function serve(t, { surplus = fakeSurplus(), config = CONFIG, health = new Map([["venice-seedance-2-fast-t2v", 2]]), models = VIDEOS } = {}) {
  const facilitator = fakeFacilitator();
  const logs = [];
  const app = createApp(config, { facilitatorClient: facilitator,
    catalogue: { ...catalogue, async videoModels() { return models; },
      async resolveVideo(id) { const m = models.get(id); if (!m) throw new UnknownModel("Unknown model"); return m; },
      async videoHealth(id) { return health.get(id) ?? null; },
      async videoServed() { return health; } }, fetchImpl: surplus.fetchImpl,
    log: (line) => logs.push(line), upstream: async () => { throw new Error("no answer is asked"); } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, surplus, logs };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const pay = (required, network) => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network), payload: { signature: "0xsigned" },
  extensions: required.extensions }) });
const VIDEO = { model: "venice-seedance-2-fast-t2v", prompt: "a green robot waves", resolution: "480p", aspect_ratio: "16:9" };

test("only text-to-video models priced per job are sold, never uncensored ones", () => {
  assert.deepEqual([...VIDEOS.keys()], ["venice-seedance-2-fast-t2v"]);
});

test("a clip is offered at its list price + 30% + the fee; nothing is started before payment", async (t) => {
  const { url, surplus } = await serve(t);
  const unpaid = await post(`${url}${VIDEO_ROUTE}`, VIDEO);
  assert.equal(unpaid.status, 402);
  const required = decode(unpaid.headers.get("payment-required"));
  assert.deepEqual(required.accepts.map((a) => [a.network, a.amount]), [[BASE, "261000"], [SOLANA, "262000"]]);
  assert.ok(required.extensions?.bazaar);
  assert.deepEqual(surplus.calls, []);
});

test("a paid clip starts one job, the payer is settled once it is accepted, and gets its id and token", async (t) => {
  const { url, surplus, facilitator } = await serve(t);
  const required = decode((await post(`${url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
  const paid = await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, BASE));
  assert.equal(paid.status, 200);
  const job = await paid.json();
  assert.deepEqual([job.id, job.status, job.job_token, job.poll, job.billing.totalAtomic],
    ["vj_123456", "queued", "tok_secret", "/v1/video/generations/vj_123456", "261000"]);
  assert.equal(job.provider, undefined, "no seller shown");
  const submit = surplus.calls[0];
  assert.deepEqual([submit.method, submit.headers.Authorization, submit.body],
    ["POST", "Bearer inf_test", { model: "venice-seedance-2-fast-t2v", prompt: "a green robot waves", resolution: "480p", aspect_ratio: "16:9" }]);
  assert.match(submit.headers["Idempotency-Key"], /^singit-[0-9a-f]{64}$/);
  assert.deepEqual(facilitator.calls.settle, [[BASE, "261000"]]);
  assert.equal((await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, BASE))).status, 409);
});

test("a job Surplus does not accept costs nothing", async (t) => {
  const { url, facilitator } = await serve(t, { surplus: fakeSurplus({ submitStatus: 402 }) });
  const required = decode((await post(`${url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
  assert.equal((await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, SOLANA))).status, 503);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("polling and the file are free with the job's token, and nothing without it", async (t) => {
  const running = await serve(t);
  const pending = await fetch(`${running.url}${VIDEO_ROUTE}/vj_123456`, { headers: { "X-Job-Token": "tok_secret" } });
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).status, "running");
  assert.equal((await fetch(`${running.url}${VIDEO_ROUTE}/vj_123456/content?token=tok_secret`)).status, 409, "not ready yet");

  const done = await serve(t, { surplus: fakeSurplus({ jobStatus: "succeeded" }) });
  const finished = await fetch(`${done.url}${VIDEO_ROUTE}/vj_123456?token=tok_secret`);
  assert.equal(finished.status, 200);
  const job = await finished.json();
  assert.deepEqual(job.results, [{ index: 0, url: `${done.url}${VIDEO_ROUTE}/vj_123456/content?index=0`, content_type: "video/mp4" }]);
  assert.equal(job.usage, undefined, "no seller costs shown");
  const file = await fetch(`${done.url}${VIDEO_ROUTE}/vj_123456/content?index=0`, { headers: { "X-Job-Token": "tok_secret" } });
  assert.equal(file.headers.get("content-type"), "video/mp4");
  assert.equal(await file.text(), "MP4DATA");
  assert.equal((await fetch(`${done.url}${VIDEO_ROUTE}/vj_123456`, { headers: { "X-Job-Token": "wrong" } })).status, 403);
  assert.equal((await fetch(`${done.url}${VIDEO_ROUTE}/vj_123456`)).status, 400);
  assert.ok(done.surplus.calls.every((c) => c.headers.Authorization === undefined), "SingIt's key never opens a job here");
});

test("what is not sold is refused before any payment is asked", async (t) => {
  const { url, surplus } = await serve(t);
  for (const [body, status] of [[{ ...VIDEO, model: "uncensored-t2v-turbo" }, 404], [{ ...VIDEO, model: "ovi-image-to-video" }, 404],
    [{ ...VIDEO, prompt: "" }, 400], [{ ...VIDEO, resolution: "4k" }, 400], [{ ...VIDEO, aspect_ratio: "5:4" }, 400],
    [{ ...VIDEO, duration_seconds: 60 }, 400]]) {
    const refused = await post(`${url}${VIDEO_ROUTE}`, body);
    assert.equal(refused.status, status, JSON.stringify(body));
    assert.equal(refused.headers.get("payment-required"), null);
  }
  assert.deepEqual(surplus.calls, []);
});

test("by default video is not listed: an empty probe, GET and HEAD keep the 404, and discovery files omit it", async (t) => {
  const { url, surplus } = await serve(t);
  for (const init of [{ method: "POST" }, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
                      { method: "GET" }, { method: "HEAD" }]) {
    const probe = await fetch(`${url}${VIDEO_ROUTE}`, init);
    assert.equal(probe.status, 404, `${init.method} ${init.body ?? ""}`);
    assert.equal(probe.headers.get("payment-required"), null);
  }
  assert.ok(!JSON.stringify(await (await fetch(`${url}/.well-known/x402`)).json()).includes(VIDEO_ROUTE));
  assert.ok(!(await (await fetch(`${url}/llms.txt`)).text()).includes(VIDEO_ROUTE));
  assert.deepEqual(surplus.calls, []);
});

test("with videoDiscoverable on, an empty unpaid probe gets the standing offer, so x402scan and Bazaar can index video", async (t) => {
  const { url, surplus } = await serve(t, { config: { ...CONFIG, videoDiscoverable: true } });
  for (const init of [{ method: "POST" }, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
                      { method: "GET" }]) {
    const probe = await fetch(`${url}${VIDEO_ROUTE}`, init);
    assert.equal(probe.status, 402, `${init.method} ${init.body ?? ""}`);
    const required = JSON.parse(Buffer.from(probe.headers.get("payment-required"), "base64").toString());
    assert.deepEqual(required.accepts.map((a) => a.network), [BASE, SOLANA], "exact on Base first");
    assert.ok(required.extensions?.bazaar);
  }
  assert.ok(JSON.stringify(await (await fetch(`${url}/.well-known/x402`)).json()).includes(VIDEO_ROUTE));
  assert.deepEqual(surplus.calls, [], "a probe never starts a job");
});

test("paying with no question is refused before any job, and before the payment is verified", async (t) => {
  const { url, surplus, facilitator } = await serve(t, { config: { ...CONFIG, videoDiscoverable: true } });
  const probe = await fetch(`${url}${VIDEO_ROUTE}`, { method: "POST" });
  const required = JSON.parse(Buffer.from(probe.headers.get("payment-required"), "base64").toString());
  const refused = await post(`${url}${VIDEO_ROUTE}`, {}, pay(required, BASE));
  assert.equal(refused.status, 404);
  assert.deepEqual(surplus.calls, []);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("prices, the request and the free model list", async (t) => {
  assert.deepEqual(videoPrice(80000, SOLANA), { listAtomic: "80000", markupAtomic: "24000", feeAtomic: "2000", totalAtomic: "106000" });
  assert.deepEqual(readVideoRequest({ prompt: "x", audio: true }, VIDEOS.get("venice-seedance-2-fast-t2v")),
    { model: "venice-seedance-2-fast-t2v", prompt: "x", audio: true });
  assert.equal(publicJob({ id: "a", status: "failed", error: { code: "provider_error", message: "no" } }, "o").error.code, "provider_error");
  const { url } = await serve(t);
  const list = await (await fetch(`${url}/v1/video/models`)).json();
  assert.deepEqual(list.data.map((m) => [m.id, m.listUsdPerJob, m.singitUsdPerJob]), [["venice-seedance-2-fast-t2v", 0.08, 0.261]]);
});

// Video is off unless SINGIT_ASK_VIDEO_SOLD=1: a paid job could fail after settlement (27.10.2026). Off, a new job is
// refused before any payment offer, the model list says so, discovery and openapi leave it out, and polling still works.
test("with video off, nothing is offered or started; already-paid jobs can still be polled", async (t) => {
  const { videoSold, ...off } = CONFIG;
  const { url, surplus, facilitator } = await serve(t, { config: { ...off, videoDiscoverable: true } });
  const unpaid = await post(`${url}${VIDEO_ROUTE}`, VIDEO);
  assert.equal(unpaid.status, 503);
  assert.equal(unpaid.headers.get("payment-required"), null);
  assert.equal((await unpaid.json()).error.code, "video_disabled");
  const probe = await fetch(`${url}${VIDEO_ROUTE}`, { method: "POST" });
  assert.equal(probe.status, 503, "the empty discovery probe gets no offer either");
  for (const method of ["GET", "HEAD"]) {
    const r = await fetch(`${url}${VIDEO_ROUTE}`, { method });
    assert.equal(r.status, 404, method);
    assert.equal(r.headers.get("payment-required"), null, method);
  }
  const forged = await post(`${url}${VIDEO_ROUTE}`, VIDEO, { "PAYMENT-SIGNATURE": encode({ x402Version: 2 }) });
  assert.equal(forged.status, 503, "a payment header is not even read");
  const models = await fetch(`${url}/v1/video/models`);
  assert.equal(models.status, 503);
  assert.equal((await models.json()).error.code, "video_disabled");
  const listed = await (await fetch(`${url}/.well-known/x402`)).json();
  assert.ok(!listed.resources.some((r) => r.includes("/v1/video")), "not in discovery even with videoDiscoverable");
  assert.ok(!/video/i.test(await (await fetch(`${url}/llms.txt`)).text()));
  const openapi = await (await fetch(`${url}/openapi.json`)).json();
  assert.ok(!Object.keys(openapi.paths).some((p) => p.startsWith("/v1/video")));
  assert.equal(surplus.calls.length, 0, "Surplus is never asked to start a job");
  assert.equal(facilitator.calls.settle.length, 0);
  const poll = await fetch(`${url}${VIDEO_ROUTE}/01M5STJCFTVSC5588N9YGQCPQW`, { headers: { "X-Job-Token": "jt_x" } });
  assert.notEqual(poll.status, 503, "polling a paid job still reaches Surplus");
});

test("video health refuses zero sellers before payment and allows unknown health", async (t) => {
  for (const count of [0, null, 2]) {
    const { url, surplus, facilitator, logs } = await serve(t, { health: new Map([[VIDEO.model, count]]) });
    const response = await post(`${url}${VIDEO_ROUTE}`, VIDEO);
    assert.equal(response.status, count === 0 ? 503 : 402);
    if (count === 0) {
      assert.equal(response.headers.get("payment-required"), null);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.deepEqual((await response.json()).error, { type: "upstream_error", code: "no_healthy_sellers",
        message: "No seller can run this video model right now. Nothing was charged." });
      assert.equal(logs.length, 1);
    }
    assert.deepEqual(surplus.calls, []);
    assert.deepEqual(facilitator.calls.settle, []);
  }
});

test("video listing hides zero sellers and reports counts, failing open only for an empty health map", async (t) => {
  for (const [health, expected] of [[new Map([[VIDEO.model, 0]]), []],
    [new Map([[VIDEO.model, 3]]), [[VIDEO.model, 3]]], [new Map([["other", 1]]), []],
    [new Map(), [[VIDEO.model, null]]]]) {
    const { url } = await serve(t, { health });
    const list = await (await fetch(`${url}/v1/video/models`)).json();
    assert.deepEqual(list.data.map((m) => [m.id, m.healthySellers]), expected);
  }
});

const model = (id, usdPerJob = 0.2, extra = {}) => ({ ...VIDEOS.get(VIDEO.model), id, usdPerJob, ...extra });

test("price floor and fallback selection respect price, health, compatibility, ordering and limit", () => {
  assert.equal(videoPrice(videoListAtomic(model("cheap", 0.08)), BASE).totalAtomic, "261000");
  assert.equal(videoPrice(videoListAtomic(model("higher", 0.4)), BASE).totalAtomic, "521000");
  assert.equal(isSoldVideoModel("UnCeNsOrEd-t2v"), false);
  const models = [model("requested", 0.4), model("b", 0.3), model("a", 0.3), model("c", 0.3),
    model("cheap", 0.08), model("expensive", 0.5), model("unknown"), model("dead"),
    model("incompatible", 0.4, { durations: [10] }), model("uncensored-t2v-turbo")];
  const health = new Map(models.filter((m) => m.id !== "unknown").map((m) => [m.id, m.id === "dead" ? 0 : 2]));
  health.set("c", 3);
  const args = { models, health, requested: "requested", signedListAtomic: 400000,
    body: { ...VIDEO, duration_seconds: 5 } };
  assert.deepEqual(pickFallbacks(args).map((m) => m.id), ["c", "a"]);
  assert.deepEqual(pickFallbacks({ ...args, models: new Map(models.map((m) => [m.id, m])), max: 4 })
    .map((m) => m.id), ["c", "a", "b", "cheap"]);
});

test("unhealthy requested model substitutes at its signed quote and settles exactly once", async (t) => {
  const models = new Map([model(VIDEO.model, 0.4), model("fallback", 0.2)].map((m) => [m.id, m]));
  const { url, surplus, facilitator, logs } = await serve(t, { models,
    health: new Map([[VIDEO.model, 0], ["fallback", 2]]) });
  const offer = await post(`${url}${VIDEO_ROUTE}`, VIDEO);
  assert.equal(offer.status, 402);
  const required = decode(offer.headers.get("payment-required"));
  assert.equal(required.accepts[0].amount, "521000");
  const response = await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, BASE));
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.deepEqual([job.model, job.requested_model, job.substituted, job.billing.totalAtomic],
    ["fallback", VIDEO.model, true, "521000"]);
  assert.deepEqual(surplus.calls.map((c) => c.body.model), ["fallback"]);
  assert.equal(surplus.calls[0].body.fallback, undefined);
  assert.deepEqual(facilitator.calls.settle, [[BASE, "521000"]]);
  assert.equal(logs.filter((line) => line.includes("substitution")).length, 1);
});

test("pricier and uncensored candidates cannot open payment; fallback opt-out and type are checked", async (t) => {
  for (const [candidate, body, status] of [[model("expensive", 0.4), VIDEO, 503],
    [model("uncensored-t2v-turbo", 0.08), VIDEO, 503],
    [model("fallback"), { ...VIDEO, fallback: false }, 503],
    [model("fallback"), { ...VIDEO, fallback: "yes" }, 400],
    [model("uncensored-t2v-turbo"), { ...VIDEO, model: "uncensored-t2v-turbo" }, 404]]) {
    const models = new Map([model(VIDEO.model), candidate].map((m) => [m.id, m]));
    const { url, surplus } = await serve(t, { models, health: new Map([[VIDEO.model, 0], [candidate.id, 2]]) });
    const response = await post(`${url}${VIDEO_ROUTE}`, body);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("payment-required"), null);
    const error = (await response.json()).error;
    if (status === 503) assert.equal(error.code, "no_healthy_sellers");
    if (status === 404) assert.equal(error.code, "model_not_found");
    assert.deepEqual(surplus.calls, []);
  }
});

test("submit failures retry within the quote; exhaustion and invalid requests never settle", async (t) => {
  for (const outcome of ["success", "exhausted", "invalid", "unreachable"]) {
    const calls = [];
    const surplus = { calls, async fetchImpl(_url, init) {
      calls.push({ body: JSON.parse(init.body), key: init.headers["Idempotency-Key"] });
      if (calls.length === 1 && outcome === "unreachable") throw new TypeError("offline");
      if (outcome === "invalid") return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
      if (calls.length === 1 || outcome === "exhausted") {
        return Response.json({ error: { code: "no_healthy_sellers" } }, { status: 503 });
      }
      return Response.json({ id: "vj_123456", status: "queued", job_token: "tok_secret" }, { status: 202 });
    } };
    const models = new Map([model(VIDEO.model), model("fallback")].map((m) => [m.id, m]));
    const { url, facilitator } = await serve(t, { models, surplus,
      health: new Map([[VIDEO.model, 2], ["fallback", 2]]) });
    const required = decode((await post(`${url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
    const response = await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, BASE));
    const success = outcome === "success" || outcome === "unreachable";
    assert.equal(response.status, success ? 200 : 503);
    assert.equal(calls.length, outcome === "invalid" ? 1 : 2);
    assert.equal(calls[0].body.model, VIDEO.model);
    if (calls.length === 2) {
      assert.equal(calls[1].body.model, "fallback");
      assert.equal(calls[1].key, `${calls[0].key}-1`);
    }
    assert.deepEqual(facilitator.calls.settle, success ? [[BASE, "261000"]] : []);
    if (!success) {
      assert.equal(response.headers.get("retry-after"), "30");
      assert.equal((await response.json()).error.code, "no_healthy_sellers");
    }
  }
});
