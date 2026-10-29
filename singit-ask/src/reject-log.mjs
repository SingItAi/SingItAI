// What Surplus said when it refused a paid question (29 October). A 404 minimum_discount_not_met only said "lower the
// floor" in our own log; the body also says which share the cheapest otherwise-eligible seller really sells at ("Best
// otherwise-eligible estimated discount is 25%"), which is the number the price guard should be compared with.
//
// One structured line per non-2xx POST to Surplus, whatever route made it (chat, Messages, Responses, speech,
// images, video): `singit-ask: surplus_reject {"model":...,"status":404,"code":"minimum_discount_not_met",...}`.
// Never logged: request or response headers, the Authorization key, the prompt, the payer. The only request header
// read is X-Min-Discount (the floor we sent, a number). Surplus's own words (`body`) are logged only for the error codes
// in BODY_CODES, which are about price and sellers and carry no user text; for any other code the line has the code and
// the body's length, not its text (an upstream error can echo the question). That text is cut to MAX_BODY characters,
// whitespace squeezed, with anything shaped like a key, token or address replaced first. The log is written after the
// response has gone back to the caller, from at most MAX_READ bytes of a clone, and never delays or fails the answer.
export const MAX_BODY = 240;
export const MAX_READ = 4096;
export const READ_TIMEOUT_MS = 3000;
export const BODY_CODES = Object.freeze(["minimum_discount_not_met", "no_healthy_sellers"]);
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

// {model, status, code, bestDiscountPct, minDiscountSent, body, bodyChars} for one refusal. `body` is null unless the
// code is one of BODY_CODES; `code` itself is kept only when it looks like an identifier.
const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;
export function describeReject({ model, status, bodyText, minDiscountSent = null }) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { /* not JSON: logged as text */ }
  const error = parsed && typeof parsed === "object" ? parsed.error : null;
  const pick = (v) => (typeof v === "string" && CODE_SHAPE.test(v) ? v : null);
  const code = pick(error?.code) ?? pick(error?.type);
  const message = typeof error?.message === "string" ? error.message : null;
  const text = message ?? bodyText;
  return {
    model: typeof model === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(model) ? model : null,
    status, code,
    // The one number the message is read for; it is a number, never text.
    bestDiscountPct: code !== null && BODY_CODES.includes(code) ? parseBestDiscount(text) : null,
    minDiscountSent: minDiscountSent !== null && /^[0-9]{1,3}(\.[0-9]+)?$/.test(String(minDiscountSent)) ? Number(minDiscountSent) : null,
    body: code !== null && BODY_CODES.includes(code) ? sanitizeBody(text) : null,
    bodyChars: String(bodyText ?? "").length,
  };
}

// At most MAX_READ bytes of a response clone as text; gives up after READ_TIMEOUT_MS. Never throws.
async function readSome(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => reader.cancel().catch(() => {}), READ_TIMEOUT_MS);
  try {
    while (size < MAX_READ) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch { /* cut short */ } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_READ).toString("utf8");
}

// `fetchImpl` wrapped: after every non-2xx answer to a POST under `surplusUrl`, log the refusal. The response goes
// back at once and untouched; the log is written afterwards from a bounded read of a clone, and a failure while
// logging never reaches the caller. `.idle()` resolves when the logging started so far is done (tests).
export function withRejectLog(fetchImpl, { surplusUrl, log }) {
  if (!surplusUrl) return fetchImpl;
  const prefix = `${surplusUrl}/`;
  const pending = new Set();
  const surplusFetch = async function surplusFetch(url, init, ...rest) {
    const response = await fetchImpl(url, init, ...rest);
    try {
      if (response.ok || String(init?.method ?? "GET").toUpperCase() !== "POST" || !String(url).startsWith(prefix)) return response;
      let model = null;
      try { model = JSON.parse(init.body).model ?? null; } catch { /* not a JSON body */ }
      const sent = init.headers?.["X-Min-Discount"] ?? init.headers?.["x-min-discount"] ?? null;
      const task = readSome(response).then((bodyText) => {
        log(`singit-ask: surplus_reject ${JSON.stringify(describeReject({ model, status: response.status, bodyText, minDiscountSent: sent }))}`);
      }).catch(() => {}).finally(() => pending.delete(task));
      pending.add(task);
    } catch { /* logging only */ }
    return response;
  };
  surplusFetch.idle = () => Promise.allSettled([...pending]);
  return surplusFetch;
}
