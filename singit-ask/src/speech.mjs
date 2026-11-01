// SingIt speech: text read aloud by any of Surplus's voice models, sold over x402 at the model's list price for the
// text's length + 30% + the network's settlement fee, and made on Surplus with this service's own key.
//
// The price follows from the text before the payer is asked (the models are priced per 1000 characters); the
// payment is verified, Surplus makes the audio, and only then is the payment settled: no audio, no charge. The audio
// is checked against the requested format (mp3 by default), with what was charged in the X-SingIt-* headers.
import crypto from "node:crypto";
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
const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
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
const FEES = { [BASE]: TERMS.settlementFeeAtomic, [SOLANA]: SOLANA_TERMS.settlementFeeAtomic };

export class SpeechError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readSpeechRequest(body, model) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SpeechError(400, "Send a JSON body.");
  if (typeof body.input !== "string" || !body.input.trim() || body.input.length > SPEECH_TERMS.maxChars) {
    throw new SpeechError(400, `Send input text of up to ${SPEECH_TERMS.maxChars} characters.`);
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
    request.response_format = body.response_format;
  }
  if (body.speed !== undefined) {
    if (typeof body.speed !== "number" || body.speed < 0.25 || body.speed > 4) throw new SpeechError(400, "speed must be 0.25 to 4.");
    request.speed = body.speed;
  }
  return request;
}

// The model's list price for this text, in micro-USD (at least 1).
export const speechListAtomic = (model, request) => Math.max(1, Math.ceil(model.usdPerUnit * request.input.length / 1000 * 1e6));

export function speechPrice(listAtomic, network) {
  const list = BigInt(listAtomic);
  const markup = (list * BigInt(SPEECH_TERMS.markupBps) + 9999n) / 10000n;
  return { listAtomic: list.toString(), markupAtomic: markup.toString(), feeAtomic: FEES[network],
           totalAtomic: (list + markup + BigInt(FEES[network])).toString() };
}

// Keep discovery descriptions within 160 characters, capability first (see app.mjs).
const DESCRIPTION = "Text-to-speech API (Kokoro, ElevenLabs, Gemini and more), OpenAI speech format. Pay per request in USDC on Base or Solana, no key.";

const INPUT_SCHEMA = { properties: {
  model: { type: "string", examples: ["venice-kokoro-tts"], description: "A speech model id from GET /v1/audio/models." },
  input: { type: "string", minLength: 1, maxLength: SPEECH_TERMS.maxChars, description: "The text to read aloud." },
  voice: { type: "string", maxLength: 60, examples: ["af_heart"], description: "A voice of the model; they are listed at GET /v1/audio/models." },
  response_format: { type: "string", enum: [...FORMATS], default: "mp3", description: "mp3 (audio/mpeg) is the default; other response_format values return their own Content-Type." },
  speed: { type: "number", minimum: 0.25, maximum: 4, description: "Speaking speed." },
}, required: ["model", "input"] };

// The example body declared to Bazaar, and what the discovery probes are priced as (see `probeList`).
const EXAMPLE = Object.freeze({ model: "venice-kokoro-tts", input: "Hello from SingIt.", voice: "af_heart", response_format: "mp3" });
// The request body as openapi.json documents it: the schema and example the Bazaar listing declares.
export const SPEECH_REQUEST_BODY = () => ({ required: true, content: { "application/json": {
  schema: { type: "object", ...INPUT_SCHEMA }, example: EXAMPLE } } });

