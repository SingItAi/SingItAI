// SingIt video: the list price per clip + 30% + the fee, charged once the clip succeeds; polling and the file
// free with the job's token, which Surplus itself checks; no seller shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel, parseVideoModels } from "../src/catalogue.mjs";
import { VIDEO_ROUTE, publicJob, readVideoRequest, safeLog, videoPrice, videoListAtomic, pickFallbacks, isSoldVideoModel } from "../src/video.mjs";

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
function fakeSurplus({ submitStatus = 202, jobStatus = "succeeded", scripts = [], submitError = { code: "insufficient_balance" } } = {}) {
  const calls = [];
  let submitted = 0;
  const positions = [];
  const job = (status) => ({ id: "vj_123456", object: "video.generation", status, model: "venice-seedance-2-fast-t2v",
    provider: "venice", usage: { seller_cost_usdc: 60000, buyer_cost_usdc: 62000 },
    results: status === "succeeded" ? [{ url: "/v1/video/generations/vj_123456/artifacts/0", mime_type: "video/mp4" }] : [] });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "POST") {
      submitted++;
      if (submitStatus !== 202) return Response.json({ error: submitError }, { status: submitStatus });
      return new Response(JSON.stringify({ ...job("queued"), job_token: "tok_secret", estimated_cost_usdc: 80000 }), { status: 202 });
    }
    if (init.headers?.["X-Job-Token"] !== "tok_secret") return new Response('{"error":"forbidden"}', { status: 403 });
    if (u.pathname.endsWith("/artifacts/0")) return new Response("MP4DATA", { headers: { "content-type": "video/mp4" } });
    const sequence = scripts[submitted - 1];
    const pos = positions[submitted - 1] ?? 0;
    positions[submitted - 1] = pos + 1;
    const next = sequence?.[Math.min(pos, sequence.length - 1)] ?? jobStatus;
    if (next === "throw") throw new TypeError("offline");
    if (next === 500) return Response.json({}, { status: 500 });
    const update = typeof next === "string" ? job(next) : { ...job(next.status), ...next };
    return new Response(JSON.stringify(update), { status: ["succeeded", "failed", "canceled", "expired"].includes(update.status) ? 200 : 202 });
  };
  return { calls, fetchImpl };
}

async function serve(t, { surplus = fakeSurplus(), config = CONFIG, health = new Map([["venice-seedance-2-fast-t2v", 2]]), models = VIDEOS } = {}) {
  let time = 0;
  config = { videoNow: () => time, videoSleep: async (ms) => { time += ms; }, ...config };
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
  assert.ok(required.accepts.every((a) => a.maxTimeoutSeconds === 150));
  assert.deepEqual(surplus.calls, []);
});

