import { createMCPClient } from "@ai-sdk/mcp";
const c = await createMCPClient({ transport: { type: "http", url: "https://app.singitai.app/mcp" } });
const tools = await c.tools();
console.log("ai-sdk mcp tools:", Object.keys(tools).length, Object.keys(tools).slice(0,3));
await c.close();
