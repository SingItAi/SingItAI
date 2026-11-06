import { MODEL_ALIAS_ROUTES, aliasPath, aliasDescription } from "./model-alias-routes.mjs";
import { routeCopy } from "./listing-snapshot.mjs";
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
import { addUsageRoute, probeNote, baseOffer, exactBaseOffer, exactSolanaOffer, solanaOffer } from "./metered.mjs";
import { unservableError, UnknownModel, priceGuard } from "./catalogue.mjs";
import { AGENT_LIMITS, LIMITS } from "./limits.mjs";
import { BASE, SOLANA, TERMS, SOLANA_TERMS, ICON_URL, ceilingAtomic, discoveryTags, modelServiceName, usd } from "./pricing.mjs";

// Public ids resolve through the catalogue; model-aliases.mjs maps any upstream difference.
// Each id must be URL-safe: it becomes
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
  { id: "nemotron-3.5-lightning", name: "NVIDIA Nemotron 3.5 Lightning", provider: "NVIDIA", family: ["nemotron"],
    blurb: "NVIDIA's fast 30B mixture-of-experts model: long-context coding and agentic tasks" },
];

const ID_SHAPE = /^[a-z0-9.-]+$/;
for (const model of MODEL_ROUTES) {
  if (!ID_SHAPE.test(model.id)) throw new Error(`model-routes.mjs: "${model.id}" is not a URL-safe model id`);
  if (model.id === "completions") throw new Error('model-routes.mjs: "completions" is not a model id');
}

// One advertised record per model: an SI-62 route stays the model's address, so an alias may never repeat it.
for (const alias of MODEL_ALIAS_ROUTES) {
  if (MODEL_ROUTES.some(m => m.id.toLowerCase() === alias.id.toLowerCase())) throw new Error(`Alias repeats SI-62 route: ${alias.id}`);
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

// Keep discovery descriptions within 500 characters, capability first (see app.mjs).
export function discoveryDescription(model) {
  return routeCopy(routePath(model.id)).description;
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
    messages: [{ role: "user", content: `Where is good coffee near the Colosseum? Answer in one sentence. (via ${model.name})` }] };
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
// max_tokens says what it does to the price: the cap a payer signs follows it (so the example's 400 quotes less than a
// larger value), and anything above LIMITS.maxTokens counts as LIMITS.maxTokens. No dollar figures: they follow the seller market.
const modelInputSchema = (schema, config = {}) => ({ ...schema, description: probeNote(400, config),
  properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !["fallback_models", "min_tier"].includes(name))
    .map(([name, property]) => [name, name !== "max_tokens" ? property : { ...property,
      description: `The longest answer, in tokens; ${LIMITS.maxTokens} is the most, and a larger value counts as ${LIMITS.maxTokens}. `
        + "The price cap you sign grows with it (the 402 states the exact amount for your request); the charge follows what was used." }])),
});

// An alias answers what POST /v1/chat/completions answers for that model (agent limits, tools, content blocks), with
// the model pinned: only the fields that would pick another model go, and the note states the agent token limit.
const aliasInputSchema = (schema, config = {}) => ({ ...schema,
  description: probeNote(400, config).replace(`above ${LIMITS.maxTokens} counts as ${LIMITS.maxTokens}`, `above ${AGENT_LIMITS.maxTokens} counts as ${AGENT_LIMITS.maxTokens}`),
  properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !["fallback_models", "min_tier"].includes(name))),
});
const pinned = (schema, model) => ({ ...schema, properties: { ...schema.properties, model: { type: "string", const: model.id } } });
const ROUTE_SET = Object.freeze({ models: MODEL_ROUTES, pathFor: m => routePath(m.id), describe: m => discoveryDescription(m), schemaFor: modelInputSchema, schemaOf: schema => schema, prefix: "" });
const ALIAS_SET = Object.freeze({ models: MODEL_ALIAS_ROUTES.filter(m => m.modality === "chat"), pathFor: aliasPath, describe: aliasDescription, schemaFor: aliasInputSchema, schemaOf: pinned, prefix: "alias" });

