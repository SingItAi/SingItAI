#!/usr/bin/env node
// A static snapshot of BlockRun's paid chat-model prices, for the website's /pricing/ comparison page
// (website/pricing/, website/pricing.mjs). Committed to website/data/blockrun-prices.json and refreshed by
// re-running this script: the browser cannot call blockrun.ai directly for a live comparison (no CORS promise
// from them, and no reason to trust a client-side proxy), so SingIt's side of the page reads its own live
// /pricing.json at request time while BlockRun's side reads this committed file.
//
// BlockRun bills a paid chat answer at provider cost — GET /api/v1/models' pricing.input/output, USD per
// million tokens — plus a flat settlement fee. That fee is not in /api/v1/models; it is pinned below from
// BlockRun's own published API pricing (checked 2026-10-24: $0.001 per request for chat), not fetched, since
// no endpoint in /api/v1/models exposes it.
//
//   node scripts/blockrun-prices-snapshot.mjs
//   node scripts/blockrun-prices-snapshot.mjs --input /path/to/already-fetched-models.json --fetched-at 2026-10-24T15:07:00Z
//   node scripts/blockrun-prices-snapshot.mjs --out website/data/blockrun-prices.json

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODELS_URL = "https://blockrun.ai/api/v1/models";
export const TRANSACTION_FEE_USD = 0.001; // BlockRun's published flat per-request fee for paid chat models

// "Paid chat models": billed per token (not per image/second/character/...), actually orderable right now.
export function parseChatModels(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((m) => m && m.billing_mode === "paid" && Array.isArray(m.categories) && m.categories.includes("chat")
      && m.available !== false && m.pricing && Number.isFinite(m.pricing.input) && Number.isFinite(m.pricing.output))
    .map((m) => ({ id: String(m.id), name: String(m.name || m.id),
      inputUsdPerMillion: Number(m.pricing.input), outputUsdPerMillion: Number(m.pricing.output) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildSnapshot(body, { fetchedAt, source = MODELS_URL, transactionFeeUsd = TRANSACTION_FEE_USD } = {}) {
  return { source, fetchedAt, transactionFeeUsd, models: parseChatModels(body) };
}

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(flag(args, "out", path.join(here, "..", "website", "data", "blockrun-prices.json")));
  const modelsUrl = flag(args, "models-url", MODELS_URL);
  const inputFile = flag(args, "input", null);
  const fetchedAt = flag(args, "fetched-at", new Date().toISOString());
  const body = inputFile
    ? JSON.parse(await readFile(inputFile, "utf8"))
    : await (async () => { const r = await fetch(modelsUrl); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })();
  const snapshot = buildSnapshot(body, { fetchedAt, source: modelsUrl });
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`${out}: ${snapshot.models.length} paid chat models\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
