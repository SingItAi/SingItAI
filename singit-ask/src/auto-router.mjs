// Text-only lite policy: eco requires every short/plain limit; premium matches long input,
// reasoning with an answer budget >= 1000 (within the HTTP limit of 1200), or reasoning with code/medium input. Otherwise standard.
// Thresholds and phrases live in config. Selection prices the request's upto ceiling on Base;
// network fees are constant across candidates. Escalation is upward only; alternates stay in the chosen tier.
import { readFileSync } from "node:fs";
import { UnknownModel, priceGuard, unservableError } from "./catalogue.mjs";
import { ceilings } from "./metered.mjs";
import { BASE, TERMS, minDiscountFor, DEFAULT_EXACT_OUTPUT_FRACTION } from "./pricing.mjs";
export const AUTO_ID = "singit/auto";
export const AUTO_DESCRIPTION = "Picks eco/standard/premium by simple rules for text prompts. Optional min_tier sets the minimum tier. X-SingIt-Model and X-SingIt-Tier report the choice. Only POST /v1/chat/completions. If the chosen model's seller refuses before payment, the router picks the next model of the tier or the next tier up, never below min_tier; after payment it retries once with another model of the same tier only if it costs no more than the price quoted, otherwise the request fails with 503 and no charge; X-SingIt-Model and X-SingIt-Tier show what actually answered.";
export const AUTO_CONFIG = JSON.parse(readFileSync(new URL("./auto-router.config.json", import.meta.url), "utf8"));
export const TIERS = ["eco", "standard", "premium"];
export function validateAutoConfig(config) {
  const validId = id => typeof id === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(id) && !/image|video|free\//i.test(id);
  const defaults = config.pinnedDefaultFallbacks === undefined ? {} : config.pinnedDefaultFallbacks;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) throw new Error("Invalid pinned default fallbacks");
  for (const [id, ids] of Object.entries(defaults)) {
    if (!validId(id) || !Array.isArray(ids) || ids.length < 1 || ids.length > 3
      || ids.some(next => !validId(next) || next === id) || new Set(ids).size !== ids.length)
      throw new Error("Invalid pinned default fallbacks");
  }

  for (const tier of TIERS) {
    if (!config.tiers[tier]?.length) throw new Error(`Empty auto tier: ${tier}`);
    for (const id of config.tiers[tier]) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || /image|video|free\//i.test(id)) throw new Error("Invalid auto model id");
    }
  }
}
validateAutoConfig(AUTO_CONFIG);
AUTO_CONFIG.pinnedDefaultFallbacks ??= {};
const reasoningPattern = new RegExp(`\\b(?:${AUTO_CONFIG.reasoningWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
export function classifyAuto(input) {
  const text = input.messages.map(m => m.content).join("\n");
  const tokens = Math.ceil(input.chars / AUTO_CONFIG.charsPerToken);
  const reasoning = reasoningPattern.test(text), code = text.includes("```");
  const { eco, premium } = AUTO_CONFIG;
  let tier = "standard", reason = "default_standard";
  if (tokens >= premium.minInputTokens) { tier = "premium"; reason = "long_input"; }
  else if (reasoning && input.maxTokens >= premium.reasoningOutputTokens) { tier = "premium"; reason = "reasoning_large_output"; }
  else if (reasoning && (code || tokens >= premium.reasoningInputTokens)) {
    tier = "premium"; reason = code ? "reasoning_with_code" : "reasoning_with_input";
  } else if (tokens <= eco.maxInputTokens && input.maxTokens <= eco.maxOutputTokens && input.messageCount <= eco.maxMessages && !code && !reasoning) {
    tier = "eco"; reason = "short_plain";
  }
  if (TIERS.indexOf(input.minTier) > TIERS.indexOf(tier)) { tier = input.minTier; reason = "min_tier"; }
  return { tier, reason };
}
export async function chooseAuto(config, catalogue, input, ErrorClass, log = () => {}) {
  const classified = classifyAuto(input);
  for (const tier of TIERS.slice(TIERS.indexOf(classified.tier))) {
    const candidates = [];
    for (const id of AUTO_CONFIG.tiers[tier]) {
      const info = await catalogue?.resolve(id).catch(() => null);
      const skip = reason => log(`singit-ask: auto skip model=${id} reason=${reason}`);
      if (!info || catalogue.isSuspended?.(info.id) || catalogue.isUnservable?.(info.id) || (catalogue.canAnswer && !await catalogue.canAnswer(info.id))) { skip("unhealthy"); continue; }
      const candidate = { ...input, model: info.id, info, ...priceGuard(catalogue, info.id, config.priceBufferPp ?? 1),
        autoTier: tier, autoReason: classified.reason };
      // Same rule as the paid call: a quote whose ceiling already covers the list-price worst case sends no floor,
      // so the seller's discount cannot refuse it and nothing to pre-check.
      const signal = await priceProtectionSignal(catalogue, candidate);
      if (signal) { skip(signal); continue; }
      candidates.push(candidate);
    }
    candidates.sort((a, b) => {
      const x = BigInt(ceilings(a.info, a).upto[BASE]), y = BigInt(ceilings(b.info, b).upto[BASE]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    if (candidates.length) {
      const [best, ...autoAlternates] = candidates;
      log(`singit-ask: auto tier=${tier} model=${best.model} reason=${best.autoReason}`);
      return { ...best, autoAlternates };
    }
  }
  throw unservableError(catalogue, AUTO_ID, ErrorClass);
}

// Shared pre-payment protection: a list-price-covering quote sends no discount floor.
export async function priceProtectionSignal(catalogue, candidate) {
  const floor = minDiscountFor(candidate, { ...TERMS, maxChargeAtomic: ceilings(candidate.info, candidate).upto[BASE] });
  if (floor == null) return null;
  if (catalogue.isPriceRejected?.(candidate.model)) return "price_rejected_recently";
  const live = await catalogue.liveDiscount?.(candidate.model);
  return live != null && 100 - live * 100 + 1e-9 < floor ? "price_below_floor" : null;
}

// Whether any amount the substitute would ask (upto and exact, on every network) is above what the pinned model would
// have asked for this request. The payer signs on one network and scheme, so "never costlier than the pinned quote" has
// to hold for each of them, not only for upto on Base.
const dearer = (candidate, pinned) => Object.entries(pinned).some(([scheme, byNetwork]) =>
  Object.entries(byNetwork).some(([network, amount]) => BigInt(candidate[scheme][network]) > BigInt(amount)));

// Caller order is stable; pinned fallbacks never become post-payment alternates.
export async function choosePinnedFallback(config, catalogue, input, choosePinned, ErrorClass, log = () => {}) {
  // Resolve outside availability handling: unknown ids and catalogue errors never trigger substitution.
  const info = await catalogue?.resolve(input.model).catch(error => {
    if (error instanceof UnknownModel) throw Object.assign(new ErrorClass(400, error.message), { code: "model_not_found" });
    throw error;
  });
  if (!info) return choosePinned(config, catalogue, input);
  const pinned = { ...input, info, isDefault: input.model === config.model,
    ...priceGuard(catalogue, info.id, config.priceBufferPp ?? 1) };
  const unpriced = model => !Number.isFinite(model.promptUsdPerToken) || !Number.isFinite(model.completionUsdPerToken)
    || model.promptUsdPerToken < 0 || model.completionUsdPerToken < 0
    || !(model.promptUsdPerToken > 0 || model.completionUsdPerToken > 0) || model.unpriced === true;
  const signalFor = async candidate => catalogue.isUnservable?.(candidate.model) ? "unhealthy"
    : catalogue.isSuspended?.(candidate.model) ? "unhealthy"
    : catalogue.canAnswer && !await catalogue.canAnswer(candidate.model) ? "unhealthy"
    : unpriced(candidate.info) ? "unpriced" : await priceProtectionSignal(catalogue, candidate);
  const signal = await signalFor(pinned);
  if (!signal) return choosePinned(config, catalogue, input);
  // Without numeric list prices there is no safe ceiling to compare against.
  if (!Number.isFinite(info.promptUsdPerToken) || !Number.isFinite(info.completionUsdPerToken)
    || info.promptUsdPerToken < 0 || info.completionUsdPerToken < 0) throw unservableError(catalogue, input.model, ErrorClass);
  // The same exact fraction the 402 will be built with, or the comparison would be made on other amounts than offered.
  const fraction = config.exactOutputFraction ?? DEFAULT_EXACT_OUTPUT_FRACTION;
  const pinnedCeilings = ceilings(info, pinned, fraction);
  const tiers = TIERS.filter(tier => AUTO_CONFIG.tiers[tier].includes(input.model));
  for (const id of input.fallbackModels) {
    const next = await catalogue.resolve(id).catch(error => {
      if (error instanceof UnknownModel) return null;
      throw error;
    });
    if (!next || tiers.some(tier => !AUTO_CONFIG.tiers[tier].includes(next.id))) continue;
    const candidate = { ...input, model: next.id, info: next, isDefault: next.id === config.model,
      ...priceGuard(catalogue, next.id, config.priceBufferPp ?? 1) };
    if (await signalFor(candidate) || dearer(ceilings(next, candidate, fraction), pinnedCeilings)) continue;
    log(`singit-ask: pinned fallback from=${input.model} to=${next.id} signal=${signal} policy=${input.fallbackPolicy ?? "request"}`);
    return { ...candidate, fallbackFrom: input.model };
  }
  throw unservableError(catalogue, input.model, ErrorClass);
}
