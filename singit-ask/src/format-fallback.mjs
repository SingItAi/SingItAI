// Paid fallback for the native format routes (POST /v1/messages, POST /v1/responses), the counterpart of what
// /v1/chat/completions does after payment (metered.mjs). Candidate selection starts from chat's attachPaidAlternates
// (reviewed defaults, same auto tier) and, when that leaves nothing, adds a few cheap healthy catalog models. A model
// outside every tier, like glm-4.7-flash or gemma-4-31b, would otherwise never get an alternate.
//
// The paid route still checks each candidate against the amount actually signed (fitsSignedCatalogCeiling), so a
// candidate is never charged above it.
import { attachPaidAlternates, signalFor } from "./auto-router.mjs";
import { unsupportedCapability } from "./agent-chat.mjs";
import { ceilings, catalogCeilingsDearer } from "./metered.mjs";
import { priceGuard } from "./catalogue.mjs";
import { BASE, reasoningHeadroom, DEFAULT_EXACT_OUTPUT_FRACTION } from "./pricing.mjs";
import { RANK_MIN_SAMPLES } from "./auto-router.mjs";

// Models Surplus is known not to serve on a format. Seeded from production (11 November 2026): deepseek-v4.1-flash
// answers 404 not_found_error in ~300 ms on /anthropic/v1/messages (also with 1000 tokens and stream), yet works on chat
// and /v1/responses. The deepseek family is therefore never chosen as an alternate there; an explicit request for one
// is still tried (and the miss learned, below). Chat and /v1/responses are not affected.
const NOT_SERVED = { "/v1/messages": id => /^deepseek-/.test(id) };
const UNSERVED_TTL_MS = 15 * 60_000;
const POOL_SIZE = 6;          // candidates kept for the pick: the best of each family first, then second-bests
const PER_FAMILY = 2;
const SCAN_LIMIT = 80;        // catalog models looked at; list() is cheapest-first, a cheap family must not crowd out the rest
// Held back from the leftover window when judging a candidate's typical duration (document: scheduling jitter).
export const WINDOW_MARGIN_MS = 250;
const NOT_A_TEXT_CHAT_MODEL = /image|video|free\//i;

// What this process saw Surplus refuse as unknown on one format. Per route and per model, so a 404 on /v1/messages
// never hides the same model on chat or /v1/responses.
export class FormatUnserved {
  constructor(now = () => Date.now()) { this.now = now; this.seen = new Map(); }
  note(route, model) { this.seen.set(`${route} ${model}`, this.now() + UNSERVED_TTL_MS); }
  has(route, model) {
    const key = `${route} ${model}`, until = this.seen.get(key);
    if (until > this.now()) return true;
    this.seen.delete(key);
    return false;
  }
  excludes(route, model) { return NOT_SERVED[route]?.(model) === true || this.has(route, model); }
}

// The leading letter run of a model id: gemma-4-31b and gemma-4-e2b are "gemma", qwen3-5-9b and qwen3.5-flash are "qwen",
// deepseek-v4.1-flash is "deepseek". A sibling usually shares its family's overload, so another family is preferred.
export const modelFamily = id => /^[a-z]+/.exec(String(id ?? "").toLowerCase())?.[0] ?? String(id ?? "");

