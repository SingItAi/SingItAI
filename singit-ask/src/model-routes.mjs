import { errorRef } from "./errors.mjs";
// SI-62: one x402 resource per popular model, `/v1/chat/<model>`, so a Bazaar search for a model name ("claude
// opus 5.5") finds a dedicated SingIt Ask listing with that model's own description and price, instead of only
// the generic /v1/chat/completions listing where the model is a body field a search engine cannot see.
//
// Each route is the same OpenAI chat-completions request/answer as /v1/chat/completions, same offers, same
// billing (metered.mjs's addUsageRoute does the actual payment and settlement work; nothing here duplicates it),
// except the model is pinned by the path: the body's `model`, if sent, must name the same model (free/… models are
// never reachable here, since there is no addFreeRoute call for these routes).
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { addUsageRoute, baseOffer, exactBaseOffer, exactSolanaOffer, solanaOffer } from "./metered.mjs";
import { unservableError, UnknownModel, priceGuard } from "./catalogue.mjs";
import { LIMITS } from "./limits.mjs";
import { BASE, SOLANA, TERMS, SOLANA_TERMS, ICON_URL, ceilingAtomic, discoveryTags, modelServiceName, usd } from "./pricing.mjs";

// The id is Surplus's own model id (catalogue.mjs's ModelCatalogue.resolve), and must be URL-safe: it becomes
// `/v1/chat/<id>` verbatim (see test/model-routes.test.mjs's id-shape assertion). None of these may ever be
// "completions": that id would collide with /v1/chat/completions itself.
export const MODEL_ROUTES = [
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic", family: ["claude"],
    blurb: "Anthropic's largest Claude model: long-context reasoning, multi-step coding and agentic tasks" },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "Anthropic", family: ["claude"],
    blurb: "Anthropic's mid-sized Claude model: everyday coding, writing and analysis at a lower cost than Opus" },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "Anthropic", family: ["claude"],
    blurb: "Anthropic's smallest, fastest Claude model: quick, low-latency answers" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "OpenAI", family: ["gpt"],
    blurb: "One of OpenAI's GPT-5.6 model variants: general-purpose chat, coding and reasoning" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "OpenAI", family: ["gpt"],
    blurb: "Another GPT-5.6 variant from OpenAI: general-purpose chat, coding and reasoning" },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "OpenAI", family: ["gpt"],
    blurb: "OpenAI's GPT-5.5 model: general-purpose chat, coding and reasoning" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: "Google", family: ["gemini"],
    blurb: "Google's Gemini 3.1 Pro preview model: long-context reasoning and multimodal input" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "Google", family: ["gemini"],
    blurb: "Google's fast, lower-cost Gemini model: high-volume or latency-sensitive tasks" },
  { id: "grok-4.7", name: "Grok 4.7", provider: "xAI", family: ["grok"],
    blurb: "xAI's Grok 4.7 model: general-purpose chat and reasoning" },
  { id: "kimi-k3", name: "Kimi K3", provider: "Moonshot AI", family: ["kimi"],
    blurb: "Moonshot AI's Kimi K3 model: long-context chat and reasoning" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "DeepSeek", family: ["deepseek"],
    blurb: "DeepSeek's larger V4 model: coding and reasoning tasks" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "DeepSeek", family: ["deepseek"],
    blurb: "DeepSeek's fast, lower-cost V4.1 model; also this service's own default model" },
  { id: "qwen3.8-max-0902", name: "Qwen3.8 Max", provider: "Alibaba", family: ["qwen"],
    blurb: "Alibaba's largest Qwen 3.8 model: coding and reasoning tasks" },
  { id: "glm-5.3", name: "GLM 5.3", provider: "Zhipu AI", family: ["glm"],
    blurb: "Zhipu AI's GLM 5.3 model: general-purpose chat and reasoning" },
];

const ID_SHAPE = /^[a-z0-9.-]+$/;
for (const model of MODEL_ROUTES) {
  if (!ID_SHAPE.test(model.id)) throw new Error(`model-routes.mjs: "${model.id}" is not a URL-safe model id`);
  if (model.id === "completions") throw new Error('model-routes.mjs: "completions" is not a model id');
}

export const routePath = (id) => `/v1/chat/${id}`;
export const modelRoutePaths = (catalogue) => MODEL_ROUTES.filter(m => !catalogue?.isSuspended?.(m.id)).map((m) => routePath(m.id));

export class ModelRouteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Pins the model to the one this route is for: a body that names a different model is refused before any
// payment is asked (400), same as a model Surplus does not list (404) or cannot answer right now (503, like a
// retryable upstream failure elsewhere in this service). Mirrors app.mjs's chooseModel, but for a fixed model.
export async function chooseModelRoute(catalogue, id, bufferPp, input) {
  if (input.model && input.model.toLowerCase() !== id.toLowerCase()) {
    throw new ModelRouteError(400, `This route answers only ${id}; omit model or set it to ${id}.`);
  }
  let info;
  try {
    info = await catalogue.resolve(id);
  } catch (error) {
    if (error instanceof UnknownModel) throw new ModelRouteError(404, error.message);
    throw error;
  }
  if (catalogue.canAnswer && !(await catalogue.canAnswer(info.id))) {
    throw unservableError(catalogue, info.id, ModelRouteError);
  }
  return { ...input, model: id, info, isDefault: false, ...priceGuard(catalogue, info.id, bufferPp) };
}

// Keep discovery descriptions within 160 characters, capability first (see app.mjs).
export function discoveryDescription(model) {
  return `Chat completions API for ${model.name} (${model.provider}), OpenAI-compatible. `
    + "Pay per call in USDC on Base or Solana, no key; you sign a price cap.";
}

