import { routeCopy } from "./listing-snapshot.mjs";
import { attachPaymentFailureCodes } from "./payment-failure-hooks.mjs";
// SingIt speech: text read aloud by any of Surplus's voice models, sold over x402 at the model's list price for the
// text's length + 30% + the network's settlement fee, and made on Surplus with this service's own key.
//
// The price follows from the text before the payer is asked (the models are priced per 1000 characters); the
// payment is verified, Surplus makes the audio, and only then is the payment settled: no audio, no charge. The audio
// is checked against the requested format (mp3 by default), with what was charged in the X-SingIt-* headers.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import { Readable } from "node:stream";
import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { UnknownModel } from "./catalogue.mjs";
import { addPaymentRoute, isDiscoveryProbe, perRequest } from "./metered.mjs";
import { ASSET, BASE, SOLANA, SOLANA_ASSET, TERMS, SOLANA_TERMS, SERVICE_NAMES, ICON_URL, discoveryTags } from "./pricing.mjs";

export const SPEECH_ROUTE = "/v1/audio/speech";
export const AUDIO_MODELS_ROUTE = "/v1/audio/models";
export const SPEECH_TERMS = Object.freeze({ markupBps: 3000, maxChars: 4096 });
export const ASYNC_SPEECH_TERMS = Object.freeze({ markupBps: 3000, maxChars: 4096, timeoutMs: 110_000, pollMs: 1000, maxBytes: 20 * 1024 * 1024 });
const AUDIO_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
const JSON_ENVELOPES = new Set(["json", "b64_json"]);
const FORMATS = new Set([...AUDIO_FORMATS, ...JSON_ENVELOPES]);
export const SPEECH_CONTENT_TYPES = Object.freeze({
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", opus: "audio/ogg", aac: "audio/aac", pcm: "audio/pcm",
});
// aac packaged in an MP4/M4A box is audio/mp4, not an elementary AAC stream; everything else keeps the requested format's type.
export const speechContentType = (format, audio) =>
  format === "aac" && audio.length >= 8 && audio.subarray(4, 8).toString("latin1") === "ftyp" ? "audio/mp4" : SPEECH_CONTENT_TYPES[format];

// Container signatures only: this is a pre-settlement sanity check, not a decoder.
export function matchesSpeechFormat(audio, format = "mp3") {
  const starts = (magic, offset = 0) => audio.length >= offset + magic.length
    && audio.subarray(offset, offset + magic.length).equals(Buffer.from(magic));
  switch (format) {
    case "mp3": return starts("ID3") || (audio.length >= 2 && audio[0] === 0xff
      && (audio[1] & 0xe0) === 0xe0 && (audio[1] & 0x06) !== 0);
    case "wav": return starts("RIFF") && starts("WAVE", 8);
    case "flac": return starts("fLaC");
    case "opus": return starts("OggS");
    case "aac": return (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xf6) === 0xf0)
      || starts("ADIF") || starts("ftyp", 4);
    case "pcm": return true;
    default: return false;
  }
}
// Pipes keep audio out of temporary files; cap both runtime and buffered output.
export function transcodeWavToMp3(wavBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
      "-map", "0:a:0", "-vn", "-codec:a", "libmp3lame", "-f", "mp3", "pipe:1"],
    { encoding: "buffer", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 20 * 1024 * 1024 }, (error, audio) => {
      if (error) return reject(new Error("Speech transcoding failed."));
      if (!audio.length || !matchesSpeechFormat(audio, "mp3")) return reject(new Error("Invalid transcoded MP3."));
      resolve(audio);
    });
    child.stdin.on("error", () => {
      child.kill("SIGKILL");
      reject(new Error("Speech transcoding input failed."));
    });
    child.stdin.end(wavBuffer);
  });
}

const FEES = { [BASE]: TERMS.settlementFeeAtomic, [SOLANA]: SOLANA_TERMS.settlementFeeAtomic };

