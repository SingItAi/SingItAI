import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const sources = ["https://ask.singitai.app/v1/models", "https://ask.singitai.app/pricing.json"];
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function requireShape(ok, message) { if (!ok) throw new Error(`Invalid response: ${message}`); }
function pair(v) {
  requireShape(object(v) && number(v.input) && number(v.output), "token prices");
  return { input: v.input, output: v.output };
}
export function snapshot(models, pricing, fetchedAt) {
  requireShape(models.object === "list" && Array.isArray(models.data) && Array.isArray(pricing.models), "model lists");
  requireShape(typeof fetchedAt === "string" && /T.*Z$/.test(fetchedAt) && Number.isFinite(Date.parse(fetchedAt)), "UTC fetchedAt");
  requireShape(object(models.fees) && number(models.fees.markupPct) && object(models.fees.perAnswerUsd), "fees");
  requireShape(object(pricing.networks) && object(pricing.referenceRequest), "networks/referenceRequest");
  for (const network of ["base", "solana"]) {
    const n = pricing.networks[network];
    requireShape(object(n) && typeof n.chain === "string" && number(n.settlementFeeUsd) && number(models.fees.perAnswerUsd[n.chain]), `${network} fees`);
  }
  requireShape(number(pricing.referenceRequest.messages) && number(pricing.referenceRequest.maxOutputTokens), "reference request");
  for (const key of ["chars", "inputTokens"]) if (Object.hasOwn(pricing.referenceRequest, key)) requireShape(number(pricing.referenceRequest[key]), `reference ${key}`);
  const byId = new Map();
  for (const p of pricing.models) {
    requireShape(object(p) && typeof p.id === "string" && !byId.has(p.id), "unique pricing ids");
    byId.set(p.id, p);
  }
  const seen = new Set();
  const kept = [];
  for (const m of models.data) {
    requireShape(object(m) && typeof m.id === "string" && !seen.has(m.id), "unique model ids");
    seen.add(m.id);
    if (!Object.hasOwn(m, "usdPerMillionTokens") || !byId.has(m.id)) continue;
    // Embeddings publish one finite rate per million tokens, not an input/output pair.
    // Those entries stay on the catalog snapshot. Any other price shape still rejects the response.
    if (typeof m.usdPerMillionTokens === "number") {
      requireShape(number(m.usdPerMillionTokens), "embedding rate");
      continue;
    }
    const result = { id: m.id };
    for (const key of ["priceBasis", "priceDescription", "name", "owned_by", "contextLength", "tags", "recommendedScheme", "recommendedSchemeWhy"]) {
      if (!Object.hasOwn(m, key)) continue;
      requireShape(key === "tags" ? Array.isArray(m[key]) && m[key].every((v) => typeof v === "string") : key === "contextLength" ? number(m[key]) : typeof m[key] === "string", key);
      result[key] = m[key];
    }
    result.usdPerMillionTokens = pair(m.usdPerMillionTokens);
    if (Object.hasOwn(m, "singitUsdPerMillionTokens")) {
      const price = pair(m.singitUsdPerMillionTokens);
      if (!["input", "output"].some((key) => price[key] === 0 && result.usdPerMillionTokens[key] > 0))
        result.singitUsdPerMillionTokens = price;
    }
    if (Object.hasOwn(m.expectedUsdPerMillionTokens ?? {}, "basis")) {
      const expected = m.expectedUsdPerMillionTokens;
      requireShape(["observed", "observed_preliminary", "trusted"].includes(expected.basis), "expected price basis");
      const kept = { basis: expected.basis };
      if (Object.hasOwn(expected, "n")) {
        requireShape(Number.isInteger(expected.n) && expected.n >= 0, "expected price n");
        kept.n = expected.n;
      }
      if (Object.hasOwn(expected, "window")) {
        requireShape(Number.isInteger(expected.window) && expected.window > 0, "expected price window");
        kept.window = expected.window;
      }
      if (Object.hasOwn(expected, "note")) {
        requireShape(typeof expected.note === "string" && expected.note.length > 0, "expected price note");
        kept.note = expected.note;
      }
      result.expectedUsdPerMillionTokens = kept;
    }
    const p = byId.get(m.id);
    for (const scheme of ["upto", "exact"]) {
      result[scheme] = {};
      for (const network of ["base", "solana"]) {
        requireShape(object(p[scheme]?.[network]) && number(p[scheme][network].usd), `${m.id} ${scheme} ${network}`);
        result[scheme][network] = {};
        for (const key of ["priceAtomic", "ceilingAtomic", "usd"]) {
          if (Object.hasOwn(p[scheme][network], key)) {
            if (key !== "usd") requireShape(typeof p[scheme][network][key] === "string" && /^\d+$/.test(p[scheme][network][key]), `${m.id} ${key}`);
            result[scheme][network][key] = p[scheme][network][key];
          }
        }
      }
    }
    kept.push(result);
  }
  requireShape(kept.length >= 50, "fewer than 50 priced models");
  const result = { fetchedAt, sources, fees: models.fees, networks: pricing.networks, referenceRequest: pricing.referenceRequest, models: kept.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  // Keep the free offer's source so the generator never invents its limits.
  if (models.free !== undefined) {
    requireShape(Array.isArray(models.free.models) && models.free.models.every((v) => typeof v === "string") && number(models.free.perVisitorPerDay), "free offer");
    result.free = { models: models.free.models, perVisitorPerDay: models.free.perVisitorPerDay };
    if (Object.hasOwn(models.free, "budgetUsdPerDay")) {
      requireShape(number(models.free.budgetUsdPerDay), "free budget");
      result.free.budgetUsdPerDay = models.free.budgetUsdPerDay;
    }
  }
  return result;
}
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--models-input", "--pricing-input", "--fetched-at", "--out"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Usage: models-snapshot.mjs [--models-input f --pricing-input f --fetched-at ISO] [--out f]");
    options[args[i]] = args[i + 1];
  }
  if (!!options["--models-input"] !== !!options["--pricing-input"]) throw new Error("Supply both fixture inputs");
  async function input(file, url) {
    if (file) return JSON.parse(await readFile(file, "utf8"));
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return response.json();
  }
  const [models, pricing] = await Promise.all([input(options["--models-input"], sources[0]), input(options["--pricing-input"], sources[1])]);
  const data = snapshot(models, pricing, options["--fetched-at"] ?? new Date().toISOString());
  const out = options["--out"] ?? "website/data/models-snapshot.json";
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`Snapshot: ${data.models.length} models`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
