// SingIt Ask: one answer from a language model, paid over x402 in USDC on Solana or Base for what it
// actually cost: model tokens + 30% + the network's settlement fee, up to 0.003 USDC. Coinbase CDP settles.
//
// The payer is charged only when the answer came back: @x402/express holds the response, and a
// handler that answers 400 or above is never settled (checked in its source, 2.28). So a model
// that fails, times out or returns nothing costs the payer nothing.
//
// The model is bought upstream on Surplus Intelligence (OpenAI-compatible, cheapest seller wins),
// with this service's own key; the payer never sees or needs it.

import express from "express";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { addUsageRoute, baseOffer, solanaOffer } from "./metered.mjs";
import { addSolanaQuotedRoute } from "./solana-quoted.mjs";
import { UnknownModel, ModelCatalogue } from "./catalogue.mjs";
import { LIMITS, THINKING_HEADROOM } from "./limits.mjs";
import { ObservedPrices } from "./observed.mjs";
import { DIRECT_TERMS, QUOTED_ROUTE, TERMS, METERED_ROUTE, SOLANA_TERMS } from "./pricing.mjs";

export const BASE = "eip155:8453";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const ROUTE = "/v1/chat/completions";

export { LIMITS, THINKING_HEADROOM };
const ROLES = new Set(["system", "user", "assistant"]);

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The messages and size of an answer, or a RequestError: checked before the model is asked.
export function readRequest(body) {
  if (!body || typeof body !== "object") throw new RequestError(400, "Send a JSON body with messages.");
  if (body.stream) throw new RequestError(400, "Streaming is not offered; send stream: false.");
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > LIMITS.messages) {
    throw new RequestError(400, `Send 1 to ${LIMITS.messages} messages.`);
  }
  let chars = 0;
  const clean = messages.map((message) => {
    if (!message || !ROLES.has(message.role) || typeof message.content !== "string") {
      throw new RequestError(400, "Each message needs a role (system, user or assistant) and text content.");
    }
    chars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (chars > LIMITS.chars) throw new RequestError(400, `Keep the messages under ${LIMITS.chars} characters in all.`);
  const asked = Number(body.max_tokens ?? LIMITS.defaultTokens);
  const maxTokens = Number.isInteger(asked) && asked > 0 ? Math.min(asked, LIMITS.maxTokens) : LIMITS.defaultTokens;
  const model = body.model === undefined || body.model === "singit-ask" ? undefined : body.model;
  if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 120)) {
    throw new RequestError(400, "model must be the id of a model listed at GET /v1/models.");
  }
  return { messages: clean, maxTokens, chars, model: model?.trim() };
}

// The model an answer is bought from and what it may cost. No model, or the default one, keeps the standing
// ceiling; any other must be on Surplus's list, and its ceiling follows its own prices.
export async function chooseModel(config, catalogue, input) {
  if (!input.model || input.model === config.model) return { ...input, model: config.model, info: null };
  if (!catalogue) throw new RequestError(400, "Choosing a model is not offered here.");
  try {
    const info = await catalogue.resolve(input.model);
    if (catalogue.canAnswer && !(await catalogue.canAnswer(info.id))) {
      throw new RequestError(400, "No trusted seller offers that model right now. Pick another; nothing was paid.");
    }
    return { ...input, info };
  } catch (error) {
    if (error instanceof UnknownModel) throw new RequestError(400, error.message);
    throw error;
  }
}

export class UpstreamError extends Error {}

