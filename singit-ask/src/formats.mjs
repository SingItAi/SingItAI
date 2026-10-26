// The other two ways agents ask a model, besides OpenAI's chat completions: Anthropic's Messages (POST /v1/messages,
// what Claude Code and the Anthropic SDK speak) and OpenAI's Responses (POST /v1/responses). Sold over x402 like the
// chat route: the payer authorizes a ceiling with `upto`, worked out from the model's list price and the size of the
// request, and is charged what the answer actually cost + 30% + the network's settlement fee, only once it came back.
//
// The request goes to Surplus as it came, with this service's key, apart from the model's name (Anthropic's dated
// names become Surplus's) and a bounded answer length. Streaming is not offered here: an answer is paid for whole.
import { x402ResourceServer, setSettlementOverrides } from "@x402/express";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { UnknownModel, priceGuard } from "./catalogue.mjs";
import { addPaymentRoute, baseOffer, ceilings, exactBaseOffer, exactSolanaOffer, isDiscoveryProbe, solanaOffer } from "./metered.mjs";
import { BASE, SOLANA, TERMS, SOLANA_TERMS, billUsage, minDiscountFor, DEFAULT_EXACT_OUTPUT_FRACTION, SERVICE_NAME, ICON_URL } from "./pricing.mjs";

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
  constructor(status, code) { super(`model answered HTTP ${status} (${code})`); this.name = "NoAnswer"; this.code = code; }
}

// Sampling knobs a caller may send that a model can refuse outright (Surplus forwards what it does not strip: kimi-k3
// and claude-opus-5.5 refuse temperature, SI-62). Each is dropped when the model's supported_parameters do not list
// it; a model with no list keeps the request as it came.
const FILTERED_PARAMS = ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "reasoning_effort"];
export function fitRequest(request, params) {
  if (!Array.isArray(params)) return request;
  const fitted = { ...request };
  for (const name of FILTERED_PARAMS) if (name in fitted && !params.includes(name)) delete fitted[name];
  return fitted;
}

// Whether a reasoning model spent the whole answer budget thinking and wrote nothing usable: Messages stops on
// max_tokens with no text block and no tool_use block, Responses ends incomplete on max_output_tokens with no
// output_text, no function_call, and no other non-reasoning item carrying content. A completed tool call with
// no text is still a real answer, not a reasoning-exhaustion refusal.
export function spentOnReasoning(route, data) {
  if (route === "/v1/messages") {
    const answered = (Array.isArray(data.content) ? data.content : []).some((b) =>
      b?.type === "tool_use" || (b?.type === "text" && String(b.text ?? "").trim()));
    return data.stop_reason === "max_tokens" && !answered;
  }
  const answered = (Array.isArray(data.output) ? data.output : []).some((item) => {
    if (!item || item.type === "reasoning") return false;
    if (item.type === "function_call") return true;
    return (Array.isArray(item.content) ? item.content : []).some((c) =>
      c?.type === "refusal" || (c?.type !== "reasoning_text" && String(c?.text ?? "").trim()));
  });
  return data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens" && !answered;
}

const MAX_TOKENS_TOO_SMALL = "This model spent the whole token budget reasoning and wrote no answer. Raise max_tokens "
  + "(max_output_tokens on /v1/responses). You were not charged.";

export const surplusModel = (name) => {
  const m = ANTHROPIC_ID.exec(name);
  return m ? `${m[1]}-${m[2]}.${m[3]}` : name;
};

// The request sent on, its model, its size in characters and the longest answer it can get.
export function readFormatRequest(route, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FormatError(400, "Send a JSON body.");
  if (body.stream) throw new FormatError(400, "Streaming is not offered over x402: an answer is paid for whole. Send stream: false.");
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 120) {
    throw new FormatError(400, "Name a model from GET /v1/models.");
  }
  const request = { ...body, model: surplusModel(body.model.trim()) };
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
  return { request, model: request.model, chars, maxTokens, messageCount };
}

// An answer as the format has it, without Surplus's own fields.
export function scrub(data) {
  for (const field of UPSTREAM_FIELDS) delete data[field];
  if (data.usage && typeof data.usage === "object") for (const field of UPSTREAM_USAGE_FIELDS) delete data.usage[field];
  return data;
}

const refusal = (route, status, message, code) => (route === "/v1/messages"
  ? { type: "error", error: { type: status === 400 || status === 422 ? "invalid_request_error" : status === 404 ? "not_found_error" : "api_error", message } }
  : { error: { type: status >= 500 ? "upstream_error" : "invalid_request_error", ...(code ? { code } : {}), message } });

