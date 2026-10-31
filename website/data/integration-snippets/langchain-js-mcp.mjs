import { MultiServerMCPClient } from "@langchain/mcp-adapters";
const client = new MultiServerMCPClient({ mcpServers: { singit: { transport: "http", url: "https://app.singitai.app/mcp" } } });
const tools = await client.getTools();
console.log("langchain-js mcp tools:", tools.length, tools.slice(0,3).map(t=>t.name));
const t = tools.find(t=>t.name.endsWith("list_price_symbols"));
const out = await t.invoke({}); console.log(String(typeof out==="string"?out:JSON.stringify(out)).slice(0,150));
await client.close();
