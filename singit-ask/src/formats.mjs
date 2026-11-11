import { isFable52, samplingAllowed, forcedToolError } from "./model-policy.mjs";
import { routeCopy } from "./listing-snapshot.mjs";
import { validateStream, consumeMessagesStream, consumeResponsesStream, terminalSSE, StreamBreak } from './agent-stream.mjs';
import { isEventStream } from './sse-read.mjs';
import { upstreamModelId } from "./model-aliases.mjs";

import { attachPaymentFailureCodes } from "./payment-failure-hooks.mjs";
import { parseBestDiscount } from "./reject-log.mjs";
import { MAX_TOKENS_TOO_SMALL } from "./errors.mjs";
import { randomUUID } from "node:crypto";
import { solanaExactWindow, withinWindow, windowRefusal, WindowExceeded, fallbackReserveMs } from "./solana-exact-window.mjs";
import { rankPaidAlternates } from "./auto-router.mjs";
import { FormatUnserved, formatAlternates, asUpstreamError, isReasoningModel } from "./format-fallback.mjs";
import { reserveChatPayment, reservationRefusal } from "./payment-reservation.mjs";
// The other two ways agents ask a model, besides OpenAI's chat completions: Anthropic's Messages (POST /v1/messages,
// what Claude Code and the Anthropic SDK speak) and OpenAI's Responses (POST /v1/responses). Sold over x402 like the
// chat route: the payer authorizes a ceiling with `upto`, worked out from the model's list price and the size of the
// request, and is charged the price shown for the model, metered by what the answer actually used, plus the network's settlement fee, only once it came back.
//
// The request goes to Surplus as it came, with this service's key, apart from the model's name (Anthropic's dated
// names become Surplus's) and a bounded answer length. stream:true is relayed live (agent-stream.mjs); only the terminal events wait for settlement.
import { x402ResourceServer, setSettlementOverrides } from "@x402/express";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { createUptoSvmServerScheme } from "./upto-svm-claim.mjs";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { markUnservable, unservableError, UnknownModel, priceGuard } from "./catalogue.mjs";
import { acceptedOf, answerLogFor, recordWhenSettled } from "./answer-log.mjs";
import { probeInput, probeNote, canRetryPaidFallback, fitsSignedCatalogCeiling } from "./metered.mjs";
import { billWithDiagnostics, addPaymentRoute, baseOffer, ceilings, exactBaseOffer, exactSolanaOffer, isDiscoveryProbe, perRequest, relaxMinDiscount, solanaOffer } from "./metered.mjs";
import { BASE, SOLANA, TERMS, SOLANA_TERMS, minDiscountFor, reasoningHeadroom, retryBudget, DEFAULT_EXACT_OUTPUT_FRACTION, SERVICE_NAMES, ICON_URL, discoveryTags, publicBilling } from "./pricing.mjs";

export const FORMAT_ROUTES = { "/v1/messages": "/anthropic/v1/messages", "/v1/responses": "/v1/responses" };
export const FORMAT_LIMITS = Object.freeze({ chars: 100_000, maxTokens: 32_000, defaultTokens: 4_096, timeoutMs: 120_000 });
const TERMS_BY_NETWORK = { [BASE]: TERMS, [SOLANA]: SOLANA_TERMS };
// Anthropic's SDK and Claude Code name models as Anthropic does (claude-sonnet-5-5, claude-fable-5-1, maybe dated); Surplus as claude-sonnet-5.5.
const ANTHROPIC_ID = /^(claude-(?:opus|sonnet|haiku|fable))-(\d+)-(\d+)(?:-\d{8})?$/;
const UPSTREAM_FIELDS = ["provider", "cost"]; // the seller, and its own price with the seller's unit
const UPSTREAM_USAGE_FIELDS = ["cost", "is_byok", "cost_details", "buyer_cost_micro"];

export class FormatError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A Surplus answer that is not billable. `code` is Surplus's error.code (Anthropic's envelope has none: its
// error.type then), or ours; never Surplus's message, which is not for matching. The message is safe to log.
class NoAnswer extends Error {
  constructor(status, code) { super(`model answered HTTP ${status} (${code})`); this.name = "NoAnswer"; this.status = status; this.code = code; }
}