test("a paid clip starts one job, the payer is settled once it succeeds, and gets its id and token", async (t) => {
  const { url, surplus, facilitator } = await serve(t);
  const required = decode((await post(`${url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
  const paid = await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, BASE));
  assert.equal(paid.status, 200);
  const job = await paid.json();
  assert.deepEqual([job.id, job.status, job.job_token, job.poll, job.billing.totalAtomic],
    ["vj_123456", "succeeded", "tok_secret", "/v1/video/generations/vj_123456", "261000"]);
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
  const running = await serve(t, { surplus: fakeSurplus({ jobStatus: "running" }) });
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
  assert.deepEqual(surplus.calls.filter((c) => c.method === "POST").map((c) => c.body.model), ["fallback"]);
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
  for (const outcome of ["success", "exhausted", "invalid"]) {
    const calls = [];
    const surplus = { calls, async fetchImpl(_url, init) {
      if (init.method !== "POST") return Response.json({ id: "vj_123456", status: "succeeded",
        results: [{ url: "/clip.mp4" }] });
      calls.push({ body: JSON.parse(init.body), key: init.headers["Idempotency-Key"] });
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
    const success = outcome === "success";
    assert.equal(response.status, success ? 200 : outcome === "invalid" ? 400 : 503);
    assert.equal(calls.length, outcome === "invalid" ? 1 : 2);
    assert.equal(calls[0].body.model, VIDEO.model);
    if (calls.length === 2) {
      assert.equal(calls[1].body.model, "fallback");
      assert.equal(calls[1].key, `${calls[0].key}-1`);
    }
    assert.deepEqual(facilitator.calls.settle, success ? [[BASE, "261000"]] : []);
    if (!success && outcome !== "invalid") {
      assert.equal(response.headers.get("retry-after"), "30");
      assert.equal((await response.json()).error.code, "no_healthy_sellers");
    }
  }
});

// These requests pass through the real payment middleware: an empty settle log on >=400 proves that holding
// the response protects the payer even when Surplus initially accepted a job, as in the 27.10 failures.
const unavailable = { status: "failed", error: { type: "provider_unavailable", message: "Unavailable" } };
const submissions = (surplus) => surplus.calls.filter((c) => c.method === "POST");
const deletions = (surplus) => surplus.calls.filter((c) => c.method === "DELETE");
async function paidVideo(service, network = BASE) {
  const required = decode((await post(`${service.url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
  return post(`${service.url}${VIDEO_ROUTE}`, VIDEO, pay(required, network));
}

test("queued then running then succeeded settles once with results after two polls", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [["running", "succeeded"]] }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.status, "succeeded");
  assert.equal(job.results.length, 1);
  assert.equal(service.surplus.calls.filter((c) => c.method === "GET").length, 2);
  assert.deepEqual(service.facilitator.calls.settle, [[BASE, "261000"]]);
});

test("accepted then provider_unavailable returns video_failed without settlement or cancellation", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [[unavailable]] }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.deepEqual((await response.json()).error, { type: "upstream_error", code: "video_failed",
    message: "The video could not be made. You were not charged." });
  assert.deepEqual(service.facilitator.calls.settle, []);
  assert.deepEqual(deletions(service.surplus), []);
});

test("retryable accepted failure uses a distinct cheaper attempt and settles the signed quote once", async (t) => {
  const models = new Map([model(VIDEO.model, 0.4), model("fallback", 0.2)].map((m) => [m.id, m]));
  const service = await serve(t, { models, health: new Map([[VIDEO.model, 2], ["fallback", 2]]),
    surplus: fakeSurplus({ scripts: [[unavailable], ["succeeded"]] }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.deepEqual([job.model, job.requested_model, job.substituted], ["fallback", VIDEO.model, true]);
  const calls = submissions(service.surplus);
  assert.deepEqual(calls.map((c) => c.body.model), [VIDEO.model, "fallback"]);
  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.deepEqual(service.facilitator.calls.settle, [[BASE, "521000"]]);
});

test("failure near the deadline cannot start a fallback", async (t) => {
  const models = new Map([model(VIDEO.model), model("fallback")].map((m) => [m.id, m]));
  const service = await serve(t, { models, health: new Map([[VIDEO.model, 2], ["fallback", 2]]),
    config: { ...CONFIG, videoPollMs: 70_000 }, surplus: fakeSurplus({ scripts: [[unavailable]] }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "video_failed");
  assert.equal(submissions(service.surplus).length, 1);
  assert.deepEqual(service.facilitator.calls.settle, []);
});

test("timeout cancels with the job token and never settles", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ jobStatus: "running" }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "video_timeout");
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(deletions(service.surplus).length, 1);
  assert.equal(deletions(service.surplus)[0].headers["X-Job-Token"], "tok_secret");
  assert.deepEqual(service.facilitator.calls.settle, []);
});

test("Base can serve a 60 second clip while Solana stops at its 35 second window", async (t) => {
  for (const network of [BASE, SOLANA]) {
    let time = 0;
    const service = await serve(t, { config: { ...CONFIG, videoPollMs: 10_000,
      videoNow: () => time, videoSleep: async (ms) => { time += ms; } },
      surplus: fakeSurplus({ scripts: [[...Array(5).fill("running"), "succeeded"]] }) });
    const response = await paidVideo(service, network);
    assert.equal(response.status, network === BASE ? 200 : 503);
    assert.equal(time, network === BASE ? 60_000 : 35_000);
    assert.deepEqual(service.facilitator.calls.settle, network === BASE ? [[BASE, "261000"]] : []);
  }
});

test("transient thrown and 500 polls can recover without another submission", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [["throw", 500, "succeeded"]] }) });
  assert.equal((await paidVideo(service)).status, 200);
  assert.equal(submissions(service.surplus).length, 1);
  assert.deepEqual(service.facilitator.calls.settle, [[BASE, "261000"]]);
});

