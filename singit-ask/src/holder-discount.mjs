import { isAddress } from "viem";

// SINGIT-holder discount on Base quotes. Payment stays USDC over x402; nothing is staked and no contract is called
// except the token's own `balanceOf`.
//
// A 402 is issued before any signature exists, so the payer is not known yet. The design:
//   1. An unpaid request may carry a payer hint: header `X-SingIt-Payer: 0x…` (or `?payer=0x…`). Only a valid Base
//      address counts; anything else is ignored and the full price is quoted.
//   2. If the hinted address qualifies, the Base `accepts[]` amounts are the discounted prices, never below cost.
//      Every Base offer also carries `extra.holderDiscount` with the tiers, so an agent can see how to qualify even
//      when it sent no hint.
//   3. The hint is never trusted. When a payment arrives, the price is asked for again and is computed for the
//      address that SIGNED it (`signedPayer`); the hint is only read for an unpaid request. Then the guard below
//      re-checks the payer before verification and after it (the facilitator's own `payer`). A payment that signed a
//      discounted amount for an address that does not qualify is refused before anything is charged; that payer
//      can ask again without a hint and pay the full price.
//   4. Qualification uses min(balance now, balance ~24 h ago): a flash loan or a just-bought position does not
//      count. Anything unknown (RPC error, no archive state for the old block, wrong chain, bad address, no client)
//      is "no discount". This module never throws to a caller on a lookup failure.
// Solana offers are never discounted.

export const BASE_NETWORK = "eip155:8453";
export const DEFAULT_SINGIT_TOKEN_ADDRESS = "0xc2c1e0b7C401e6217193732272444D928646eba3";  // same default as sign402-gateway's base_balances.py
export const SINGIT_DECIMALS = 18;
export const PAYER_HEADER = "X-SingIt-Payer";
export const PAYER_QUERY = "payer";
export const DEFAULT_TIERS = "20000000:500,50000000:1000,150000000:1500+daily";
export const DEFAULT_LOOKBACK_SECONDS = 86_400;
export const DEFAULT_CACHE_MS = 60_000;
const BPS = 10_000n;
const MAX_TIERS = 8;

const BALANCE_OF = [{ type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];

// "minWholeTokens:discountBps[+daily],…" -> tiers sorted by threshold. Throws on anything unreadable.
export function parseTiers(text) {
  const parts = String(text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_TIERS) throw new Error(`holder tiers: want 1 to ${MAX_TIERS} entries`);
  const tiers = parts.map((part) => {
    const m = /^([1-9][0-9]{0,17}):([1-9][0-9]{0,3})(\+daily)?$/.exec(part);
    if (!m || Number(m[2]) >= 10_000) throw new Error(`holder tiers: cannot read "${part}" (want minTokens:discountBps[+daily], bps 1 to 9999)`);
    return Object.freeze({ minTokens: BigInt(m[1]), discountBps: Number(m[2]), higherDailyLimit: m[3] === "+daily" });
  }).sort((a, b) => (a.minTokens < b.minTokens ? -1 : a.minTokens > b.minTokens ? 1 : 0));
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minTokens === tiers[i - 1].minTokens || tiers[i].discountBps < tiers[i - 1].discountBps)
      throw new Error("holder tiers: thresholds must be distinct and discounts must not shrink as the balance grows");
  }
  return Object.freeze(tiers);
}