export class SpeechError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readSpeechRequest(body, model) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SpeechError(400, "Send a JSON body.");
  if (typeof body.input !== "string" || !body.input.trim() || body.input.length > SPEECH_TERMS.maxChars) {
    throw new SpeechError(400, `Send input text of up to ${SPEECH_TERMS.maxChars} characters.`);
  }
  const envelope = JSON_ENVELOPES.has(body.response_format);
  // json/b64_json only wrap the audio we already made; they are never sent upstream.
  if (model.usdPerJob && (body.speed !== undefined || (body.response_format !== undefined && !envelope))) {
    throw new SpeechError(400, "Async speech returns the provider audio format; speed and response_format are not supported.");
  }
  const request = { model: model.id, input: body.input };
  if (body.voice !== undefined) {
    if (typeof body.voice !== "string" || body.voice.length > 60 || (model.voices && !model.voices.includes(body.voice))) {
      throw new SpeechError(400, model.voices ? `voice must be one of ${model.voices.slice(0, 12).join(", ")}…` : "voice must be a short string.");
    }
    request.voice = body.voice;
  }
  if (body.response_format !== undefined) {
    if (!FORMATS.has(body.response_format)) throw new SpeechError(400, `response_format must be one of ${[...FORMATS].join(", ")}.`);
    if (envelope) request.envelope = "json";
    else request.response_format = body.response_format;
  }
  if (body.speed !== undefined) {
    if (typeof body.speed !== "number" || body.speed < 0.25 || body.speed > 4) throw new SpeechError(400, "speed must be 0.25 to 4.");
    request.speed = body.speed;
  }
  return request;
}

// The model's list price for this text, in micro-USD (at least 1).
export const speechListAtomic = (model, request) => Math.max(1, Math.ceil((model.usdPerJob ?? model.usdPerUnit * request.input.length / 1000) * 1e6));

export function speechPrice(listAtomic, network) {
  const list = BigInt(listAtomic);
  const markup = (list * BigInt(SPEECH_TERMS.markupBps) + 9999n) / 10000n;
  return { listAtomic: list.toString(), markupAtomic: markup.toString(), feeAtomic: FEES[network],
           totalAtomic: (list + markup + BigInt(FEES[network])).toString() };
}

// Keep discovery descriptions within 160 characters, capability first (see app.mjs).
const DESCRIPTION = routeCopy("/v1/audio/speech").description;

const INPUT_SCHEMA = { properties: {
  model: { type: "string", examples: ["venice-kokoro-tts"], description: "A speech model id from GET /v1/audio/models, including elevenlabs/multilingual-v2, elevenlabs/v3, bytedance/seed-audio-1.0 (fixed per-job pricing; provider audio format; no speed/response_format)." },
  input: { type: "string", minLength: 1, maxLength: SPEECH_TERMS.maxChars, description: "The text to read aloud." },
  voice: { type: "string", maxLength: 60, examples: ["af_heart"], description: "A voice of the model; they are listed at GET /v1/audio/models." },
  response_format: { type: "string", enum: [...FORMATS], default: "mp3", description: "mp3 (audio/mpeg) is the default; json and b64_json wrap that default mp3 as JSON with audio_base64; other values return their own Content-Type." },
  speed: { type: "number", minimum: 0.25, maximum: 4, description: "Speaking speed." },
}, required: ["model", "input"] };

// The example body declared to Bazaar, and what the discovery probes are priced as (see `probeList`).
const EXAMPLE = Object.freeze({ model: "venice-kokoro-tts", input: "Hello from SingIt.", voice: "af_heart", response_format: "b64_json" });
export const SPEECH_JSON_EXAMPLE = Object.freeze({
  object: "audio", model: "venice-kokoro-tts", voice: "af_heart", format: "mp3",
  content_type: "audio/mpeg", audio_base64: "SUQzBA==", bytes: 4,
});
export const SPEECH_JSON_SCHEMA = { type: "object", required: ["object", "model", "format", "content_type", "audio_base64", "bytes"], properties: {
  object: { type: "string", const: "audio" }, model: { type: "string" }, voice: { type: "string" },
  format: { type: "string", enum: [...AUDIO_FORMATS] }, content_type: { type: "string" },
  audio_base64: { type: "string", description: "The audio bytes, standard base64." },
  bytes: { type: "integer", minimum: 1 },
} };
// The request body as openapi.json documents it: the schema and example the Bazaar listing declares.
export const SPEECH_REQUEST_BODY = () => ({ required: true, content: { "application/json": {
  schema: { type: "object", ...INPUT_SCHEMA }, example: EXAMPLE } } });

