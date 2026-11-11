// Solana `exact`: the answer must come within a window of the payment's verification.
//
// On Solana `exact` the payer's transaction is verified before the model runs and settled after it. A transaction
// carries a recent blockhash that the chain accepts for about 150 blocks (roughly 60-90 s from when the payer fetched
// it), so a slow answer can outlive it: settlement then fails with BlockhashNotFound, nothing is charged, and the
// answer is thrown away. In the 24 hours to 8 November 2026 the production journal had 42 such refusals; 41 could be
// matched to their answers, and every one of those answers took more than 30 s (p50 41 s, max 79 s).
//
// The window was 20 s until 10 November 2026, when it clipped production tails: 14 of the 18 unanswered Solana paid
// chats that day were window cuts, two of them late at 20002 ms, while successful same-day Solana paid answers had a
// p95 of 16 s. 30 s recaptures the 20-30 s tail and still refuses the historically stale (>30 s) durations above.
//
// So the model gets SOLANA_EXACT_WINDOW_MS from the moment verification succeeded. An answer that is not complete by
// then is cut off and refused as 503 no_billable_answer before any settlement: nothing is charged and the payer can
// try again. When a paid or auto alternate is attached, the first model is cut off
// SOLANA_EXACT_FALLBACK_RESERVE_MS before the cutoff (default 10 s, leaving 20 s for the first model) so one
// in-window fallback can still run. A first model that would have used the whole window otherwise left no time for
// the alternate: 15 of 20 unanswered external Solana paid chats in the 7 days to 11 November 2026 were window cuts,
// including one at the 30 s cutoff after #279. This only narrows the risk: the payer's blockhash may already be old
// when it is verified, and without an RPC read the server cannot tell. Base and Solana `upto` (its escrow deposit
// settles before the model) are unchanged.
import { paymentFailureContext } from "./payment-failure-hooks.mjs";

export const SOLANA_EXACT_WINDOW_MS = 30_000;
// Time left in the window for one paid/auto fallback after a slow first model. 10 s is above the recent Solana paid
// p50 (~6 s) and keeps a 20 s first-model slice, the window that was already in production until 10 November.
export const SOLANA_EXACT_FALLBACK_RESERVE_MS = 10_000;
export const SOLANA_EXACT_MIN_PRIMARY_MS = 8_000;

// How many milliseconds to hold back from the first model so a fallback can still finish inside `remaining`.
// Zero when there is no alternate, the reserve is disabled, or the window is too short to split.
export function fallbackReserveMs(config = {}, remaining, hasAlternate) {
  if (!hasAlternate || !Number.isFinite(remaining) || remaining <= 0) return 0;
  const reserve = Number.isSafeInteger(config.solanaExactFallbackReserveMs) && config.solanaExactFallbackReserveMs >= 0
    ? config.solanaExactFallbackReserveMs : SOLANA_EXACT_FALLBACK_RESERVE_MS;
  if (reserve <= 0) return 0;
  const minPrimary = Math.min(SOLANA_EXACT_MIN_PRIMARY_MS, Math.max(1, Math.floor(remaining / 2)));
  if (remaining <= reserve + minPrimary) return 0;
  return reserve;
}

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
