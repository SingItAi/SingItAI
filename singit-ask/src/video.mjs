// SingIt video: a clip from any of Surplus's text-to-video models, sold over x402 at the model's list price per job +
// 30% + the network's settlement fee, made on Surplus with this service's own key.
//
// A clip takes minutes, so it is a job. The payment is verified, the job is submitted, and the payer is settled once
// Surplus has accepted the job: they get its id and its job token. Polling and the finished file are free and need
// only that token, which Surplus itself checks; nothing is kept here. A job that fails after it was accepted is not
// refunded over x402 (there is no way back for an exact payment), which the description says.
import crypto from "node:crypto";
import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { UnknownModel } from "./catalogue.mjs";
import { addPaymentRoute, isDiscoveryProbe } from "./metered.mjs";
import { ASSET, BASE, SOLANA, SOLANA_ASSET, TERMS, SOLANA_TERMS, SERVICE_NAMES, ICON_URL, discoveryTags } from "./pricing.mjs";

export const VIDEO_ROUTE = "/v1/video/generations";
export const VIDEO_MODELS_ROUTE = "/v1/video/models";
export const VIDEO_TERMS = Object.freeze({ markupBps: 3000, minListAtomic: 200_000,
  maxPromptChars: 2000, maxListAtomic: 1_000_000 });
const FEES = { [BASE]: TERMS.settlementFeeAtomic, [SOLANA]: SOLANA_TERMS.settlementFeeAtomic };
const JOB_ID = /^[A-Za-z0-9_-]{6,80}$/;

export class VideoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readVideoRequest(body, model) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new VideoError(400, "Send a JSON body.");
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > VIDEO_TERMS.maxPromptChars) {
    throw new VideoError(400, `Send a prompt of up to ${VIDEO_TERMS.maxPromptChars} characters.`);
  }
  if (body.fallback !== undefined && typeof body.fallback !== "boolean") {
    throw new VideoError(400, "fallback must be a boolean.");
  }
  const request = { model: model.id, prompt: body.prompt };
  const pick = (field, allowed, test) => {
    if (body[field] === undefined) return;
    if (!test(body[field]) || (allowed && !allowed.includes(body[field]))) {
      throw new VideoError(400, allowed ? `${field} must be one of ${allowed.join(", ")}.` : `${field} is not valid.`);
    }
    request[field] = body[field];
  };
  pick("duration_seconds", model.durations, (v) => Number.isInteger(v) && v > 0 && v <= 30);
  pick("resolution", model.resolutions, (v) => typeof v === "string" && v.length <= 10);
  pick("aspect_ratio", model.aspectRatios, (v) => typeof v === "string" && /^[0-9]{1,2}:[0-9]{1,2}$/.test(v));
  if (body.audio !== undefined) {
    if (typeof body.audio !== "boolean" || (body.audio && !model.audio)) throw new VideoError(400, "This model makes no audio.");
    request.audio = body.audio;
  }
  return request;
}

// Cheap $0.09 models (longcat-distilled and grok-imagine) had flaky sellers; the old $0.118 price does not
// pay for failures/retries. The floor equals the wan-2-2-a14b level, while the catalogue keeps the real list price.
export const videoListAtomic = (model) => Math.max(Math.ceil(model.usdPerJob * 1e6), VIDEO_TERMS.minListAtomic);
export const isSoldVideoModel = (id) => !/uncensored/i.test(id);

// Only a compatible, known-healthy substitute within the signed quote may run: retries must never enlarge the
// payer's authorization, and unknown seller health is insufficient evidence for choosing a different model.
export function pickFallbacks({ models, health, requested, signedListAtomic, body, max = 2 }) {
  return [...(models instanceof Map ? models.values() : models)].filter((m) => {
    if (m.id === requested || !isSoldVideoModel(m.id) || videoListAtomic(m) > signedListAtomic
      || !(health?.get(m.id) > 0)) return false;
    try { readVideoRequest(body, m); return true; } catch { return false; }
  }).sort((a, b) => videoListAtomic(b) - videoListAtomic(a) || health.get(b.id) - health.get(a.id)
    || a.id.localeCompare(b.id)).slice(0, Math.max(0, max));
}

