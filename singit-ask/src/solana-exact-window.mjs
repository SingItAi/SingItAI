// Solana `exact`: the answer must come within a window of the payment's verification.
//
// On Solana `exact` the payer's transaction is verified before the model runs and settled after it. A transaction
// carries a recent blockhash that the chain accepts for about 150 blocks (roughly 60-90 s from when the payer fetched
// it), so a slow answer can outlive it: settlement then fails with BlockhashNotFound, nothing is charged, and the
// answer is thrown away. In the 24 hours to 8 November 2026 the production journal had 42 such refusals; 41 could be
// matched to their answers, and every one of those answers took more than 30 s (p50 41 s, max 79 s).
//
// So the model gets SOLANA_EXACT_WINDOW_MS from the moment verification succeeded. An answer that is not complete by
// then is cut off and refused as 503 no_billable_answer before any settlement: nothing is charged and the payer can
// try again. This only narrows the risk: the payer's blockhash may already be old when it is verified, and without an
// RPC read the server cannot tell. Base and Solana `upto` (its escrow deposit settles before the model) are unchanged.
import { paymentFailureContext } from "./payment-failure-hooks.mjs";

export const SOLANA_EXACT_WINDOW_MS = 20_000;
export const realClock = Object.freeze({ now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) });

export class WindowExceeded extends Error {
  constructor(phase) {
    super(`solana exact window ${phase}`);
    this.name = "WindowExceeded";
    this.code = "solana_exact_window";
    this.phase = phase;          // "unverified", "budget" (spent before the model), "timeout" or "late"
  }
}

const acceptedOf = req => {
  try { return JSON.parse(Buffer.from(req.get("payment-signature") ?? req.get("x-payment"), "base64").toString()).accepted ?? {}; }
  catch { return {}; }
};

// The window for this request, or null when it does not apply (not a Solana `exact` payment).
export function solanaExactWindow(req, config = {}) {
  const { network, scheme } = acceptedOf(req);
  if (scheme !== "exact" || typeof network !== "string" || !network.startsWith("solana:")) return null;
  const store = paymentFailureContext.getStore();
  const clock = store?.clock ?? realClock;
  const ms = Number.isSafeInteger(config.solanaExactWindowMs) && config.solanaExactWindowMs > 0
    ? config.solanaExactWindowMs : SOLANA_EXACT_WINDOW_MS;
  // Only a verification of this very payment that succeeded starts the window.
  const verified = store?.verified;
  const verifiedAt = verified && verified.network === network && verified.scheme === scheme ? verified.at : null;
  return { ms, clock, verifiedAt, cutoff: verifiedAt == null ? null : verifiedAt + ms };
}

// Runs `work(remainingMs)` inside the window. One gate decides the outcome: whichever of the answer and the cutoff
// comes first wins, and the other is ignored. An answer is accepted only if it completes strictly before the cutoff,
// read from the clock when it completes (a timer can fire late), so an answer at or after the cutoff never reaches
// settlement. Throws WindowExceeded when the window is missing, already spent or runs out.
export async function withinWindow(win, work) {
  if (win.cutoff == null) throw new WindowExceeded("unverified");
  const remaining = win.cutoff - win.clock.now();
  if (remaining <= 0) throw new WindowExceeded("budget");
  let decided = false, timer;
  const cutoff = new Promise((_, reject) => {
    timer = win.clock.setTimeout(() => { if (!decided) { decided = true; reject(new WindowExceeded("timeout")); } }, remaining);
  });
  const answer = Promise.resolve().then(() => work(remaining)).then(
    value => {
      if (decided) throw new WindowExceeded("late");
      decided = true;
      if (win.clock.now() >= win.cutoff) throw new WindowExceeded("late");   // completed at or after the cutoff
      return value;
    },
    error => {
      if (decided) throw new WindowExceeded("late");
      decided = true;
      if (win.clock.now() >= win.cutoff) throw new WindowExceeded("late");
      throw error;
    });
  answer.catch(() => {});
  try { return await Promise.race([answer, cutoff]); }
  finally { win.clock.clearTimeout(timer); }
}

// The refusal for a spent window: the existing no-charge 503, plus the machine code and this request's id.
export function windowRefusal(res, requestId) {
  res.set("Retry-After", "30");
  res.set("X-SingIt-Error", "no_billable_answer");
  res.set("Cache-Control", "no-store");
  return { request_id: requestId };
}
