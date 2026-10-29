// The published settlement fee is charged consistently, including while the
// facilitator's promotional free allowance applies. Amounts are USDC micro-units.
export const METERED_ROUTE = "/v1/chat/completions/metered";
export const BASE = "eip155:8453";
export const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAY_TO = "0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e";
export const TERMS = Object.freeze({ version: 1, mode: "actual_usage", markupBps: 3000,
  settlementFeeAtomic: "1000", maxChargeAtomic: "3000" });

export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_PAY_TO = "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu";
export const SOLANA_TERMS = Object.freeze({ ...TERMS, settlementFeeAtomic: "2000" });

// The x402 resource's branding (ResourceInfo's serviceName/iconUrl, @x402/core 2.28): Bazaar and other directories
// show these next to the listing. SERVICE_NAME is the service's own name (the bare origin's index, llms.txt).
export const SERVICE_NAME = "SingIt Ask";
export const ICON_URL = "https://singitai.app/assets/icons/icon-512.png";

// Each discoverable route's serviceName says what it is, brand first (SI-90): CDP's Bazaar search is semantic, and
// every top result for a generic query ("chat completions", "web search") has a descriptive serviceName, so one
// "SingIt Ask" for every route ranked for none of them. Short: directories show it as the listing's title.
export const SERVICE_NAMES = Object.freeze({
  "/v1/chat/completions": "SingIt LLM Chat Completions",
  "/v1/messages": "SingIt Anthropic Messages API",
  "/v1/responses": "SingIt OpenAI Responses API",
  "/v1/exa/search": "SingIt Web Search (Exa)",
  "/v1/exa/answer": "SingIt Web Answers (Exa)",
  "/v1/exa/contents": "SingIt Web Page Contents (Exa)",
  "/v1/audio/speech": "SingIt Text to Speech",
  "/v1/images/generations": "SingIt Image Generation",
  "/v1/video/generations": "SingIt Video Generation",
});
// A per-model route's (model-routes.mjs) serviceName: "SingIt Claude Opus 5.5 Chat".
export const modelServiceName = (name) => `SingIt ${name} Chat`;

// Bazaar keeps only the first 5 tags (SI-90), so the category tags a buyer searches for come first, brand and
// network after; the rest still reach directories that keep them all.
export const MAX_TAGS = 10;
export const discoveryTags = (...tags) => [...new Set(tags)].slice(0, MAX_TAGS);

// The share of max_tokens `exact`'s flat price assumes the answer will use. Was 0.65 (p90 of 38 recorded answers,
// SI-60); 0.3 since SI-102 (26.10), so `exact` on Base is not dearer than BlockRun's for the same question (Opus 5.5
// at max_tokens 500: about 0.0020 USDC against their 0.00215; at 0.65 it was 0.00322). The recorded answers (32 paid
// web-agent answers at max_tokens 1200) are bimodal: p50 about 0.12, p75 0.44, p90 0.63, mean 0.24, so 0.3 still
// sits above the mean. The answer is never cut short: max_tokens goes upstream unchanged. An answer that runs past
// 0.3 is still delivered and settled at the flat price (`allowOverrun` below absorbs the difference, and it is
// logged); with the 30% markup and the settlement fee it costs this service more than it was paid only past about
// 0.6-0.8 of max_tokens, depending on the model and network. `upto` is unaffected: it always prices and authorizes
// the whole budget and settles actual usage. SINGIT_ASK_EXACT_OUTPUT_FRACTION overrides this (server.mjs).
export const DEFAULT_EXACT_OUTPUT_FRACTION = 0.3;

// Below this, a request is never authorized: cheap enough that a sensible floor matters more than honesty.
// Unlike `terms.maxChargeAtomic`, which the gateway and every buyer pin as the standing maximum, this floor is
// free to move: it only ever pushes a ceiling up, never past that maximum.
export const MIN_CEILING_ATOMIC = "1500";

