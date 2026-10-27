// SI-102 follow-up: `exact` is never dearer than the same question at a competitor (BlockRun), unless that would
// sell below this service's own cost floor.
//
// The competitor's price is not a per-model constant: it is rebuilt per question from the rule their own 402
// challenges follow (competitor-ceilings.json, with where the numbers came from), so it scales with the question
// and its max_tokens (or this service's default max_tokens when the request leaves it out) the same way theirs does.
// The input side uses this service's own estimate (about 4 characters per token plus 4 per message), which is below
// the competitor's (they count about 38 tokens for a 45-character question), so the cap errs on the cheap side.
//
// The floor is the typical answer `exact` assumes (exactOutputFraction of max_tokens), bought at the cheapest
// trusted Surplus offer for the model, plus `floorMarkupBps` and the network's settlement fee. When the cap is below
// that floor the floor is kept and logged (throttled: once per model and network per FLOOR_LOG_EVERY_MS).
// `upto` is never capped: it authorizes the whole budget and settles actual usage.
import { readFileSync } from "node:fs";
import { ceilingAtomic } from "./pricing.mjs";

export const DEFAULT_COMPETITOR_CAP = Object.freeze(JSON.parse(
  readFileSync(new URL("./competitor-ceilings.json", import.meta.url), "utf8")));

// `config.competitorCap`: undefined means the bundled competitor-ceilings.json, null turns the cap off
// (SINGIT_ASK_COMPETITOR_CAP=off, server.mjs), an object replaces it (SINGIT_ASK_COMPETITOR_CAP_FILE, tests).
export const competitorCapFor = (config) => (config?.competitorCap === undefined ? DEFAULT_COMPETITOR_CAP : config.competitorCap);

// The competitor's `exact` price for this question on `network`, in atomic USDC, or null when none is configured.
export function competitorExactAtomic(cap, modelId, network, { chars, maxTokens, messageCount }) {
  const rule = cap?.networks?.[network];
  const model = cap?.models?.[modelId];
  if (!rule || !model || !(maxTokens > 0)) return null;
  const inputTokens = Math.ceil((chars ?? 0) / 4) + 4 * (messageCount ?? 1);
  const outputTokens = Math.ceil(maxTokens * rule.exactOutputFraction);
  const micro = Math.ceil(inputTokens * model.inputUsdPerMillion + outputTokens * model.outputUsdPerMillion);
  return BigInt(Math.max(micro + Number(rule.feeAtomic ?? 0), Number(rule.minAtomic ?? 0)));
}

export const FLOOR_LOG_EVERY_MS = 10 * 60_000;
const lastFloorLog = new Map();
export function resetFloorLog() { lastFloorLog.clear(); }

// `exact`'s amount after the cap: min(uncapped, max(competitor, floor)). Never above the uncapped price (so the
// default model's clamp to the standing maximum still holds), never below the floor.
// `share` is the cheapest trusted share of list price known for the model (catalogue.mjs's priceGuard
// `cheapestShare`), falling back to the guarded share, then list price.
export function capExact({ cap, info, network, terms, uncapped, size, exactTokens, share, log = console.error, now = Date.now }) {
  if (!cap || !info) return uncapped;
  const competitor = competitorExactAtomic(cap, info.id, network, size);
  if (competitor === null || BigInt(uncapped) <= competitor) return uncapped;
  const floor = BigInt(ceilingAtomic(info, { chars: size.chars, messageCount: size.messageCount, maxTokens: exactTokens },
    { markupBps: cap.floorMarkupBps ?? terms.markupBps, settlementFeeAtomic: terms.settlementFeeAtomic }, share ?? 1));
  let amount = competitor;
  if (floor > competitor) {
    amount = floor;
    const key = `${info.id} ${network}`, t = now();
    if (!(t - (lastFloorLog.get(key) ?? -Infinity) < FLOOR_LOG_EVERY_MS)) {
      lastFloorLog.set(key, t);
      log(`singit-ask: exact cap for ${info.id} on ${network} (${cap.competitor ?? "competitor"} ${competitor}) is below the cost floor ${floor}; floor kept`);
    }
  }
  return (amount < BigInt(uncapped) ? amount : BigInt(uncapped)).toString();
}
