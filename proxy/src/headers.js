// Product labels accepted on x-singit-client. Must stay a short allowlist: never forward raw
// User-Agent strings or other PII. Keep in sync with singit-ask/src/agent-traffic.mjs SOURCES
// (plus the proxy/mcp tokens this package introduces).
export const CLIENTS = Object.freeze([
  "openai-python", "openai-node", "langchain", "litellm", "vercel-ai",
  "cursor", "claude-code", "continue", "openclaw", "curl", "browser",
  "singit-proxy", "singit-mcp", "other",
]);

const TOKEN = /^[a-z0-9._-]{1,32}$/;

/** Sanitize a configured or incoming client label. Invalid or empty values become `fallback`. */
export function sanitizeClient(value, fallback = "singit-proxy") {
  if (value == null || value === "") return fallback;
  const token = String(value).trim().toLowerCase().split("/")[0];
  return TOKEN.test(token) && CLIENTS.includes(token) ? token : fallback;
}

/** Header value sent to ask.singitai.app. A configured product (openclaw, continue, …) is sent as-is
 *  so numbers.json can attribute the call; otherwise `singit-proxy/<version>`. */
export function clientHeader(client, version) {
  const token = sanitizeClient(client, "singit-proxy");
  return token === "singit-proxy" ? `singit-proxy/${version}` : token;
}

/** Attach x-singit-client (and a default User-Agent) without overwriting a caller-set header. */
export function withClientHeader(fetchImpl, { client, version }) {
  const value = clientHeader(client, version);
  const ua = `singit-proxy/${version}`;
  return (input, init) => {
    if (typeof Request !== "undefined" && input instanceof Request) {
      const headers = new Headers(input.headers);
      if (!headers.has("x-singit-client")) headers.set("x-singit-client", value);
      headers.set("user-agent", ua);
      return fetchImpl(new Request(input, { headers }), init);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("x-singit-client")) headers.set("x-singit-client", value);
    headers.set("user-agent", ua);
    return fetchImpl(input, { ...init, headers });
  };
}

/** Retry network / 5xx failures on unpaid hops only. Never retry a request that already carries a
 *  payment signature: 402 after a signed attempt is a refusal, not a signal to try again. */
export function withRetries(fetchImpl, { retries = 1 } = {}) {
  return async (input, init) => {
    const headers = typeof Request !== "undefined" && input instanceof Request
      ? input.headers : new Headers(init?.headers);
    const paid = headers.has("payment-signature") || headers.has("PAYMENT-SIGNATURE");
    const attempts = paid ? 1 : retries + 1;
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        const req = typeof Request !== "undefined" && input instanceof Request ? input.clone() : input;
        const response = await fetchImpl(req, init);
        if (response.status < 500 || i === attempts - 1 || paid) return response;
      } catch (error) {
        lastError = error;
        if (i === attempts - 1 || paid) throw error;
      }
    }
    throw lastError;
  };
}