export function addSpeechRoutes(app, config, { facilitatorClient, publicClient, catalogue, fetchImpl = fetch, resolveHostname = lookup, ffmpeg = transcodeWavToMp3, log = console.error, open }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  attachPaymentFailureCodes(server);
  const priced = new WeakMap();
  const used = new Map();
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

  // Free: speech prices for x402 and transcription prices for API-key consumers.
  app.get(AUDIO_MODELS_ROUTE, open, async (_req, res) => {
    const voice = await catalogue.voiceModels().catch(() => ({ speech: new Map(), transcription: new Map() }));
    const speech = [...voice.speech.values()].map((m) => ({ id: m.id, object: "model", kind: "speech", modality: "speech", upstream_id: m.upstreamId ?? m.id, x402: true, route: SPEECH_ROUTE, name: m.name,
      owned_by: m.provider || "surplus", voices: m.voices, ...(m.usdPerJob ? { listUsdPerJob: m.usdPerJob,
        singitUsdPerJob: (Number(speechPrice(Math.ceil(m.usdPerJob * 1e6), BASE).totalAtomic) - Number(FEES[BASE])) / 1e6,
        totalUsdPerJob: Object.fromEntries([BASE, SOLANA].map(n => [n, Number(speechPrice(Math.ceil(m.usdPerJob * 1e6), n).totalAtomic) / 1e6])) }
        : { listUsdPer1kChars: m.usdPerUnit,
      singitUsdPer1kChars: Number((m.usdPerUnit * (1 + SPEECH_TERMS.markupBps / 10000)).toFixed(6)) }) }));
    const transcription = [...voice.transcription.values()].map((m) => ({ id: m.id, object: "model", kind: "transcription",
      x402: false, route: null, access: "api-key",
      name: m.name, owned_by: m.provider || "surplus", listUsdPerMinute: m.usdPerUnit,
      singitUsdPerMinute: Number((m.usdPerUnit * (1 + SPEECH_TERMS.markupBps / 10000)).toFixed(6)) }));
    res.json({ object: "list", endpoint: SPEECH_ROUTE,
      note: "Transcription models are priced here for API-key use and are not payable on /v1/audio/speech over x402.",
      fees: { markupPct: SPEECH_TERMS.markupBps / 100,
      perRequestUsd: { [BASE]: Number(TERMS.settlementFeeAtomic) / 1e6, [SOLANA]: Number(SOLANA_TERMS.settlementFeeAtomic) / 1e6 } },
      data: [...speech.sort((a, b) => (a.listUsdPerJob ?? a.listUsdPer1kChars) - (b.listUsdPerJob ?? b.listUsdPer1kChars)),
             ...transcription.sort((a, b) => a.listUsdPerMinute - b.listUsdPerMinute)] });
  });

  // The discovery probes (GET/HEAD and the empty, unpaid POST) are offered what EXAMPLE, the body declared to
  // Bazaar below, is offered right now: the price CDP's Bazaar records for this route and what vet402 compares its
  // empty POST against (price_mismatch otherwise). The old standing list price only when it cannot be quoted now.
  const probeList = perRequest(async () => {
    try {
      const model = await catalogue.resolveSpeech(EXAMPLE.model);
      return speechListAtomic(model, readSpeechRequest(EXAMPLE, model));
    } catch {
      return 1_000_000;
    }
  });
  const price = (network) => async (ctx) => {
    const quote = priced.get(ctx.adapter.getBody());
    const amount = speechPrice(quote?.listAtomic ?? await probeList(ctx), network).totalAtomic;
    return network === BASE ? { asset: ASSET, amount, extra: { name: "USD Coin", version: "2" } } : { asset: SOLANA_ASSET, amount };
  };
  app.post(SPEECH_ROUTE, async (req, res, next) => {
    // x402scan's empty, unpaid probe gets the example's offer (`probeList`), not a model-lookup 404.
    if (isDiscoveryProbe(req)) return next();
    try {
      const model = await catalogue.resolveSpeech(req.body?.model);
      const request = readSpeechRequest(req.body, model);
      priced.set(req.body, { model, request, listAtomic: speechListAtomic(model, request) });
      next();
    } catch (error) {
      const status = error instanceof UnknownModel ? 404 : error.status ?? 503;
      res.status(status).json({ error: { type: status === 503 ? "upstream_error" : "invalid_request_error",
        code: status === 404 ? "model_not_found" : status === 503 ? "upstream_unavailable" : "invalid_request", message: status === 503 ? "Try again shortly." : error.message } });
    }
  });
  addPaymentRoute(app, { [`POST ${SPEECH_ROUTE}`]: {
    // exact on Base first: the simplest offer for a buyer that only inspects accepts[0].
    accepts: [
      { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120, price: price(BASE) },
      { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 120, price: price(SOLANA) },
    ],
    mimeType: "application/json", description: DESCRIPTION, serviceName: SERVICE_NAMES[SPEECH_ROUTE], iconUrl: ICON_URL,
    tags: discoveryTags("text-to-speech", ...routeCopy("/v1/audio/speech").tags, "tts", "speech", "audio", "openai-compatible", "pay-per-use", "solana", "base",
                        "singit"),
    // Advertised example opts into the JSON envelope so directories that require JSON on 2xx can verify delivery.
    extensions: declareDiscoveryExtension({ bodyType: "json",
      input: EXAMPLE,
      inputSchema: INPUT_SCHEMA,
      output: { example: SPEECH_JSON_EXAMPLE, schema: SPEECH_JSON_SCHEMA } }),
  } }, server, { log, publicClient });
  app.post(SPEECH_ROUTE, async (req, res) => {
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
    const seen = digest(header);
    if (used.has(seen)) return res.status(409).json({ error: { type: "invalid_request_error", code: "payment_duplicate", message: "This payment was already used." } });
    used.set(seen, Date.now());
    for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
    const { model, request, listAtomic } = priced.get(req.body);
    const started = Date.now();
    let response, audio, actualFormat;
    try {
      if (model.usdPerJob) {
        ({ response, audio, format: actualFormat } = await generateAsyncSpeech(config, model, request, { fetchImpl, resolveHostname }));
      } else {
        const { envelope: _envelope, ...upstreamRequest } = request;
        response = await fetchImpl(`${config.surplusUrl}${SPEECH_ROUTE}`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}` },
        body: JSON.stringify(upstreamRequest), signal: AbortSignal.timeout(120_000) });
        audio = Buffer.from(await response.arrayBuffer());
      }
    } catch (error) {
      log(`singit-ask: voice model unreachable (${error.name})`);
      return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "no_billable_answer", message: "No audio was made. You were not charged." } });
    }
    const type = response.headers.get("content-type") ?? "";
    const format = actualFormat ?? request.response_format ?? "mp3";
    if (response.ok && format === "mp3" && !matchesSpeechFormat(audio, format) && matchesSpeechFormat(audio, "wav")) {
      const inputBytes = audio.length;
      try {
        const mp3 = await ffmpeg(audio);
        if (!Buffer.isBuffer(mp3) || !mp3.length || !matchesSpeechFormat(mp3, "mp3")) throw new Error("Invalid MP3");
        audio = mp3;
        log(`singit-ask: voice model ${request.model} transcoded WAV to mp3 (${inputBytes} in bytes, ${audio.length} out bytes)`);
      } catch {
        log(`singit-ask: voice model ${request.model} WAV to mp3 transcoding failed (${inputBytes} in bytes, 0 out bytes)`);
      }
    }
    const pcmError = format === "pcm" && /(?:json|text|html)/i.test(type);
    if (!response.ok || !audio.length || !matchesSpeechFormat(audio, format) || pcmError) {
      log(`singit-ask: voice model ${request.model} answered HTTP ${response.status} (format ${format}, upstream content-type ${JSON.stringify(type)}, ${audio.length} bytes, first4 ${audio.subarray(0, 4).toString("hex")})`);
      return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "no_billable_answer", message: "No audio was made. You were not charged." } });
    }
    const cost = Number(response.headers.get("x-si-buyer-cost-micro"));
    if (Number.isFinite(cost) && cost > listAtomic) log(`singit-ask: ${request.model} cost ${cost} micro-USD, listed ${listAtomic}`);
    const billing = speechPrice(listAtomic, network);
    log(`singit-ask: ${request.input.length} characters read by ${request.model} in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC (format ${format}, upstream content-type ${JSON.stringify(type)}, ${audio.length} bytes)`);
    const contentType = speechContentType(format, audio);
    res.set({ "X-SingIt-Charged-Atomic": billing.totalAtomic, "X-SingIt-List-Atomic": billing.listAtomic,
              "Cache-Control": "no-store" });
    if (request.envelope === "json") {
      return res.json({
        object: "audio", model: request.model, ...(request.voice ? { voice: request.voice } : {}),
        format, content_type: contentType, audio_base64: audio.toString("base64"), bytes: audio.length,
      });
    }
    res.set("Content-Type", contentType);
    res.send(audio);
  });
}

// OPEN QUESTION: offline docs do not specify TTS fields on music jobs. Verify prompt + voice
// with one explicitly approved paid call before merging. Keep this assumption in one adapter.
export function asyncSpeechBody(model, request) {
  return { model: model.upstreamId, prompt: request.input, ...(request.voice ? { voice: request.voice } : {}) };
}

export async function generateAsyncSpeech(config, model, request, {
  fetchImpl = fetch, artifactFetch, resolveHostname = lookup, timeoutMs = ASYNC_SPEECH_TERMS.timeoutMs,
  pollMs = ASYNC_SPEECH_TERMS.pollMs, maxBytes = ASYNC_SPEECH_TERMS.maxBytes,
} = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { Authorization: `Bearer ${config.surplusKey}` };
  // The same deadline covers submission, polling, redirects and streamed download.
  const get = async (path, init = {}) => {
    signal.throwIfAborted();
    const response = await fetchImpl(`${config.surplusUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal });
    if (!response.ok) throw new SpeechError(503, "Speech upstream unavailable.");
    return response;
  };
  // Default production path pins the validated address on the TLS socket (DNS rebinding).
  // Tests may inject artifactFetch or a custom fetchImpl for the download hop.
  const download = artifactFetch ?? (fetchImpl === fetch ? pinnedFetch
    : (url, init) => fetchImpl(url.href, init));
  let job = await (await get('/v1/music/generations', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(asyncSpeechBody(model, request)) })).json();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(job?.id ?? '')) throw new SpeechError(503, 'Invalid speech job.');
  const id = job.id;
  while (job.status !== 'succeeded') {
    if (!['queued', 'submitted', 'running'].includes(job.status)) throw new SpeechError(503, 'Speech job failed.');
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, pollMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    job = await (await get(`/v1/music/generations/${id}`)).json();
  }
  if (!Array.isArray(job.results) || !job.results.length) throw new SpeechError(503, 'Missing speech artifact.');
  const origin = new URL(config.surplusUrl).origin;
  let url = new URL(`/v1/media/artifacts/${id}/0`, origin);
  let response;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const address = await validateArtifactUrl(url, resolveHostname);
    response = await download(url, { redirect: 'manual', signal,
      headers: url.origin === origin ? headers : {} }, address);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects >= 3) throw new SpeechError(503, 'Invalid speech artifact redirect.');
    url = new URL(location, url);
  }
  if (!response.ok) throw new SpeechError(503, 'Speech artifact unavailable.');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new SpeechError(503, 'Speech artifact too large.');
  }
  const chunks = []; let bytes = 0;
  if (!response.body) throw new SpeechError(503, 'Empty speech artifact.');
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maxBytes) throw new SpeechError(503, 'Speech artifact too large.');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  const audio = Buffer.concat(chunks);
  const format = ['mp3', 'wav', 'opus', 'flac', 'aac'].find(f => matchesSpeechFormat(audio, f));
  if (!audio.length || !format) throw new SpeechError(503, 'Invalid speech artifact.');
  return { response, audio, format };
}