// What this process saw each model do on one network for format-route paid attempts: the last RING outcomes with their
// duration (answered or not, including a reserve cut or a window timeout). In memory only: no persistence, no payer,
// request or key data, and never published. HealthStats only knows external payers and has no per-model latency.
const RING = 20, KEY_CAP = 300;
export class FormatTracker {
  constructor() { this.seen = new Map(); }
  record(model, network, ok, ms) {
    if (typeof model !== "string" || !Number.isFinite(ms)) return;
    const key = `${network} ${model}`, ring = this.seen.get(key) ?? [];
    this.seen.delete(key);
    ring.push({ ok: ok === true, ms: Math.max(0, Math.round(ms)) });
    if (ring.length > RING) ring.shift();
    this.seen.set(key, ring);
    if (this.seen.size > KEY_CAP) this.seen.delete(this.seen.keys().next().value);
  }
  // { n, rate, p50 } or null when the model has not been seen. One sample counts (a single 30 s timeout is news).
  stats(model, network) {
    const ring = this.seen.get(`${network} ${model}`);
    if (!ring?.length) return null;
    const sorted = ring.map(r => r.ms).sort((a, b) => a - b);
    return { n: ring.length, rate: ring.filter(r => r.ok).length / ring.length, p50: sorted[Math.floor((sorted.length - 1) / 2)] };
  }
}

// Order candidates: a model whose recent attempts here all failed goes last; then well-sampled HealthStats records by
// answered / attempts (as rankPaidAlternates); then the in-memory success rate (unknown counts as 0.5, so a cold model
// beats a poor one but not a good one); then a known p50 before an unknown one, lower first. Ties keep the given order,
// which is the whole order on a cold start.
export function rankFormatAlternates(pool, { health = () => null, tracker, network } = {}) {
  const scored = pool.map((candidate, index) => {
    let h = null;
    try { h = health(candidate.model); } catch {}
    const sampled = Number.isSafeInteger(h?.attempts) && Number.isSafeInteger(h?.answered) && h.attempts >= RANK_MIN_SAMPLES;
    const t = tracker?.stats(candidate.model, network) ?? null;
    return { candidate, index, t, healthRate: sampled ? Math.min(h.answered, h.attempts) / h.attempts : null };
  });
  const failing = s => (s.t && s.t.rate === 0 ? 1 : 0);
  return scored.sort((a, b) => failing(a) - failing(b)
    || (a.healthRate == null) - (b.healthRate == null) || (a.healthRate != null && b.healthRate - a.healthRate)
    || (b.t?.rate ?? 0.5) - (a.t?.rate ?? 0.5)
    || (a.t == null) - (b.t == null) || (a.t ? a.t.p50 - b.t.p50 : 0)
    || a.index - b.index).map(s => s.candidate);
}

// The one alternate, picked when it is needed: from the pool built at the start, re-checked now (a model that 503'd or was
// marked unservable since is out), inside the signed amount (`fits`) and, on a Solana exact window, only a model whose
// recent p50 fits the time that is left (`remainingMs`; no sample means it stays). Another family than the failed model is
// preferred; the same family only when nothing else is left. `tooSlow` says candidates were dropped for time alone.
export async function pickAlternate(pool, { route, format, catalogue, unserved, fits, health, tracker, network, remainingMs = Infinity }) {
  const viable = [];
  let tooSlow = false;
  for (const candidate of pool) {
    if (candidate.model === format.model || unserved.excludes(route, candidate.model) || catalogue?.isUnservable?.(candidate.model)) continue;
    if (!fits(candidate)) continue;
    if (await signalFor(catalogue, candidate).catch(() => "unhealthy")) continue;
    if (!fitsWindow(tracker?.stats(candidate.model, network), remainingMs)) { tooSlow = true; continue; }
    viable.push(candidate);
  }
  const ranked = rankFormatAlternates(viable, { health, tracker, network });
  const failed = modelFamily(format.fallbackFrom ?? format.model);
  const alternate = ranked.find(c => modelFamily(c.model) !== failed) ?? ranked[0] ?? null;
  return { alternate, tooSlow: tooSlow && !alternate };
}

// Whether a model's recent p50 fits `remainingMs`. Unknown latency fits: a cold start must still work.
export const fitsWindow = (stats, remainingMs) => !stats || !Number.isFinite(remainingMs) || stats.p50 + WINDOW_MARGIN_MS <= remainingMs;