// Sampling knobs a caller may send that a model can refuse outright (Surplus forwards what it does not strip: kimi-k3
// and claude-opus-5.5 refuse temperature, SI-62). Each is dropped when the model's supported_parameters do not list
// it; a model with no list keeps the request as it came.
const FILTERED_PARAMS = ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "reasoning_effort"];
export function fitRequest(request, params) {
  if (!Array.isArray(params) && samplingAllowed(request.model, "temperature")) return request;
  const fitted = { ...request };
  for (const name of FILTERED_PARAMS) if (name in fitted && (!samplingAllowed(request.model, name) || (Array.isArray(params) && !params.includes(name)))) delete fitted[name];
  if (isFable52(request.model) && fitted.reasoning_effort === undefined && fitted.reasoning === undefined) {
    if (!Array.isArray(params) || params.includes("reasoning_effort")) fitted.reasoning_effort = "low";
    else if (params.includes("reasoning")) fitted.reasoning = { effort: "low" };
  }
  return fitted;
}

// REASONING_HEADROOM (pricing.mjs, SI-112): the room the ceiling already prices for a model that cannot stop
// thinking is added to the answer limit sent upstream, as askSurplus does on the chat routes.
export function withHeadroom(request, info) {
  const extra = reasoningHeadroom(request?.model, info);
  if (!extra) return request;
  const field = Number.isInteger(request.max_output_tokens) ? "max_output_tokens" : Number.isInteger(request.max_tokens) ? "max_tokens" : null;
  return field ? { ...request, [field]: request[field] + extra } : request;
}

// A reasoning model asked for a small answer spends all of it thinking (qwen3-5-9b at max_tokens 150, 11 November 2026).
// So it is asked for at least this many tokens upstream, without touching the quoted ceiling: an answer that costs more than
// was signed is billed at the signed amount and the service absorbs the rest (billUsage allowOverrun, as for a
// reasoning retry). Only when the dearest the raised budget could cost stays within MIN_BUDGET_EXPOSURE times what
// the request was quoted, so an expensive model is never asked for more than its payer priced.
export const REASONING_MIN_UPSTREAM_TOKENS = 1024;
const MIN_BUDGET_EXPOSURE = 3n;
const budgetField = request => (Number.isInteger(request.max_output_tokens) ? "max_output_tokens" : "max_tokens");
export function withMinBudget(request, format, exactOutputFraction) {
  const field = budgetField(request);
  if (!isReasoningModel(format.info) || !Number.isInteger(request[field]) || request[field] >= REASONING_MIN_UPSTREAM_TOKENS) return { request, raised: false };
  // `ceilings` prices the headroom already in `request` as overhead, so price the raised budget without counting it twice.
  const headroom = reasoningHeadroom(request.model, format.info);
  try {
    const quoted = ceilings(format.info, format, exactOutputFraction).upto[BASE];
    const raised = ceilings(format.info, { ...format, maxTokens: Math.max(1, REASONING_MIN_UPSTREAM_TOKENS - headroom) }, exactOutputFraction).upto[BASE];
    if (BigInt(raised) > MIN_BUDGET_EXPOSURE * BigInt(quoted)) return { request, raised: false };
  } catch { return { request, raised: false }; }
  return { request: { ...request, [field]: REASONING_MIN_UPSTREAM_TOKENS }, raised: true };
}

// Whether a reasoning model spent the whole answer budget thinking and wrote nothing usable: Messages stops on
// max_tokens with no text block and no tool_use block, Responses ends incomplete on max_output_tokens with no
// output_text, no function_call, and no other non-reasoning item carrying content. A completed tool call with
// no text is still a real answer, not a reasoning-exhaustion refusal.
function hasAnswer(route, data) {
  if (route === "/v1/messages") {
    const answered = (Array.isArray(data.content) ? data.content : []).some((b) =>
      b?.type === "tool_use" || (b?.type === "text" && String(b.text ?? "").trim()));
    return answered;
  }
  const answered = (Array.isArray(data.output) ? data.output : []).some((item) => {
    if (!item || item.type === "reasoning") return false;
    if (item.type === "function_call") return true;
    return (Array.isArray(item.content) ? item.content : []).some((c) =>
      c?.type === "refusal" || (c?.type !== "reasoning_text" && String(c?.text ?? "").trim()));
  });
  return answered;
}

