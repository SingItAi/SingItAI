// Free prices for agents, no payment and no key, the way BlockRun offers theirs: a reason to come and find the rest.
//
//   GET /v1/prices                       what can be asked for
//   GET /v1/prices/crypto/{symbol}       55 cryptocurrencies in USD, from Chainlink on Base
//   GET /v1/prices/metal/{symbol}        gold (XAU) and silver (XAG) in USD, from Chainlink on Base
//   GET /v1/prices/fx/{base}/{quote}     30 currencies: Chainlink on Base where both sides have a feed, else the
//                                        European Central Bank's daily reference rates (via api.frankfurter.dev)
//
// Pyth's Hermes, which BlockRun's free prices come from, needs a paid key since October 2026. Chainlink's feeds are
// public on-chain data, read here in one multicall at most once a minute; the ECB's rates are public and change once
// a working day, read at most once an hour. Every answer says where it came from and how old it is.
import FEEDS from "./price-feeds.json" with { type: "json" };

export const PRICE_TERMS = Object.freeze({ chainlinkSeconds: 60, ecbSeconds: 3600, perVisitorPerMinute: 60, perMinute: 3000 });
const ECB_URL = "https://api.frankfurter.dev/v1/latest?base=USD";
const ROUND_ABI = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
  { type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }];
const CHAINLINK = "Chainlink Data Feeds on Base";
const ECB = "European Central Bank reference rates (api.frankfurter.dev)";

export class PriceBook {
  constructor({ publicClient, fetchImpl = fetch, now = Date.now, feeds = FEEDS.feeds }) {
    Object.assign(this, { publicClient, fetchImpl, now, feeds });
    this.chain = null; this.chainAt = 0; this.loadingChain = null;
    this.ecb = null; this.ecbAt = 0; this.loadingEcb = null;
  }

  // Every feed's latest round, in one multicall; one read in flight; a failed read keeps the last one.
  async chainlink() {
    if (!this.chain || this.now() - this.chainAt >= PRICE_TERMS.chainlinkSeconds * 1000) {
      this.loadingChain ??= (async () => {
        try {
          const entries = Object.entries(this.feeds);
          const results = await this.publicClient.multicall({ allowFailure: true,
            contracts: entries.map(([, f]) => ({ address: f.address, abi: ROUND_ABI, functionName: "latestRoundData" })) });
          const chain = new Map();
          results.forEach((r, i) => {
            const [symbol, feed] = entries[i];
            if (r.status !== "success" || r.result[1] <= 0n) return;
            chain.set(symbol, { price: Number(r.result[1]) / 10 ** feed.decimals, updatedAt: Number(r.result[3]), feed });
          });
          if (chain.size) { this.chain = chain; this.chainAt = this.now(); }
        } catch { /* keep the last prices */ }
        finally { this.loadingChain = null; }
      })();
      if (!this.chain) await this.loadingChain;
    }
    return this.chain ?? new Map();
  }