// A Surplus refusal in the shape canRetryPaidFallback judges (chat's UpstreamError). Anything else stays unretryable.
export const asUpstreamError = error => (error?.name === "NoAnswer"
  ? { name: "UpstreamError", status: error.status, code: error.code } : { name: error?.name });

// Whether a request carries tools or images, for unsupportedCapability.
export function formatFlags(body) {
  const text = (() => { try { return JSON.stringify(body.messages ?? body.input ?? ""); } catch { return ""; } })();
  return { tools: Array.isArray(body.tools) && body.tools.length > 0 || /"type":"(?:tool_use|tool_result|function_call|function_call_output)"/.test(text),
    images: /"type":"(?:image|input_image|image_url)"/.test(text) };
}

export const isReasoningModel = info => reasoningHeadroom(info?.id, info) > 0;

// Candidates for one retry after payment, best first. `nonReasoning` (after a model spent its whole budget thinking)
// keeps only models that do not think.
export async function formatAlternates({ config, catalogue, route, format, request, unserved, nonReasoning = false }) {
  if (!catalogue || !format.info) return [];
  const fraction = config.exactOutputFraction ?? DEFAULT_EXACT_OUTPUT_FRACTION;
  const flags = formatFlags(request);
  const usable = candidate => !unserved.excludes(route, candidate.model)
    && !(nonReasoning && isReasoningModel(candidate.info));
  const asFormat = candidate => ({ ...format, ...candidate, request: { ...format.request, model: candidate.model },
    fallbackFrom: format.fallbackFrom ?? format.model });
  const input = { ...format, flags };
  // 1. Chat's policy: reviewed defaults or same-tier models, even for the service default model (which chat never
  //    substitutes): config.model is often deepseek-v4.1-flash, which Surplus does not serve on /v1/messages.
  const chosen = await attachPaidAlternates(config, catalogue, input, { ...format }, { automatic: true }).catch(() => format);
  const reviewed = (chosen.paidAlternates ?? []).filter(usable).map(asFormat);
  if (reviewed.length) return reviewed;
  // 2. Else a few of the cheapest healthy, priced catalog models no dearer than the quoted one and able to take the request.
  let models = [];
  try { models = typeof catalogue.list === "function" ? await catalogue.list() : []; } catch {}
  const quoted = ceilings(format.info, format, fraction);
  const found = [];
  let scanned = 0;
  for (const next of models) {
    if (scanned >= SCAN_LIMIT) break;
    if (!next?.id || next.id === format.model || !/^[a-z0-9][a-z0-9.-]*$/.test(next.id) || NOT_A_TEXT_CHAT_MODEL.test(next.id)) continue;
    if (unsupportedCapability(next, flags)) continue;
    const candidate = { model: next.id, info: next, isDefault: false, ...priceGuard(catalogue, next.id, config.priceBufferPp ?? 1) };
    if (!usable(candidate)) continue;
    scanned++;
    if (await signalFor(catalogue, { ...input, ...candidate }).catch(() => "unhealthy")) continue;
    const priced = ceilings(next, { ...format, ...candidate }, fraction);
    if (catalogCeilingsDearer(priced, quoted)) continue;
    found.push({ candidate, upto: BigInt(priced.upto[BASE]) });
  }
  // Models that do not think come first: a small budget is the usual reason to be here. Then cheapest.
  found.sort((a, b) => (isReasoningModel(a.candidate.info) - isReasoningModel(b.candidate.info)) || (a.upto < b.upto ? -1 : a.upto > b.upto ? 1 : 0));
  // The best of every family before any family's second: cheap siblings of one family cannot crowd out the others.
  const rounds = [];
  for (const f of found) {
    const family = modelFamily(f.candidate.model), round = found.filter(o => modelFamily(o.candidate.model) === family).indexOf(f);
    if (round < PER_FAMILY) (rounds[round] ??= []).push(f);
  }
  return rounds.flat().slice(0, POOL_SIZE).map(f => asFormat(f.candidate));
}
