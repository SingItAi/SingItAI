import { payAskRequest, SingItAskError } from "../x402/pay.js";
import { DailyLimiter, usdToAtomic, BASE_PIN, DEFAULT_ASK_BASE_URL } from "../x402/guards.js";
import { isX402Available, X402_INSTALL_HINT } from "../x402/loader.js";
import { readSetting, readNumberSetting } from "../settings.js";

// One limiter per runtime, so repeated action invocations share a rolling-day cap instead of
// resetting it. A changed cap setting updates the same limiter rather than starting a fresh one.
const limiters = new WeakMap();
const fallbackKey = {};
export function limiterFor(runtime, maxPerDayUsd) {
  const key = runtime !== null && typeof runtime === "object" ? runtime : fallbackKey;
  const capAtomic = BigInt(usdToAtomic(maxPerDayUsd));
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new DailyLimiter(capAtomic);
    limiters.set(key, limiter);
  } else {
    limiter.capAtomic = capAtomic;
  }
  return limiter;
}

function requiredSettings(runtime) {
  const evmPrivateKey = readSetting(runtime, "SINGIT_EVM_PRIVATE_KEY");
  const maxPerCallUsd = readNumberSetting(runtime, "SINGIT_MAX_PER_CALL_USD");
  const maxPerDayUsd = readNumberSetting(runtime, "SINGIT_MAX_PER_DAY_USD");
  if (!evmPrivateKey || maxPerCallUsd == null || maxPerDayUsd == null) return null;
  return { evmPrivateKey, maxPerCallUsd, maxPerDayUsd };
}

// Paid x402 chat call to SingIt Ask on Base (https://ask.singitai.app/v1/chat/completions),
// guarded by the pinned Base offer (network/asset/payTo) and the configured per-call/per-day USDC
// ceilings — see ../x402/guards.js and ../x402/pay.js (trimmed from sdk/typescript). Requires
// the optional peer @x402/evm, SINGIT_EVM_PRIVATE_KEY and BOTH caps; absent any of the three, validate() returns false and the
// action is never offered, so an agent without an explicitly funded+capped wallet never pays.
export const singitPaidChatAction = {
  name: "SINGIT_PAID_CHAT",
  similes: ["ASK_SINGIT", "PAID_CHAT", "SINGIT_X402_CHAT"],
  description: "Ask a question to SingIt Ask, paid per answer over x402 on Base. Needs "
    + "SINGIT_EVM_PRIVATE_KEY, SINGIT_MAX_PER_CALL_USD, SINGIT_MAX_PER_DAY_USD and the optional @x402/evm package.",
  examples: [
    [
      { name: "{{user}}", content: { text: "Ask SingIt Ask: what is x402?" } },
      { name: "{{agent}}", content: { text: "Paying SingIt Ask for an answer.", actions: ["SINGIT_PAID_CHAT"] } },
    ],
  ],
  validate: async (runtime, message) => {
    if (!requiredSettings(runtime)) return false;
    if (!(await isX402Available())) return false;
    return /ask singit( ask)?|singit ask/i.test(message?.content?.text ?? "");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const settings = requiredSettings(runtime);
    if (!settings) {
      const text = "SINGIT_PAID_CHAT needs SINGIT_EVM_PRIVATE_KEY, SINGIT_MAX_PER_CALL_USD and "
        + "SINGIT_MAX_PER_DAY_USD; at least one is not configured, so no payment will be made.";
      await callback?.({ text, actions: ["SINGIT_PAID_CHAT"] });
      return { text, success: false, error: "missing_wallet_or_caps" };
    }
    if (!(await isX402Available())) {
      await callback?.({ text: X402_INSTALL_HINT, actions: ["SINGIT_PAID_CHAT"] });
      return { text: X402_INSTALL_HINT, success: false, error: "missing_x402_evm" };
    }
    const { evmPrivateKey, maxPerCallUsd, maxPerDayUsd } = settings;
    const question = (message?.content?.text ?? "").replace(/^.*?ask singit( ask)?:?/i, "").trim() || message?.content?.text || "";
    const baseUrl = readSetting(runtime, "SINGIT_ASK_BASE_URL") ?? DEFAULT_ASK_BASE_URL;
    try {
      const { response, payment } = await payAskRequest({
        body: { messages: [{ role: "user", content: question }] },
        baseUrl, evmPrivateKey, limiter: limiterFor(runtime, maxPerDayUsd),
        maxPerCallAtomic: usdToAtomic(maxPerCallUsd), payTo: BASE_PIN.payTo,
      });
      const answer = response?.choices?.[0]?.message?.content ?? "(no answer)";
      const text = payment ? `${answer}\n\n(paid ${payment.amountAtomic} atomic USDC on Base)` : answer;
      await callback?.({ text, actions: ["SINGIT_PAID_CHAT"] });
      return { text, success: true, data: { answer, payment } };
    } catch (error) {
      const unpaid = error instanceof SingItAskError;
      const text = unpaid ? `SingIt Ask is unavailable (HTTP ${error.status}); no payment was made.`
        : `SingIt Ask payment was refused: ${error.message}`;
      await callback?.({ text, actions: ["SINGIT_PAID_CHAT"] });
      return { text, success: false, error: error.message, ...(unpaid ? { data: { status: error.status } } : {}) };
    }
  },
};