// `allowOverrun` is for `exact`: that scheme already charged the flat ceiling regardless of actual usage (see
// metered.mjs), so going over it costs this service the difference instead of refusing the answer. `upto` never
// sets it: a metered payment that would collect more than it is authorized to is refused instead, as before.
export function billUsage(usage, terms = TERMS, { allowOverrun = false } = {}) {
  const raw = usage?.buyer_cost_micro;
  if (!(typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
      && !(typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw))) {
    throw new Error("Provider did not report a valid actual cost; payment refused.");
  }
  const provider = BigInt(raw);
  const markup = (provider * BigInt(terms.markupBps) + 9999n) / 10000n;
  const total = provider + markup + BigInt(terms.settlementFeeAtomic);
  const cap = BigInt(terms.maxChargeAtomic);
  const billed = { ...terms, providerCostAtomic: provider.toString(), markupAtomic: markup.toString() };
  if (total <= cap) return { ...billed, totalAtomic: total.toString(), currency: "USDC" };
  if (!allowOverrun) throw Object.assign(new Error("Actual cost exceeds the authorized ceiling; payment refused."),
    { code: "ceiling_exceeded", totalAtomic: total.toString() });
  return { ...billed, totalAtomic: cap.toString(), overrunAtomic: (total - cap).toString(), currency: "USDC" };
}

