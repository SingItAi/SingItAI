#!/usr/bin/env node
// A daily, free comparison of what SingIt asks for one short chat answer against what BlockRun asks for the same
// model, read from each side's own unpaid x402 402 response (the `accepts` of its payment challenge).
//
// It sends ONE unpaid POST per model per side: no payment header, no signature, no key, no wallet. A 402 costs
// nobody anything. Only two hosts are ever contacted (ask.singitai.app, blockrun.ai); see the flags below for tests.
//
//   node scripts/compare-402-blockrun.mjs                          # JSON report on stdout, exit 2 if we cost more
//   node scripts/compare-402-blockrun.mjs --append compare.jsonl   # also append one line per run (a daily history)
//   node scripts/compare-402-blockrun.mjs --tolerance 0.02         # alert only when we are >2% above BlockRun
//   node scripts/compare-402-blockrun.mjs --max-tokens 500
//
// What is compared, per model: the cheapest Base (eip155:8453) offer on each side. SingIt's cheapest is its `upto`
// ceiling (settled for the actual usage, so what a customer really pays is less); BlockRun's `exact` price is what it
// charges. `exactVsExact` also compares SingIt's flat `exact` offer with BlockRun's, because that is the like-for-like
// number for a client that cannot sign `upto`.
//
// Exit codes: 0 = no alert (a probe that failed is listed under `errors` and does not alert unless --strict);
// 2 = SingIt is more expensive than BlockRun (beyond --tolerance) for at least one model; 1 = usage error.
// A sample systemd user timer is in deploy/systemd/singit-compare-402.{service,timer}; nothing installs it.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BASE_NETWORK = "eip155:8453";
export const OURS_BASE = "https://ask.singitai.app";
export const THEIRS_BASE = "https://blockrun.ai";
export const ALLOWED_HOSTS = new Set(["ask.singitai.app", "blockrun.ai"]);
// [SingIt model id, BlockRun model id]. SingIt: POST /v1/chat/{id}; BlockRun: POST /api/v1/chat/completions {model}.
export const MODELS = [
  ["claude-opus-5.5", "anthropic/claude-opus-5.5"],
  ["claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"],
  ["gpt-5.5", "openai/gpt-5.5"],
  ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash"],
];
export const PROMPT = "Explain x402 in one short paragraph, please!!";

const decode = (value) => {
  if (!value) return null;
  for (const text of [() => Buffer.from(String(value), "base64").toString("utf8"), () => String(value)]) {
    try { return JSON.parse(text()); } catch { /* try the next form */ }
  }
  return null;
};

// The accepts of a 402, from the PAYMENT-REQUIRED header (v2) or X-PAYMENT-REQUIRED, falling back to the JSON body.
export function parseAccepts({ status, headers, body }) {
  if (status !== 402) return { error: `http_${status}` };
  const get = (name) => headers?.get?.(name) ?? null;
  const challenge = decode(get("payment-required") ?? get("x-payment-required")) ?? (body && typeof body === "object" ? body : null);
  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : null;
  if (!accepts) return { error: "no_accepts" };
  const offers = accepts
    .map((a) => ({ scheme: String(a.scheme), network: String(a.network), atomic: String(a.amount ?? a.maxAmountRequired ?? "") }))
    .filter((a) => /^[0-9]+$/.test(a.atomic));
  return offers.length ? { offers } : { error: "no_amounts" };
}

const cheapest = (offers, predicate = () => true) =>
  offers.filter((o) => o.network === BASE_NETWORK && predicate(o)).reduce((best, o) => (best === null || BigInt(o.atomic) < BigInt(best.atomic) ? o : best), null);

const usd = (atomic) => (atomic === null ? null : Number(atomic) / 1e6);