// <=300 characters with the "SingIt Ask: " prefix (see app.mjs's DISCOVERY_DESCRIPTION for why): what each format
// does and when to call it, not what it costs.
const DESCRIPTIONS = {
  "/v1/messages": "Anthropic's Messages API (what Claude Code and the Anthropic SDK speak), any model listed at GET "
    + "/v1/models, Claude included. Call it when an agent needs a Claude-format answer with no API key or account, "
    + "or wants to try another model the same way.",
  "/v1/responses": "OpenAI's Responses API, any model listed at GET /v1/models (GPT, Claude, Gemini, DeepSeek and more). "
    + "Call it when an agent needs an answer in OpenAI's Responses format with no API key or account.",
};
const EXAMPLES = {
  "/v1/messages": { model: "claude-sonnet-5.5", max_tokens: 300, messages: [{ role: "user", content: "What is x402?" }] },
  "/v1/responses": { model: "gpt-5.5", input: "What is x402?", max_output_tokens: 300 },
};
// What each field is, for the Bazaar listing: the fields readFormatRequest() checks, nothing it would refuse.
const MODEL_FIELD = { type: "string", maxLength: 120, examples: ["claude-sonnet-5.5", "gpt-5.5", "gemini-3.1-pro"],
  description: "Any model id from GET /v1/models; Anthropic's dashed names (claude-sonnet-5-5) work too." };
const STREAM_FIELD = { type: "boolean", enum: [false], description: "Streaming is not offered: an answer is paid for whole." };
const INPUT_SCHEMAS = {
  "/v1/messages": { properties: {
    model: MODEL_FIELD,
    max_tokens: { type: "integer", minimum: 1, maximum: FORMAT_LIMITS.maxTokens,
      description: "The longest answer, in tokens. The payment ceiling grows with it; the charge follows what was used." },
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
      description: "The longest answer, in tokens. The payment ceiling grows with it; the charge follows what was used." },
    instructions: { type: "string", description: "Optional system instructions." },
    tools: { type: "array", description: "Optional tool definitions." },
    stream: STREAM_FIELD,
  }, required: ["model", "input"] },
};
// A real answer's shape and charge (Base, `upto`): 6 micro-USD of tokens, 2 markup, 1000 settlement fee.
const BILLING_EXAMPLE = { ...TERMS, providerCostAtomic: "6", markupAtomic: "2", totalAtomic: "1008", currency: "USDC" };
const OUTPUT_EXAMPLES = {
  "/v1/messages": { id: "msg_01example", type: "message", role: "assistant", model: "claude-sonnet-5.5",
    content: [{ type: "text", text: "x402 is an open standard for paying for an API call with a stablecoin over HTTP 402." }],
    stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 24 }, billing: BILLING_EXAMPLE },
  "/v1/responses": { id: "resp_example", object: "response", status: "completed", model: "gpt-5.5",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
      text: "x402 is an open standard for paying for an API call with a stablecoin over HTTP 402." }] }],
    usage: { input_tokens: 12, output_tokens: 24, total_tokens: 36 }, billing: BILLING_EXAMPLE },
};
const OUTPUT_SCHEMA = { type: "object", required: ["billing"], properties: {
  billing: { type: "object", description: "What was charged, in USDC micro-units", properties: {
    providerCostAtomic: { type: "string" }, markupAtomic: { type: "string" },
    totalAtomic: { type: "string", description: "The amount settled" }, currency: { type: "string", const: "USDC" } } } } };
const TAGS = ["llm", "chat", "inference", "claude", "gpt", "gemini", "deepseek", "pay-per-use", "solana", "base", "singit"];