// One completion from Surplus Intelligence. Any failure is an UpstreamError: the payer is not charged.
//
// Thinking is switched off and the cheapest seller is asked first. Measured on 12 October over four models: the
// cheapest seller answered as fast as the fastest one within twice its price (1.8-8 s against 2-14 s) and cost the
// same or less; the 21-24 s seen on 4 October did not recur. Some sellers refuse to switch thinking off ("Reasoning
// is mandatory for this endpoint"), and Surplus gives up after two of them; such a refusal costs nothing, so the
// question is asked once more with as little thinking as the seller allows. Surplus documents all three:
// docs/reference/reasoning, docs/marketplace/routing-controls.
export async function askSurplus(config, messages, maxTokens, fetchImpl = fetch, model = config.model) {
  const ask = (reasoning) => fetchImpl(`${config.surplusUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens + THINKING_HEADROOM, temperature: 0.4,
                           reasoning_effort: reasoning, si_route: { objective: "price" } }),
    signal: AbortSignal.timeout(LIMITS.timeoutMs),
  });
  let response;
  try {
    response = await ask("none");
    if (response.status === 400) {
      const refusal = await response.clone().json().catch(() => null);
      if (refusal?.error?.code === "request_rejected" && /reasoning/i.test(refusal.error.message ?? "")) response = await ask("low");
    }
  } catch (error) {
    throw new UpstreamError(`model unreachable (${error.name})`);
  }
  if (!response.ok) throw new UpstreamError(`model answered HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new UpstreamError("model returned no text");
  return { content, finishReason: data.choices[0].finish_reason ?? "stop", usage: data.usage ?? null };
}

const EXAMPLE = {
  input: { messages: [{ role: "user", content: "Where is good coffee near the Colosseum?" }], max_tokens: 400 },
  output: {
    object: "chat.completion",
    model: "singit-ask",
    choices: [{ index: 0, message: { role: "assistant", content: "Around the Colosseum, try…" }, finish_reason: "stop" }],
  },
};

export function createApp(config, { facilitatorClient, upstream = askSurplus, fetchImpl = fetch, log = console.error,
                                    catalogue = config.surplusUrl ? new ModelCatalogue({ url: config.surplusUrl, fetchImpl, blocked: config.blockedProviders ?? [] }) : null,
                                    observed = new ObservedPrices({ file: config.observedFile }) }) {
  const app = express();
  app.locals.catalogue = catalogue;  // server.mjs warms it
  app.disable("x-powered-by");
  // cloudflared connects over loopback and supplies the public HTTPS scheme.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "128kb" })); // unreadable JSON is refused before any payment is asked

  const pricing = { [SOLANA]: SOLANA_TERMS, [BASE]: TERMS };
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "singit-ask", model: config.model, facilitator: "coinbase-cdp", pricing,
               metered: TERMS, ...(config.directSolana ? { directSolana: { endpoint: QUOTED_ROUTE, ...DIRECT_TERMS } } : {}) });
  });
  // Free: the default and every other model that can be asked for, with the list prices its ceiling is built from.
  app.get("/v1/models", async (_req, res) => {
    // Only the models that can be answered now (the default always is).
    const listed = catalogue ? await catalogue.list().catch(() => []) : [];
    const answerable = await Promise.all(listed.map((m) => (catalogue.canAnswer ? catalogue.canAnswer(m.id) : true)));
    const models = listed.filter((m, i) => answerable[i] || m.id === config.model);
    const market = catalogue?.market ? await catalogue.market().catch(() => new Map()) : new Map();
    res.json({ object: "list", default: config.model, endpoint: ROUTE, pricing,
      data: [{ id: "singit-ask", object: "model", owned_by: "singit", upstream: config.model },
        ...models.map(m => {
          // The price an answer is expected to cost: what this service's own answers from the model cost, or,
          // before the first, the share of list price Surplus's trusted sellers ask. Never the best offer.
          const seen = observed.share(m.id), trusted = market.get(m.id)?.trustedShare;
          const share = seen ?? trusted ?? null;
          return { id: m.id, object: "model", owned_by: m.provider || "surplus", name: m.name, contextLength: m.contextLength,
            tags: m.tags ?? [],
            usdPerMillionTokens: { input: m.promptUsdPerToken * 1e6, output: m.completionUsdPerToken * 1e6 },
            ...(share === null ? {} : { expectedUsdPerMillionTokens: { input: m.promptUsdPerToken * 1e6 * share,
              output: m.completionUsdPerToken * 1e6 * share, basis: seen === null ? "trusted" : "observed" } }) };
        })] });
  });

  const choose = input => chooseModel(config, catalogue, input);
  // Every answer that came back teaches the price shown for its model. It never delays or fails the answer.
  const learning = async (config_, messages, maxTokens, fetchImpl_, model = config.model) => {
    const answer = await upstream(config_, messages, maxTokens, fetchImpl_, model);
    catalogue?.resolve(model).then((list) => observed.record(model, answer.usage, list)).catch(() => {});
    return answer;
  };
  const route = { facilitatorClient, config, readRequest, choose, upstream: learning, fetchImpl, log };
  // Public: any x402 agent pays on Solana or Base for actual usage. Listed for discovery.
  addUsageRoute(app, ROUTE, quotes => [solanaOffer(config, quotes), baseOffer(config, quotes)], {
    description: `SingIt Ask: one answer from ${config.model}, OpenAI-compatible. Pays actual token cost + 30% `
                 + "+ settlement fee (0.002 USDC on Solana, 0.001 on Base), at most 0.003 USDC; nothing without an answer.",
    serviceName: "SingIt Ask",
    tags: ["llm", "chat", "openai-compatible", "solana", "base", "singit"],
    extensions: {
      ...declareEip2612GasSponsoringExtension(),
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: EXAMPLE.input,
        inputSchema: {
          properties: {
            messages: { type: "array", items: { type: "object" } },
            max_tokens: { type: "integer", maximum: LIMITS.maxTokens },
            model: { type: "string", description: "Any model id from GET /v1/models; the ceiling follows its price." },
          },
          required: ["messages"],
        },
        output: { example: EXAMPLE.output },
      }),
    },
  }, route);
  // The web agent's Base payments, pinned to this address by the gateway's buyer.
  addUsageRoute(app, METERED_ROUTE, quotes => [baseOffer(config, quotes)], {
    description: "SingIt Ask: actual model cost + 30% markup + 0.001 USDC settlement fee. Authorize at most 0.003 USDC.",
    extensions: declareEip2612GasSponsoringExtension(),
  }, route);
  // The web agent's Solana payments: measured privately, then paid directly from the owner's delegated USDC.
  if (config.directSolana) addSolanaQuotedRoute(app, config, { facilitatorClient, readRequest, choose, upstream: learning, fetchImpl, log });

  return app;
}
