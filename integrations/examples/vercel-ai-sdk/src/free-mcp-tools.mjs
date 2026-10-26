// Free mode, part 1: load SingIt's MCP tools with the AI SDK's MCP client (@ai-sdk/mcp) and call
// one free tool. No API key, no payment — get_price, list_price_symbols and list_models work for
// any caller.
import { createMCPClient } from "@ai-sdk/mcp";

export const DEFAULT_MCP_URL = "https://app.singitai.app/mcp";

function toolOutput(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find(part => part.type === "text")?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runFreeMcpTools({ mcpUrl = DEFAULT_MCP_URL } = {}) {
  const client = await createMCPClient({ transport: { type: "http", url: mcpUrl } });
  try {
    const tools = await client.tools();
    const toolNames = Object.keys(tools);
    const priceResult = tools.get_price ? await tools.get_price.execute({ kind: "crypto", symbol: "BTC" }) : null;
    return { toolNames, price: priceResult ? toolOutput(priceResult) : null };
  } finally {
    await client.close();
  }
}