export function addSpeechRoutes(app, config, { facilitatorClient, catalogue, fetchImpl = fetch, log = console.error, open }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  const priced = new WeakMap();
  const used = new Map();
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

  // Free: every voice model, speech per 1000 characters and transcription per minute (transcription: API keys only).
  app.get(AUDIO_MODELS_ROUTE, open, async (_req, res) => {
    const voice = await catalogue.voiceModels().catch(() => ({ speech: new Map(), transcription: new Map() }));
    const speech = [...voice.speech.values()].map((m) => ({ id: m.id, object: "model", kind: "speech", name: m.name,
      owned_by: m.provider || "surplus", voices: m.voices, listUsdPer1kChars: m.usdPerUnit,
      singitUsdPer1kChars: Number((m.usdPerUnit * (1 + SPEECH_TERMS.markupBps / 10000)).toFixed(6)) }));
    const transcription = [...voice.transcription.values()].map((m) => ({ id: m.id, object: "model", kind: "transcription",
      name: m.name, owned_by: m.provider || "surplus", listUsdPerMinute: m.usdPerUnit,
      singitUsdPerMinute: Number((m.usdPerUnit * (1 + SPEECH_TERMS.markupBps / 10000)).toFixed(6)) }));
    res.json({ object: "list", endpoint: SPEECH_ROUTE, fees: { markupPct: SPEECH_TERMS.markupBps / 100,
      perRequestUsd: { [BASE]: Number(TERMS.settlementFeeAtomic) / 1e6, [SOLANA]: Number(SOLANA_TERMS.settlementFeeAtomic) / 1e6 } },
      data: [...speech.sort((a, b) => a.listUsdPer1kChars - b.listUsdPer1kChars),
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
      priced.set(req.body, { request, listAtomic: speechListAtomic(model, request) });
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
    mimeType: "audio/mpeg", description: DESCRIPTION, serviceName: SERVICE_NAMES[SPEECH_ROUTE], iconUrl: ICON_URL,
    tags: discoveryTags("text-to-speech", "tts", "speech", "audio", "openai-compatible", "pay-per-use", "solana", "base",
                        "singit"),
    // The answer is audio bytes, not JSON, so there is no JSON output example to give.
    extensions: declareDiscoveryExtension({ bodyType: "json",
      input: EXAMPLE,
      inputSchema: INPUT_SCHEMA }),
  } }, server, { log });
  app.post(SPEECH_ROUTE, async (req, res) => {
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
    const seen = digest(header);
    if (used.has(seen)) return res.status(409).json({ error: { type: "invalid_request_error", code: "payment_duplicate", message: "This payment was already used." } });
    used.set(seen, Date.now());
    for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
    const { request, listAtomic } = priced.get(req.body);
    const started = Date.now();
    let response, audio;
    try {
      response = await fetchImpl(`${config.surplusUrl}${SPEECH_ROUTE}`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(120_000) });
      audio = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      log(`singit-ask: voice model unreachable (${error.name})`);
      return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "no_billable_answer", message: "No audio was made. You were not charged." } });
    }
    const type = response.headers.get("content-type") ?? "";
    const format = request.response_format ?? "mp3";
    const pcmError = format === "pcm" && /(?:json|text|html)/i.test(type);
    if (!response.ok || !audio.length || !matchesSpeechFormat(audio, format) || pcmError) {
      log(`singit-ask: voice model ${request.model} answered HTTP ${response.status} (format ${format}, upstream content-type ${JSON.stringify(type)}, ${audio.length} bytes, first4 ${audio.subarray(0, 4).toString("hex")})`);
      return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "no_billable_answer", message: "No audio was made. You were not charged." } });
    }
    const cost = Number(response.headers.get("x-si-buyer-cost-micro"));
    if (Number.isFinite(cost) && cost > listAtomic) log(`singit-ask: ${request.model} cost ${cost} micro-USD, listed ${listAtomic}`);
    const billing = speechPrice(listAtomic, network);
    log(`singit-ask: ${request.input.length} characters read by ${request.model} in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC (format ${format}, upstream content-type ${JSON.stringify(type)}, ${audio.length} bytes)`);
    res.set({ "Content-Type": speechContentType(format, audio), "X-SingIt-Charged-Atomic": billing.totalAtomic, "X-SingIt-List-Atomic": billing.listAtomic,
              "Cache-Control": "no-store" });
    res.send(audio);
  });
}
