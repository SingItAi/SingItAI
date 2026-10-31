// Free answers, to try SingIt Ask before paying: a model asked for as "free/<id>" answers with no payment, within
// small limits per visitor and per day. Anything else on the route is paid as before, so an unpaid question without
// the prefix still gets the 402 offer that directories and paying agents expect.
//
// Shared daily spend and answer counts persist; visitor networks remain in memory only.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { TERMS, billUsage, worstModelCostMicro } from "./pricing.mjs";

export const DEFAULT_FREE_MODELS = Object.freeze(["openai-gpt-oss-20b", "gemma-4-e2b", "gemma-3-27b-it", "mistral-small-3.2-24b-instruct", "qwen3-coder-30b-a3b-instruct", "deepseek-v4.1-flash"]);
export const DEFAULT_FREE_EXAMPLE = "deepseek-v4.1-flash";

export const FREE_PREFIX = "free/";

export const FREE_DEFAULTS = Object.freeze({
  budgetUsdPerDay: 0.25,
  perVisitorPerDay: 20,
  perDay: 1_000,
  concurrent: 4,
  maxTokens: 400,
  chars: 4_000,
});

const dayOf = (now) => Math.floor(now / 86_400_000);
const secondsToMidnight = (now) => Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);

// An empty model list disables free answers; a zero budget disables the dollar cap.
export function freeTerms(config) {
  const models = (config.freeModels ?? DEFAULT_FREE_MODELS).filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
  const budget = config.freeBudgetUsdPerDay;
  return { ...FREE_DEFAULTS, ...(config.freeLimits ?? {}), models,
    budgetUsdPerDay: Number.isFinite(budget) && budget >= 0 ? budget : FREE_DEFAULTS.budgetUsdPerDay,
    stateFile: config.freeStateFile };
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
  constructor(terms, now = Date.now, log = () => {}) {
    Object.assign(this, { terms, now, day: dayOf(now()), total: 0, spentMicro: 0, reservedMicro: 0, visitors: new Map(), running: 0, log: message => { try { log(message); } catch {} } });
    if (terms.stateFile) {
      try {
        const s = JSON.parse(readFileSync(terms.stateFile, "utf8"));
        if (s.version !== 1 || ![s.day, s.spentMicro, s.answers].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid");
        // Answers that were in flight when the process stopped may have been billed upstream: count their
        // reserved worst case as spent, so a crash can only make the cap stricter, never looser.
        const pending = s.pendingMicro === undefined ? 0 : s.pendingMicro;
        if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("invalid");
        if (s.day === this.day) Object.assign(this, { spentMicro: s.spentMicro + pending, total: s.answers });
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
          // An unreadable or invalid file cannot say what today's spend was: fail closed (today's budget is
          // treated as spent until midnight UTC) rather than hand out a second allowance.
          this.log("singit-ask: invalid free budget state; today's free budget is treated as spent");
          if (terms.budgetUsdPerDay > 0) this.spentMicro = Math.round(terms.budgetUsdPerDay * 1e6);
        }
      }
    }
  }

  #roll() {
    const today = dayOf(this.now());
    if (today !== this.day) Object.assign(this, { day: today, total: 0, spentMicro: 0, reservedMicro: 0, visitors: new Map() });
  }

  // One free answer for this visitor, or the reason there is none now.
  take(visitor, worstCost = 0) {
    this.#roll();
    const used = this.visitors.get(visitor) ?? 0;
    if (used >= this.terms.perVisitorPerDay) return { ok: false, reason: "visitor" };
    if (this.total >= this.terms.perDay) return { ok: false, reason: "day" };
    if (this.terms.budgetUsdPerDay > 0 && this.spentMicro + this.reservedMicro + worstCost > Math.round(this.terms.budgetUsdPerDay * 1e6)) return { ok: false, reason: "budget" };
    if (this.running >= this.terms.concurrent) return { ok: false, reason: "busy" };
    this.visitors.set(visitor, used + 1);
    this.total += 1;
    this.running += 1;
    this.reservedMicro += worstCost;
    this.save();
    return { ok: true, day: this.day, reserved: worstCost, left: this.terms.perVisitorPerDay - used - 1 };
  }

  save() {
    // In-flight reservations are saved as `pendingMicro` and counted as spent after a restart (see the constructor).
    if (!this.terms.stateFile) return;
    try {
      mkdirSync(dirname(this.terms.stateFile), { recursive: true });
      const tmp = `${this.terms.stateFile}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, day: this.day, spentMicro: this.spentMicro, answers: this.total, pendingMicro: this.reservedMicro }), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.terms.stateFile);
    } catch { if (!this.writeFailed) { this.writeFailed = true; this.log("singit-ask: free budget state write failed"); } }
  }

  spend(micro, turn = { reserved: 0, day: this.day }) {
    this.#roll();
    if (turn.day !== this.day) return;
    this.reservedMicro = Math.max(0, this.reservedMicro - turn.reserved);
    const before = this.spentMicro;
    this.spentMicro += Number(micro);
    const cap = this.terms.budgetUsdPerDay * 1e6;
    for (const percent of [50, 90, 100]) if (cap > 0 && before < cap * percent / 100 && this.spentMicro >= cap * percent / 100)
      this.log(`singit-ask: free budget used ${percent}%`);
    this.save();
  }

  done() { this.running = Math.max(0, this.running - 1); }

  // A free answer that did not come back is not counted against the visitor.
  giveBack(visitor, turn = { reserved: 0, day: this.day }) {
    this.#roll();
    if (turn.day !== this.day) return;
    this.reservedMicro = Math.max(0, this.reservedMicro - turn.reserved);
    const used = this.visitors.get(visitor) ?? 0;
    if (used > 0) this.visitors.set(visitor, used - 1);
    this.total = Math.max(0, this.total - 1);
    this.save();
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
  budget: "Today's free answers are used up (the shared daily free budget is spent). Free answers return after midnight UTC. Pay per answer instead: drop the free/ prefix "
    + "(x402, USDC on Base or Solana).",
  busy: "Free answers are busy right now. Try again in a few seconds, or pay per answer: drop the free/ prefix.",
};

// The free route goes in front of the paid one: it answers "free/" questions and passes everything else on.
export function addFreeRoute(app, route, { config, terms, allowance, readRequest,
                                            RequestError, upstream, catalogue = null, fetchImpl, log }) {
  allowance ??= new FreeAllowance(terms, Date.now, log);
  app.post(route, async (req, res, next) => {
    const asked = req.body?.model;
    if (typeof asked !== "string" || !asked.startsWith(FREE_PREFIX)) return next();
    const model = asked.slice(FREE_PREFIX.length);
    const refuse = (status, message) => res.status(status).json({ error: { message, type: "invalid_request_error", code: status >= 500 ? "upstream_unavailable" : "invalid_request" } });
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
    if (terms.budgetUsdPerDay > 0) {
      info = catalogue ? await catalogue.resolve(model).catch(() => null) : null;
      if (!info) return refuse(503, "Free answers are paused: this model's price is not known right now. Try again later, or pay per answer.");
    }
    const visitor = visitorOf(req);
    const maxTokens = Math.min(input.maxTokens, terms.maxTokens);
    const worstCost = terms.budgetUsdPerDay > 0 ? freeAnswerCost(null, info, input, maxTokens) : 0;
    if (!Number.isSafeInteger(worstCost) || worstCost < 0) return refuse(503, "Free answers are paused: price unknown.");
    const turn = allowance.take(visitor, worstCost);
    if (!turn.ok) {
      res.set("Retry-After", String(turn.reason === "busy" ? 5 : allowance.secondsToReset()));
      if (["visitor", "day"].includes(turn.reason)) res.set({ "X-RateLimit-Limit": String(terms.perVisitorPerDay),
        "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(allowance.now() / 1000) + allowance.secondsToReset()) });
      return res.status(429).json({ error: { message: REFUSALS[turn.reason], type: "rate_limit_error",
        code: turn.reason === "budget" ? "free_budget_exhausted" : turn.reason === "busy" ? "free_tier_busy" : "free_tier_exhausted" } });
    }
    const started = Date.now();
    try {
      const answer = await upstream(config, input.messages, maxTokens, fetchImpl, model);
      if (terms.budgetUsdPerDay > 0) allowance.spend(freeAnswerCost(answer.usage, info, input, maxTokens), turn);
      log(`singit-ask: free answer in ${Date.now() - started} ms`);
      res.set({ "X-SingIt-Free": "true", "X-SingIt-Free-Remaining": String(turn.left) });
      res.json({ id: `singit-ask-free-${started}`, object: "chat.completion", created: Math.floor(started / 1000),
        model: asked, choices: [{ index: 0, message: { role: "assistant", content: answer.content },
          finish_reason: answer.finishReason }], usage: answer.usage, billing: { free: true } });
    } catch (error) {
      allowance.giveBack(visitor, turn);
      log(`singit-ask: no free answer after ${Date.now() - started} ms (${error.name})`);
      res.set("Retry-After", "30").status(503).json({ error: { message: "No answer came back. Try again.", type: "upstream_error", code: "no_billable_answer" } });
    } finally {
      allowance.done();
    }
  });
}