export function spentOnReasoning(route, data) {
  return !hasAnswer(route, data) && (route === "/v1/messages"
    ? data.stop_reason === "max_tokens"
    : data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens");
}

export const surplusModel = (name) => {
  const m = ANTHROPIC_ID.exec(name);
  return m ? `${m[1]}-${m[2]}.${m[3]}` : name;
};

// Both formats use priceGuard, just like chat. The audit's Messages quotes (18270/8106/8811)
// reproduce exactly at share=1 and max_tokens=400, not at the guarded shares in its books.
// That snapshot had no effective guard; this tree already guards real format POSTs. Messages
// additionally counts serialized envelopes/tools, and formats allow 32000 tokens, versus agent chat's 8192.
// The request sent on, its model, its size in characters and the longest answer it can get.
export function readFormatRequest(route, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FormatError(400, "Send a JSON body.");
  validateStream(body, FormatError);
  const modelOmitted = body.model === undefined || body.model === null;
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 120) {
    throw new FormatError(400, "Name a model from GET /v1/models.");
  }
  const request = { ...body, stream: body.stream === true, stream_options: undefined, model: surplusModel(body.model.trim()) };
  const forced = forcedToolError(request.model, body.tool_choice);
  if (forced) throw new FormatError(forced.status, forced.message);
  let maxTokens, sized, messageCount;
  if (route === "/v1/messages") {
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 200) {
      throw new FormatError(400, "Send 1 to 200 messages.");
    }
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > FORMAT_LIMITS.maxTokens) {
      throw new FormatError(400, `max_tokens must be 1 to ${FORMAT_LIMITS.maxTokens}.`);
    }
    maxTokens = body.max_tokens;
    sized = [body.messages, body.system ?? "", body.tools ?? ""];
    messageCount = body.messages.length;
  } else {
    if (!(typeof body.input === "string" && body.input.trim()) && !(Array.isArray(body.input) && body.input.length)) {
      throw new FormatError(400, "Send input: text or a list of items.");
    }
    if (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1
        || body.max_output_tokens > FORMAT_LIMITS.maxTokens)) {
      throw new FormatError(400, `max_output_tokens must be 1 to ${FORMAT_LIMITS.maxTokens}.`);
    }
    // An answer with no stated length could cost more than the ceiling the payer signed: it gets one.
    maxTokens = body.max_output_tokens ?? FORMAT_LIMITS.defaultTokens;
    request.max_output_tokens = maxTokens;
    sized = [body.input, body.instructions ?? "", body.tools ?? ""];
    messageCount = Array.isArray(body.input) ? body.input.length : 1;
  }
  const chars = sized.reduce((n, part) => n + (typeof part === "string" ? part.length : JSON.stringify(part).length), 0);
  if (chars > FORMAT_LIMITS.chars) throw new FormatError(400, `Keep the request under ${FORMAT_LIMITS.chars} characters.`);
  return { request, model: request.model, chars, maxTokens, messageCount,
    ...(route === "/v1/responses" ? { modelOmitted } : {}) };
}

// An answer as the format has it, without Surplus's own fields.
export function scrub(data) {
  for (const field of UPSTREAM_FIELDS) delete data[field];
  if (data.usage && typeof data.usage === "object") for (const field of UPSTREAM_USAGE_FIELDS) delete data.usage[field];
  return data;
}

const refusal = (route, status, message, code, extra = {}) => (route === "/v1/messages"
  ? { type: "error", error: { type: status === 400 || status === 422 ? "invalid_request_error" : status === 404 ? "not_found_error" : "api_error", message, code: code ?? (status === 404 ? "model_not_found" : status >= 500 ? "upstream_unavailable" : "invalid_request"), ...extra } }
  : { error: { type: status >= 500 ? "upstream_error" : "invalid_request_error", code: code ?? (status === 404 ? "model_not_found" : status >= 500 ? "upstream_unavailable" : "invalid_request"), message, ...extra } });

// Keep discovery descriptions within 500 characters, capability first (see app.mjs).
const DESCRIPTIONS = Object.fromEntries(['/v1/messages', '/v1/responses'].map(path => [path, routeCopy(path).description]));
const EXAMPLES = {
  "/v1/messages": { model: "claude-sonnet-5.5", max_tokens: 300, messages: [{ role: "user", content: "What is x402?" }] },
  "/v1/responses": { model: "deepseek-v4.1-flash", input: "What is x402?", max_output_tokens: 300 },
};
// What each field is, for the Bazaar listing: the fields readFormatRequest() checks, nothing it would refuse.
const MODEL_FIELD = { type: "string", maxLength: 120, examples: ["claude-sonnet-5.5", "deepseek-v4.1-flash", "gemini-3.8-flash"],
  description: "Any model id from GET /v1/models; Anthropic's dashed names (claude-sonnet-5-5) work too." };
