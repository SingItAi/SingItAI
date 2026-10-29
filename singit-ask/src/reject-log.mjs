// What Surplus said when it refused a paid question (29 October). A 404 minimum_discount_not_met only said "lower the
// floor" in our own log; the body also says which share the cheapest otherwise-eligible seller really sells at ("Best
// otherwise-eligible estimated discount is 25%"), which is the number the price guard should be compared with.
//
// One structured line per non-2xx POST to Surplus, whatever route made it (chat, Messages, Responses, speech,
// images, video): `singit-ask: surplus_reject {"model":...,"status":404,"code":"minimum_discount_not_met",...}`.
// Never logged: request or response headers, the Authorization key, the prompt, the payer. The only request header
// read is X-Min-Discount (the floor we sent, a number). The body is cut to MAX_BODY characters, whitespace squeezed,
// and anything shaped like a key, token or address is replaced first.
export const MAX_BODY = 240;
const SECRET_SHAPES = [
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]"],
  [/\b(?:inf|sk|pk|key|tok|ghp|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{6,}/gi, "[redacted]"],
  [/\b0x[0-9a-fA-F]{40,}\b/g, "[redacted]"],
  [/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];
export function sanitizeBody(text) {
  let out = String(text ?? "");
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}...` : out;
}

const BEST_DISCOUNT = /Best otherwise-eligible estimated discount is\s+(-?[0-9]+(?:\.[0-9]+)?)\s*%/i;
// The percentage as a number (25 for "25%"), or null when the text does not carry it.
export function parseBestDiscount(text) {
  const match = BEST_DISCOUNT.exec(String(text ?? ""));
  return match ? Number(match[1]) : null;
}

// {model, status, code, bestDiscountPct, minDiscountSent, body} for one refusal.
export function describeReject({ model, status, bodyText, minDiscountSent = null }) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { /* not JSON: logged as text */ }
  const error = parsed && typeof parsed === "object" ? parsed.error : null;
  const code = typeof error?.code === "string" ? error.code : typeof error?.type === "string" ? error.type : null;
  const message = typeof error?.message === "string" ? error.message : null;
  return {
    model: typeof model === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(model) ? model : null,
    status, code: code === null ? null : sanitizeBody(code).slice(0, 80),
    bestDiscountPct: parseBestDiscount(message ?? bodyText),
    minDiscountSent: minDiscountSent !== null && /^[0-9]{1,3}(\.[0-9]+)?$/.test(String(minDiscountSent)) ? Number(minDiscountSent) : null,
    body: sanitizeBody(message ?? bodyText),
  };
}

// `fetchImpl` wrapped: after every non-2xx answer to a POST under `surplusUrl`, log the refusal. The response goes
// back untouched (its body is read from a clone); a failure while logging never reaches the caller.
export function withRejectLog(fetchImpl, { surplusUrl, log }) {
  if (!surplusUrl) return fetchImpl;
  const prefix = `${surplusUrl}/`;
  return async function surplusFetch(url, init, ...rest) {
    const response = await fetchImpl(url, init, ...rest);
    try {
      if (response.ok || String(init?.method ?? "GET").toUpperCase() !== "POST" || !String(url).startsWith(prefix)) return response;
      let model = null;
      try { model = JSON.parse(init.body).model ?? null; } catch { /* not a JSON body */ }
      const sent = init.headers?.["X-Min-Discount"] ?? init.headers?.["x-min-discount"] ?? null;
      const bodyText = await response.clone().text();
      log(`singit-ask: surplus_reject ${JSON.stringify(describeReject({ model, status: response.status, bodyText, minDiscountSent: sent }))}`);
    } catch { /* logging only */ }
    return response;
  };
}
