// Simple, deterministic keyword extraction for the free get_price tool — not an LLM call, so the
// free actions work with zero model cost. Good enough for "price of BTC" / "EUR to USD" phrasing;
// an agent that wants richer extraction can replace this action with its own.
const METALS = new Set(["XAU", "XAG"]);
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "is", "in", "to", "what", "whats", "price", "worth",
  "quote", "me", "us", "and", "on", "at", "current", "today", "now", "please", "rate",
]);

export function extractPriceArgs(text = "") {
  const fx = /\b([a-z]{3})\s*(?:\/|to)\s*([a-z]{3})\b/i.exec(text);
  if (fx) return { kind: "fx", base: fx[1].toUpperCase(), quote: fx[2].toUpperCase() };

  const candidates = (text.match(/[A-Za-z]{2,6}/g) ?? []).filter(word => !STOPWORDS.has(word.toLowerCase()));
  const symbol = (candidates[0] ?? "BTC").toUpperCase();
  return { kind: METALS.has(symbol) ? "metal" : "crypto", symbol };
}
