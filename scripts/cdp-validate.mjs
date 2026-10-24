#!/usr/bin/env node
// Asks Coinbase's free x402 validator whether each live resource in scripts/bazaar-resources.json is ready for
// the Bazaar (docs.cdp.coinbase.com/x402/seller/get-discovered). The endpoint needs no API key and no payment:
// it fetches the resource's 402 challenge and simulates a payment against it. This script sends only
// `{ resource, method }`; it never carries a payment header, a key or any other credential.
//
//   node scripts/cdp-validate.mjs                 # every resource in bazaar-resources.json
//   node scripts/cdp-validate.mjs --json          # machine-readable report
//   node scripts/cdp-validate.mjs --config PATH   # another resource list
//
// Exit codes: 0 every resource is valid and its simulation was accepted; 1 at least one resource failed
// validation (or has a required preflight failure); 2 the check could not be completed (bad config, network
// error, timeout, a reply that is not JSON). Network use is the whole point of this tool, so it is NOT part of
// the offline CI gate: only .github/workflows/bazaar-validate.yml runs it, on manual dispatch and weekly.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = path.join(HERE, "bazaar-resources.json");
export const DEFAULT_ENDPOINT = "https://api.cdp.coinbase.com/platform/v2/x402/validate";
export const TIMEOUT_MS = 20_000;

// The reply's `preflight` holds required failures and advisory recommendations. The documented field names
// could change, so read the few shapes that make sense and keep whatever text each entry carries.
const text = (entry) => {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return String(entry);
  const message = entry.message ?? entry.description ?? entry.reason ?? entry.detail ?? entry.error;
  const code = entry.code ?? entry.check ?? entry.id ?? entry.name;
  if (message && code && message !== code) return `${code}: ${message}`;
  return String(message ?? code ?? JSON.stringify(entry));
};
const list = (value) => (Array.isArray(value) ? value.map(text) : value && typeof value === "object" ? Object.values(value).flat().map(text) : []);

// Turns one validator reply into { ok, valid, outcome, failures, recommendations, reasons }.
export function evaluate(reply) {
  const preflight = reply?.preflight ?? {};
  const failures = list(preflight.failures ?? preflight.required ?? preflight.requiredFailures ?? preflight.errors);
  const recommendations = list(preflight.recommendations ?? preflight.advisory ?? preflight.warnings);
  const valid = reply?.valid === true;
  const outcome = reply?.simulation?.outcome ?? null;
  const reasons = [];
  if (!valid) reasons.push(`valid is ${JSON.stringify(reply?.valid ?? null)}, expected true`);
  if (outcome !== "accepted") reasons.push(`simulation.outcome is ${JSON.stringify(outcome)}, expected "accepted"`);
  if (failures.length) reasons.push(`${failures.length} required preflight failure(s)`);
  return { ok: reasons.length === 0, valid, outcome, failures, recommendations, reasons };
}

// Validates one { url, method }. Returns { url, method, ...evaluate(reply) } or { url, method, error } when the
// call itself did not complete. `fetchImpl` is injectable so tests never touch the network.
export async function validateResource(entry, { fetchImpl = fetch, endpoint = DEFAULT_ENDPOINT, timeoutMs = TIMEOUT_MS } = {}) {
  const { url, method } = entry;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ resource: url, method }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    let reply;
    try { reply = JSON.parse(body); } catch { return { url, method, error: `HTTP ${response.status}: the reply is not JSON` }; }
    // A 4xx that carries no verdict (bad request, rate limit) is a failed check, not a passed or failed resource.
    if (!response.ok && reply?.valid === undefined) {
      const detail = reply?.message ?? reply?.error ?? reply?.errorMessage;
      return { url, method, error: `HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}` };
    }
    return { url, method, ...evaluate(reply) };
  } catch (error) {
    return { url, method, error: error?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : `request failed: ${error?.message ?? error}` };
  }
}

export function readConfig(file = DEFAULT_CONFIG) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const resources = config.resources;
  if (!Array.isArray(resources) || resources.length === 0) throw new Error(`${file}: "resources" must be a non-empty array`);
  for (const entry of resources) {
    if (typeof entry?.url !== "string" || !entry.url.startsWith("https://")) throw new Error(`${file}: every resource needs an https url (${JSON.stringify(entry?.url)})`);
    if (!["GET", "POST"].includes(entry.method)) throw new Error(`${file}: method of ${entry.url} must be GET or POST`);
  }
  return { endpoint: config.validateEndpoint ?? DEFAULT_ENDPOINT, resources };
}

// Runs every resource (one after another, the validator is rate limited) and returns { code, results }.
export async function validateAll({ resources, endpoint, fetchImpl, timeoutMs }) {
  const results = [];
  for (const entry of resources) results.push(await validateResource(entry, { fetchImpl, endpoint, timeoutMs }));
  const code = results.some((r) => r.error) ? 2 : results.every((r) => r.ok) ? 0 : 1;
  return { code, results };
}

export function format(results) {
  const lines = [];
  for (const r of results) {
    const head = r.error ? "ERROR" : r.ok ? "ok   " : "FAIL ";
    lines.push(`${head} ${r.method} ${r.url}`);
    if (r.error) { lines.push(`       ${r.error}`); continue; }
    lines.push(`       valid=${r.valid} simulation.outcome=${r.outcome ?? "none"}`);
    for (const f of r.failures) lines.push(`       FAIL ${f}`);
    for (const reason of r.reasons) lines.push(`       ${reason}`);
    for (const rec of r.recommendations) lines.push(`       advice: ${rec}`);
  }
  const bad = results.filter((r) => r.error || !r.ok).length;
  lines.push(`\n${results.length} resource(s), ${results.length - bad} passed, ${bad} did not`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  let config;
  try { config = readConfig(option("--config") ?? DEFAULT_CONFIG); } catch (error) { err(`cdp-validate: ${error.message}`); return 2; }
  const { code, results } = await validateAll({ ...config, fetchImpl });
  out(argv.includes("--json") ? JSON.stringify({ code, results }, null, 2) : format(results));
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
