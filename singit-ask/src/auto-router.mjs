// Text-only lite policy: eco requires every short/plain limit; premium matches long input,
// reasoning with an answer budget >= 1000 (within the HTTP limit of 1200), or reasoning with code/medium input. Otherwise standard.
// Thresholds and phrases live in config. Selection prices the request's upto ceiling on Base;
// network fees are constant across candidates. No default-model clamp or provider fallback.
import { readFileSync } from "node:fs";
import { priceGuard, unservableError } from "./catalogue.mjs";
import { ceilings } from "./metered.mjs";
import { BASE } from "./pricing.mjs";
export const AUTO_ID = "singit/auto";
export const AUTO_DESCRIPTION = "Picks eco/standard/premium by simple rules for text prompts. Optional min_tier sets the minimum tier. X-SingIt-Model and X-SingIt-Tier report the choice. Only POST /v1/chat/completions.";
export const AUTO_CONFIG = JSON.parse(readFileSync(new URL("./auto-router.config.json", import.meta.url), "utf8"));
export const TIERS = ["eco", "standard", "premium"];
export function validateAutoConfig(config) {
  for (const tier of TIERS) {
    if (!config.tiers[tier]?.length) throw new Error(`Empty auto tier: ${tier}`);
    for (const id of config.tiers[tier]) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || /image|video|free\//i.test(id)) throw new Error("Invalid auto model id");
    }
  }
}
validateAutoConfig(AUTO_CONFIG);
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
export async function chooseAuto(config, catalogue, input, ErrorClass) {
  const classified = classifyAuto(input);
  for (const tier of TIERS.slice(TIERS.indexOf(classified.tier))) {
    let best = null, bestPrice;
    for (const id of AUTO_CONFIG.tiers[tier]) {
      const info = await catalogue?.resolve(id).catch(() => null);
      if (!info || catalogue.isUnservable?.(info.id) || (catalogue.canAnswer && !await catalogue.canAnswer(info.id))) continue;
      const candidate = { ...input, model: info.id, info, ...priceGuard(catalogue, info.id, config.priceBufferPp ?? 1),
        autoTier: tier, autoReason: classified.reason };
      const price = BigInt(ceilings(info, candidate).upto[BASE]);
      if (!best || price < bestPrice) { best = candidate; bestPrice = price; }
    }
    if (best) return best;
  }
  throw unservableError(catalogue, AUTO_ID, ErrorClass);
}
