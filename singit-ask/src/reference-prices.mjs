// Reviewed allowlist and fallback floors. Public prices alone are insufficient: sellers can offer above list.
// Each static side is max(public reference, dearest trusted offer checked 2026-11-01).
// LIMITS.chars caps prompts at 24000 characters (about 24k tokens conservatively), inside every lowest context tier.
export const REFERENCE_PRICES = Object.freeze({
  // Venice Gemini 3.1 Pro Preview <=200K; Google 2/12; checked 2026-11-01.
  "gemini-3.1-pro": Object.freeze({ inputUsdPerM: 2.5, outputUsdPerM: 15, source: "Venice Gemini 3.1 Pro Preview <=200K; Google 2/12; checked 2026-11-01" }),
  // Alibaba Cloud Model Studio Singapore <=256K; checked 2026-11-01.
  "qwen3.5-plus": Object.freeze({ inputUsdPerM: 0.4, outputUsdPerM: 2.4, source: "Alibaba Cloud Model Studio Singapore <=256K; checked 2026-11-01" }),
  // Alibaba Cloud Model Studio Singapore; checked 2026-11-01.
  "qwen3.5-flash": Object.freeze({ inputUsdPerM: 0.1, outputUsdPerM: 0.4, source: "Alibaba Cloud Model Studio Singapore; checked 2026-11-01" }),
  // MiniMax pay-as-you-go; checked 2026-11-01.
  "minimax-m2.7-highspeed": Object.freeze({ inputUsdPerM: 0.6, outputUsdPerM: 2.4, source: "MiniMax pay-as-you-go; checked 2026-11-01" }),
  // Anthropic fast mode 30/150; Venice offers up to 32.4/162; checked 2026-11-01.
  "claude-opus-4.6-fast": Object.freeze({ inputUsdPerM: 32.4, outputUsdPerM: 162, source: "Anthropic fast mode 30/150; Venice offers up to 32.4/162; checked 2026-11-01" }),
  // 6x Opus fast-mode premium; Venice offers up to 36/180; checked 2026-11-01.
  "claude-opus-4-7-fast": Object.freeze({ inputUsdPerM: 36, outputUsdPerM: 180, source: "6x Opus fast-mode premium; Venice offers up to 36/180; checked 2026-11-01" }),
  // Venice zai-org-glm-5-1; checked 2026-11-01.
  "e2ee-glm-5.1": Object.freeze({ inputUsdPerM: 1.54, outputUsdPerM: 4.84, source: "Venice zai-org-glm-5-1; checked 2026-11-01" }),
  // Venice google-gemma-3-27b-it 0.12/0.20; offers up to 0.07/0.25; checked 2026-11-01.
  "e2ee-gemma-3-27b": Object.freeze({ inputUsdPerM: 0.12, outputUsdPerM: 0.25, source: "Venice google-gemma-3-27b-it 0.12/0.20; offers up to 0.07/0.25; checked 2026-11-01" }),
  // Venice google-gemma-4-31b-it 0.12/0.36; offers up to 0.125/0.375; checked 2026-11-01.
  "e2ee-gemma-4-31b": Object.freeze({ inputUsdPerM: 0.125, outputUsdPerM: 0.375, source: "Venice google-gemma-4-31b-it 0.12/0.36; offers up to 0.125/0.375; checked 2026-11-01" }),
  // Surplus openai-gpt-oss-20b 0.03/0.13; offers up to 0.05/0.19; checked 2026-11-01.
  "e2ee-gpt-oss-20b-p": Object.freeze({ inputUsdPerM: 0.05, outputUsdPerM: 0.19, source: "Surplus openai-gpt-oss-20b 0.03/0.13; offers up to 0.05/0.19; checked 2026-11-01" }),
  // Venice/Surplus larger sibling qwen3-5-35b-a3b upper bound; checked 2026-11-01.
  "qwen3-5-9b": Object.freeze({ inputUsdPerM: 0.15, outputUsdPerM: 1, source: "Venice/Surplus larger sibling qwen3-5-35b-a3b upper bound; checked 2026-11-01" }),
  // Venice e2ee-qwen3-6-35b-a3b 0.182/1.18; offers up to 0.8/2.4; checked 2026-11-01.
  "e2ee-qwen3-6-35b-a3b-uncensored-p": Object.freeze({ inputUsdPerM: 0.8, outputUsdPerM: 2.4, source: "Venice e2ee-qwen3-6-35b-a3b 0.182/1.18; offers up to 0.8/2.4; checked 2026-11-01" }),
});
export const BOOK_PRICE_MARGIN = 1.10;
export function matchesBook(book, id) {
  const model = book?.model ?? book?.data?.model;
  return typeof model !== "string" || model.toLowerCase() === String(id).toLowerCase();
}
// Health, availability and capacity deliberately do not limit the bound: dear sellers can return.
export function bookPrices(book, blockedSet = new Set()) {
  const offers = book?.data?.offers ?? book?.offers;
  if (!Array.isArray(offers)) return null;
  let input = 0, output = 0;
  for (const o of offers) {
    if (o?.trusted !== true || blockedSet.has(String(o.provider_id ?? "").toLowerCase())
        || (o.pricing_mode != null && o.pricing_mode !== "per_token")) continue;
    const i = Number(o.effective_input_per_1m), out = Number(o.effective_output_per_1m);
    if (!(Number.isFinite(i) && i > 0 && Number.isFinite(out) && out > 0)) continue;
    input = Math.max(input, i); output = Math.max(output, out);
  }
  return input > 0 ? { inputUsdPerToken: input / 1e12, outputUsdPerToken: output / 1e12 } : null;
}
export function derivedPrice(id, live) {
  const ref = Object.hasOwn(REFERENCE_PRICES, id) ? REFERENCE_PRICES[id] : null;
  if (!ref) return null;
  return { inputUsdPerToken: Math.max(ref.inputUsdPerM / 1e6, (live?.inputUsdPerToken ?? 0) * BOOK_PRICE_MARGIN),
    outputUsdPerToken: Math.max(ref.outputUsdPerM / 1e6, (live?.outputUsdPerToken ?? 0) * BOOK_PRICE_MARGIN) };
}
