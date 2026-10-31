// Additive error metadata shared by all Ask routes. Never replace a supplied code.
export const ERROR_CODES = Object.freeze([
  "invalid_json", "invalid_request", "payload_too_large", "model_not_found", "not_found",
  "rate_limited", "free_tier_exhausted", "free_budget_exhausted", "free_tier_busy", "payment_required",
  "payment_duplicate", "stale_payment_permit", "no_billable_answer", "no_healthy_sellers", "max_tokens_too_small",
  "upstream_unavailable", "unauthorized", "forbidden", "internal_error",
  "invalid_identity", "request_changed", "already_prepared", "previous_quote_pending", "unknown_model",
  "already_paid", "already_submitted", "quote_unavailable", "invalid_payment", "terms_changed",
  "verification_unavailable", "verification_refused", "payment_unresolved",
]);
export function defaultErrorCode(status, type) {
  if (status === 404) return type === "not_found_error" ? "model_not_found" : "not_found";
  return ({ 400: "invalid_request", 401: "unauthorized", 402: "payment_required", 403: "forbidden",
    409: "payment_duplicate", 413: "payload_too_large", 422: "invalid_request", 429: "rate_limited",
    502: "upstream_unavailable", 503: "upstream_unavailable", 504: "upstream_unavailable" })[status] ?? "internal_error";
}
export function errorCodesMiddleware(_req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body)) {
      if (body.error && typeof body.error === "object" && body.error.code === undefined) {
        body = { ...body, error: { ...body.error, code: defaultErrorCode(res.statusCode, body.error.type) } };
      } else if (typeof body.error === "string" && body.code === undefined) body = { ...body, code: /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : defaultErrorCode(res.statusCode) };
      else if (!body.error && body.code === undefined && res.statusCode !== 402) body = { ...body, code: defaultErrorCode(res.statusCode) };
    }
    return json(body);
  };
  next();
}
export const RATE_LIMIT_HEADERS = Object.fromEntries(["Limit", "Remaining", "Reset"].map(name => [
  `X-RateLimit-${name}`, { description: name === "Reset" ? "Limiter reset time, Unix seconds" : `${name} requests in the limiting allowance`, schema: { type: "integer" } },
]));
const detail = { type: "object", required: ["type", "message", "code"], properties: {
  type: { type: "string" }, message: { type: "string" }, code: { type: "string", examples: ERROR_CODES },
} };
export const ERROR_SCHEMAS = {
  ErrorResponse: { type: "object", required: ["error"], properties: { error: detail } },
  AnthropicErrorResponse: { type: "object", required: ["type", "error"], properties: { type: { const: "error" }, error: detail } },
  PaymentRequired402: { type: "object", required: ["error", "code"], properties: {
    x402Version: { type: "integer", description: "Present when the 402 is a payment challenge; equals x402Version in the decoded PAYMENT-REQUIRED header. Absent when a payment was submitted but could not be settled." },
    accepts: { type: "array", description: "Present when the 402 is a payment challenge; equals accepts in the decoded PAYMENT-REQUIRED header. Absent when a payment was submitted but could not be settled.", items: { type: "object", additionalProperties: true } },
    error: { type: "string" }, code: { const: "payment_required" },
  } },
  RateLimited429: { $ref: "#/components/schemas/ErrorResponse" },
};
export const errorRef = name => ({ $ref: `#/components/schemas/${name}` });
