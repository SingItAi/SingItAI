// The cheapest qualifying share of list price per model (catalogue.mjs's `guardShares`) is replaced only at the end
// of a full pass over the order books, about two minutes. Held in memory alone, every restart quoted at list price
// until that pass ended, and `exact` is charged in full: measured on 6 November, claude-opus-5.5 at max_tokens 200
// went from 1897 to 3893 micro-USDC on Base for 1m49s after a restart, and back to exactly 1897.
//
// So the last pass is kept here, and read back at start. What it may cost if the market has moved since:
// - dearer: a share that is too low goes out with its X-Min-Discount floor, the same as a share just read, so
//   Surplus refuses before any answer and nothing is settled (metered.mjs's "no billable answer").
// - cheaper: a share that is too high is still at most 1, so the quote is never above what list price would be.
// A share is only a number the header already has to make true, so a wrong one can refuse an answer, not overcharge.
// Each share keeps the time its own book was read, not the time of the pass that carried it over: an unreadable
// book cannot keep an old share looking new across restarts. Old, corrupt or missing data means list price (share
// 1, no header), the behaviour without this file.
import { readFileSync, statSync } from "node:fs";
import { validId, writeSuspensions } from "./suspensions.mjs";

// A healthy file is at most about 20 minutes old: a pass is due every 10 minutes, checked every 5, and takes 2.
export const GUARD_SHARES_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_BYTES = 2_000_000;

const usable = (id, entry, now, maxAgeMs) => validId(id)
  && typeof entry?.share === "number" && entry.share >= 0 && entry.share <= 1
  && typeof entry.readAt === "number" && entry.readAt <= now && now - entry.readAt <= maxAgeMs;

// { id: { share, readAt } } as a Map, only the entries that can still be believed; empty when the file cannot be.
export function readGuardShares(file, now, maxAgeMs = GUARD_SHARES_MAX_AGE_MS) {
  const shares = new Map();
  try {
    if (!file || statSync(file).size > MAX_BYTES) return shares;
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || Array.isArray(data) || typeof data !== "object") return shares;
    for (const [id, entry] of Object.entries(data))
      if (usable(id, entry, now, maxAgeMs)) shares.set(id, { share: entry.share, readAt: entry.readAt });
  } catch { /* no usable history: quote at list until the first pass */ }
  return shares;
}

// Atomic and private (0600 in a 0700 directory), and never throws: a price hint is not worth failing a pass for.
// A share with no known read time is left out.
export async function writeGuardShares(file, shares, readAt) {
  if (!file) return;
  await writeSuspensions(file, Object.fromEntries([...shares].filter(([id]) => readAt.has(id))
    .map(([id, share]) => [id, { share, readAt: readAt.get(id) }])));
}
