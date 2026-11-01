// Runs SingIt Ask on loopback, for the Cloudflare tunnel in front of it. Coinbase CDP settles every payment.
//
//   SINGIT_ASK_PAY_TO_SOLANA   where Solana payments go (its USDC account must exist)
//   SINGIT_ASK_PAY_TO_BASE     where Base payments go
//   SURPLUS_API_KEY            the inf_… buyer key the model is bought with
//   CDP_API_KEY_ID, CDP_API_KEY_SECRET   the CDP facilitator's credentials
//   SINGIT_ASK_DIRECT_SOLANA   1 turns on the web agent's private Solana route, with
//   SINGIT_ASK_QUOTE_TOKEN     its shared secret (32+ characters) and
//   SINGIT_ASK_QUOTE_DB        its private SQLite file
//   SINGIT_ASK_MODEL           upstream model, default deepseek-v4.1-flash
//   SINGIT_ASK_UNSERVABLE_TTL_MINUTES  seller rejection cache, default 15 minutes; 0 disables
//   SINGIT_ASK_PORT            default 8140
//   SINGIT_ASK_BLOCKED_PROVIDERS  provider ids the Surplus key blocks (comma-separated), so models only they sell
//                              are not offered
//   SINGIT_ASK_OBSERVED_PRICES where what answers cost per model is kept (no prompts), default
//                              ~/.config/singit-ask/observed-prices.json
//   SINGIT_ASK_STATS_FILE      persistent private counters, default ~/.config/singit-ask/health-stats.json
//   SINGIT_ASK_OWN_PAYERS_FILE optional own payers, one per line with # comments
//   SINGIT_ASK_FREE_MODELS     models answered free as "free/<id>" (comma-separated); unset means six default free models,
//                              empty turns free answers off
//   SINGIT_ASK_FREE_PER_VISITOR, SINGIT_ASK_FREE_PER_DAY  free answers a day per visitor and for everyone together
//                              (defaults in src/free.mjs); visitors are counted by network (IPv4 /24, IPv6 /64)
//   SINGIT_ASK_FREE_BUDGET_USD_PER_DAY  daily dollar budget for free answers; default 0.25; 0 disables
//   SINGIT_ASK_EXA_API_KEY     SingIt's Exa API key: turns on /v1/exa/search, /contents and /answer, resold over x402
//                              at Exa's list price with no markup (src/search.mjs)
//   SINGIT_ASK_BASE_RPC        the Base RPC free prices read Chainlink from (https://mainnet.base.org)
//   SINGIT_ASK_PRICE_BUFFER_PP percentage points added to a model's cheapest known Surplus share before it is
//                              turned into the X-Min-Discount header (src/catalogue.mjs's priceGuard), default 1
//   SINGIT_ASK_REASONING_EFFORT   measurement only, default unset: "model=effort,..." (none|minimal|low|medium|high)
//                              asks that model for this reasoning effort instead of "none" (e.g. claude-opus-5.5=low)
//   SINGIT_ASK_EXA_MARKUP_BPS default 0: integer 0..10000; invalid values use 0.
//   SINGIT_ASK_EXA_FEE_ATOMIC default "0,0": non-negative integer N for both networks or "base,solana"; invalid uses 0,0.
//   SINGIT_ASK_EXACT_RESERVE   default "0.25,32,256": the thinking tokens `exact` prices for Claude Opus, as
//                              clamp(round(factor*max_tokens), min, max); "full" restores pricing the whole headroom.
//                              Only the price: the upstream max_tokens and `upto` are unchanged (pricing.mjs EXACT_RESERVE)
//   SINGIT_ASK_REASONING_HEADROOM measurement only, default unset: "model=tokens,..." replaces the model's thinking
//                              headroom (pricing.mjs REASONING_HEADROOM) in the ceiling and upstream max_tokens
//   SINGIT_ASK_EXACT_OUTPUT_FRACTION  fraction (0,1] of max_tokens that `exact` offers price their output at;
//                              `upto` always prices the whole budget. Default 0.3

import { parseExaMarkupBps, parseExaFeeAtomic, setExaMarkupBps, setExaFeeAtomic } from "./search.mjs";
import { readFileSync } from "node:fs";
import { parseOwnPayers } from "./own-payers.mjs";
import { createRequire } from "node:module";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withFacilitatorHints } from './facilitator-hints.mjs';
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createApp, parseReasoningEffort } from "./app.mjs";
import { PriceBook } from "./prices.mjs";
import { DEFAULT_FREE_MODELS, FREE_DEFAULTS } from "./free.mjs";
import { DEFAULT_EXACT_OUTPUT_FRACTION, parseReasoningHeadroom, setReasoningHeadroomOverrides, parseExactReserve, setExactReserve } from "./pricing.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    console.error(`singit-ask: ${name} is required`);
    process.exit(1);
  }
  return value;
}

