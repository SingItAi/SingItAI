// Local spend ledger for `singit-cc stats`: totals per model and per UTC day, taken from the paid
// answer's billing.totalAtomic (micro-USDC). It never holds keys, prompts or answers.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionDir } from "@singitai/session-wallet";

export const ledgerPath = (env = process.env) => path.join(sessionDir(env), "cc-ledger.json");
const empty = () => ({ version: 1, calls: 0, totalAtomic: 0, byModel: {}, byDay: {} });
const DAYS_KEPT = 90;

export function readLedger(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(env), "utf8"));
    if (parsed?.version === 1 && parsed.byModel && parsed.byDay) return parsed;
  } catch { /* missing or unreadable: start over */ }
  return empty();
}

export function recordSpend({ model, totalAtomic, now = new Date() }, env = process.env) {
  if (typeof totalAtomic !== "string" || !/^\d{1,15}$/.test(totalAtomic)) return null;
  const atomic = Number(totalAtomic);
  const ledger = readLedger(env);
  const add = (bucket, key) => {
    const row = bucket[key] ??= { calls: 0, atomic: 0 };
    row.calls += 1;
    row.atomic += atomic;
  };
  ledger.calls += 1;
  ledger.totalAtomic += atomic;
  add(ledger.byModel, String(model ?? "unknown").slice(0, 120));
  add(ledger.byDay, now.toISOString().slice(0, 10));
  for (const day of Object.keys(ledger.byDay).sort().slice(0, -DAYS_KEPT)) delete ledger.byDay[day];
  const file = ledgerPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return ledger;
}

export function clearLedger(env = process.env) {
  rmSync(ledgerPath(env), { force: true });
}

export const usd = atomic => `$${(atomic / 1e6).toFixed(6)}`;
