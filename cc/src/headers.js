// Product labels accepted on x-singit-client. Must stay a short allowlist: never forward raw
// User-Agent strings or other PII. Keep in sync with singit-ask/src/agent-traffic.mjs SOURCES and
// proxy/src/headers.js CLIENTS.
export const CLIENTS = Object.freeze([
  "openai-python", "openai-node", "langchain", "litellm", "vercel-ai",
  "cursor", "claude-code", "continue", "openclaw", "curl", "browser",
  "singit-proxy", "singit-mcp", "singit-cc", "other",
]);

export const DEFAULT_CLIENT = "singit-cc";
const TOKEN = /^[a-z0-9._-]{1,32}$/;

/** Sanitize a configured client label. Invalid or empty values become `fallback`. */
export function sanitizeClient(value, fallback = DEFAULT_CLIENT) {
  if (value == null || value === "") return fallback;
  const token = String(value).trim().toLowerCase().split("/")[0];
  return TOKEN.test(token) && CLIENTS.includes(token) ? token : fallback;
}

/** Header value sent to ask.singitai.app: `singit-cc/<version>` unless another allowlisted
 *  product label was configured, which is sent as-is. */
export function clientHeader(client, version) {
  const token = sanitizeClient(client, DEFAULT_CLIENT);
  return token === DEFAULT_CLIENT ? `${DEFAULT_CLIENT}/${version}` : token;
}

/** Attach x-singit-client and our own User-Agent. Claude Code's headers never reach Ask. */
export function withClientHeader(fetchImpl, { client, version }) {
  const value = clientHeader(client, version);
  const ua = `${DEFAULT_CLIENT}/${version}`;
  return (input, init) => {
    if (typeof Request !== "undefined" && input instanceof Request) {
      const headers = new Headers(input.headers);
      headers.set("x-singit-client", value);
      headers.set("user-agent", ua);
      return fetchImpl(new Request(input, { headers }), init);
    }
    const headers = new Headers(init?.headers);
    headers.set("x-singit-client", value);
    headers.set("user-agent", ua);
    return fetchImpl(input, { ...init, headers });
  };
}

/** Retry network / 5xx failures on unpaid hops only. Never retry a request that already carries a
 *  payment signature: 402 after a signed attempt is a refusal, not a signal to try again. */
export function withRetries(fetchImpl, { retries = 1 } = {}) {
  return async (input, init) => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const headers = isRequest ? input.headers : new Headers(init?.headers);
    const paid = headers.has("payment-signature");
    const attempts = paid ? 1 : retries + 1;
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await fetchImpl(isRequest ? input.clone() : input, init);
        if (response.status < 500 || i === attempts - 1) return response;
      } catch (error) {
        lastError = error;
        if (i === attempts - 1) throw error;
      }
    }
    throw lastError;
  };
}