  async ecbRates() {
    if (!this.ecb || this.now() - this.ecbAt >= PRICE_TERMS.ecbSeconds * 1000) {
      this.loadingEcb ??= (async () => {
        try {
          const response = await this.fetchImpl(ECB_URL, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
          const data = response.ok ? await response.json() : null;
          if (data?.rates && typeof data.date === "string") {
            this.ecb = { date: data.date, perUsd: { USD: 1, ...Object.fromEntries(Object.entries(data.rates)
              .filter(([, v]) => typeof v === "number" && v > 0)) } };
            this.ecbAt = this.now();
          }
        } catch { /* keep the last rates */ }
        finally { this.loadingEcb = null; }
      })();
      if (!this.ecb) await this.loadingEcb;
    }
    return this.ecb;
  }

  // A crypto or metal price in USD, or null.
  async usd(kind, symbol) {
    const key = String(symbol ?? "").toUpperCase();
    const feed = this.feeds[key];
    if (!feed || feed.class !== kind) return null;
    const round = (await this.chainlink()).get(key);
    if (!round) return null;
    const age = Math.max(0, Math.floor(this.now() / 1000) - round.updatedAt);
    return { symbol: feed.symbol ?? key, name: feed.name, quote: "USD", price: round.price,
      updatedAt: new Date(round.updatedAt * 1000).toISOString(), ageSeconds: age, stale: age > feed.heartbeat * 1.5,
      source: CHAINLINK, feed: feed.address };
  }

  // How many `quote` one `base` buys, or null.
  async fx(base, quote) {
    const [b, q] = [String(base ?? "").toUpperCase(), String(quote ?? "").toUpperCase()];
    if (!/^[A-Z]{3}$/.test(b) || !/^[A-Z]{3}$/.test(q)) return null;
    const onChain = (code) => code === "USD" || this.feeds[code]?.class === "fiat";
    if (onChain(b) && onChain(q)) {
      const chain = await this.chainlink();
      const side = (code) => (code === "USD" ? { price: 1, updatedAt: Infinity } : chain.get(code));
      const [sb, sq] = [side(b), side(q)];
      if (sb && sq) {
        const updated = Math.min(sb.updatedAt, sq.updatedAt);
        return { base: b, quote: q, rate: sb.price / sq.price, source: CHAINLINK,
          updatedAt: Number.isFinite(updated) ? new Date(updated * 1000).toISOString() : null };
      }
    }
    const ecb = await this.ecbRates();
    if (!ecb || !ecb.perUsd[b] || !ecb.perUsd[q]) return null;
    return { base: b, quote: q, rate: ecb.perUsd[q] / ecb.perUsd[b], source: ECB, date: ecb.date };
  }

  async list() {
    const ecb = await this.ecbRates().catch(() => null);
    const by = (kind) => Object.entries(this.feeds).filter(([, f]) => f.class === kind).map(([k]) => k).sort();
    return { crypto: by("crypto"), metal: by("metal"), fx: Object.keys(ecb?.perUsd ?? {}).sort() };
  }
}

// Per visitor and in all, per minute: free, but not a firehose.
function limiter(now = Date.now) {
  let minute = 0, total = 0;
  const visitors = new Map();
  return (visitor) => {
    const m = Math.floor(now() / 60_000);
    if (m !== minute) { minute = m; total = 0; visitors.clear(); }
    const used = visitors.get(visitor) ?? 0;
    if (used >= PRICE_TERMS.perVisitorPerMinute || total >= PRICE_TERMS.perMinute) return false;
    visitors.set(visitor, used + 1); total += 1;
    return true;
  };
}

export function addPriceRoutes(app, { book, open, now = Date.now }) {
  const allow = limiter(now);
  const visitorOf = (req) => req.get("cf-connecting-ip") || req.ip || "unknown";
  const gate = (req, res, next) => {
    if (allow(visitorOf(req))) return next();
    res.set("Retry-After", "60").status(429).json({ error: { type: "rate_limit_error",
      message: `Free prices: up to ${PRICE_TERMS.perVisitorPerMinute} requests a minute. Try again in a minute.` } });
  };
  const missing = (res, what) => res.status(404).json({ error: { type: "invalid_request_error", code: "not_found",
    message: `${what} is not offered. See GET /v1/prices.` } });
  app.get("/v1/prices", open, gate, async (_req, res) => {
    res.json({ object: "prices", free: true, ...(await book.list()),
      sources: { crypto: CHAINLINK, metal: CHAINLINK, fx: `${CHAINLINK} where both currencies have a feed, else ${ECB}` },
      endpoints: ["/v1/prices/crypto/{symbol}", "/v1/prices/metal/{symbol}", "/v1/prices/fx/{base}/{quote}"] });
  });
  for (const kind of ["crypto", "metal"]) {
    app.get(`/v1/prices/${kind}/:symbol`, open, gate, async (req, res) => {
      const price = await book.usd(kind, req.params.symbol);
      return price ? res.json({ object: "price", ...price }) : missing(res, `${req.params.symbol} as ${kind}`);
    });
  }
  app.get("/v1/prices/fx/:base/:quote", open, gate, async (req, res) => {
    const rate = await book.fx(req.params.base, req.params.quote);
    return rate ? res.json({ object: "rate", ...rate }) : missing(res, `${req.params.base}/${req.params.quote}`);
  });
}
