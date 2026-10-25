// SingIt video: the list price per clip + 30% + the fee, charged once Surplus accepted the job; polling and the file
// free with the job's token, which Surplus itself checks; no seller shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel, parseVideoModels } from "../src/catalogue.mjs";
import { VIDEO_ROUTE, publicJob, readVideoRequest, videoPrice } from "../src/video.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
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

async function serve(t, { surplus = fakeSurplus() } = {}) {
  const facilitator = fakeFacilitator();
  const logs = [];
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, fetchImpl: surplus.fetchImpl,
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
  assert.deepEqual(required.accepts.map((a) => [a.network, a.amount]), [[BASE, "105000"], [SOLANA, "106000"]]);
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
    ["vj_123456", "queued", "tok_secret", "/v1/video/generations/vj_123456", "105000"]);
  assert.equal(job.provider, undefined, "no seller shown");
  const submit = surplus.calls[0];
  assert.deepEqual([submit.method, submit.headers.Authorization, submit.body],
    ["POST", "Bearer inf_test", { model: "venice-seedance-2-fast-t2v", prompt: "a green robot waves", resolution: "480p", aspect_ratio: "16:9" }]);
  assert.match(submit.headers["Idempotency-Key"], /^singit-[0-9a-f]{64}$/);
  assert.deepEqual(facilitator.calls.settle, [[BASE, "105000"]]);
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

test("an empty unpaid probe gets the standing offer, so x402scan and Bazaar can index video", async (t) => {
  const { url, surplus } = await serve(t);
  for (const init of [{ method: "POST" }, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
                      { method: "GET" }]) {
    const probe = await fetch(`${url}${VIDEO_ROUTE}`, init);
    assert.equal(probe.status, 402, `${init.method} ${init.body ?? ""}`);
    const required = JSON.parse(Buffer.from(probe.headers.get("payment-required"), "base64").toString());
    assert.deepEqual(required.accepts.map((a) => a.network), [BASE, SOLANA], "exact on Base first");
    assert.ok(required.extensions?.bazaar);
  }
  assert.deepEqual(surplus.calls, [], "a probe never starts a job");
});

test("paying with no question is refused before any job, and before the payment is verified", async (t) => {
  const { url, surplus, facilitator } = await serve(t);
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
  assert.deepEqual(list.data.map((m) => [m.id, m.singitUsdPerJob]), [["venice-seedance-2-fast-t2v", 0.105]]);
});