export function addModelRoutes(app, config, { facilitatorClient, publicClient, catalogue, readRequest, upstream, fetchImpl, log,
                                              inputSchema, outputSchema, exampleOutput }, { models, pathFor, describe, schemaFor, schemaOf } = ROUTE_SET) {
  const bufferPp = config.priceBufferPp ?? 1;
  inputSchema = schemaFor(inputSchema, config);
  for (const model of models) {
    // The discovery probes are quoted for this route's own Bazaar example body (metered.mjs's `exampleProbe`).
    addUsageRoute(app, pathFor(model), (quotes, fallback) => [
      // upto first (SI-102): the metered, actual-cost offer is the one a buyer that only inspects accepts[0] sees.
      baseOffer(config, quotes, fallback("upto", BASE)),
      solanaOffer(config, quotes, fallback("upto", SOLANA)),
      exactBaseOffer(config, quotes, fallback("exact", BASE)),
      exactSolanaOffer(config, quotes, fallback("exact", SOLANA)),
    ], {
      description: describe(model),
      serviceName: modelServiceName(model.name),
      iconUrl: ICON_URL,
      tags: modelTags(model),
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({ bodyType: "json", input: modelExample(model), inputSchema: schemaOf(inputSchema, model),
          output: { example: exampleOutput, schema: outputSchema } }),
      },
    }, {
      facilitatorClient, catalogue, config, readRequest,
      choose: (input) => chooseModelRoute(catalogue, model.id, bufferPp, input),
      upstream, fetchImpl, log, publicClient,
      offerEmptyProbe: true,
      probeBody: modelExample(model),
    });
  }
}

// Every model route's openapi.json path entry, priced at that model's own range when the catalogue can resolve it
// right now, else the generic `fallbackPrice` (the same one /v1/chat/completions shows).
export async function modelOpenapiPaths(catalogue, { inputSchema, outputSchema, exampleOutput, fallbackPrice, config = {} }, { models, pathFor, describe, schemaFor, schemaOf, prefix } = ROUTE_SET) {
  inputSchema = schemaFor(inputSchema, config);
  const entries = await Promise.all(models.filter(m => !catalogue?.isSuspended?.(m.id)).map(async (model) => {
    const own = await modelPriceRange(catalogue, model);
    return [pathFor(model), { post: {
      operationId: prefix + operationId(model), summary: `Generate a ${model.name} chat completion`, description: describe(model),
      "x-payment-info": { notes: probeNote(400, config), price: { mode: "dynamic", currency: "USD", ...(own ?? fallbackPrice) }, protocols: [{ x402: {} }] },
      requestBody: { required: true, content: { "application/json": {
        schema: { type: "object", ...schemaOf(inputSchema, model) }, example: modelExample(model) } } },
      responses: {
        200: { description: "The answer, with what it was charged",
               content: { "application/json": { schema: outputSchema, example: exampleOutput }, "text/event-stream": { schema: { type: "string" }, description: "Complete buffered chat SSE after settlement, ending with [DONE]." } } },
        400: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "model does not match this route's model, or the question cannot be answered; nothing was charged" },
        402: { content: { "application/json": { schema: errorRef("PaymentRequired402") } }, description: "Payment Required: x402 challenge in the PAYMENT-REQUIRED header" },
        404: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "This model is not available; nothing was charged" },
        422: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "After one automatic retry with a larger budget, max_tokens too small: this reasoning model spent it all thinking and wrote no answer; raise max_tokens. Nothing was charged" },
        503: { content: { "application/json": { schema: errorRef("ErrorResponse") } }, description: "No seller or no billable answer right now; nothing was charged. Retry after Retry-After",
               headers: { "Retry-After": { description: "Seconds to wait before trying again", schema: { type: "integer" } } } },
      },
      security: [{ x402: [] }],
    } }];
  }));
  return Object.fromEntries(entries);
}

export const addModelAliasRoutes = (app, config, deps) => addModelRoutes(app, config, deps, ALIAS_SET);
export const chatAliasOpenapiPaths = (catalogue, options) => modelOpenapiPaths(catalogue, options, ALIAS_SET);