export function videoPrice(listAtomic, network) {
  const list = BigInt(listAtomic);
  const markup = (list * BigInt(VIDEO_TERMS.markupBps) + 9999n) / 10000n;
  return { listAtomic: list.toString(), markupAtomic: markup.toString(), feeAtomic: FEES[network],
           totalAtomic: (list + markup + BigInt(FEES[network])).toString() };
}

// A job as the payer sees it: Surplus's status and results, its files behind this service's own URLs, no seller.
export function publicJob(job, origin) {
  const results = Array.isArray(job?.results) ? job.results : [];
  return { id: job.id, object: "video.generation", status: job.status, model: job.model,
    ...(job.error ? { error: { code: job.error.code ?? job.error.type, message: job.error.message } } : {}),
    results: results.map((r, i) => ({ index: i, url: `${origin}${VIDEO_ROUTE}/${job.id}/content?index=${i}`,
      ...(r?.mime_type || r?.content_type ? { content_type: r.mime_type ?? r.content_type } : {}) })),
    ...(job.created_at ? { created_at: job.created_at } : {}), ...(job.completed_at ? { completed_at: job.completed_at } : {}) };
}

// <=300 characters, opening with the category words, the brand once, later, and no billing talk (see app.mjs's
// DISCOVERY_DESCRIPTION for why); prices, the job flow and the no-refund rule are in openapi.json and on
// GET /v1/video/models.
const DESCRIPTION = "Video generation API, text to video: clips from 30+ models (LongCat, Grok Imagine, Wan, PixVerse, "
  + "Seedance and more; list at GET /v1/video/models), no API key needed. Call it when an agent needs a short video from a text prompt: "
  + "it answers with a job to poll. Served by SingIt.";

const INPUT_SCHEMA = { properties: {
  model: { type: "string", examples: ["wan-2-2-a14b-text-to-video"], description: "A video model id from GET /v1/video/models." },
  prompt: { type: "string", minLength: 1, maxLength: VIDEO_TERMS.maxPromptChars, description: "What the clip should show." },
  duration_seconds: { type: "integer", minimum: 1, maximum: 30, examples: [5],
    description: "Clip length; the lengths each model takes are listed at GET /v1/video/models." },
  resolution: { type: "string", maxLength: 10, examples: ["480p"], description: "Only for models that list resolutions." },
  aspect_ratio: { type: "string", pattern: "^[0-9]{1,2}:[0-9]{1,2}$", examples: ["16:9"], description: "Only for models that list them." },
  audio: { type: "boolean", description: "Only for models that make audio." },
  fallback: { type: "boolean", default: true,
    description: "Set false to refuse a substitute model when the chosen one has no healthy seller; the price never rises." },
}, required: ["model", "prompt"] };
// Shape and charge of a real answer: an accepted job (poll it for free with job_token), 200000 micro-USD list price,
// 60000 markup, 1000 settlement fee (Base).
const OUTPUT_EXAMPLE = { id: "01M5STJCFTVSC5588N9YGQCPQW", object: "video.generation", status: "queued",
  model: "wan-2-2-a14b-text-to-video", results: [], job_token: "jt_…", poll: "/v1/video/generations/01M5STJCFTVSC5588N9YGQCPQW",
  billing: { listAtomic: "200000", markupAtomic: "60000", feeAtomic: "1000", totalAtomic: "261000", currency: "USDC" } };