test("invalid_request terminal failure returns only its message and never settles", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [[{ status: "failed",
    error: { type: "invalid_request", message: "Prompt refused", retryable: false } }]] }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { type: "invalid_request_error", message: "Prompt refused" } });
  assert.deepEqual(service.facilitator.calls.settle, []);
});

test("succeeded without a file is a nonbillable failure", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [[{ status: "succeeded", results: [] }]] }) });
  const response = await paidVideo(service);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "video_failed");
  assert.deepEqual(service.facilitator.calls.settle, []);
});

test("a replay during the hold cannot start a second job or settle twice", async (t) => {
  let release, held;
  const waiting = new Promise((resolve) => { held = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const service = await serve(t, { config: { ...CONFIG, videoSleep: async () => { held(); await gate; } } });
  const required = decode((await post(`${service.url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
  const headers = pay(required, BASE);
  const first = post(`${service.url}${VIDEO_ROUTE}`, VIDEO, headers);
  await waiting;
  try {
    assert.equal((await post(`${service.url}${VIDEO_ROUTE}`, VIDEO, headers)).status, 409);
    assert.equal(submissions(service.surplus).length, 1);
    assert.deepEqual(service.facilitator.calls.settle, []);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.deepEqual(service.facilitator.calls.settle, [[BASE, "261000"]]);
});

test("fallback submit 400 skips incompatible substitute and tries the next healthy model", async (t) => {
  const surplus = fakeSurplus();
  const fetchImpl = surplus.fetchImpl;
  surplus.fetchImpl = async (url, init) => {
    if (init.method === "POST" && JSON.parse(init.body).model === "a") {
      surplus.calls.push({ method: "POST", body: JSON.parse(init.body), headers: init.headers });
      return Response.json({ error: { type: "invalid_request", message: "Unsupported parameter" } }, { status: 400 });
    }
    return fetchImpl(url, init);
  };
  const models = new Map([model(VIDEO.model), model("a"), model("b")].map((m) => [m.id, m]));
  const service = await serve(t, { models, surplus, health: new Map([[VIDEO.model, 0], ["a", 2], ["b", 2]]) });
  const response = await paidVideo(service);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "b");
  assert.deepEqual(submissions(surplus).map((c) => c.body.model), ["a", "b"]);
  assert.deepEqual(service.facilitator.calls.settle, [[BASE, "261000"]]);
});

test("requested submit invalid_request returns its message or a generic refusal without settlement", async (t) => {
  for (const message of ["The prompt is too long.", undefined]) {
    const service = await serve(t, { surplus: fakeSurplus({ submitStatus: 400,
      submitError: { type: "invalid_request", message } }) });
    const response = await paidVideo(service);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { type: "invalid_request_error",
      message: message ?? "The video request was refused." } });
    assert.equal(submissions(service.surplus).length, 1);
    assert.deepEqual(service.facilitator.calls.settle, []);
  }
});

test("a substitute that refuses the request after acceptance ends that attempt, the next healthy model still runs", async (t) => {
  const models = new Map([model(VIDEO.model, 0.4), model("fallback-a", 0.3), model("fallback-b", 0.2)].map((m) => [m.id, m]));
  const service = await serve(t, { models, health: new Map([[VIDEO.model, 2], ["fallback-a", 2], ["fallback-b", 2]]),
    surplus: fakeSurplus({ scripts: [[unavailable], [{ status: "failed", error: { type: "invalid_request", retryable: false } }],
      ["succeeded"]] }), config: { ...CONFIG, videoHoldMs: 85_000 } });
  const response = await paidVideo(service);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "fallback-b");
  assert.deepEqual(submissions(service.surplus).map((c) => c.body.model), [VIDEO.model, "fallback-a", "fallback-b"]);
  assert.deepEqual(service.facilitator.calls.settle, [[BASE, "521000"]]);
});

test("a submit whose outcome is unknown never starts a second model for the same payment", async (t) => {
  for (const mode of ["offline", "http500", "no_job"]) {
    const calls = [];
    const surplus = { calls, async fetchImpl(_url, init) {
      calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (mode === "offline") throw new TypeError("offline");
      if (mode === "http500") return Response.json({ error: {} }, { status: 500 });
      return Response.json({ status: "queued" }, { status: 202 });
    } };
    const models = new Map([model(VIDEO.model), model("fallback")].map((m) => [m.id, m]));
    const service = await serve(t, { models, surplus, health: new Map([[VIDEO.model, 2], ["fallback", 2]]) });
    const response = await paidVideo(service);
    assert.equal(response.status, 503, mode);
    assert.equal((await response.json()).error.code, "video_failed");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1, mode);
    assert.deepEqual(service.facilitator.calls.settle, [], mode);
  }
});

// A paid test on 28.10 answered video_failed after 65 s with nothing in the log saying why: every video job that
// does not give a clip now writes one JSON line with the reason.
const failLines = (service) => service.logs.filter((l) => l.startsWith("singit-ask: video job not delivered "))
  .map((l) => JSON.parse(l.slice("singit-ask: video job not delivered ".length)));

test("a job Surplus fails is logged with its id, status, error fields, elapsed time and the reason upstream_failed", async (t) => {
  let time = 0;
  const failure = { status: "failed", error: { type: "provider_unavailable", code: "provider_unavailable",
    message: "No provider could accept this job right now. Please retry.", retryable: true } };
  const service = await serve(t, { config: { ...CONFIG, videoPollMs: 10_000, videoNow: () => time,
    videoSleep: async (ms) => { time += ms; } }, surplus: fakeSurplus({ scripts: [[...Array(5).fill("running"), failure]] }) });
  assert.equal((await paidVideo(service)).status, 503);
  assert.deepEqual(failLines(service), [{ reason: "upstream_failed", job_id: "vj_123456", model: VIDEO.model, status: "failed",
    http_status: 200, error_code: "provider_unavailable", error_type: "provider_unavailable",
    error_message: "No provider could accept this job right now. Please retry.", retryable: true, results: 0,
    elapsed_s: 60, remaining_s: 25, next: "none" }]);
  assert.deepEqual(service.facilitator.calls.settle, []);
});

test("the 20 s retry guard is logged as window_cutoff and only ever applies to a job that already failed", async (t) => {
  const models = new Map([model(VIDEO.model), model("fallback")].map((m) => [m.id, m]));
  const service = await serve(t, { models, health: new Map([[VIDEO.model, 2], ["fallback", 2]]),
    config: { ...CONFIG, videoPollMs: 70_000 }, surplus: fakeSurplus({ scripts: [[unavailable]] }) });
  assert.equal((await paidVideo(service)).status, 503);
  const [line] = failLines(service);
  assert.deepEqual([line.reason, line.cause, line.elapsed_s, line.remaining_s, line.next], ["window_cutoff", "upstream_failed", 70, 15, "none"]);
  assert.equal(submissions(service.surplus).length, 1);
});

test("a job that is still running at 70 s is not cut by the retry guard: it is polled to the end of the window", async (t) => {
  let time = 0;
  const service = await serve(t, { config: { ...CONFIG, videoPollMs: 10_000, videoNow: () => time,
    videoSleep: async (ms) => { time += ms; } }, surplus: fakeSurplus({ scripts: [[...Array(6).fill("running"), "succeeded"]] }) });
  assert.equal((await paidVideo(service)).status, 200);
  assert.equal(time, 70_000);
  assert.deepEqual(failLines(service), []);
});

test("a job still running at the end of the window is logged as poll_timeout", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ jobStatus: "running" }) });
  assert.equal((await paidVideo(service)).status, 503);
  const [line] = failLines(service);
  assert.deepEqual([line.reason, line.status, line.job_id, line.elapsed_s], ["poll_timeout", "running", "vj_123456", 85]);
});

test("a succeeded job with no file is logged as no_result_file", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [[{ status: "succeeded", results: [] }]] }) });
  assert.equal((await paidVideo(service)).status, 503);
  assert.deepEqual([failLines(service)[0].reason, failLines(service)[0].status, failLines(service)[0].results], ["no_result_file", "succeeded", 0]);
});

test("poll errors are counted in the log line, and secrets in Surplus's text never reach it", async (t) => {
  const key = "inf_" + "k".repeat(20);
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [["throw", 500, { status: "failed", error: { type: "provider_error",
    message: `Bearer ${key} rejected token tok_secret jt_abcdef123456 ` + "x".repeat(400), retryable: true } }]] }) });
  assert.equal((await paidVideo(service)).status, 503);
  const raw = service.logs.join("\n");
  for (const secret of [key, "jt_abcdef123456", "Bearer"]) assert.ok(!raw.includes(secret), secret);
  assert.ok(!raw.includes("PAYMENT-SIGNATURE") && !raw.toLowerCase().includes("0xsigned"));
  const [line] = failLines(service);
  assert.equal(line.poll_errors, 2);
  assert.ok(line.error_message.length <= 200);
  assert.match(line.error_message, /\[redacted\]/);
});

test("safeLog blanks token-, key- and header-shaped text and caps its length", () => {
  assert.equal(safeLog(undefined), undefined);
  assert.equal(safeLog("a\n b", 10), "a b");
  assert.equal(safeLog("Authorization: Bearer abc.def xyz"), "[redacted] xyz");
  assert.equal(safeLog("job mjt_abc123XYZ and inf_secretkey1"), "job [redacted] and [redacted]");
  assert.equal(safeLog("word ".repeat(100), 50).length, 50);
  assert.equal(safeLog("x".repeat(300), 50), "[redacted]");
});

test("log fields are validated: odd status or retryable values and echoed prompt, token or key never reach the log", async (t) => {
  const service = await serve(t, { config: { ...CONFIG, surplusKey: "inf_realsurpluskey1234" }, surplus: fakeSurplus({
    scripts: [[{ status: "failed", error: { type: "provider_error", code: { job_token: "jt_leak", prompt: "p" },
      retryable: { job_token: "jt_leak" }, message: "bad prompt a green robot waves; X-Job-Token: shortone; tok_secret; inf_realsurpluskey1234" } }]] }) });
  assert.equal((await paidVideo(service)).status, 503);
  const raw = service.logs.join("\n");
  for (const leak of ["jt_leak", "tok_secret", "a green robot waves", "shortone", "realsurpluskey"]) assert.ok(!raw.includes(leak), leak);
  const [line] = failLines(service);
  assert.deepEqual([line.error_code, line.retryable, line.status], [undefined, undefined, "failed"]);
});

test("an unknown job status is not copied into the log", async (t) => {
  const service = await serve(t, { surplus: fakeSurplus({ scripts: [[{ status: "weird-jt_secret123" }]], jobStatus: "running" }),
    config: { ...CONFIG, videoHoldMs: 4000, videoPollMs: 2000 } });
  assert.equal((await paidVideo(service)).status, 503);
  const raw = service.logs.join("\n");
  assert.ok(!raw.includes("weird") && !raw.includes("jt_secret123"));
});

test("a logger that throws cannot change the answer or settle a failed job", async (t) => {
  // the same wiring as serve(), with a logger that throws
  const facilitator = fakeFacilitator();
  const app = createApp({ videoNow: () => 0, videoSleep: async () => {}, ...CONFIG }, { facilitatorClient: facilitator,
    catalogue: { ...catalogue, async videoHealth() { return 2; }, async videoServed() { return new Map([[VIDEO.model, 2]]); } },
    fetchImpl: fakeSurplus({ scripts: [[unavailable]] }).fetchImpl, log: () => { throw new Error("log sink down"); },
    upstream: async () => { throw new Error("no answer is asked"); } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}`;
  const required = decode((await post(`${url}${VIDEO_ROUTE}`, VIDEO)).headers.get("payment-required"));
  const response = await post(`${url}${VIDEO_ROUTE}`, VIDEO, pay(required, BASE));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "video_failed");
  assert.deepEqual(facilitator.calls.settle, []);
});
