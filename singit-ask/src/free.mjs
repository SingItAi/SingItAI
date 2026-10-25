// Free answers, to try SingIt Ask before paying: a model asked for as "free/<id>" answers with no payment, within
// small limits per visitor and per day. Anything else on the route is paid as before, so an unpaid question without
// the prefix still gets the 402 offer that directories and paying agents expect.
//
// The limits bound what free answers can cost this service: short questions and answers, a few a day per visitor
// network, a ceiling for everyone together, optionally a budget in dollars, a few at a time. Counters live in
// memory and start again on a restart; that can give out at most one more day's allowance, which the daily
// ceiling keeps small. Free answers carry no wallet, so there is no per-wallet limit here: the network is the
// only identity they have.

import { isIP } from "node:net";
import { TERMS, billUsage, worstModelCostMicro } from "./pricing.mjs";

export const FREE_PREFIX = "free/";

export const FREE_DEFAULTS = Object.freeze({
  perVisitorPerDay: 20,
  perDay: 1_000,
  concurrent: 4,
  maxTokens: 400,
  chars: 4_000,
});

const dayOf = (now) => Math.floor(now / 86_400_000);
const secondsToMidnight = (now) => Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);

// The free models and limits from configuration; none when the list is empty. `budgetUsdPerDay` is absent unless
// configured: then no dollar budget is checked.
export function freeTerms(config) {
  const models = (config.freeModels ?? []).filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
  const budget = config.freeBudgetUsdPerDay;
  return { ...FREE_DEFAULTS, ...(config.freeLimits ?? {}), models,
    ...(Number.isFinite(budget) && budget > 0 ? { budgetUsdPerDay: budget } : {}) };
}

// The 8 sixteen-bit groups of an IPv6 address, or null. An IPv4 tail (::ffff:1.2.3.4) counts as two groups.
function ipv6Groups(address) {
  let text = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4) {
    const [a, b, c, d] = v4.split(".").map(Number);
    text = text.slice(0, -v4.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, ...extra] = text.split("::");
  if (extra.length) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < (tail === undefined ? 0 : 1)) return null;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

