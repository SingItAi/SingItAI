// SingIt video: a clip from any of Surplus's text-to-video models, sold over x402 at the model's list price per job +
// 30% + the network's settlement fee, made on Surplus with this service's own key.
//
// A clip takes minutes, so it is a job. The payment is verified, the job is submitted, and the payer is settled once
// Surplus has accepted the job: they get its id and its job token. Polling and the finished file are free and need
// only that token, which Surplus itself checks; nothing is kept here. A job that fails after it was accepted is not
// refunded over x402 (there is no way back for an exact payment), which the description says.
import crypto from "node:crypto";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { UnknownModel } from "./catalogue.mjs";
import { ASSET, BASE, SOLANA, SOLANA_ASSET, TERMS, SOLANA_TERMS } from "./pricing.mjs";

export const VIDEO_ROUTE = "/v1/video/generations";
export const VIDEO_MODELS_ROUTE = "/v1/video/models";
export const VIDEO_TERMS = Object.freeze({ markupBps: 3000, maxPromptChars: 2000, maxListAtomic: 1_000_000 });
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

export const videoListAtomic = (model) => Math.ceil(model.usdPerJob * 1e6);

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

const DESCRIPTION = "A video clip from 36 text-to-video models (Seedance, Veo, Kling, Wan, LTX, Runway and more; list at "
  + "GET /v1/video/models), as a job: pay the model's list price per clip + 30% + a settlement fee (0.001 USDC on Base, "
  + "0.002 on Solana), get a job id and token, then poll GET /v1/video/generations/{id} for free. From about 0.105 USDC. "
  + "Charged once the job is accepted; a job that then fails is not refunded.";

export function addVideoRoutes(app, config, { facilitatorClient, catalogue, fetchImpl = fetch, log = console.error, open }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  const priced = new WeakMap();
  const used = new Map();
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const origin = (req) => `${req.protocol}://${req.get("host")}`;
  const tokenOf = (req) => String(req.get("x-job-token") ?? req.query.token ?? "").slice(0, 400);

  app.get(VIDEO_MODELS_ROUTE, open, async (_req, res) => {
    const models = await catalogue.videoModels().catch(() => new Map());
    res.json({ object: "list", endpoint: VIDEO_ROUTE, fees: { markupPct: VIDEO_TERMS.markupBps / 100,
      perRequestUsd: { [BASE]: Number(TERMS.settlementFeeAtomic) / 1e6, [SOLANA]: Number(SOLANA_TERMS.settlementFeeAtomic) / 1e6 } },
      data: [...models.values()].map((m) => ({ id: m.id, object: "model", name: m.name, owned_by: m.provider || "surplus",
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
      return res.status(response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 502)
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
      if (!download.ok) return res.status(502).json({ error: { type: "upstream_error", message: "The file could not be fetched." } });
      res.set({ "Content-Type": download.headers.get("content-type") ?? "video/mp4", "Cache-Control": "no-store" });
      res.send(Buffer.from(await download.arrayBuffer()));
    } catch {
      res.status(503).json({ error: { type: "upstream_error", message: "Try again shortly." } });
    }
  });

  const price = (network) => (ctx) => {
    const quote = priced.get(ctx.adapter.getBody());
    const amount = videoPrice(quote?.listAtomic ?? VIDEO_TERMS.maxListAtomic, network).totalAtomic;
    return network === BASE ? { asset: ASSET, amount, extra: { name: "USD Coin", version: "2" } } : { asset: SOLANA_ASSET, amount };
  };
  app.post(VIDEO_ROUTE, async (req, res, next) => {
    // The video seller still refuses jobs, so an unpaid discovery probe keeps the model-lookup 404.
    // A 402 here would let x402scan index a route that cannot complete a clip.
    try {
      const model = await catalogue.resolveVideo(req.body?.model);
      const request = readVideoRequest(req.body, model);
      const listAtomic = videoListAtomic(model);
      if (listAtomic > VIDEO_TERMS.maxListAtomic) throw new VideoError(400, "This model costs more than is sold here.");
      priced.set(req.body, { request, listAtomic });
      next();
    } catch (error) {
      const status = error instanceof UnknownModel ? 404 : error.status ?? 503;
      res.status(status).json({ error: { type: status === 503 ? "upstream_error" : "invalid_request_error",
        code: status === 404 ? "model_not_found" : undefined, message: status === 503 ? "Try again shortly." : error.message } });
    }
  });
  app.use(paymentMiddleware({ [`POST ${VIDEO_ROUTE}`]: {
    accepts: [
      { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 120, price: price(SOLANA) },
      { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120, price: price(BASE) },
    ],
    mimeType: "application/json", description: `SingIt Video: ${DESCRIPTION}`,
    extensions: declareDiscoveryExtension({ bodyType: "json",
      input: { model: "venice-seedance-2-fast-t2v", prompt: "a small green robot waves hello", resolution: "480p", aspect_ratio: "16:9" } }),
  } }, server));
  app.post(VIDEO_ROUTE, async (req, res) => {
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
    const seen = digest(header);
    if (used.has(seen)) return res.status(409).json({ error: { type: "invalid_request_error", message: "This payment was already used." } });
    used.set(seen, Date.now());
    for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
    const { request, listAtomic } = priced.get(req.body);
    let response, job;
    try {
      response = await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}`, { method: "POST",
        // The same payment never makes two jobs, even if this request is repeated before it is marked used.
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}`, "Idempotency-Key": `singit-${seen}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(60_000) });
      job = await response.json().catch(() => null);
    } catch (error) {
      log(`singit-ask: video submit unreachable (${error.name})`);
      return res.status(502).json({ error: { type: "upstream_error", message: "The video was not started. You were not charged." } });
    }
    const token = job?.job_token ?? job?.token;
    if ((response.status !== 200 && response.status !== 202) || !job?.id || !token) {
      log(`singit-ask: video submit for ${request.model} answered HTTP ${response.status} (${job?.error?.code ?? "no job"})`);
      return res.status(502).json({ error: { type: "upstream_error", message: "The video was not started. You were not charged." } });
    }
    const billing = { ...videoPrice(listAtomic, network), currency: "USDC" };
    log(`singit-ask: video job ${job.id} for ${request.model} accepted for ${billing.totalAtomic} micro-USDC`);
    // 200, not 202: the accepted job is what was paid for, and buyers that take only a 200 as delivered settle cleanly.
    res.json({ ...publicJob(job, `${req.protocol}://${req.get("host")}`), job_token: token,
      poll: `${VIDEO_ROUTE}/${job.id}`, billing });
  });
}