// Reject non-public destinations, including IPv4-mapped IPv6 addresses. Resolve every
// hop (including Surplus); a hostname with any unsafe answer fails closed. The first
// safe answer is pinned onto the TLS connection so a later DNS rebind cannot switch hosts.
const artifactBlocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['168.63.129.16', 32], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) artifactBlocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::1', 128], ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16],
]) artifactBlocked.addSubnet(address, prefix, 'ipv6');
async function validateArtifactUrl(url, resolveHostname) {
  if (url.protocol !== 'https:' || url.username || url.password) throw new SpeechError(503, 'Unsafe speech artifact URL.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }]
    : await resolveHostname(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address }) => {
    const fam = isIP(address);
    return !fam || artifactBlocked.check(address, fam === 4 ? 'ipv4' : 'ipv6');
  })) throw new SpeechError(503, 'Unsafe speech artifact address.');
  const chosen = addresses[0];
  return { address: chosen.address, family: chosen.family || isIP(chosen.address) };
}
// Pin the checked address to the TLS connection; hostname still verifies the certificate.
function pinnedFetch(url, { headers, signal }, address) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, signal, lookup: (_host, options, cb) =>
      options.all ? cb(null, [address]) : cb(null, address.address, address.family) }, (res) => {
      try {
        const nullBody = [101, 204, 205, 304].includes(res.statusCode);
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
      } catch (error) { reject(error); }
    });
    req.on('error', reject); req.end();
  });
}
