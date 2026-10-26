// Free mode, part 1: load SingIt's MCP tools with @langchain/mcp-adapters and call one free tool.
// No API key, no payment — get_price, list_price_symbols and list_models work for any caller.
import { MCPAdapter } from "@langchain/mcp-adapters";

export const DEFAULT_MCP_URL = "https://app.singitai.app/mcp";

export async function runFreeMcpTools({ mcpUrl = DEFAULT_MCP_URL } = {}) {
  const adapter = new MCPAdapter({ servers: { singit: { url: mcpUrl } } });
  try {
    const tools = await adapter.listTools();
    const toolNames = tools.map(tool => tool.name);
    // MCPAdapter prefixes tool names with the server key ("singit_get_price") to avoid collisions
    // across multiple servers; match by suffix so this still works if that default changes.
    const priceTool = tools.find(tool => tool.name.endsWith("get_price"));
    const price = priceTool ? await priceTool.invoke({ kind: "crypto", symbol: "BTC" }) : null;
    return { toolNames, price };
  } finally {
    await adapter.close();
  }
}