const STREAM_FIELD = { type: "boolean", enum: [false, true], description: "Live SSE: tokens are relayed as the model writes them once payment is verified; billing is on the terminal event, released after settlement." };
const INPUT_SCHEMAS = {
  "/v1/messages": { properties: {
    model: MODEL_FIELD,
    max_tokens: { type: "integer", minimum: 1, maximum: FORMAT_LIMITS.maxTokens,
      description: "The longest answer, in tokens. The payment ceiling grows with it up to 32000; the charge follows what was used." },
    messages: { type: "array", minItems: 1, maxItems: 200, description: "The conversation, oldest first (Anthropic format).",
      items: { type: "object", required: ["role", "content"], properties: {
        role: { type: "string", enum: ["user", "assistant"] },
        content: { description: "Text, or a list of Anthropic content blocks." } } } },
    system: { description: "Optional system-level context for the model, as text or content blocks." },
    tools: { type: "array", description: "Optional Anthropic tool definitions." },
    stream: STREAM_FIELD,
  }, required: ["model", "max_tokens", "messages"] },
  "/v1/responses": { properties: {
    model: MODEL_FIELD,
    input: { description: "The question: text, or a non-empty list of input items (OpenAI Responses format).",
      oneOf: [{ type: "string", minLength: 1 }, { type: "array", minItems: 1 }] },
    max_output_tokens: { type: "integer", minimum: 1, maximum: FORMAT_LIMITS.maxTokens, default: FORMAT_LIMITS.defaultTokens,
      description: "The longest answer, in tokens. The payment ceiling grows with it up to 32000; the charge follows what was used." },
    instructions: { type: "string", description: "Optional system instructions." },
    tools: { type: "array", description: "Optional tool definitions." },
    stream: STREAM_FIELD,
  }, required: ["model", "input"] },
};
// A route's request body as openapi.json documents it: the schema and example the Bazaar listing declares.
export const formatRequestBody = (route) => ({ required: true, content: { "application/json": {
  schema: { type: "object", ...INPUT_SCHEMAS[route] }, example: EXAMPLES[route] } } });
// A real answer's shape and charge (Base, `upto`): settled total 1008 micro-USDC, including the 1000 settlement fee.
const BILLING_EXAMPLE = publicBilling({ ...TERMS, providerCostAtomic: "6", markupAtomic: "2", totalAtomic: "1008", currency: "USDC" });
const OUTPUT_EXAMPLES = {
  "/v1/messages": { id: "msg_01example", type: "message", role: "assistant", model: "claude-sonnet-5.5",
    content: [{ type: "text", text: "x402 is an open standard for paying for an API call with a stablecoin over HTTP 402." }],
    stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 24 }, billing: BILLING_EXAMPLE },
  "/v1/responses": { id: "resp_example", object: "response", status: "completed", model: "deepseek-v4.1-flash",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
      text: "x402 is an open standard for paying for an API call with a stablecoin over HTTP 402." }] }],
    usage: { input_tokens: 12, output_tokens: 24, total_tokens: 36 }, billing: BILLING_EXAMPLE },
};
const OUTPUT_SCHEMA = { type: "object", required: ["billing"], properties: {
  billing: { type: "object", description: "What was charged, in USDC micro-units", properties: {
    providerCostAtomic: { type: "string" },
    totalAtomic: { type: "string", description: "The amount settled" }, settlementFeeAtomic: { type: "string" },
    currency: { type: "string", const: "USDC" } } } } };
// Bazaar keeps only the first 5 (pricing.mjs's discoveryTags): the format's own category first.
const TAGS = {
  "/v1/messages": discoveryTags("llm", "anthropic-messages", "claude", "inference", "chat", "anthropic-compatible",
                                "gpt", "gemini", "deepseek", "singit"),
  "/v1/responses": discoveryTags("llm", "openai-responses", "inference", "chat", "openai-compatible", "gpt", "claude",
                                 "gemini", "deepseek", "singit"),
};