// Atomic USDC micro-units as a plain decimal string, for a human price (openapi.json, /v1/models, /openapi.json's
// x-payment-info): "1008" -> "0.001008".
export const usd = atomic => (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

// The ceiling one answer can cost: the most the model could bill for this question and answer size, plus the
// markup and the fee. It never drops below MIN_CEILING_ATOMIC; only models whose worst case is higher get a
// higher ceiling.
//
// Input is estimated from `charsPerToken`: by default about 4 characters per token (the way a chat template
// actually spends tokens), plus 4 tokens of overhead per message. That default charges a CJK, emoji or other
// high-entropy prompt for fewer tokens than a real tokenizer would spend on it, which is fine for `exact` (its
// flat ceiling already absorbs an overrun via `allowOverrun`) but not for a ceiling that is meant to be the
// highest this question can honestly cost: callers authorizing an `upto` ceiling, or a cap checked against actual
// usage after the fact, must pass `charsPerToken: 1`, the loosest bound no tokenizer exceeds, so that bound can
// never be undercut by a dense prompt. A higher authorization costs the payer nothing: `upto` only ever settles
// actual usage.
//
// The output is priced at the whole token budget the answer may ask for (its `max_tokens`, sent to Surplus
// unchanged: see askSurplus), since thinking shares that same budget instead of getting room beyond it.
//
// `share` is the worst-case fraction of list price this answer can be bought at, 1 when no better guarantee is
// known (metered.mjs's `ceilings`, catalogue.mjs's `priceGuard`): Surplus's own list prices are above what a
// seller actually charges, so a ceiling priced at list (share 1) holds even when a dearer seller wins; a smaller
// share holds only together with the X-Min-Discount header that makes it true.
//
// MODEL_COST_OVERHEAD (SI-110): tokens a model bills that the question and max_tokens do not account for, per model
// id. `promptTokens` is a hidden system prompt the seller adds; `reasoningTokens` is thinking billed beyond
// max_tokens instead of inside it. Measured on grok-4.7 on 27 October: a 22-character question came back with
// prompt_tokens 1248 (about 1220 hidden) and, at max_tokens 32, completion_tokens 56 of which 51 reasoning, so its
// actual cost (1561 micro-USDC with markup and fee) ran past the 1500 ceiling and the paid answer was refused while
// this service still paid for it. Rounded up to 1300 and 64. Only the ceiling grows: `upto` still settles actual
// usage, and a payer's balance must only cover the higher authorization. `exact`, which charges the ceiling, gets
// dearer for these models by the same overhead, which it otherwise absorbs as an overrun.
export const MODEL_COST_OVERHEAD = Object.freeze({
  "grok-4.7": Object.freeze({ promptTokens: 1300, reasoningTokens: 64 }),
});
// REASONING_HEADROOM (SI-112): tokens added to max_tokens upstream (askSurplus) for a model whose thinking cannot be
// switched off and is counted inside max_tokens, so a small max_tokens is not all spent thinking. Measured on
// gemini-3.1-pro-preview on 27 October: `reasoning: {effort: "none"}` (its only listed control) still thought; at
// max_tokens 32 the answer was empty (422 max_tokens_too_small), at 512 a three-word answer took 275 completion
// tokens. Gemini 3 Pro has no thinking-off setting (lowest thinking level is "low"), so room is added instead.
// The headroom is priced as output (costOverhead's reasoningTokens), so the ceiling covers it; `upto` still settles
// actual usage, `exact` gets dearer by it. The payer's max_tokens may then bound the answer only loosely.
//
// claude-opus-5.5 (SI-113): it lists reasoning_effort and is sent "none", yet a three-word answer came back with 26
// completion tokens (about 20 of them thinking, 27 October, twice) and once spent all of max_tokens 64 thinking (422,
// paid test 17:49 CET); at 256 it answered. 256 more tokens upstream cover that; the payer is billed what was used.
export const REASONING_HEADROOM = Object.freeze({
  "gemini-3.1-pro-preview": 1024,
  "claude-opus-5.5": 256,
});
// Which scheme a buyer should sign (28 October): for Claude Opus, `upto`. Opus's thinking cannot be switched off, so
// an `exact` price has to carry max_tokens' share plus REASONING_HEADROOM at the purchase price, and that flat amount
// is usually well above what the answer used (a three-word answer was 26 tokens, about 20 of them thinking); `upto`
// charges what the answer really cost. Both offers stay in the 402 (`upto` first); this only says which to pick. The
// price formula is untouched. Shown by GET /pricing.json and GET /v1/models, in openapi.json and in the docs.
export const isUptoPrimary = (id) => typeof id === "string" && /^claude-opus-/.test(id);
export const UPTO_PRIMARY = Object.freeze({
  recommended: "upto",
  why: "Pay Claude Opus with upto: it settles what the answer really cost (+30% + the fee), up to the ceiling you sign. "
    + "exact is a flat price that includes room for Opus's thinking tokens, so it is usually dearer than the answer "
    + "used, with no metering and no refund.",
});
export const reasoningHeadroom = (id) => (typeof id === "string" && Object.hasOwn(REASONING_HEADROOM, id) ? REASONING_HEADROOM[id] : 0);
export const costOverhead = (model) => {
  const id = typeof model?.id === "string" ? model.id : "";
  const extra = Object.hasOwn(MODEL_COST_OVERHEAD, id) ? MODEL_COST_OVERHEAD[id] : null;
  return { promptTokens: extra?.promptTokens ?? 0, reasoningTokens: (extra?.reasoningTokens ?? 0) + reasoningHeadroom(id) };
};

// The most the model itself could bill for this question and answer size, in micro-units, before markup and fee.
export function worstModelCostMicro(model, { chars, maxTokens, messageCount, charsPerToken = 4 }, share = 1) {
  const extra = costOverhead(model);
  const inputTokens = Math.ceil(chars / charsPerToken) + 4 * messageCount + extra.promptTokens;
  const outputTokens = maxTokens + extra.reasoningTokens;
  return Math.ceil((inputTokens * model.promptUsdPerToken + outputTokens * model.completionUsdPerToken) * share * 1e6);
}

export function ceilingAtomic(model, size, terms, share = 1) {
  const worst = worstModelCostMicro(model, size, share);
  const total = BigInt(worst) + (BigInt(worst) * BigInt(terms.markupBps) + 9999n) / 10000n + BigInt(terms.settlementFeeAtomic);
  const floor = BigInt(MIN_CEILING_ATOMIC);
  return (total > floor ? total : floor).toString();
}

// The X-Min-Discount to send for a paid question: the guard's floor only when it is needed. The floor pins the
// answer to the cheapest seller (priceGuard: cheapest qualifying offer + 1pp), and Surplus answers 404
// minimum_discount_not_met when that seller is gone. When the model's worst case at list price still fits what the
// payer authorized (`terms.maxChargeAtomic`), any seller is affordable and nothing can overrun, so none is sent.
// Safe for both schemes: `upto` still refuses an answer over its ceiling (billUsage), and `exact` was paid the
// flat ceiling, which the list-price worst case already fits, so no seller can cost more than was authorized.
export function minDiscountFor(input, terms) {
  if (input.minDiscount == null) return null;
  if (!input.info) return input.minDiscount;
  const size = { chars: input.chars, maxTokens: input.maxTokens, messageCount: input.messageCount, charsPerToken: 1 };
  return BigInt(ceilingAtomic(input.info, size, terms, 1)) <= BigInt(terms.maxChargeAtomic) ? null : input.minDiscount;
}

// Web Ask: measure privately, then settle once from the delegated owner account.
export const QUOTED_ROUTE = "/v1/chat/completions/quoted/solana";
export const QUOTED_URL = `https://ask.singitai.app${QUOTED_ROUTE}`;
export const DIRECT_TERMS = TERMS;