const providerTag = (provider) => provider.toLowerCase().replace(/\s+/g, "");

// The model's own id and provider inside the first 5 (Bazaar keeps no more), after the category.
export function modelTags(model) {
  return discoveryTags("llm", "chat-completions", model.id, providerTag(model.provider), "openai-compatible",
    ...model.family, "inference", "chat", "singit");
}

// Bazaar's discovery extension wants a realistic example body; the model is named explicitly, matching this
// route's own pinned model (sending it is allowed as long as it agrees with the path).
export function modelExample(model) {
  return { model: model.id, max_tokens: 400,
    messages: [{ role: "user", content: `Where is good coffee near the Colosseum? (via ${model.name})` }] };
}

// A short, valid OpenAPI operationId from the model's display name: "Claude Opus 5.5" -> "chatClaudeOpus55".
export function operationId(model) {
  const words = model.name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/);
  return "chat" + words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

// The least and the most this model's own route can charge, for its openapi.json listing: the least is Base's
// settlement fee (same as every other route), the most is this model's own ceiling for the largest question and
// answer this service takes, on Solana's terms. `null` when the model cannot be resolved right now; the caller
// falls back to the generic price range, same as app.mjs's priceRange does for an unlisted model.
export async function modelPriceRange(catalogue, model) {
  const info = await catalogue.resolve(model.id).catch(() => null);
  if (!info) return null;
  const size = { chars: LIMITS.chars, maxTokens: LIMITS.maxTokens, messageCount: LIMITS.messages, charsPerToken: 1 };
  return { min: usd(TERMS.settlementFeeAtomic), max: usd(ceilingAtomic(info, size, SOLANA_TERMS)) };
}

// One x402 resource per model in MODEL_ROUTES, reusing addUsageRoute (metered.mjs) for the actual payment and
// settlement work: this only supplies the pinned `choose` and each route's own discovery metadata and probe price.
// Registered only when there is a catalogue to resolve models against, same gate as addFormatRoutes/addImageRoutes.
// Pinned routes ignore fallback_models and cannot select singit/auto for min_tier.
const modelInputSchema = (schema) => ({ ...schema,
  properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !["fallback_models", "min_tier"].includes(name))),
});

export function addModelRoutes(app, config, { facilitatorClient, catalogue, readRequest, upstream, fetchImpl, log,
                                              inputSchema, outputSchema, exampleOutput }) {
  const bufferPp = config.priceBufferPp ?? 1;
  inputSchema = modelInputSchema(inputSchema);
  for (const model of MODEL_ROUTES) {
    // The discovery probes are quoted for this route's own Bazaar example body (metered.mjs's `exampleProbe`).
    addUsageRoute(app, routePath(model.id), (quotes, fallback) => [
      // upto first (SI-102): the metered, actual-cost offer is the one a buyer that only inspects accepts[0] sees.
      baseOffer(config, quotes, fallback("upto", BASE)),
      solanaOffer(config, quotes, fallback("upto", SOLANA)),
      exactBaseOffer(config, quotes, fallback("exact", BASE)),
      exactSolanaOffer(config, quotes, fallback("exact", SOLANA)),
    ], {
      description: discoveryDescription(model),
      serviceName: modelServiceName(model.name),
      iconUrl: ICON_URL,
      tags: modelTags(model),
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({ bodyType: "json", input: modelExample(model), inputSchema,
          output: { example: exampleOutput, schema: outputSchema } }),
      },
    }, {
      facilitatorClient, catalogue, config, readRequest,
      choose: (input) => chooseModelRoute(catalogue, model.id, bufferPp, input),
      upstream, fetchImpl, log,
      offerEmptyProbe: true,
      probeBody: modelExample(model),
    });
  }
}

// Every model route's openapi.json path entry, priced at that model's own range when the catalogue can resolve it
// right now, else the generic `fallbackPrice` (the same one /v1/chat/completions shows).
export async function modelOpenapiPaths(catalogue, { inputSchema, outputSchema, exampleOutput, fallbackPrice }) {
  inputSchema = modelInputSchema(inputSchema);
  const entries = await Promise.all(MODEL_ROUTES.filter(m => !catalogue?.isSuspended?.(m.id)).map(async (model) => {
    const own = await modelPriceRange(catalogue, model);
    return [routePath(model.id), { post: {
      operationId: operationId(model), summary: `Generate a ${model.name} chat completion`, description: discoveryDescription(model),
      "x-payment-info": { price: { mode: "dynamic", currency: "USD", ...(own ?? fallbackPrice) }, protocols: [{ x402: {} }] },
      requestBody: { required: true, content: { "application/json": {
        schema: { type: "object", ...inputSchema }, example: modelExample(model) } } },
      responses: {
        200: { description: "The answer, with what it was charged",
               content: { "application/json": { schema: outputSchema, example: exampleOutput } } },
        400: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "model does not match this route's model, or the question cannot be answered; nothing was charged" },
        402: { content: { "application/json": { schema: errorRef("PaymentRequired402") } }, description: "Payment Required: x402 challenge in the PAYMENT-REQUIRED header" },
        404: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "This model is not available; nothing was charged" },
        422: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "max_tokens too small: this reasoning model spent it all thinking and wrote no answer; raise max_tokens. Nothing was charged" },
        503: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "No seller or no billable answer right now; nothing was charged. Retry after Retry-After",
               headers: { "Retry-After": { description: "Seconds to wait before trying again", schema: { type: "integer" } } } },
      },
      security: [{ x402: [] }],
    } }];
  }));
  return Object.fromEntries(entries);
}
