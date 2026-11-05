// What one paid answer may ask for. For the default model, at these sizes the cost stays under the standing
// 0.003 USDC ceiling; any other model's ceiling is worked out from its own prices (pricing.mjs, ceilingAtomic).
// Thinking is switched off, but a seller may not obey; `max_tokens` bounds the answer and any thinking together
// (askSurplus sends it unchanged, plus a priced REASONING_HEADROOM for a model that cannot stop thinking), so a seller that thinks anyway only ever spends from the one priced budget.
export const LIMITS = { messages: 40, chars: 24_000, maxTokens: 1_200, defaultTokens: 800, timeoutMs: 45_000 };

// 100,000 characters matches FORMAT_LIMITS.chars. The 128 kb JSON body limit still applies before payment.
// 200 turns, 64 tools/calls and four images bound agent conversations; output is capped at 8192 tokens.
export const AGENT_LIMITS = { messages: 200, chars: 100_000, maxTokens: 8_192, tools: 64, images: 4, toolCalls: 64 };
// Estimated image token exposure expressed as characters, independent of URL length.
export const IMAGE_CHAR_ALLOWANCE = 8_000;
