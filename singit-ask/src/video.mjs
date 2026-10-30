// SingIt video: a clip from any of Surplus's text-to-video models, sold over x402 at the model's list price per job +
// 30% + the network's settlement fee, made on Surplus with this service's own key.
//
// Payment is verified first, but settlement waits for a finished clip within one bounded window across attempts.
// Failed or late jobs answer >=400 so x402 cancels settlement; polling and downloads remain free with the job token.
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

// Text from Surplus that goes to the log: capped, one line, token-, key- and header-shaped strings blanked.
export function safeLog(value, max = 80, exact = []) {
  if (value === undefined || value === null || typeof value === "object") return undefined;
  let text = String(value);
  // Values this request itself holds (job token, Surplus key, the prompt's opening) are blanked wherever they appear,
  // in case Surplus echoes them back in an error message.
  for (const secret of exact) if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[redacted]");
  return text.replace(/\s+/g, " ")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(?:token|key|secret|authorization|signature|password)\b\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:mjt|jt|inf|sk|bc)_[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/0x[0-9a-fA-F]{40,}/g, "[redacted]").replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]").slice(0, max);
}

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

// Only a compatible, known-healthy substitute within the signed quote may run: retries must never enlarge the
// payer's authorization, and unknown seller health is insufficient evidence for choosing a different model.
export function pickFallbacks({ models, health, requested, signedListAtomic, body, max = 2 }) {
  return [...(models instanceof Map ? models.values() : models)].filter((m) => {
    if (m.id === requested || videoListAtomic(m) > signedListAtomic
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
// DISCOVERY_DESCRIPTION for why); prices, the job flow and the completion window are in openapi.json and on
// GET /v1/video/models.
const DESCRIPTION = "Video generation API, text to video: clips from 30+ models (LongCat, Grok Imagine, Wan, PixVerse, "
  + "Seedance and more; list at GET /v1/video/models), no API key needed. Call it when an agent needs a short video from a text prompt: "
  + "it answers once the clip is ready. Served by SingIt.";

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
// Shape and charge of a real answer: a finished clip (download for free with job_token), 200000 micro-USD list price,
// 60000 markup, 1000 settlement fee (Base).
const OUTPUT_EXAMPLE = { id: "01M5STJCFTVSC5588N9YGQCPQW", object: "video.generation", status: "succeeded",
  model: "wan-2-2-a14b-text-to-video",
  results: [{ index: 0, url: "/v1/video/generations/01M5STJCFTVSC5588N9YGQCPQW/content?index=0" }],
  job_token: "jt_…", poll: "/v1/video/generations/01M5STJCFTVSC5588N9YGQCPQW",
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

  // Remain off by default after the 27.10.2026 provider failures; enabling sales is a separate operator decision.
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
      data: [...models.values()].filter((m) => !served || !served.size || served.get(m.id) > 0)
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
    // The offer allows Base hold + verification + settlement; Solana's blockhash still requires a shorter hold.
    // exact on Base first: the simplest offer for a buyer that only inspects accepts[0].
    accepts: [
      { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 150, price: price(BASE) },
      { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 150, price: price(SOLANA) },
    ],
    mimeType: "application/json", description: DESCRIPTION, serviceName: SERVICE_NAMES[VIDEO_ROUTE], iconUrl: ICON_URL,
    tags: discoveryTags("video-generation", "text-to-video", "video", "pay-per-use", "solana", "base", "singit"),
    extensions: declareDiscoveryExtension({ bodyType: "json",
      input: { model: "wan-2-2-a14b-text-to-video", prompt: "a small green robot waves hello", duration_seconds: 5 },
      inputSchema: INPUT_SCHEMA, output: { example: OUTPUT_EXAMPLE, schema: OUTPUT_SCHEMA } }),
  } }, server, { discoverable: Boolean(config.videoDiscoverable), log });  // undefined would mean the default, true
  const now = config.videoNow ?? Date.now;
  const sleep = config.videoSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  app.post(VIDEO_ROUTE, async (req, res) => {
    const started = now();
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
    const seen = digest(header);
    if (used.has(seen)) return res.status(409).json({ error: { type: "invalid_request_error", message: "This payment was already used." } });
    used.set(seen, Date.now());
    for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
    const deadline = started + (network === SOLANA ? config.videoHoldSolanaMs ?? 35_000 : config.videoHoldMs ?? 85_000);
    const remaining = () => deadline - now();
    const failed = (code) => res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code,
      message: code === "video_timeout" ? "The video was not ready in time. You were not charged; try again."
        : "The video could not be made. You were not charged." } });
    const invalid = (error) => res.status(400).json({ error: { type: "invalid_request_error",
      message: typeof error?.message === "string" ? error.message : "The video request was refused." } });
    const { request, listAtomic } = priced.get(req.body);
    // One line per job that did not give a clip: which job, what Surplus said, how long, and WHY we stopped. On 28.10
    // a paid test answered video_failed after 65 s and nothing in the log said whether Surplus failed the job, it
    // finished without a file, or the retry guard cut in. Only the job id (not its token), HTTP status, Surplus's own
    // error fields (truncated, token- and key-shaped strings blanked) and the model are written: never a header,
    // payment payload, seller or prompt.
    const lastHttp = {};
    // A failing logger must never change what the payer gets (a 503 that settles nothing, or a 200 that does).
    const note = (line) => { try { log(line); } catch { /* logging is best effort */ } };
    const exactSecrets = () => [token, config.surplusKey, String(req.body?.prompt ?? "").slice(0, 24)];
    const STATUSES = ["queued", "submitted", "running", "succeeded", "failed", "canceled", "expired"];
    const logFail = (reason, attempt, job, extra = {}) => {
      // Strings are scrubbed of this request's own secrets; status and retryable are only ever a known word / a boolean.
      const exact = exactSecrets();
      note(`singit-ask: video job not delivered ${JSON.stringify({
        reason, job_id: safeLog(job?.id, 80, exact), model: attempt?.model, status: STATUSES.includes(job?.status) ? job.status : undefined,
        http_status: lastHttp.status, poll_errors: lastHttp.errors || undefined, error_code: safeLog(job?.error?.code, 80, exact),
        error_type: safeLog(job?.error?.type, 80, exact), error_message: safeLog(job?.error?.message, 200, exact),
        retryable: typeof job?.error?.retryable === "boolean" ? job.error.retryable : undefined,
        results: Array.isArray(job?.results) ? job.results.length : undefined,
        elapsed_s: Math.round((now() - started) / 100) / 10, remaining_s: Math.round(remaining() / 100) / 10, ...extra })}`);
    };
    // Re-read health after payment verification: a seller may disappear between the offer and submission.
    // Distinct idempotency keys isolate rejected attempts, and a terminal retryable failure may use a cheaper healthy model.
    // Catalogue reads share the request's own deadline (a cold health pass reads every book and can take minutes):
    // past 5 s or the window, health is "unknown", so no substitute is chosen and the requested model is tried as is.
    const within = (promise, fallback) => Promise.race([Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => { setTimeout(() => resolve(fallback), Math.max(1, Math.min(5000, remaining()))).unref?.(); })]);
    const health = await within(catalogue.videoServed?.(), undefined);
    const fallbacks = req.body.fallback === false || !health ? [] : pickFallbacks({
      models: await within(catalogue.videoModels(), new Map()), health, requested: request.model,
      signedListAtomic: listAtomic, body: req.body });
    const attempts = [...(await within(catalogue.videoHealth?.(request.model), null) === 0 ? [] : [request]),
      ...fallbacks.map((m) => readVideoRequest(req.body, m))];
    let job, token, actual;
    let accepted = false;
    for (const [n, attempt] of attempts.entries()) {
      if (remaining() <= 0) return failed("video_timeout");
      if (accepted && remaining() < (config.videoMinRetryMs ?? 20_000)) return failed("video_failed");
      if (attempt.model !== request.model && !(await within(catalogue.videoHealth?.(attempt.model), null) > 0)) continue;
      try {
        const response = await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}`, { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}`,
            "Idempotency-Key": `singit-${seen}${n ? `-${n}` : ""}` },
          body: JSON.stringify(attempt), signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, remaining()))) });
        job = await response.json().catch(() => null);
        token = job?.job_token ?? job?.token;
        if ((response.status === 200 || response.status === 202) && job?.id && token) {
          accepted = true;
          lastHttp.status = response.status; lastHttp.errors = 0;
          const id = job.id;
          // @x402/express cancels settlement for >=400; a 200 must mean a finished clip, since exact payments
          // cannot be refunded after settlement. A transient poll failure leaves the job pending, never billable.
          while (remaining() > 0) {
            if (job.status === "succeeded" && Array.isArray(job.results) && job.results.some((r) => typeof r?.url === "string" && r.url)) {
              actual = attempt.model;
              break;
            }
            if (["failed", "canceled", "expired", "succeeded"].includes(job.status)) {
              // The job is already terminal here, so the retry guard below never ends a job that is still running:
              // a running one is polled until the window closes. It only decides whether a next model may start.
              const reason = job.status === "succeeded" ? "no_result_file" : "upstream_failed";
              // A request Surplus refuses is the payer's problem only on the model they asked for; a substitute
              // that refuses it (a parameter it does not take) just ends that attempt.
              if (job.error?.type === "invalid_request" || job.error?.retryable === false) {
                logFail(reason, attempt, job, { next: attempt.model !== request.model ? "next_model" : "none" });
                if (attempt.model !== request.model) break;
                return job.error?.type === "invalid_request" ? invalid(job.error) : failed("video_failed");
              }
              if (remaining() < (config.videoMinRetryMs ?? 20_000)) {
                logFail("window_cutoff", attempt, job, { cause: reason, next: "none" });
                return failed("video_failed");
              }
              logFail(reason, attempt, job, { next: n + 1 < attempts.length ? "next_model" : "none" });
              break;
            }
            await sleep(Math.min(config.videoPollMs ?? 2000, remaining()));
            if (remaining() <= 0) break;
            try {
              const poll = await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}/${id}`, {
                headers: { "X-Job-Token": token },
                signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, remaining()))) });
              const update = await poll.json().catch(() => null);
              lastHttp.status = poll.status;
              if (poll.ok && update) job = { ...update, id }; else lastHttp.errors = (lastHttp.errors ?? 0) + 1;
            } catch { lastHttp.errors = (lastHttp.errors ?? 0) + 1; /* Keep holding: a network failure says nothing about whether the clip finished. */ }
          }
          if (!actual && remaining() <= 0) {
            logFail("poll_timeout", attempt, job, { next: "none" });
            try {
              await fetchImpl(`${config.surplusUrl}${VIDEO_ROUTE}/${id}`, { method: "DELETE",
                headers: { "X-Job-Token": token }, signal: AbortSignal.timeout(10_000) });
            } catch { /* Cancellation is best effort; its outcome must never turn a late clip into a charge. */ }
            return failed("video_timeout");
          }
          if (actual) break;
          continue;
        }
        if (response.status === 400 && (job?.error?.code === "invalid_request"
          || job?.error?.type === "invalid_request") && attempt.model === request.model) return invalid(job.error);
        // A submit whose answer we cannot read (5xx other than Surplus's own 503, or a 2xx with no job) may still
        // have started a job: a second model would fund two clips for one payment, so the chain stops here.
        if (response.status >= 500 && response.status !== 503 || response.status < 400 && response.status >= 200) {
          note(`singit-ask: video submit for ${attempt.model} answered HTTP ${response.status} with no usable job ${JSON.stringify({
            error_code: safeLog(job?.error?.code, 80, exactSecrets()), elapsed_s: Math.round((now() - started) / 100) / 10 })}`);
          return failed("video_failed");
        }
      } catch (error) {
        // Unreachable or timed out: the job may exist upstream under this Idempotency-Key; never start another.
        note(`singit-ask: video submit unreachable (${error.name}) after ${Math.round((now() - started) / 100) / 10} s`);
        return failed("video_failed");
      }
    }
    if (!actual && accepted) return failed("video_failed");
    if (!actual) return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error",
      code: "no_healthy_sellers", message: "The video was not started. You were not charged." } });
    if (actual !== request.model) log(`singit-ask: video substitution ${request.model} -> ${actual}`);
    const billing = { ...videoPrice(listAtomic, network), currency: "USDC" };
    log(`singit-ask: video job ${job.id} for ${actual} finished for ${billing.totalAtomic} micro-USDC`);
    // The middleware settles once, after this completed response, at the original signed quote.
    res.json({ ...publicJob({ ...job, model: actual }, origin(req)), job_token: token,
      ...(actual !== request.model ? { requested_model: request.model, substituted: true } : {}),
      poll: `${VIDEO_ROUTE}/${job.id}`, billing });
  });
}