const config = {
  directSolana: process.env.SINGIT_ASK_DIRECT_SOLANA === "1",
  // Video is off unless SINGIT_ASK_VIDEO_SOLD=1 (a paid job can fail after settlement; see video.mjs). When sold,
  // SINGIT_ASK_VIDEO_DISCOVERABLE=1 also lists it for x402 discovery.
  videoSold: process.env.SINGIT_ASK_VIDEO_SOLD === "1",
  videoDiscoverable: process.env.SINGIT_ASK_VIDEO_DISCOVERABLE === "1",
  quoteToken: process.env.SINGIT_ASK_QUOTE_TOKEN,
  quoteDb: process.env.SINGIT_ASK_QUOTE_DB,
  payToSolana: required("SINGIT_ASK_PAY_TO_SOLANA"),
  payToBase: required("SINGIT_ASK_PAY_TO_BASE"),
  surplusKey: required("SURPLUS_API_KEY"),
  surplusUrl: (process.env.SURPLUS_API_URL || "https://api.surplusintelligence.ai").replace(/\/$/, ""),
  model: process.env.SINGIT_ASK_MODEL || "deepseek-v4.1-flash",
  // Where the gateway's free wallet report lives (listed in /openapi.json only; this service does not serve it).
  walletReportOrigin: (process.env.SINGIT_ASK_WALLET_REPORT_ORIGIN || "https://app.singitai.app").replace(/\/$/, ""),
  blockedProviders: String(process.env.SINGIT_ASK_BLOCKED_PROVIDERS || "").split(",").map((p) => p.trim()).filter(Boolean),
  // Off unless set: one anonymous line per paid answer (tokens against max_tokens, cost); see src/answer-log.mjs.
  answerLogFile: String(process.env.SINGIT_ASK_ANSWER_LOG || "").trim() || null,
  observedFile: process.env.SINGIT_ASK_OBSERVED_PRICES
    || `${process.env.HOME}/.config/singit-ask/observed-prices.json`,
};
{
  const ttlText = String(process.env.SINGIT_ASK_UNSERVABLE_TTL_MINUTES ?? "15").trim();
  const ttl = ttlText ? Number(ttlText) : NaN;
  config.unservableTtlMs = (Number.isFinite(ttl) && ttl >= 0 ? ttl : 15) * 60_000;
  const bufferPp = Number(process.env.SINGIT_ASK_PRICE_BUFFER_PP);
  config.priceBufferPp = Number.isInteger(bufferPp) && bufferPp >= 0 ? bufferPp : 1;
  const fraction = Number(process.env.SINGIT_ASK_EXACT_OUTPUT_FRACTION);
  config.exactOutputFraction = fraction > 0 && fraction <= 1 ? fraction : DEFAULT_EXACT_OUTPUT_FRACTION;
}
// A bad value stops the process at start, never prices a request with a guess.
config.reasoningEffort = parseReasoningEffort(process.env.SINGIT_ASK_REASONING_EFFORT);
setReasoningHeadroomOverrides(parseReasoningHeadroom(process.env.SINGIT_ASK_REASONING_HEADROOM));
setExactReserve(parseExactReserve(process.env.SINGIT_ASK_EXACT_RESERVE));
setExaMarkupBps(parseExaMarkupBps(process.env.SINGIT_ASK_EXA_MARKUP_BPS));
setExaFeeAtomic(parseExaFeeAtomic(process.env.SINGIT_ASK_EXA_FEE_ATOMIC));
config.statsFile = process.env.SINGIT_ASK_STATS_FILE || `${process.env.HOME}/.config/singit-ask/health-stats.json`;
config.statsToken = process.env.SINGIT_ASK_STATS_TOKEN;
try {
  config.ownPayers = process.env.SINGIT_ASK_OWN_PAYERS_FILE
    ? parseOwnPayers(readFileSync(process.env.SINGIT_ASK_OWN_PAYERS_FILE, "utf8")) : [];
} catch {
  console.error("singit-ask: SINGIT_ASK_OWN_PAYERS_FILE could not be read");
  process.exit(1);
}
console.error(`singit-ask: own payer exclusions: ${config.ownPayers.length}`);
const model = config.model;
config.freeModels = process.env.SINGIT_ASK_FREE_MODELS === undefined ? DEFAULT_FREE_MODELS
  : process.env.SINGIT_ASK_FREE_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
const positive = (name) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : undefined; };
config.freeLimits = Object.fromEntries(Object.entries({
  perVisitorPerDay: positive("SINGIT_ASK_FREE_PER_VISITOR"), perDay: positive("SINGIT_ASK_FREE_PER_DAY"),
}).filter(([, v]) => v !== undefined));
config.freeStateFile = process.env.SINGIT_ASK_FREE_STATE_FILE ?? `${process.env.HOME}/.config/singit-ask/free-budget.json`;
{
  const raw = process.env.SINGIT_ASK_FREE_BUDGET_USD_PER_DAY;
  const budget = raw?.trim() ? Number(raw) : NaN;
  config.freeBudgetUsdPerDay = Number.isFinite(budget) && budget >= 0 ? budget : FREE_DEFAULTS.budgetUsdPerDay;
}
const port = Number(process.env.SINGIT_ASK_PORT || 8140);

required("CDP_API_KEY_ID"); required("CDP_API_KEY_SECRET");
// The CDP component's installed, authenticated SDK signs each facilitator call.
const requireCdp = createRequire(new URL("../../cdp-x402-service/package.json", import.meta.url));
const facilitatorClient = withFacilitatorHints(new HTTPFacilitatorClient(requireCdp("@coinbase/x402").facilitator));

config.exaKey = String(process.env.SINGIT_ASK_EXA_API_KEY || "").trim() || null;
if (config.exaKey) console.error("singit-ask: search on (Exa)");

const priceBook = new PriceBook({ publicClient: createPublicClient({ chain: base,
  transport: http(process.env.SINGIT_ASK_BASE_RPC || "https://mainnet.base.org", { retryCount: 1, timeout: 10_000 }),
  batch: { multicall: true } }) });

const app = createApp(config, { facilitatorClient, priceBook });
// The model list and its live prices are read now and kept fresh, so no visitor waits for Surplus.
app.locals.catalogue?.warm().catch(() => { /* the first read retries */ });
app.listen(port, "127.0.0.1", () => {
  console.error(`singit-ask: ${config.model}, actual usage over Coinbase CDP on Solana and Base, on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { app.locals.healthStats.flush(); process.exit(0); });
