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

// Models Surplus is known not to serve on a format. Seeded from production (11 November 2026): deepseek-v4.1-flash
// answers 404 not_found_error in ~300 ms on /anthropic/v1/messages (also with 1000 tokens and stream), yet works on chat
// and /v1/responses. The deepseek family is therefore never chosen as an alternate there; an explicit request for one
// is still tried (and the miss learned, below). Chat and /v1/responses are not affected.
const NOT_SERVED = { "/v1/messages": id => /^deepseek-/.test(id) };
const UNSERVED_TTL_MS = 15 * 60_000;
const POOL_SIZE = 3;
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
  for (const next of models) {
    if (found.length >= POOL_SIZE * 4) break;   // list() is cheapest-first: a handful is enough to pick from
    if (!next?.id || next.id === format.model || !/^[a-z0-9][a-z0-9.-]*$/.test(next.id) || NOT_A_TEXT_CHAT_MODEL.test(next.id)) continue;
    if (unsupportedCapability(next, flags)) continue;
    const candidate = { model: next.id, info: next, isDefault: false, ...priceGuard(catalogue, next.id, config.priceBufferPp ?? 1) };
    if (!usable(candidate)) continue;
    if (await signalFor(catalogue, { ...input, ...candidate }).catch(() => "unhealthy")) continue;
    const priced = ceilings(next, { ...format, ...candidate }, fraction);
    if (catalogCeilingsDearer(priced, quoted)) continue;
    found.push({ candidate, upto: BigInt(priced.upto[BASE]) });
  }
  // Models that do not think come first: a small budget is the usual reason to be here. Then cheapest.
  found.sort((a, b) => (isReasoningModel(a.candidate.info) - isReasoningModel(b.candidate.info)) || (a.upto < b.upto ? -1 : a.upto > b.upto ? 1 : 0));
  return found.slice(0, POOL_SIZE).map(f => asFormat(f.candidate));
}
