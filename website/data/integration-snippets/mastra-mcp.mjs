import { MCPClient } from "@mastra/mcp";
const mcp = new MCPClient({
  id: "singit",
  servers: { singit: { url: new URL("https://app.singitai.app/mcp") } },
});
const tools = await mcp.listTools();
console.log("mastra mcp tools:", Object.keys(tools).length, Object.keys(tools).slice(0, 3));
await mcp.disconnect();
