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
    this.full = false;
    if (file) try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* record() reports it once */ }
  }

  // `entry`: { route, model, scheme, network, maxTokens, usage, billing }. Never throws: a log must not cost an answer.
  record({ route, model, scheme, network, maxTokens, usage, billing } = {}) {
    if (!this.file || this.full) return false;
    try {
      const hour = new Date(Math.floor(this.now() / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ":00Z";
      const line = { hour, route: word(route), model: word(model), scheme: word(scheme), network: word(network), maxTokens: int(maxTokens),
        ...tokensOf(usage), upstreamMicro: int(billing?.providerCostAtomic ?? usage?.buyer_cost_micro),
        billedAtomic: int(billing?.totalAtomic), ceilingAtomic: int(billing?.maxChargeAtomic), overrunAtomic: int(billing?.overrunAtomic) ?? 0 };
      const text = `${JSON.stringify(line)}\n`;
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch { /* a new file */ }
      if (size + text.length > this.maxBytes) {
        this.full = true;
        this.log(`singit-ask: answer log full (${this.maxBytes} bytes), no more answers are recorded`);
        return false;
      }
      fs.appendFileSync(this.file, text, { mode: 0o600 });
      return true;
    } catch (error) {
      this.log(`singit-ask: answer log write failed (${error.code ?? error.name})`);
      return false;
    }
  }
}

const logs = new Map();
// One AnswerLog per file, shared by every route that is given the same config.
export function answerLogFor(config, log) {
  const file = config?.answerLogFile;
  if (!file) return null;
  if (!logs.has(file)) logs.set(file, new AnswerLog({ file, log }));
  return logs.get(file);
}