export function addFormatRoutes(app, config, { facilitatorClient, publicClient, catalogue, fetchImpl = fetch, log = console.error, record = () => {} }) {
  const exactOutputFraction = config.exactOutputFraction ?? DEFAULT_EXACT_OUTPUT_FRACTION;
  const bufferPp = config.priceBufferPp ?? 1;
  const answerLog = answerLogFor(config, log);
  for (const [route, upstreamPath] of Object.entries(FORMAT_ROUTES)) {
    const quotes = new WeakMap();
    const server = new x402ResourceServer(facilitatorClient)
      .register(BASE, new UptoEvmScheme())
      .register(BASE, new ExactEvmScheme())
      .register(SOLANA, createUptoSvmServerScheme({ withdrawDelay: 300, rpcUrl: config.solanaRpcUrl }))
      .register(SOLANA, new ExactSvmScheme());
    attachPaymentFailureCodes(server);
    // Discovery prices the example at list share by default; real POSTs below retain priceGuard.
    // The same probeInput policy drives chat and formats, including optional discovery output budgets.
    const probeCeilings = perRequest(async () => {
      try {
        const input = readFormatRequest(route, EXAMPLES[route]);
        const info = await catalogue.resolve(input.model);
        return ceilings(info, probeInput({ ...input, info, ...priceGuard(catalogue, info.id, bufferPp) }, config), exactOutputFraction);
      } catch {
        return ceilings(null, {}, exactOutputFraction);
      }
    });
    const probe = (bucket, network) => async (ctx) => (await probeCeilings(ctx))[bucket][network];
    app.all(route, (req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method) && !isDiscoveryProbe(req)) return next();
      const model = readFormatRequest(route, EXAMPLES[route]).model;
      if (!catalogue.isUnservable?.(model)) return next();
      const error = unservableError(catalogue, model, FormatError);
      res.set("Retry-After", String(error.retryAfter)).status(503).json(refusal(route, 503, error.message, "no_healthy_sellers"));
    });
    app.post(route, async (req, res, next) => {
      // x402scan's empty, unpaid probe gets the example's offer (above), not a "Send a JSON body"/"Name a model" error.
      if (isDiscoveryProbe(req)) { req.askCeilings = ceilings(null, {}, exactOutputFraction); return next(); }
      try {
        const input = readFormatRequest(route, req.body);
        const info = await catalogue.resolve(input.model);
        if (catalogue.canAnswer && !(await catalogue.canAnswer(info.id))) {
          if (catalogue.isUnservable?.(info.id)) throw unservableError(catalogue, info.id, FormatError);
          throw new FormatError(400, "No trusted seller offers that model right now. Pick another; nothing was paid.");
        }
        req.format = { ...input, info, ...priceGuard(catalogue, info.id, bufferPp) };
        req.askCeilings = ceilings(info, req.format, exactOutputFraction);
        quotes.set(req.body, req.askCeilings);
        // One payment, one answer at a time: the same payment in flight, whatever the body or route, is refused before verification.
        const reserved = reserveChatPayment(req, res);
        if (reserved === "duplicate" || reserved === "full") {
          const { status, body } = reservationRefusal(res, reserved, (s, message, code) => refusal(route, s, message, code));
          return res.status(status).json(body);
        }
        next();
      } catch (error) {
        if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
        const status = error instanceof UnknownModel ? 404 : error.status ?? 503;
        const message = status === 503 && !error.retryAfter ? "Try again shortly." : error.message;
        res.status(status).json(refusal(route, status, message, error.retryAfter ? "no_healthy_sellers" : undefined));
      }
    });
    addPaymentRoute(app, { [`POST ${route}`]: {
      // upto first (SI-102): the metered, actual-cost offer is the one a buyer that only inspects accepts[0] sees.
      accepts: [baseOffer(config, quotes, probe("upto", BASE)), solanaOffer(config, quotes, probe("upto", SOLANA)),
        exactBaseOffer(config, quotes, probe("exact", BASE)), exactSolanaOffer(config, quotes, probe("exact", SOLANA))],
      mimeType: "application/json",
      description: DESCRIPTIONS[route], serviceName: SERVICE_NAMES[route], iconUrl: ICON_URL, tags: discoveryTags(...TAGS[route], ...routeCopy(route).tags),
      extensions: { ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({ bodyType: "json", input: EXAMPLES[route], inputSchema: { ...INPUT_SCHEMAS[route], description: probeNote(300, config, true) },
          output: { example: OUTPUT_EXAMPLES[route], schema: OUTPUT_SCHEMA } }) },
    } }, server, { log, publicClient });
    const unserved = new FormatUnserved();
    app.post(route, async (req, res) => {
      const started = Date.now();
      let retried = false, recorded = false;
      // Live streaming (agent-stream.mjs). A model that answers with JSON anyway takes the buffered path.
      const live = res.locals?.live ?? null;
      const refuse = (status, body) => live?.started ? live.abort(status) : res.status(status).json(body);
      let liveAttempt = null;
      const modelHeaders = () => {
        if (!req.format?.fallbackFrom) return;
        res.set("X-SingIt-Model", req.format.model);
        res.set("X-SingIt-Fallback-From", req.format.fallbackFrom);
        res.set("X-SingIt-Fallback-Policy", "paid");
      };
      if (live) { live.onCommit = modelHeaders; live.arm(); }
      const observe = outcome => {
        if (recorded) return;
        recorded = true;
        try { record(req.format?.model, outcome); } catch {}
      };
      try {
        const header = req.get("payment-signature") ?? req.get("x-payment");
        const accepted = JSON.parse(Buffer.from(header, "base64").toString()).accepted ?? {};
        const exact = accepted.scheme === "exact";
        const bucket = exact ? req.askCeilings?.exact : req.askCeilings?.upto;
        const terms = TERMS_BY_NETWORK[accepted.network] && bucket && { ...TERMS_BY_NETWORK[accepted.network], maxChargeAtomic: bucket[accepted.network] };
        if (!terms) throw new Error("payment on an unknown network");
        // Solana `exact`: the answer must be complete within the window from verification (solana-exact-window.mjs).
        const win = solanaExactWindow(req, config);
        const limitAt = Math.min(started + FORMAT_LIMITS.timeoutMs, win?.cutoff ?? Infinity);
        const consume = route === "/v1/messages" ? consumeMessagesStream : consumeResponsesStream;
        // A raised reasoning budget may cost more than was signed; that is billed at the signed amount (see withMinBudget).
        let absorb = false;
        // After payment a different model may answer once, only within the amount signed. Off with the operator switch
        // or X-SingIt-Fallback: off, exactly as on /v1/chat/completions.
        const fallbackOff = config.defaultFallbacks === false
          || String(req.get("X-SingIt-Fallback") ?? "").split(",").some(value => value.trim().toLowerCase() === "off");
        const pools = new Map();
        const poolFor = (nonReasoning = false) => {
          if (fallbackOff) return Promise.resolve([]);
          if (!pools.has(nonReasoning)) pools.set(nonReasoning, formatAlternates({ config, catalogue, route, format: req.format,
            request: req.body, unserved, nonReasoning }).catch(() => []));
          return pools.get(nonReasoning);
        };
        const fits = candidate => fitsSignedCatalogCeiling(
          ceilings(candidate.info, candidate, exactOutputFraction)[exact ? "exact" : "upto"][accepted.network], terms.maxChargeAtomic);
        const ranked = pool => rankPaidAlternates(pool, id => app.locals?.healthStats?.paidModelSuccess?.(id, accepted.network));
        const reservedFailure = () => Object.assign(new NoAnswer(503, "upstream_unavailable"), { singitReserved: true });

        // One model's try: the request as it stands in req.format, its discount and reasoning retries, and the check that
        // what came back is an answer. Everything that makes it not one is a NoAnswer.
        const attempt = async ({ reserve }) => {
          retried = false;
          const controller = new AbortController();
          liveAttempt = live?.attempt() ?? null;
          const mine = liveAttempt;
          try {
            // The price floor only when the model's list-price worst case would not fit what was paid (pricing.mjs).
            let minDiscount = minDiscountFor(req.format, terms);
            const fitted = withHeadroom(fitRequest(req.format.request, req.format.info?.params), req.format.info);
            const budget = withMinBudget(fitted, req.format, exactOutputFraction);
            let body = budget.request;
            absorb = budget.raised;
            const send = () => fetchImpl(`${config.surplusUrl}${upstreamPath}`, { method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}`,
                         ...(minDiscount != null ? { "X-Min-Discount": String(minDiscount) } : {}),
                         ...(route === "/v1/messages" ? { "anthropic-version": req.get("anthropic-version") ?? "2023-06-01" } : {}) },
              body: JSON.stringify({ ...body, model: upstreamModelId(body.model) }),
              signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, limitAt - Date.now())), controller.signal, ...(mine ? [mine.signal] : [])]) })
              .catch(() => { throw new NoAnswer(503, "unreachable"); });
            // What a response holds: the event stream is relayed to the client as it arrives, anything else is read whole.
            const read = async response => {
              if (!(mine && response.ok && isEventStream(response))) return response.json().catch(() => null);
              try { return await consume(response, mine); }
              catch (error) { throw new NoAnswer(error instanceof StreamBreak ? error.status || 503 : 503, error instanceof StreamBreak ? error.code : "unreachable"); }
            };
            const exchange = async () => {
              let response = await send();
              // Read for every status: a long request can come back HTTP 200 with an error body.
              let data = await read(response);
              // Solana exact gets one upstream attempt (no retry inside its window).
              if (!win && response.ok && data && !data.error && data.type !== "error" && data.status !== "failed" && spentOnReasoning(route, data)
                  && limitAt - Date.now() > 8000) {
                // One extra call at <= 2x budget; the service absorbs the first attempt and any overrun.
                const field = budgetField(body);
                body = { ...body, [field]: retryBudget(body[field]) }; retried = true;
                response = await send(); data = await read(response);
              }
              const code = typeof data?.error?.code === "string" ? data.error.code : null;
              if (code === "minimum_discount_not_met" && limitAt - Date.now() > 1000) {
                const discountError = Object.assign(new NoAnswer(response.status, code), { bestDiscountPct: parseBestDiscount(data?.error?.message) });
                const relaxed = relaxMinDiscount(req.format, discountError, {
                  exact, network: accepted.network, maxChargeAtomic: terms.maxChargeAtomic, exactOutputFraction,
                });
                if (relaxed) {
                  try { catalogue?.markPriceRejected?.(req.format.model, { bestDiscountPct: discountError.bestDiscountPct }); } catch {}
                  log(`singit-ask: discount retry ${route} model=${req.format.model} minDiscount ${req.format.minDiscount} -> ${discountError.bestDiscountPct}`);
                  req.format = relaxed;
                  minDiscount = minDiscountFor(req.format, terms);
                  response = await send(); data = await read(response);
                }
              }
              return { response, data };
            };
            const answer = async () => {
              const { response, data } = await exchange();
              if (!response.ok || !data || typeof data !== "object" || data.error || data.type === "error" || data.status === "failed") {
                const code = typeof data?.error?.code === "string" ? data.error.code
                  : typeof data?.error?.type === "string" ? data.error.type : "upstream_error";
                throw Object.assign(new NoAnswer(response.status, code), { bestDiscountPct: parseBestDiscount(data?.error?.message) });
              }
              if (spentOnReasoning(route, data)) throw new NoAnswer(response.status, "max_tokens_spent_reasoning");
              if (!hasAnswer(route, data)) throw new NoAnswer(response.status, "no_text");
              return { response, data };
            };
            if (!win) return await answer();
            return await withinWindow(win, remaining => {
              // Like chat: hold back the end of the window from a first model, so one alternate can still finish. It only
              // protects a fallback; once the client has data there is none to protect.
              const reserveMs = reserve ? fallbackReserveMs(config, remaining, true) : 0;
              if (!(reserveMs > 0 && remaining > reserveMs)) return answer();
              let timer;
              const cut = new Promise((_, reject) => {
                timer = win.clock.setTimeout(() => { if (!live?.dataSent) reject(reservedFailure()); }, remaining - reserveMs);
              });
              cut.catch(() => {});
              return Promise.race([answer(), cut]).finally(() => win.clock.clearTimeout(timer));
            });
          } catch (error) {
            controller.abort();
            mine?.abandon();
            throw error;
          }
        };

        // Whether this model is already known not to be served on this format, with an alternate that fits to use instead.
        let result, failure = null;
        const known = unserved.has(route, req.format.model) && (await poolFor()).some(fits);
        if (known) failure = Object.assign(new NoAnswer(404, "not_found_error"), { singitSkipped: true });
        else {
          try { result = await attempt({ reserve: Boolean(win && (await poolFor()).length) }); }
          catch (error) { if (error instanceof WindowExceeded || !(error instanceof NoAnswer)) throw error; failure = error; }
        }
        if (failure) {
          // The same refusals chat treats as "model unavailable", plus a reasoning model that spent its whole budget thinking
          // (only here; chat does not retry that). Never once a data event is out, never past the window or the deadline.
          const spent = failure.code === "max_tokens_spent_reasoning";
          const formatMiss = failure.status === 404 && failure.code !== "minimum_discount_not_met";
          const retryable = !fallbackOff && !live?.dataSent && Date.now() < limitAt && (spent || canRetryPaidFallback(asUpstreamError(failure)));
          const alternate = retryable && ranked(await poolFor(spent)).find(fits);
          if (formatMiss) unserved.note(route, req.format.model);
          if (!alternate) {
            if (!failure.singitSkipped) throw failure;
            result = await attempt({ reserve: false });   // nothing else fits: ask the model anyway
          } else {
            if (!failure.singitSkipped) {
              try { record(req.format.model, { ok: false, code: failure.code, status: failure.status }); } catch {}
              // A format miss says nothing about the model elsewhere; a cut for the reserve is not the seller's failure.
              if (!formatMiss && !failure.singitReserved && !spent) markUnservable(catalogue, req.format.model, failure, log);
            }
            log(`singit-ask: ${route} paid fallback from=${req.format.model} to=${alternate.model} code=${failure.code} status=${failure.status}`);
            req.format = alternate;
            // One retry, sequential: a second failure is final. Discount, reasoning and window rules apply to it as to any attempt.
            result = await attempt({ reserve: false });
          }
        }
        const { response, data } = result;
        if (!live?.started) modelHeaders();
        catalogue?.noteAnswered?.(req.format.model);
        const reported = data.usage?.buyer_cost_micro ?? response.headers.get("x-si-buyer-cost-micro");
        const haveCost = (typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0)
          || (typeof reported === "string" && /^(0|[1-9][0-9]*)$/.test(reported));
        // Surplus's Anthropic Messages and Responses streams often omit buyer_cost_micro (chat completions include it).
        // `exact` charges the signed ceiling anyway, so a missing cost must not refuse after tokens have already gone out.
        // `upto` still needs the actual cost to know what to settle.
        let billing;
        if (haveCost) {
          const usage = billWithDiagnostics({ ...data.usage, buyer_cost_micro: reported },
            terms, exact, route, req.format.model, log, retried || absorb);
          // `exact` already settled the full ceiling it was offered; see metered.mjs for why there is nothing to override,
          // and for why going over it (usage.overrunAtomic) still answers instead of refusing.
          billing = exact ? { ...usage, mode: "exact_ceiling", totalAtomic: terms.maxChargeAtomic } : usage;
          if (exact && usage.overrunAtomic) log(`singit-ask: ${route} exact overrun ${usage.overrunAtomic} micro-USDC`);
        } else if (exact) {
          log(`singit-ask: ${route} ${req.format.model} exact answer with no buyer_cost_micro; settling the ceiling`);
          billing = { mode: "exact_ceiling", totalAtomic: terms.maxChargeAtomic, currency: "USDC" };
        } else {
          throw new Error("Provider did not report a valid actual cost; payment refused.");
        }
        recordWhenSettled(res, answerLog, { route, model: req.format.model, modelOmitted: req.format.modelOmitted, ...acceptedOf(req), usage: data.usage, billing,
          maxTokens: req.format.maxTokens });  // the normalised limit the ceiling was priced from
        if (!exact) setSettlementOverrides(res, { amount: billing.totalAtomic });
        log(`singit-ask: ${route} answer ready by ${req.format.model} in ${Date.now() - started} ms`
          + `${route === "/v1/responses" ? `, isDefault=${req.format.modelOmitted === true}` : ","} settling ${billing.totalAtomic} micro-USDC`);
        observe({ ok: true, retried });
        if (liveAttempt?.committed) {
          // The tokens are out; the terminal event with the billing waits for settlement (end() is the middleware's one settle).
          live.final = terminalSSE(route, { answer: data, billing: publicBilling(billing) });
          return res.end();
        }
        res.json({ ...scrub(data), ...(retried ? { retried: true } : {}), billing: publicBilling(billing) });
      } catch (error) {
        liveAttempt?.abandon();
        if (error instanceof WindowExceeded) {
          // Not the seller's failure to count against it: the payment's window ran out. Nothing settles.
          observe({ ok: false, code: error.code, status: 503, retried });
          log(`singit-ask: ${route} ${req.format?.model} no billable answer after ${Date.now() - started} ms (solana exact window, ${error.phase})`);
          try { app.locals?.healthStats?.recordWindowRefusal?.(error.phase); } catch {}
          return refuse(503, { ...refusal(route, 503, "The answer did not complete in time for this Solana exact payment. You were not charged; try again.", "no_billable_answer"),
            ...(live?.started ? {} : windowRefusal(res, `req_${randomUUID()}`)) });
        }
        observe({ ok: false, code: error.code, status: error.status, retried });
        if (!live?.dataSent) markUnservable(catalogue, req.format?.model, error, log);
        // Not settled: on Base nothing moves, on Solana the escrowed ceiling is refunded in full.
        log(`singit-ask: ${route} ${req.format?.model} no billable answer after ${Date.now() - started} ms (${error.message})`);
        if (error.code === "max_tokens_spent_reasoning") {
          // Say what to send instead. `minimum` is a size that has answered such models; it is never above the route's limit.
          const field = route === "/v1/messages" ? "max_tokens" : "max_output_tokens";
          const asked = req.format?.maxTokens ?? 0;
          const minimum = Math.min(FORMAT_LIMITS.maxTokens, Math.max(REASONING_MIN_UPSTREAM_TOKENS, 2 * asked));
          return refuse(422, refusal(route, 422, MAX_TOKENS_TOO_SMALL, "max_tokens_too_small",
            minimum > asked ? { next_action: { type: "raise_max_tokens", field, minimum } } : {}));
        }
        if (live?.started) return live.abort(503);
        // Never 502: Cloudflare swaps an origin 502/504 for its own HTML page, and passes a 503 through.
        res.set("Retry-After", "30").status(503).json(refusal(route, 503, "No billable answer was produced. You were not charged; try again.", "no_billable_answer"));
      }
    });
  }
}
