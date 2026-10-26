// Simple, deterministic keyword extraction for the free get_price tool — not an LLM call, so the
// free actions work with zero model cost. Good enough for "price of BTC" / "EUR to USD" phrasing;
// an agent that wants richer extraction can replace this action with its own.
const METALS = new Set(["XAU", "XAG"]);
const KNOWN_SYMBOLS = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "BNB", "LTC", "AVAX", "DOT", "LINK", "XAU", "XAG"]);
// The gateway's fx lookup (/v1/prices/fx/{base}/{quote}) is fiat-only; crypto and metal tickers
// must go through the crypto/metal lookup even when phrased as a pair ("BTC/USD").
const FIAT = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "SGD", "SEK", "NOK", "DKK",
  "PLN", "CZK", "HUF", "RON", "TRY", "INR", "KRW", "MXN", "BRL", "ZAR", "THB", "IDR", "MYR", "PHP",
  "ILS", "AED", "SAR", "TWD", "CLP", "COP", "ARS", "UAH", "VND", "EGP", "NGN", "KES", "PKR", "BDT",
]);
const NAMES = {
  bitcoin: "BTC", ethereum: "ETH", ether: "ETH", solana: "SOL", ripple: "XRP", dogecoin: "DOGE",
  cardano: "ADA", litecoin: "LTC", gold: "XAU", silver: "XAG",
};
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "is", "in", "to", "what", "whats", "price", "worth", "how", "much",
  "quote", "me", "us", "and", "on", "at", "current", "today", "now", "please", "rate", "it", "its",
  "up", "doing", "tell", "give", "show", "get", "can", "you", "are", "do", "does", "my", "per", "one",
  "cost", "costs", "value", "of", "right", "check", "look", "s", "t", "re", "ll", "d", "ve", "m",
]);

export function extractPriceArgs(text = "") {
  for (const pair of text.matchAll(/\b([a-z]{3})\s*(?:\/|to)\s*([a-z]{3})\b/gi)) {
    const base = pair[1].toUpperCase();
    const quote = pair[2].toUpperCase();
    if (FIAT.has(base) && FIAT.has(quote)) return { kind: "fx", base, quote };
    const symbol = [base, quote].find(side => KNOWN_SYMBOLS.has(side))
      ?? (FIAT.has(quote) && !STOPWORDS.has(base.toLowerCase()) ? base : null)
      ?? (FIAT.has(base) && !STOPWORDS.has(quote.toLowerCase()) ? quote : null);
    if (symbol) return { kind: METALS.has(symbol) ? "metal" : "crypto", symbol };
  }

  // Drop contraction suffixes first ("What's" -> "What", "it’s" -> "it") so a stray "s" or "re"
  // fragment can never be picked up as a symbol.
  const words = (text.replace(/['’][A-Za-z]+/g, "").match(/[A-Za-z]+/g) ?? []).filter(word => !STOPWORDS.has(word.toLowerCase()));
  const known = words.find(word => KNOWN_SYMBOLS.has(word.toUpperCase()) || NAMES[word.toLowerCase()]);
  const ticker = words.find(word => /^[A-Z]{2,6}$/.test(word));
  const loose = words.find(word => word.length >= 2 && word.length <= 5);
  const chosen = known ?? ticker ?? loose;
  const symbol = chosen ? (NAMES[chosen.toLowerCase()] ?? chosen.toUpperCase()) : "BTC";
  return { kind: METALS.has(symbol) ? "metal" : "crypto", symbol };
}