const intEnv = (value, fallback, { min, max }) => {
  const n = Number(String(value ?? "").trim());
  return value !== undefined && String(value).trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// Env -> settings. A bad tier list is logged once and replaced by the documented defaults: a typo must not take the
// service down or turn into a 500 on a buyer's request.
export function loadHolderConfig(env = process.env, log = () => {}) {
  let tiers;
  try { tiers = parseTiers(String(env.SINGIT_ASK_HOLDER_TIERS ?? "").trim() || DEFAULT_TIERS); }
  catch (error) {
    try { log(`singit-ask: SINGIT_ASK_HOLDER_TIERS ignored, using the defaults (${error.message})`); } catch { /* logging must not break startup */ }
    tiers = parseTiers(DEFAULT_TIERS);
  }
  const token = [env.SINGIT_ASK_SINGIT_TOKEN_ADDRESS, env.SIGN402_SINGIT_TOKEN_ADDRESS]
    .map((v) => String(v ?? "").trim()).find((v) => v) ?? DEFAULT_SINGIT_TOKEN_ADDRESS;
  return { tiers, token: isAddress(token, { strict: false }) ? token : DEFAULT_SINGIT_TOKEN_ADDRESS,
    lookbackSeconds: intEnv(env.SINGIT_ASK_HOLDER_LOOKBACK_SECONDS, DEFAULT_LOOKBACK_SECONDS, { min: 3_600, max: 30 * 86_400 }),
    cacheMs: intEnv(env.SINGIT_ASK_HOLDER_CACHE_MS, DEFAULT_CACHE_MS, { min: 1_000, max: 3_600_000 }) };
}

// The price after `bps`, rounded down, and never below `floor` (provider cost plus the settlement fee) or above `list`.
export function applyDiscount(list, floor, bps) {
  const total = BigInt(list), low = BigInt(floor);
  if (!(bps > 0) || bps >= 10_000) return total;
  const discounted = (total * (BPS - BigInt(bps))) / BPS;
  const price = discounted > low ? discounted : low;
  return price < total ? price : total;
}

// A quoted total's cost floor when only the total is known (the chat ceilings): the provider cost it was built from
// plus the fee. total = P + ceil(P * markup) + fee, so floor((total - fee) / (1 + markup)) is P or a hair more;
// rounding toward a higher floor only ever gives the holder a smaller discount, never a below-cost price.
export function costFloorFromTotal(total, markupBps, feeAtomic) {
  const fee = BigInt(feeAtomic), t = BigInt(total);
  if (t <= fee) return t;
  return fee + ((t - fee) * BPS) / (BPS + BigInt(markupBps));
}

// Provider cost + fee of a priced item ({listAtomic|exaAtomic, feeAtomic}), as the routes' own price helpers return it.
export const floorOf = (priced) => BigInt(priced.listAtomic ?? priced.exaAtomic) + BigInt(priced.feeAtomic);

const decode = (header) => { try { return JSON.parse(Buffer.from(String(header), "base64").toString("utf8")); } catch { return null; } };
const validAddress = (value) => typeof value === "string" && isAddress(value, { strict: true });

// The address that signed a payment attempt, from its own payload (EIP-3009 `authorization` for exact, Permit2 for
// upto). The facilitator proves this address signed it, so it is the only one the price may follow once a payment
// is present. `{ present: true, from: null }`: a payment attempt this module cannot read (full price).
export function signedPayer(payload) {
  if (!payload || typeof payload !== "object") return { present: true, from: null };
  const inner = payload.payload;
  const from = inner?.permit2Authorization?.from ?? inner?.authorization?.from;
  const base = payload.accepted?.network === BASE_NETWORK;
  const amount = payload.accepted?.amount;
  return { present: true, from: base && validAddress(from) ? from : null,
    signedAtomic: base && typeof amount === "string" && /^[0-9]{1,30}$/.test(amount) ? BigInt(amount) : null };
}

export class HolderDiscount {
  constructor({ publicClient, config = loadHolderConfig(), now = Date.now, log = () => {}, timeoutMs = 2_500,
    failTtlMs = 30_000, blockTtlMs = 300_000, perMinute = 120, maxEntries = 1_000 }) {
    Object.assign(this, { publicClient, now, log, timeoutMs, failTtlMs, blockTtlMs, perMinute, maxEntries });
    this.tiers = config.tiers; this.token = config.token;
    this.lookbackSeconds = config.lookbackSeconds; this.cacheMs = config.cacheMs;
    this.cache = new Map();      // lowercase address -> { at, ttl, balance: bigint|null }
    this.inflight = new Map();
    this.fresh = [];             // times of fresh lookups in the last minute
    this.block = null;           // { at, number } the block ~lookback ago
    this.blockInflight = null;
    this.warned = false;
  }

  get enabled() {
    const id = this.publicClient?.chain?.id;
    return Boolean(this.publicClient) && (id === undefined || id === 8453);
  }

  // The tier reached by `balance` whole tokens (the last one that matches), or null.
  tierFor(wholeTokens) {
    let hit = null;
    for (const tier of this.tiers) if (wholeTokens >= tier.minTokens) hit = tier;
    return hit;
  }

  // Compact, agent-readable and free of addresses and of anything about our margin.
  extra(appliedBps = 0) {
    return { holderDiscount: { network: BASE_NETWORK, token: "SINGIT", header: PAYER_HEADER, query: PAYER_QUERY,
      lookbackSeconds: this.lookbackSeconds, appliedBps,
      tiers: this.tiers.map((t) => ({ minTokens: t.minTokens.toString(), discountBps: t.discountBps,
        ...(t.higherDailyLimit ? { higherDailyLimit: true } : {}) })) } };
  }

  async withTimeout(work) {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }

  // A block number about `lookbackSeconds` old, and a little older rather than younger. Base blocks are about 2 s
  // apart, so latest - lookback/2 is the estimate; one correction from that block's own timestamp follows.
  async pastBlock() {
    if (this.block && this.now() - this.block.at < this.blockTtlMs) return this.block.number;
    if (!this.blockInflight) {
      this.blockInflight = (async () => {
        const latest = await this.withTimeout(this.publicClient.getBlockNumber());
        let estimate = latest - BigInt(Math.round(this.lookbackSeconds / 2));
        if (estimate < 1n) throw new Error("chain too young");
        const target = Math.floor(this.now() / 1000) - this.lookbackSeconds;
        const sample = await this.withTimeout(this.publicClient.getBlock({ blockNumber: estimate }));
        const drift = Number(sample.timestamp) - target;   // > 0: the estimate is younger than wanted
        estimate -= BigInt(Math.round(drift / 2)) + 30n;   // 30 blocks (about a minute) of margin toward older
        if (estimate < 1n) throw new Error("chain too young");
        this.block = { at: this.now(), number: estimate };
        return estimate;
      })().finally(() => { this.blockInflight = null; });
    }
    return this.blockInflight;
  }

  async load(key) {
    let balance = null;
    try {
      const past = await this.pastBlock();
      const read = (extra) => this.withTimeout(this.publicClient.readContract({ address: this.token, abi: BALANCE_OF,
        functionName: "balanceOf", args: [key], ...extra }));
      const [current, old] = await Promise.all([read({ blockTag: "latest" }), read({ blockNumber: past })]);
      if (typeof current === "bigint" && typeof old === "bigint" && current >= 0n && old >= 0n)
        balance = current < old ? current : old;   // the flash-loan guard
    } catch {
      if (!this.warned) { this.warned = true; try { this.log("singit-ask: holder discount lookup failing; quoting full price"); } catch { /* ok */ } }
    }
    this.cache.set(key, { at: this.now(), ttl: balance === null ? this.failTtlMs : this.cacheMs, balance });
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    return balance;
  }

  // min(now, ~24 h ago) in token base units, or null when unknown. Never throws.
  async effectiveBalance(address) {
    try {
      if (!this.enabled || !validAddress(address)) return null;
      const key = address.toLowerCase();
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < hit.ttl) return hit.balance;
      if (this.inflight.has(key)) return await this.inflight.get(key);
      const nowMs = this.now();
      this.fresh = this.fresh.filter((t) => nowMs - t < 60_000);
      if (this.fresh.length >= this.perMinute) return null;   // a hint header must not spend our RPC budget
      this.fresh.push(nowMs);
      const pending = this.load(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
      return await pending;
    } catch { return null; }
  }

  // The tier an address qualifies for right now (null: none, or unknown).
  async tierOf(address) {
    const balance = await this.effectiveBalance(address);
    return balance === null ? null : this.tierFor(balance / 10n ** BigInt(SINGIT_DECIMALS));
  }

  async bpsFor(address) { return (await this.tierOf(address))?.discountBps ?? 0; }

  // Whom a request's price follows: the signer if a payment is attached, else the (validated) hint.
  payerOf(ctx) {
    try {
      const adapter = ctx?.adapter;
      const header = adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment");
      if (header) return signedPayer(decode(header));
      const queried = adapter.getQueryParam?.(PAYER_QUERY);
      const hint = adapter.getHeader(PAYER_HEADER.toLowerCase()) ?? adapter.getHeader(PAYER_HEADER) ?? (Array.isArray(queried) ? queried[0] : queried);
      return { present: false, from: validAddress(hint) ? hint : null, signedAtomic: null };
    } catch { return { present: true, from: null, signedAtomic: null }; }
  }

  // The Base amount and extra for one offer. `total` is the list price, `floor` the cost floor. Full price on any doubt.
  async quote(ctx, total, floor) {
    const list = BigInt(total);
    try {
      const payer = this.payerOf(ctx);
      const bps = payer.from ? await this.bpsFor(payer.from) : 0;
      let amount = applyDiscount(list, floor, bps);
      // A signer who paid more than their discounted price (up to list) is not turned away for it.
      if (payer.present && payer.signedAtomic !== null && payer.signedAtomic > amount && payer.signedAtomic <= list) amount = payer.signedAtomic;
      return { amount: amount.toString(), extra: this.extra(amount < list ? bps : 0) };
    } catch { return { amount: list.toString(), extra: this.extra(0) }; }
  }

  // Verification hooks. Hooks that throw are ignored by the x402 core, so these catch everything and refuse.
  attach(server, { log = () => {} } = {}) {
    const refuse = { abort: true, reason: "holder_discount_not_eligible",
      message: `The paying address does not qualify for the quoted lower price. Nothing was charged. Ask for a new quote without ${PAYER_HEADER} and pay the full price.` };
    const appliedOf = (requirements) => (requirements?.network === BASE_NETWORK ? Number(requirements.extra?.holderDiscount?.appliedBps ?? 0) : 0);
    const check = async (applied, address) => {
      try { return applied <= (await this.bpsFor(address)); } catch { return false; }
    };
    server.onBeforeVerify(async (ctx) => {
      const applied = appliedOf(ctx.requirements);
      if (!(applied > 0)) return;
      const { from } = signedPayer(ctx.paymentPayload);
      if (!from || !(await check(applied, from))) {
        try { log("singit-ask: holder discount refused before verify"); } catch { /* ok */ }
        return refuse;
      }
    });
    server.onAfterVerify(async (ctx) => {
      const applied = appliedOf(ctx.requirements);
      if (!(applied > 0) || ctx.result?.isValid === false) return;
      // The facilitator's own answer to who paid decides; it must be the signer and must still qualify.
      const payer = ctx.result?.payer, { from } = signedPayer(ctx.paymentPayload);
      if (!validAddress(payer) || !from || payer.toLowerCase() !== from.toLowerCase() || !(await check(applied, payer))) {
        try { log("singit-ask: holder discount refused after verify"); } catch { /* ok */ }
        return refuse;
      }
      try {
        const req = ctx.transportContext?.request?.adapter?.req;
        if (req) { req.singitHolderBps = applied; req.singitSignedAtomic = String(ctx.requirements.amount); }
      } catch { /* ok */ }
    });
  }
}

export function createHolderDiscount({ publicClient, env = process.env, log = () => {}, ...rest } = {}) {
  return publicClient ? new HolderDiscount({ publicClient, config: loadHolderConfig(env, log), log, ...rest }) : null;
}

// Route helpers: the holder-aware Base price object, and the billing a holder's receipt shows.
export async function holderBasePrice(config, ctx, total, floor, base = {}) {
  const holder = config?.holderDiscount;
  if (!holder?.enabled) return { amount: String(total), extra: base };
  const { amount, extra } = await holder.quote(ctx, total, floor);
  return { amount, extra: { ...base, ...extra } };
}

// A priced item's billing for the request that paid it: on a discounted Base payment the total is what was signed.
export function holderBilling(billing, req) {
  const bps = req?.singitHolderBps;
  if (!(bps > 0) || req.singitSignedAtomic === undefined) return billing;
  return { ...billing, totalAtomic: String(req.singitSignedAtomic), holderDiscountBps: bps };
}
