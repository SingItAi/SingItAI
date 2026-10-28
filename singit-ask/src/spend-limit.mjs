// Spend limit and receipt, visible in the x402 exchange itself (plan item 3, 28.10.2026).
//
//  * An unpaid request that carries `X-SingIt-Limiter: 0x<AgentAllowance address>` gets what that limiter allows
//    right now, read from Base, in the 402: header `X-SingIt-Spend-Limit` (JSON) and the 402's JSON body
//    (`singitSpendLimit`, the body is otherwise `{}`). Each Base offer is marked as fitting the limiter or not, so an
//    agent learns "this will be refused" before it signs, and no attempt is wasted.
//  * Every answer that settled carries `X-SingIt-Receipt` (JSON): our reference, the transaction, network, payer and
//    the amount charged, next to the facilitator's own PAYMENT-RESPONSE.
//
// Nothing here moves money or changes a price, and nothing in x402's `extensions` is added: a client echoes the
// server's extensions into the signed payload, and an unknown key there is not ours to risk. The limiter address is
// supplied by the caller and is never logged or stored beyond a short in-memory cache.
import { parseAbi } from "viem";
import { SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";

export const LIMITER_HEADER = "x-singit-limiter";
export const LIMIT_HEADER = "X-SingIt-Spend-Limit";
export const RECEIPT_HEADER = "X-SingIt-Receipt";
export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const ABI = parseAbi([
  "function token() view returns (address)",
  "function paused() view returns (bool)",
  "function expiry() view returns (uint256)",
  "function dailyCap() view returns (uint256)",
  "function perPurchaseCap() view returns (uint256)",
  "function remainingToday() view returns (uint256)",
  "function allowanceLeft() view returns (uint256)",
]);
const FIELDS = ["token", "paused", "expiry", "dailyCap", "perPurchaseCap", "remainingToday", "allowanceLeft"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const min = (...values) => values.reduce((a, b) => (a < b ? a : b));

// Reads limiters on Base, a few seconds at a time: one read per address per `ttlMs`, one in flight per address, and
// a ceiling on fresh reads per minute so the header cannot be used to spend this service's RPC budget.
export class SpendLimitReader {
  constructor({ publicClient, now = Date.now, ttlMs = 15_000, failTtlMs = 60_000, perMinute = 60, timeoutMs = 2_500, maxEntries = 500 }) {
    Object.assign(this, { publicClient, now, ttlMs, failTtlMs, perMinute, timeoutMs, maxEntries });
    this.cache = new Map();     // lowercase address -> { at, ttl, value }
    this.inflight = new Map();
    this.fresh = [];            // timestamps of fresh reads in the last minute
  }

  // A cached read at most `maxAgeMs` old, or null. Never touches the network.
  peek(address, maxAgeMs = 60_000) {
    const hit = this.cache.get(String(address).toLowerCase());
    return hit && !hit.value.error && this.now() - hit.at <= maxAgeMs ? hit.value : null;
  }

  async read(address) {
    if (!ADDRESS.test(String(address ?? ""))) return { v: 1, error: "invalid_address" };
    const key = address.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < hit.ttl) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const nowMs = this.now();
    this.fresh = this.fresh.filter((t) => nowMs - t < 60_000);
    if (this.fresh.length >= this.perMinute) return { v: 1, limiter: key, error: "busy" };
    this.fresh.push(nowMs);
    const pending = this.load(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async load(key) {
    let value, timer;
    try {
      const results = await Promise.race([
        this.publicClient.multicall({ allowFailure: true,
          contracts: FIELDS.map((functionName) => ({ address: key, abi: ABI, functionName })) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs); }),
      ]);
      const got = Object.fromEntries(FIELDS.map((name, i) => [name, results[i]?.status === "success" ? results[i].result : undefined]));
      if (FIELDS.some((name) => got[name] === undefined)) value = { v: 1, limiter: key, error: "not_an_allowance_limiter" };
      else if (String(got.token).toLowerCase() !== BASE_USDC) value = { v: 1, limiter: key, error: "unsupported_token" };
      else value = describeLimiter(key, got, Math.floor(this.now() / 1000));
    } catch {
      value = { v: 1, limiter: key, error: "unreadable" };
    } finally { clearTimeout(timer); }
    const failed = Boolean(value.error);
    this.cache.set(key, { at: this.now(), ttl: failed ? this.failTtlMs : this.ttlMs, value });
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}

// What a limiter allows right now. `spendableNowAtomic` is the most one purchase can be: the smaller of the
// per-purchase cap, today's remainder and what the owner left approved on the token. (The owner's own USDC balance is
// not read, and the limiter's day rolls over at 00:00 UTC.)
export function describeLimiter(limiter, got, nowSeconds) {
  const expired = nowSeconds >= Number(got.expiry);
  const spendable = got.paused || expired ? 0n : min(got.perPurchaseCap, got.remainingToday, got.allowanceLeft);
  return { v: 1, limiter, network: BASE_NETWORK, asset: "USDC", asOf: new Date(nowSeconds * 1000).toISOString(),
    paused: Boolean(got.paused), expired, expiresAt: new Date(Number(got.expiry) * 1000).toISOString(),
    dailyCapAtomic: String(got.dailyCap), perPurchaseCapAtomic: String(got.perPurchaseCap),
    remainingTodayAtomic: String(got.remainingToday), allowanceLeftAtomic: String(got.allowanceLeft),
    spendableNowAtomic: String(spendable) };
}

// Each offer in a 402's `accepts`, against the limiter. Only Base is checked: a Solana offer is marked as not checked.
export function offersAgainstLimit(info, accepts = []) {
  if (info.error) return info;
  const spendable = BigInt(info.spendableNowAtomic);
  return { ...info, offers: accepts.map((offer) => {
    const base = { scheme: offer.scheme, network: offer.network, amountAtomic: String(offer.amount) };
    if (offer.network !== BASE_NETWORK) return { ...base, fits: null, reason: "not_checked" };
    if (info.paused) return { ...base, fits: false, reason: "limiter_paused" };
    if (info.expired) return { ...base, fits: false, reason: "limiter_expired" };
    if (BigInt(offer.amount) <= spendable) return { ...base, fits: true };
    const reason = BigInt(offer.amount) > BigInt(info.perPurchaseCapAtomic) ? "over_per_purchase_cap"
      : BigInt(offer.amount) > BigInt(info.remainingTodayAtomic) ? "over_remaining_today" : "over_allowance_left";
    return { ...base, fits: false, reason };
  }) };
}

const decodeHeader = (value) => { try { return JSON.parse(Buffer.from(String(value), "base64").toString("utf8")); } catch { return null; } };
const isPayment = (req) => Boolean(req.get("payment-signature") ?? req.get("x-payment"));

// Mounted once, before every paid route. It only wraps this response's `setHeader` and `json`; on any failure the
// response goes out as it would have without it.
export function spendLimitMiddleware({ reader = null, log = () => {} } = {}) {
  return async (req, res, next) => {
    const paid = isPayment(req);
    const limiterHeader = req.get(LIMITER_HEADER);
    let limit = null;                      // what to show in a 402
    let seen = null;                       // the accepted offers of this 402
    if (reader && limiterHeader && !paid && ["POST", "GET", "HEAD"].includes(req.method)) {
      try { limit = await reader.read(limiterHeader.trim()); } catch { limit = null; }
    }
    const peeked = reader && limiterHeader && paid && ADDRESS.test(limiterHeader.trim()) ? reader.peek(limiterHeader.trim()) : null;
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      const key = String(name).toLowerCase();
      try {
        if (key === "payment-required" && limit) {
          seen = decodeHeader(value)?.accepts ?? [];
          setHeader(LIMIT_HEADER, JSON.stringify(offersAgainstLimit(limit, seen)));
        } else if (key === SETTLEMENT_OVERRIDES_HEADER.toLowerCase() && paid) {
          // A route that settles actual usage (`upto`) says so through x402's own override header: that amount, not
          // the signed ceiling, is what the receipt reports as charged.
          const amount = JSON.parse(String(value)).amount;
          if (/^[0-9]+$/.test(String(amount ?? ""))) res.locals.singitSettledAmount = String(amount);
        } else if (key === "payment-response" && paid) {
          const receipt = receiptFor(req, res, decodeHeader(value), peeked);
          if (receipt) setHeader(RECEIPT_HEADER, JSON.stringify(receipt));
        }
      } catch (error) { log(`singit-ask: spend-limit header skipped (${error.name})`); }
      return setHeader(name, value);
    };
    if (limit) {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode === 402 && body && typeof body === "object" && !Array.isArray(body)) {
          try { body = { ...body, singitSpendLimit: offersAgainstLimit(limit, seen ?? []) }; } catch { /* keep the body */ }
        }
        return json(body);
      };
    }
    next();
  };
}

// The receipt for a settled answer. `res.locals.singitReceipt` is set by the route that knows what it billed.
export function receiptFor(req, res, settlement, peeked = null) {
  if (!settlement?.success || !settlement.transaction) return null;
  const accepted = decodeHeader(req.get("payment-signature") ?? req.get("x-payment"))?.accepted ?? {};
  const own = res.locals?.singitReceipt ?? {};
  const receipt = { v: 1, ref: own.ref ?? settlement.transaction, tx: settlement.transaction,
    network: settlement.network ?? accepted.network, scheme: accepted.scheme, payer: settlement.payer,
    asset: "USDC", chargedAtomic: String(own.chargedAtomic ?? res.locals?.singitSettledAmount ?? accepted.amount ?? ""), ceilingAtomic: String(accepted.amount ?? "") };
  if (peeked && !peeked.error) receipt.limit = { limiter: peeked.limiter, asOf: peeked.asOf,
    remainingTodayBeforeAtomic: peeked.remainingTodayAtomic, spendableNowBeforeAtomic: peeked.spendableNowAtomic };
  return receipt;
}
