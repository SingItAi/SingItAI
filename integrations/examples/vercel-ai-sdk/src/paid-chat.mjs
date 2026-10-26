// Paid mode: one real x402 payment on Base for a SingIt Ask chat completion, through the AI SDK's
// OpenAI-compatible provider pointed at https://ask.singitai.app/v1 with an x402-paying fetch
// (./x402/pay.js). Runs only when the caller opts in explicitly — see runPaidChat below.
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createSingitPaidFetch } from "./x402/pay.js";
import { DailyLimiter, usdToAtomic } from "./x402/guards.js";
import { DEFAULT_ASK_BASE_URL } from "./free-chat-probe.mjs";

export function paidChatModeFromEnv(env = process.env) {
  if (env.SINGIT_ALLOW_PAID !== "1") return null;
  const evmPrivateKey = env.SINGIT_EVM_PRIVATE_KEY;
  const maxPerCallUsd = Number(env.SINGIT_MAX_PER_CALL_USD);
  const maxPerDayUsd = Number(env.SINGIT_MAX_PER_DAY_USD);
  if (!evmPrivateKey || !Number.isFinite(maxPerCallUsd) || !Number.isFinite(maxPerDayUsd)) return null;
  return { evmPrivateKey, maxPerCallUsd, maxPerDayUsd };
}

// One limiter per (baseUrl) for the life of the process, so repeated runPaidChat calls share one
// rolling-day cap instead of each call starting a fresh one. Callers may pass their own `limiter`.
const limiters = new Map();
export function sharedLimiter(baseUrl, maxPerDayUsd) {
  const capAtomic = BigInt(usdToAtomic(maxPerDayUsd));
  let limiter = limiters.get(baseUrl);
  if (!limiter) {
    limiter = new DailyLimiter(capAtomic);
    limiters.set(baseUrl, limiter);
  } else {
    limiter.capAtomic = capAtomic;
  }
  return limiter;
}

/**
 * `prompt` is sent to SingIt Ask, paid over x402. `caps` is `{ evmPrivateKey, maxPerCallUsd,
 * maxPerDayUsd }` — pass `paidChatModeFromEnv()`'s result, or your own. `baseUrl`/`model` default
 * to the live SingIt Ask route; override for a local mock merchant in tests. `limiter` is an
 * optional DailyLimiter; by default one is kept per `baseUrl` for the life of the process.
 */
export async function runPaidChat({ prompt, caps, baseUrl = DEFAULT_ASK_BASE_URL, model = "deepseek-v4.1-flash", limiter }) {
  if (!caps) {
    throw new Error("Paid mode needs SINGIT_ALLOW_PAID=1, SINGIT_EVM_PRIVATE_KEY, SINGIT_MAX_PER_CALL_USD "
      + "and SINGIT_MAX_PER_DAY_USD (see README.md).");
  }
  const fetchImpl = createSingitPaidFetch({ ...caps, baseUrl, limiter: limiter ?? sharedLimiter(baseUrl, caps.maxPerDayUsd) });
  const provider = createOpenAICompatible({
    name: "singit-ask",
    baseURL: `${baseUrl}/v1`,
    apiKey: "unused-singit-pays-over-x402",
    fetch: fetchImpl,
  });
  const result = await generateText({ model: provider.chatModel(model), prompt });
  return result;
}