const OUTPUT_SCHEMA = { type: "object", required: ["id", "status", "job_token", "billing"], properties: {
  id: { type: "string", description: "The job id" }, object: { type: "string", const: "video.generation" },
  status: { type: "string", description: "queued, running, succeeded or failed" }, model: { type: "string" },
  requested_model: { type: "string" }, substituted: { type: "boolean" },
  results: { type: "array", description: "The clips, once the job has succeeded", items: { type: "object", properties: {
    index: { type: "integer" }, url: { type: "string", description: "Download it with the job token" },
    content_type: { type: "string" } } } },
  job_token: { type: "string", description: "Send as X-Job-Token to poll and download, for free" },
  poll: { type: "string", description: "GET this path for the job's status and files" },
  billing: { type: "object", description: "What was charged, in USDC micro-units", properties: {
    listAtomic: { type: "string" }, markupAtomic: { type: "string" }, feeAtomic: { type: "string" },
    totalAtomic: { type: "string", description: "The amount settled" }, currency: { type: "string", const: "USDC" } } },
} };

export function addVideoRoutes(app, config, { facilitatorClient, catalogue, fetchImpl = fetch, log = console.error, open }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  const priced = new WeakMap();
  const used = new Map();
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const origin = (req) => `${req.protocol}://${req.get("host")}`;
  const tokenOf = (req) => String(req.get("x-job-token") ?? req.query.token ?? "").slice(0, 400);

  // Off unless config.videoSold (SINGIT_ASK_VIDEO_SOLD=1): Surplus accepted a paid job on 27.10.2026 and failed it
  // moments later (provider_unavailable), and a payment settled on acceptance is not refunded. Until settlement waits
  // for a finished clip, a new job is refused before any payment offer, with no 402; jobs already paid for can still be
  // polled and downloaded below.
  const sold = Boolean(config.videoSold);
  const disabled = (_req, res) => res.set("Retry-After", "86400").status(503).json({ error: { type: "upstream_error",
    code: "video_disabled", message: "Video generation is switched off for now. Nothing was charged." } });
  if (!sold) {
    app.get(VIDEO_MODELS_ROUTE, open, disabled);
    app.post(VIDEO_ROUTE, open, disabled);
  } else app.get(VIDEO_MODELS_ROUTE, open, async (_req, res) => {
    const models = await catalogue.videoModels().catch(() => new Map());
    const served = await catalogue.videoServed?.();
    res.json({ object: "list", endpoint: VIDEO_ROUTE, fees: { markupPct: VIDEO_TERMS.markupBps / 100,
      perRequestUsd: { [BASE]: Number(TERMS.settlementFeeAtomic) / 1e6, [SOLANA]: Number(SOLANA_TERMS.settlementFeeAtomic) / 1e6 } },
      data: [...models.values()].filter((m) => isSoldVideoModel(m.id) && (!served || !served.size || served.get(m.id) > 0))
        .map((m) => ({ ...(served ? { healthySellers: served.get(m.id) ?? null } : {}), id: m.id, object: "model", name: m.name, owned_by: m.provider || "surplus",
        durations: m.durations, resolutions: m.resolutions, aspect_ratios: m.aspectRatios, audio: m.audio,
        listUsdPerJob: m.usdPerJob, singitUsdPerJob: Number(videoPrice(videoListAtomic(m), BASE).totalAtomic) / 1e6 }))
        .sort((a, b) => a.listUsdPerJob - b.listUsdPerJob) });
  });

  // Free, with the job's token: where the job is, and its files.
  app.get(`${VIDEO_ROUTE}/:id`, open, async (req, res) => {
    const token = tokenOf(req);
    if (!JOB_ID.test(req.params.id) || !token) {
      return res.status(400).json({ error: { type: "invalid_request_error", message: "Send the job id and its X-Job-Token." } });
    }
    let response;
    try {
      response = await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}/${req.params.id}`, {
        headers: { "X-Job-Token": token }, signal: AbortSignal.timeout(20_000) });
    } catch { return res.status(503).json({ error: { type: "upstream_error", message: "Try again shortly." } }); }
    const job = await response.json().catch(() => null);
    if (!job || (response.status !== 200 && response.status !== 202)) {
      return res.status(response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 503)
        .json({ error: { type: "invalid_request_error", message: "No such job, or not with this token." } });
    }
    res.status(response.status).json(publicJob({ ...job, id: job.id ?? req.params.id }, origin(req)));
  });
  app.get(`${VIDEO_ROUTE}/:id/content`, open, async (req, res) => {
    const token = tokenOf(req);
    const index = Number(req.query.index ?? 0);
    if (!JOB_ID.test(req.params.id) || !token || !Number.isInteger(index) || index < 0 || index > 7) {
      return res.status(400).json({ error: { type: "invalid_request_error", message: "Send the job id, its token and a file index." } });
    }
    try {
      const status = await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}/${req.params.id}`, {
        headers: { "X-Job-Token": token }, signal: AbortSignal.timeout(20_000) });
      const job = await status.json().catch(() => null);
      const file = Array.isArray(job?.results) ? job.results[index] : null;
      if (status.status !== 200 || job?.status !== "succeeded" || !file?.url) {
        return res.status(status.status === 202 ? 409 : 404).json({ error: { type: "invalid_request_error",
          message: status.status === 202 ? "The video is not ready yet." : "No such file, or not with this token." } });
      }
      // Surplus's file URLs are on its own API (the token opens them) or a provider's public link.
      const url = new URL(file.url, config.surplusUrl);
      const own = url.origin === new URL(config.surplusUrl).origin;
      const download = await fetchImpl(url, { headers: own ? { "X-Job-Token": token } : {}, redirect: "follow",
        signal: AbortSignal.timeout(120_000) });
      if (!download.ok) return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", message: "The file could not be fetched." } });
      res.set({ "Content-Type": download.headers.get("content-type") ?? "video/mp4", "Cache-Control": "no-store" });
      res.send(Buffer.from(await download.arrayBuffer()));
    } catch {
      res.status(503).json({ error: { type: "upstream_error", message: "Try again shortly." } });
    }
  });

  if (!sold) return;
  const price = (network) => (ctx) => {
    const quote = priced.get(ctx.adapter.getBody());
    const amount = videoPrice(quote?.listAtomic ?? VIDEO_TERMS.maxListAtomic, network).totalAtomic;
    return network === BASE ? { asset: ASSET, amount, extra: { name: "USD Coin", version: "2" } } : { asset: SOLANA_ASSET, amount };
  };
  app.post(VIDEO_ROUTE, async (req, res, next) => {
    // Listed for discovery only when config.videoDiscoverable is set: then x402scan's empty, unpaid probe gets the
    // standing offer, as images do. Off by default because Surplus's video sellers come and go (a clip went through
    // on 25.10.2026, then three paid attempts met no_healthy_sellers); a 402 here would let a directory index a route
    // that often cannot complete. Paying with no question is refused either way: the model lookup answers 404.
    if (config.videoDiscoverable && isDiscoveryProbe(req)) return next();
    try {
      const model = await catalogue.resolveVideo(req.body?.model);
      if (!isSoldVideoModel(model.id)) throw new UnknownModel("That video model is not available.");
      const request = readVideoRequest(req.body, model);
      const listAtomic = videoListAtomic(model);
      if (listAtomic > VIDEO_TERMS.maxListAtomic) throw new VideoError(400, "This model costs more than is sold here.");
      const fallbacks = async () => pickFallbacks({ models: await catalogue.videoModels(),
        health: await catalogue.videoServed?.(), requested: model.id, signedListAtomic: listAtomic, body: req.body });
      if (await catalogue.videoHealth?.(model.id) === 0
        && (req.body.fallback === false || !(await fallbacks()).length)) {
        log(`singit-ask: video no healthy sellers for ${model.id}`);
        return res.set("Retry-After", "60").status(503).json({ error: { type: "upstream_error",
          code: "no_healthy_sellers", message: "No seller can run this video model right now. Nothing was charged." } });
      }
      priced.set(req.body, { request, listAtomic });
      next();
    } catch (error) {
      const status = error instanceof UnknownModel ? 404 : error.status ?? 503;
      res.status(status).json({ error: { type: status === 503 ? "upstream_error" : "invalid_request_error",
        code: status === 404 ? "model_not_found" : undefined, message: status === 503 ? "Try again shortly." : error.message } });
    }
  });
  addPaymentRoute(app, { [`POST ${VIDEO_ROUTE}`]: {
    // exact on Base first: the simplest offer for a buyer that only inspects accepts[0].
    accepts: [
      { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120, price: price(BASE) },
      { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 120, price: price(SOLANA) },
    ],
    mimeType: "application/json", description: DESCRIPTION, serviceName: SERVICE_NAMES[VIDEO_ROUTE], iconUrl: ICON_URL,
    tags: discoveryTags("video-generation", "text-to-video", "video", "pay-per-use", "solana", "base", "singit"),
    extensions: declareDiscoveryExtension({ bodyType: "json",
      input: { model: "wan-2-2-a14b-text-to-video", prompt: "a small green robot waves hello", duration_seconds: 5 },
      inputSchema: INPUT_SCHEMA, output: { example: OUTPUT_EXAMPLE, schema: OUTPUT_SCHEMA } }),
  } }, server, { discoverable: Boolean(config.videoDiscoverable), log });  // undefined would mean the default, true
  app.post(VIDEO_ROUTE, async (req, res) => {
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
    const seen = digest(header);
    if (used.has(seen)) return res.status(409).json({ error: { type: "invalid_request_error", message: "This payment was already used." } });
    used.set(seen, Date.now());
    for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
    const { request, listAtomic } = priced.get(req.body);
    // Re-read health after payment verification: a seller may disappear between the offer and submission.
    // Distinct idempotency keys isolate rejected attempts, while the first accepted job ends the chain forever.
    const health = await catalogue.videoServed?.();
    const fallbacks = req.body.fallback === false ? [] : pickFallbacks({ models: await catalogue.videoModels(),
      health, requested: request.model, signedListAtomic: listAtomic, body: req.body });
    const attempts = [...(await catalogue.videoHealth?.(request.model) === 0 ? [] : [request]),
      ...fallbacks.map((m) => readVideoRequest(req.body, m))];
    let job, token, actual;
    for (const [n, attempt] of attempts.entries()) {
      if (attempt.model !== request.model && !(await catalogue.videoHealth?.(attempt.model) > 0)) continue;
      try {
        const response = await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}`, { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}`,
            "Idempotency-Key": `singit-${seen}${n ? `-${n}` : ""}` },
          body: JSON.stringify(attempt), signal: AbortSignal.timeout(60_000) });
        job = await response.json().catch(() => null);
        token = job?.job_token ?? job?.token;
        if ((response.status === 200 || response.status === 202) && job?.id && token) {
          actual = attempt.model;
          break;
        }
        if (response.status === 400 && (job?.error?.code === "invalid_request"
          || job?.error?.type === "invalid_request")) break;
      } catch (error) { log(`singit-ask: video submit unreachable (${error.name})`); }
    }
    if (!actual) return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error",
      code: "no_healthy_sellers", message: "The video was not started. You were not charged." } });
    if (actual !== request.model) log(`singit-ask: video substitution ${request.model} -> ${actual}`);
    const billing = { ...videoPrice(listAtomic, network), currency: "USDC" };
    log(`singit-ask: video job ${job.id} for ${actual} accepted for ${billing.totalAtomic} micro-USDC`);
    // 200, not 202: the accepted job is what was paid for, and buyers that take only a 200 as delivered settle cleanly.
    res.json({ ...publicJob({ ...job, model: actual }, origin(req)), job_token: token,
      ...(actual !== request.model ? { requested_model: request.model, substituted: true } : {}),
      poll: `${VIDEO_ROUTE}/${job.id}`, billing });
  });
}
