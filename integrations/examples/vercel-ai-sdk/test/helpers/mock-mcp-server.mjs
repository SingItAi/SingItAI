// A minimal local stand-in for SingIt's MCP server (sign402-gateway/README.md#mcp-server), enough
// to test this plugin's MCP client offline: JSON-RPC over HTTP, no session. Implements
// initialize/tools/list/tools/call, free tools without a key, and one paid tool ("web_search")
// that requires `Authorization: Bearer <apiKey>` and records every Authorization header it saw so
// tests can assert the plugin never sends anything else (no logging surface, just an assertion
// hook). Not a replica of the real gateway's scopes/rate limits/analytics.
import http from "node:http";

export function startMockMcpServer({ apiKey = "sk_singit_test" } = {}) {
  const seenAuthorizationHeaders = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const { id, method, params } = body;
    const authorization = req.headers.authorization;
    seenAuthorizationHeaders.push(authorization ?? null);

    const reply = (result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };
    const replyError = (status, code, message) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    };

    if (method === "initialize") {
      return reply({
        protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "singit-mock", version: "0.0.0" },
      });
    }
    if (method === "tools/list") {
      return reply({
        tools: [
          { name: "get_price", description: "Current price of a major cryptocurrency, gold or silver, or an FX rate.",
            inputSchema: { type: "object", properties: {
              kind: { type: "string", enum: ["crypto", "metal", "fx"] },
              symbol: { type: "string" }, base: { type: "string" }, quote: { type: "string" },
            }, required: ["kind"] } },
          { name: "list_price_symbols", description: "Every symbol get_price supports.",
            inputSchema: { type: "object", properties: {} } },
          { name: "list_models", description: "SingIt's available chat/image/audio models and prices.",
            inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["chat", "images", "audio"] } } } },
          { name: "web_search", description: "Searches the web through Exa.",
            inputSchema: { type: "object", properties: { query: { type: "string" }, numResults: { type: "integer" }, type: { type: "string" } }, required: ["query"] } },
          { name: "read_page", description: "Reads one web page's text through Exa.",
            inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
        ],
      });
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const PAID_TOOLS = new Set(["web_search", "read_page"]);
      if (PAID_TOOLS.has(name)) {
        if (!authorization) return replyError(401, -32001, "This tool needs a SingIt API key.");
        if (authorization !== `Bearer ${apiKey}`) return replyError(401, -32001, "Invalid or revoked API key.");
      }
      if (name === "get_price") return reply(toolResult({ symbol: args.symbol ?? "BTC", kind: args.kind ?? "crypto", price: "64230.12" }));
      if (name === "list_price_symbols") return reply(toolResult({ symbols: ["BTC", "ETH", "XAU", "XAG"] }));
      if (name === "list_models") return reply(toolResult({ data: [{ id: "deepseek-v4.1-flash" }] }));
      if (name === "web_search") return reply(toolResult({ results: [{ title: "Result for " + args.query, url: "https://example.com" }] }));
      if (name === "read_page") return reply(toolResult({ text: "Page text for " + args.url }));
      return replyError(200, -32602, `Unknown tool '${name}'.`);
    }
    return replyError(200, -32601, `Unknown method '${method}'.`);
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/mcp`;
      resolve({
        url,
        apiKey,
        seenAuthorizationHeaders,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function toolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
