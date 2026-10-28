// An anonymous, per-answer record of what a paid answer really used: how many tokens came back against the max_tokens
// that was asked for, and what it cost. It exists to answer one question with data instead of guesses: how much of the
// output budget do real answers use (the p50/p90/p99 that decide an `exact` ceiling)?
//
// One JSON line per settled answer, appended to SINGIT_ASK_ANSWER_LOG (off when unset). Kept on purpose:
//   hour (UTC, rounded down), route, model, scheme, network, maxTokens, promptTokens, completionTokens,
//   reasoningTokens, upstreamMicro (what the model cost), billedAtomic (what was settled), ceilingAtomic, overrunAtomic.
// Never kept: the question, the answer, the payer, a transaction, a header, an IP, a timestamp finer than the hour.
// Every value is coerced to a number or a short token from a fixed alphabet, so nothing free-form can be written.
import fs from "node:fs";
import path from "node:path";

const MAX_PENDING = 200;  // appends waiting on a slow disk; beyond this a line is dropped rather than queued without bound

const MAX_BYTES = 50 * 1024 * 1024;   // one file never grows past this: logging stops rather than fill the disk
const WORD = /^[A-Za-z0-9._:/-]{1,80}$/;

const int = (value) => {
  const n = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const word = (value) => (typeof value === "string" && WORD.test(value) ? value : null);

// The three token counts from either usage shape (OpenAI-style prompt/completion, Anthropic-style input/output).
export function tokensOf(usage) {
  return {
    promptTokens: int(usage?.prompt_tokens ?? usage?.input_tokens),
    completionTokens: int(usage?.completion_tokens ?? usage?.output_tokens),
    reasoningTokens: int(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens),
  };
}

// The scheme and network the payer signed for; empty when the header is unreadable.
export function acceptedOf(req) {
  try {
    const accepted = JSON.parse(Buffer.from(req.get("payment-signature") ?? req.get("x-payment"), "base64").toString()).accepted ?? {};
    return { scheme: accepted.scheme, network: accepted.network };
  } catch { return {}; }
}

export class AnswerLog {
  constructor({ file = null, now = () => Date.now(), maxBytes = MAX_BYTES, log = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.maxBytes = maxBytes;
    this.log = log;
    this.warned = false;
    this.size = 0;       // what the file holds (re-read after a failed append: it may have been written in part)
    this.queued = 0;     // bytes waiting to be appended
    this.pending = 0;
    this.chain = Promise.resolve();
    if (file) try {
      fs.mkdirSync(path.dirname(file), { recursive: true });   // once, at start-up, never on the answer path
      try { this.size = fs.statSync(file).size; } catch { /* a new file */ }
    } catch { /* record() reports it once */ }
  }

  // `entry`: { route, model, scheme, network, maxTokens, usage, billing }. Never throws and never waits for the disk:
  // the line is queued and appended in order, so a slow or stalled disk cannot hold up an answer or its settlement.
  // Resolves nothing; `flush()` waits for the queue (tests, shutdown).
  record({ route, model, scheme, network, maxTokens, usage, billing } = {}) {
    if (!this.file) return false;
    try {
      const hour = new Date(Math.floor(this.now() / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ":00Z";
      const line = { hour, route: word(route), model: word(model), scheme: word(scheme), network: word(network), maxTokens: int(maxTokens),
        ...tokensOf(usage), upstreamMicro: int(billing?.providerCostAtomic ?? usage?.buyer_cost_micro),
        billedAtomic: int(billing?.totalAtomic), ceilingAtomic: int(billing?.maxChargeAtomic), overrunAtomic: int(billing?.overrunAtomic) ?? 0 };
      const text = `${JSON.stringify(line)}\n`;
      if (this.size + this.queued + text.length > this.maxBytes) {
        if (!this.warned) this.log(`singit-ask: answer log full (${this.maxBytes} bytes), answers are not recorded`);
        this.warned = true;
        return false;
      }
      if (this.pending >= MAX_PENDING) return false;
      this.queued += text.length;
      this.pending++;
      this.chain = this.chain
        .then(async () => {
          try {
            await fs.promises.appendFile(this.file, text, { mode: 0o600 });
            this.size += text.length;
          } catch (error) {
            this.log(`singit-ask: answer log write failed (${error.code ?? error.name})`);
            // A failed append may still have written part of the line: take the file's real size, not a guess.
            try { this.size = (await fs.promises.stat(this.file)).size; } catch { /* no file: nothing was written */ }
          }
        })
        .finally(() => { this.queued -= text.length; this.pending--; });
      return true;
    } catch (error) {
      this.log(`singit-ask: answer log failed (${error.code ?? error.name})`);
      return false;
    }
  }

  flush() { return this.chain; }
}

// Record once the payment has really settled. The x402 middleware sets PAYMENT-RESPONSE with the facilitator's
// result after settling: `success: true` and a transaction, or (failure) `success: false`. That moment does not depend
// on the client still being connected, unlike `finish`.
export function recordWhenSettled(res, log, entry) {
  if (!log) return;
  const setHeader = res.setHeader.bind(res);
  let done = false;
  res.setHeader = (name, value) => {
    if (!done && String(name).toLowerCase() === "payment-response") {
      try {
        const settlement = JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
        if (settlement?.success === true && settlement.transaction) { done = true; log.record(entry); }
      } catch { /* never into the answer */ }
    }
    return setHeader(name, value);
  };
}

const logs = new Map();
// One AnswerLog per file, shared by every route that is given the same config.
export function answerLogFor(config, log) {
  const file = config?.answerLogFile;
  if (!file) return null;
  if (!logs.has(file)) logs.set(file, new AnswerLog({ file, log }));
  return logs.get(file);
}
