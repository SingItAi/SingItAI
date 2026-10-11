// What one paid answer may ask for. For the default model, at these sizes the cost stays under the standing
// 0.003 USDC ceiling; any other model's ceiling is worked out from its own prices (pricing.mjs, ceilingAtomic).
export const LIMITS = { messages: 40, chars: 24_000, maxTokens: 1_200, defaultTokens: 800, timeoutMs: 45_000 };
// Thinking is switched off, but a seller may not obey, and thinking shares the token budget with the
// answer: on 4 October one spent 931 of 1200 tokens thinking and the answer stopped mid-word. The answer keeps
// its whole budget; the ceiling of any model counts this headroom as billable.
export const THINKING_HEADROOM = 1_000;
