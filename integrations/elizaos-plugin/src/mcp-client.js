// Minimal JSON-RPC client for SingIt's remote MCP server (sign402-gateway/README.md#mcp-server).
// Streamable HTTP, JSON responses only: one POST is one answer, no session, no SSE stream — so
// this never needs an `initialize` call before `tools/call`. The API key, when present, travels
// only in the Authorization header of each request and is never logged, including in errors.
export const DEFAULT_MCP_URL = "https://app.singitai.app/mcp";

export class SingItMcpError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "SingItMcpError";
    this.code = code;
    this.status = status;
  }
}

let requestCounter = 0;

export class SingItMcpClient {
  constructor({ url = DEFAULT_MCP_URL, apiKey, fetchImpl = fetch } = {}) {
    this.url = url;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async #call(method, params) {
    const id = ++requestCounter;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      // Never interpolate headers/init into the error: the Authorization header must not leak here.
      throw new SingItMcpError(`Could not reach the SingIt MCP server (${error.message}).`);
    }
    if (response.status === 401) {
      throw new SingItMcpError("The SingIt API key was rejected (401). Create one at https://app.singitai.app/app/.", { status: 401 });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SingItMcpError(`The SingIt MCP server returned a non-JSON response (HTTP ${response.status}).`, { status: response.status });
    }
    if (payload.error) {
      throw new SingItMcpError(payload.error.message || "The SingIt MCP server returned an error.", { code: payload.error.code, status: response.status });
    }
    return payload.result;
  }

  listTools() {
    return this.#call("tools/list", {});
  }

  async callTool(name, args = {}) {
    const result = await this.#call("tools/call", { name, arguments: args });
    if (result?.isError) {
      const text = result.content?.find(c => c.type === "text")?.text ?? "The tool call failed.";
      throw new SingItMcpError(text);
    }
    const text = result?.content?.find(c => c.type === "text")?.text;
    if (text === undefined) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