// The network an address is counted in: the IPv4 /24 or the IPv6 /64, so rotating addresses inside one subnet
// does not multiply the allowance. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) counts as that IPv4 address.
// Anything that is not an address stays as it is, which puts all such requests in one bucket.
export function networkOf(address) {
  const text = String(address ?? "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = isIP(text);
  if (kind === 4) return `${text.split(".").slice(0, 3).join(".")}.0/24`;
  const groups = kind === 6 ? ipv6Groups(text) : null;
  if (!groups) return text || "unknown";
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.0/24`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

export class FreeAllowance {
  constructor(terms, now = Date.now) {
    Object.assign(this, { terms, now, day: dayOf(now()), total: 0, spentMicro: 0, visitors: new Map(), running: 0 });
  }

  #roll() {
    const today = dayOf(this.now());
    if (today !== this.day) Object.assign(this, { day: today, total: 0, spentMicro: 0, visitors: new Map() });
  }

  // One free answer for this visitor, or the reason there is none now.
  take(visitor) {
    this.#roll();
    const used = this.visitors.get(visitor) ?? 0;
    if (used >= this.terms.perVisitorPerDay) return { ok: false, reason: "visitor" };
    if (this.total >= this.terms.perDay) return { ok: false, reason: "day" };
    if (this.budgetUsed()) return { ok: false, reason: "budget" };
    if (this.running >= this.terms.concurrent) return { ok: false, reason: "busy" };
    this.visitors.set(visitor, used + 1);
    this.total += 1;
    this.running += 1;
    return { ok: true, left: this.terms.perVisitorPerDay - used - 1 };
  }

  // Whether the day's dollar budget, when there is one, is spent.
  budgetUsed() {
    const budget = this.terms.budgetUsdPerDay;
    return budget !== undefined && this.spentMicro >= Math.round(budget * 1e6);
  }

  // What one answer cost, in USDC micro-units, counted toward the day's budget.
  spend(micro) {
    this.#roll();
    this.spentMicro += Number(micro);
  }

  done() { this.running = Math.max(0, this.running - 1); }

  // A free answer that did not come back is not counted against the visitor.
  giveBack(visitor) {
    this.#roll();
    const used = this.visitors.get(visitor) ?? 0;
    if (used > 0) this.visitors.set(visitor, used - 1);
    this.total = Math.max(0, this.total - 1);
  }

  secondsToReset() { return secondsToMidnight(this.now()); }
}

// The visitor a free answer is counted against. The service listens on loopback behind the Cloudflare tunnel, and
// Cloudflare sets CF-Connecting-IP to the client's address itself, overwriting any the client sent.
// It is counted by network (networkOf), not by address.
export const visitorOf = (req) => networkOf(req.get("cf-connecting-ip") || req.ip);

// What a free answer cost the service, in USDC micro-units, with no markup and no fee: the cost Surplus reports
// for it, validated as the paid path validates it (billUsage). Without a usable report, the most this question
// could have cost at the model's list price (worstModelCostMicro, input at one token per character: the loosest bound, so dense text such as CJK
// can never be under-counted against the budget; Codex review). Null when even that is unknown.
const AT_COST = Object.freeze({ ...TERMS, markupBps: 0, settlementFeeAtomic: "0", maxChargeAtomic: String(Number.MAX_SAFE_INTEGER) });
export function freeAnswerCost(usage, info, input, maxTokens) {
  try {
    return Number(billUsage(usage, AT_COST).providerCostAtomic);
  } catch { /* no usable report: price the worst case */ }
  if (!info) return null;
  return worstModelCostMicro(info, { chars: input.chars, maxTokens, messageCount: input.messages.length, charsPerToken: 1 });
}

const REFUSALS = {
  visitor: "That is today's free answers from this network. Pay per answer instead: drop the free/ prefix "
    + "(x402, USDC on Base or Solana), or come back tomorrow (UTC).",
  day: "Today's free answers are used up. Pay per answer instead: drop the free/ prefix "
    + "(x402, USDC on Base or Solana), or come back tomorrow (UTC).",
  budget: "Today's free answers are used up. Pay per answer instead: drop the free/ prefix "
    + "(x402, USDC on Base or Solana), or come back tomorrow (UTC).",
  busy: "Free answers are busy right now. Try again in a few seconds, or pay per answer: drop the free/ prefix.",
};

// The free route goes in front of the paid one: it answers "free/" questions and passes everything else on.
export function addFreeRoute(app, route, { config, terms, allowance = new FreeAllowance(terms), readRequest,
                                            RequestError, upstream, catalogue = null, fetchImpl, log }) {
  app.post(route, async (req, res, next) => {
    const asked = req.body?.model;
    if (typeof asked !== "string" || !asked.startsWith(FREE_PREFIX)) return next();
    const model = asked.slice(FREE_PREFIX.length);
    const refuse = (status, message) => res.status(status).json({ error: { message, type: "invalid_request_error" } });
    if (!terms.models.includes(model)) {
      return refuse(400, terms.models.length
        ? `Free answers come from ${terms.models.map((m) => FREE_PREFIX + m).join(", ")}.`
        : "Free answers are not offered here.");
    }
    let input;
    try {
      input = readRequest({ ...req.body, model: undefined });
    } catch (error) {
      if (error instanceof RequestError) return refuse(error.status, error.message);
      throw error;
    }
    if (input.chars > terms.chars) return refuse(400, `Keep a free question under ${terms.chars} characters.`);
    // With a budget, the model's price must be known before anything is spent: it prices an answer whose cost
    // is not reported. Unknown, nothing is spent.
    let info = null;
    if (terms.budgetUsdPerDay !== undefined) {
      info = catalogue ? await catalogue.resolve(model).catch(() => null) : null;
      if (!info) return refuse(503, "Free answers are paused: this model's price is not known right now. Try again later, or pay per answer.");
    }
    const visitor = visitorOf(req);
    const turn = allowance.take(visitor);
    if (!turn.ok) {
      res.set("Retry-After", String(turn.reason === "busy" ? 5 : allowance.secondsToReset()));
      return res.status(429).json({ error: { message: REFUSALS[turn.reason], type: "rate_limit_error" } });
    }
    const started = Date.now();
    try {
      const maxTokens = Math.min(input.maxTokens, terms.maxTokens);
      const answer = await upstream(config, input.messages, maxTokens, fetchImpl, model);
      if (terms.budgetUsdPerDay !== undefined) allowance.spend(freeAnswerCost(answer.usage, info, input, maxTokens));
      log(`singit-ask: free answer in ${Date.now() - started} ms`);
      res.set({ "X-SingIt-Free": "true", "X-SingIt-Free-Remaining": String(turn.left) });
      res.json({ id: `singit-ask-free-${started}`, object: "chat.completion", created: Math.floor(started / 1000),
        model: asked, choices: [{ index: 0, message: { role: "assistant", content: answer.content },
          finish_reason: answer.finishReason }], usage: answer.usage, billing: { free: true } });
    } catch (error) {
      allowance.giveBack(visitor);
      log(`singit-ask: no free answer after ${Date.now() - started} ms (${error.name})`);
      res.set("Retry-After", "30").status(503).json({ error: { message: "No answer came back. Try again.", type: "upstream_error" } });
    } finally {
      allowance.done();
    }
  });
}
