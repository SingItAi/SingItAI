// Free answers, to try SingIt Ask before paying: a model asked for as "free/<id>" answers with no payment, within
// small limits per visitor and per day. Anything else on the route is paid as before, so an unpaid question without
// the prefix still gets the 402 offer that directories and paying agents expect.
//
// The limits bound what free answers can cost this service: short questions and answers, a few a day per visitor,
// a ceiling for everyone together, a few at a time. Counters live in memory and start again on a restart; that
// can give out at most one more day's allowance, which the daily ceiling keeps small.

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

// The free models and limits from configuration; none when the list is empty.
export function freeTerms(config) {
  const models = (config.freeModels ?? []).filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
  return { ...FREE_DEFAULTS, ...(config.freeLimits ?? {}), models };
}

export class FreeAllowance {
  constructor(terms, now = Date.now) {
    Object.assign(this, { terms, now, day: dayOf(now()), total: 0, visitors: new Map(), running: 0 });
  }

  #roll() {
    const today = dayOf(this.now());
    if (today !== this.day) Object.assign(this, { day: today, total: 0, visitors: new Map() });
  }

  // One free answer for this visitor, or the reason there is none now.
  take(visitor) {
    this.#roll();
    const used = this.visitors.get(visitor) ?? 0;
    if (used >= this.terms.perVisitorPerDay) return { ok: false, reason: "visitor" };
    if (this.total >= this.terms.perDay) return { ok: false, reason: "day" };
    if (this.running >= this.terms.concurrent) return { ok: false, reason: "busy" };
    this.visitors.set(visitor, used + 1);
    this.total += 1;
    this.running += 1;
    return { ok: true, left: this.terms.perVisitorPerDay - used - 1 };
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
export const visitorOf = (req) => req.get("cf-connecting-ip") || req.ip || "unknown";

const REFUSALS = {
  visitor: "That is today's free answers from this address. Pay per answer instead: drop the free/ prefix "
    + "(x402, USDC on Base or Solana), or come back tomorrow (UTC).",
  day: "Today's free answers are used up. Pay per answer instead: drop the free/ prefix "
    + "(x402, USDC on Base or Solana), or come back tomorrow (UTC).",
  busy: "Free answers are busy right now. Try again in a few seconds, or pay per answer: drop the free/ prefix.",
};

// The free route goes in front of the paid one: it answers "free/" questions and passes everything else on.
export function addFreeRoute(app, route, { config, terms, allowance = new FreeAllowance(terms), readRequest,
                                            RequestError, upstream, fetchImpl, log }) {
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
    const visitor = visitorOf(req);
    const turn = allowance.take(visitor);
    if (!turn.ok) {
      res.set("Retry-After", String(turn.reason === "busy" ? 5 : allowance.secondsToReset()));
      return res.status(429).json({ error: { message: REFUSALS[turn.reason], type: "rate_limit_error" } });
    }
    const started = Date.now();
    try {
      const answer = await upstream(config, input.messages, Math.min(input.maxTokens, terms.maxTokens), fetchImpl, model);
      log(`singit-ask: free answer in ${Date.now() - started} ms`);
      res.set({ "X-SingIt-Free": "true", "X-SingIt-Free-Remaining": String(turn.left) });
      res.json({ id: `singit-ask-free-${started}`, object: "chat.completion", created: Math.floor(started / 1000),
        model: asked, choices: [{ index: 0, message: { role: "assistant", content: answer.content },
          finish_reason: answer.finishReason }], usage: answer.usage, billing: { free: true } });
    } catch (error) {
      allowance.giveBack(visitor);
      log(`singit-ask: no free answer after ${Date.now() - started} ms (${error.name})`);
      res.status(502).json({ error: { message: "No answer came back. Try again.", type: "upstream_error" } });
    } finally {
      allowance.done();
    }
  });
}