export function addFormatRoutes(app, config, { facilitatorClient, catalogue, fetchImpl = fetch, log = console.error }) {
  const exactOutputFraction = config.exactOutputFraction ?? DEFAULT_EXACT_OUTPUT_FRACTION;
  const bufferPp = config.priceBufferPp ?? 1;
  for (const [route, upstreamPath] of Object.entries(FORMAT_ROUTES)) {
    const quotes = new WeakMap();
    const server = new x402ResourceServer(facilitatorClient)
      .register(BASE, new UptoEvmScheme())
      .register(BASE, new ExactEvmScheme())
      .register(SOLANA, new UptoSvmScheme({ withdrawDelay: 300 }))
      .register(SOLANA, new ExactSvmScheme());
    app.post(route, async (req, res, next) => {
      // x402scan's empty, unpaid probe gets the standing offer, not a "Send a JSON body"/"Name a model" error.
      if (isDiscoveryProbe(req)) { req.askCeilings = ceilings(null, {}, exactOutputFraction); return next(); }
      try {
        const input = readFormatRequest(route, req.body);
        const info = await catalogue.resolve(input.model);
        if (catalogue.canAnswer && !(await catalogue.canAnswer(info.id))) {
          throw new FormatError(400, "No trusted seller offers that model right now. Pick another; nothing was paid.");
        }
        req.format = { ...input, info, ...priceGuard(catalogue, info.id, bufferPp) };
        req.askCeilings = ceilings(info, req.format, exactOutputFraction);
        quotes.set(req.body, req.askCeilings);
        next();
      } catch (error) {
        const status = error instanceof UnknownModel ? 404 : error.status ?? 503;
        res.status(status).json(refusal(route, status, status === 503 ? "Try again shortly." : error.message));
      }
    });
    addPaymentRoute(app, { [`POST ${route}`]: {
      // exact on Base first: the simplest offer for a buyer that only inspects accepts[0].
      accepts: [exactBaseOffer(config, quotes), solanaOffer(config, quotes), baseOffer(config, quotes), exactSolanaOffer(config, quotes)],
      mimeType: "application/json",
      description: `SingIt Ask: ${DESCRIPTIONS[route]}`, serviceName: SERVICE_NAME, iconUrl: ICON_URL,
      tags: [...TAGS, route === "/v1/messages" ? "anthropic-compatible" : "openai-compatible"],
      extensions: { ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({ bodyType: "json", input: EXAMPLES[route], inputSchema: INPUT_SCHEMAS[route],
          output: { example: OUTPUT_EXAMPLES[route], schema: OUTPUT_SCHEMA } }) },
    } }, server);
    app.post(route, async (req, res) => {
      const started = Date.now();
      try {
        const header = req.get("payment-signature") ?? req.get("x-payment");
        const accepted = JSON.parse(Buffer.from(header, "base64").toString()).accepted ?? {};
        const exact = accepted.scheme === "exact";
        const bucket = exact ? req.askCeilings?.exact : req.askCeilings?.upto;
        const terms = TERMS_BY_NETWORK[accepted.network] && bucket && { ...TERMS_BY_NETWORK[accepted.network], maxChargeAtomic: bucket[accepted.network] };
        if (!terms) throw new Error("payment on an unknown network");
        // The price floor only when the model's list-price worst case would not fit what was paid (pricing.mjs).
        const minDiscount = minDiscountFor(req.format, terms);
        const response = await fetchImpl(`${config.surplusUrl}${upstreamPath}`, { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}`,
                     ...(minDiscount != null ? { "X-Min-Discount": String(minDiscount) } : {}),
                     ...(route === "/v1/messages" ? { "anthropic-version": req.get("anthropic-version") ?? "2023-06-01" } : {}) },
          body: JSON.stringify(fitRequest(req.format.request, req.format.info?.params)), signal: AbortSignal.timeout(FORMAT_LIMITS.timeoutMs) });
        // Read for every status: a long request can come back HTTP 200 with an error body.
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || typeof data !== "object" || data.error || data.type === "error" || data.status === "failed") {
          const code = typeof data?.error?.code === "string" ? data.error.code
            : typeof data?.error?.type === "string" ? data.error.type : "upstream_error";
          throw new NoAnswer(response.status, code);
        }
        if (spentOnReasoning(route, data)) throw new NoAnswer(response.status, "max_tokens_spent_reasoning");
        const reported = data.usage?.buyer_cost_micro ?? response.headers.get("x-si-buyer-cost-micro");
        const usage = billUsage({ buyer_cost_micro: reported }, terms, { allowOverrun: exact });
        // `exact` already settled the full ceiling it was offered; see metered.mjs for why there is nothing to override,
        // and for why going over it (usage.overrunAtomic) still answers instead of refusing.
        const billing = exact ? { ...usage, mode: "exact_ceiling", totalAtomic: terms.maxChargeAtomic } : usage;
        if (exact && usage.overrunAtomic) log(`singit-ask: ${route} exact overrun ${usage.overrunAtomic} micro-USDC`);
        if (!exact) setSettlementOverrides(res, { amount: billing.totalAtomic });
        log(`singit-ask: ${route} answered by ${req.format.model} in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC`);
        res.json({ ...scrub(data), billing });
      } catch (error) {
        // Not settled: on Base nothing moves, on Solana the escrowed ceiling is refunded in full.
        log(`singit-ask: ${route} ${req.format?.model} no billable answer after ${Date.now() - started} ms (${error.message})`);
        if (error.code === "max_tokens_spent_reasoning") {
          return res.status(422).json(refusal(route, 422, MAX_TOKENS_TOO_SMALL, "max_tokens_too_small"));
        }
        // Never 502: Cloudflare swaps an origin 502/504 for its own HTML page, and passes a 503 through.
        res.set("Retry-After", "30").status(503).json(refusal(route, 503, "No billable answer was produced. You were not charged; try again.", "no_billable_answer"));
      }
    });
  }
}