// One model: our offers against theirs. `tolerance` 0.02 means "alert only when we are more than 2% dearer".
export function compareModel(model, ours, theirs, { tolerance = 0 } = {}) {
  const row = { model, ours: ours.error ?? null, theirs: theirs.error ?? null };
  if (ours.error || theirs.error) return { ...row, verdict: "unknown", alert: false };
  const o = cheapest(ours.offers);
  const t = cheapest(theirs.offers);
  if (!o || !t) return { ...row, ours: o ? null : "no_base_offer", theirs: t ? null : "no_base_offer", verdict: "unknown", alert: false };
  const oExact = cheapest(ours.offers, (x) => x.scheme === "exact");
  const tExact = cheapest(theirs.offers, (x) => x.scheme === "exact");
  const ratio = (a, b) => (a && b ? Number(a.atomic) / Number(b.atomic) : null);
  const r = ratio(o, t);
  const alert = Number(o.atomic) > Number(t.atomic) * (1 + tolerance);
  return { ...row, oursCheapestUsd: usd(o.atomic), oursScheme: o.scheme, theirsCheapestUsd: usd(t.atomic), theirsScheme: t.scheme,
    ratio: Number(r.toFixed(4)), exactVsExact: oExact && tExact ? { oursUsd: usd(oExact.atomic), theirsUsd: usd(tExact.atomic), ratio: Number(ratio(oExact, tExact).toFixed(4)) } : null,
    verdict: Number(o.atomic) < Number(t.atomic) ? "cheaper" : Number(o.atomic) === Number(t.atomic) ? "same" : "dearer", alert };
}

export function summarise(rows, { at, maxTokens }) {
  const known = rows.filter((r) => r.verdict !== "unknown");
  return { at, maxTokens, prompt: PROMPT, network: BASE_NETWORK,
    alerts: rows.filter((r) => r.alert).map((r) => r.model),
    errors: rows.filter((r) => r.verdict === "unknown").map((r) => ({ model: r.model, ours: r.ours, theirs: r.theirs })),
    cheaper: known.filter((r) => r.verdict === "cheaper").length, dearer: known.filter((r) => r.verdict === "dearer").length, models: rows };
}

async function probe(fetchImpl, url, body) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) return { error: "host_not_allowed" };
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "singit-price-compare/1" },
      body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20_000) });
    let json = null;
    try { json = await response.json(); } catch { /* a 402 may carry only the header */ }
    return parseAccepts({ status: response.status, headers: response.headers, body: json });
  } catch (error) {
    return { error: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

export async function run({ fetchImpl = fetch, oursBase = OURS_BASE, theirsBase = THEIRS_BASE, maxTokens = 500, tolerance = 0, models = MODELS, now = () => new Date() } = {}) {
  const messages = [{ role: "user", content: PROMPT }];
  const rows = [];
  for (const [ours, theirs] of models) {
    const [a, b] = await Promise.all([
      probe(fetchImpl, `${oursBase}/v1/chat/${ours}`, { messages, max_tokens: maxTokens }),
      probe(fetchImpl, `${theirsBase}/api/v1/chat/completions`, { model: theirs, messages, max_tokens: maxTokens }),
    ]);
    rows.push(compareModel(ours, a, b, { tolerance }));
  }
  return summarise(rows, { at: now().toISOString(), maxTokens });
}

export function renderText(report) {
  const f = (v) => (v === null || v === undefined ? "—" : `$${v.toFixed(4)}`);
  const lines = [`SingIt vs BlockRun, unpaid 402s, ${report.network}, max_tokens ${report.maxTokens} (${report.at})`];
  for (const r of report.models) {
    lines.push(r.verdict === "unknown"
      ? `${r.model.padEnd(22)} unknown (ours: ${r.ours ?? "ok"}, theirs: ${r.theirs ?? "ok"})`
      : `${r.model.padEnd(22)} ours ${f(r.oursCheapestUsd)} (${r.oursScheme})  BlockRun ${f(r.theirsCheapestUsd)} (${r.theirsScheme})  ×${r.ratio}  ${r.verdict}${r.alert ? "  ← ALERT" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

const flag = (args, name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

async function main() {
  const args = process.argv.slice(2);
  const tolerance = Number(flag(args, "tolerance", "0"));
  const maxTokens = Number(flag(args, "max-tokens", "500"));
  if (!(tolerance >= 0 && tolerance < 10) || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    process.stderr.write("usage: compare-402-blockrun.mjs [--tolerance 0.02] [--max-tokens 500] [--append file.jsonl] [--json] [--strict]\n");
    process.exit(1);
  }
  const report = await run({ tolerance, maxTokens });
  const append = flag(args, "append", null);
  if (append) await appendFile(append, `${JSON.stringify(report)}\n`);
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  if (report.alerts.length || (args.includes("--strict") && report.errors.length)) process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
