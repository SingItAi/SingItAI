import { SingItMcpClient, DEFAULT_MCP_URL } from "../mcp-client.js";
import { readSetting } from "../settings.js";

// Paid (needs the key's "search" scope), billed per call from the key's own SingIt limits. Absent
// a SINGIT_API_KEY setting, validate() returns false so the action is never offered or run.
export const singitWebSearchAction = {
  name: "SINGIT_WEB_SEARCH",
  similes: ["WEB_SEARCH", "SEARCH_THE_WEB"],
  description: "Search the web through SingIt's paid MCP tool web_search (Exa). Needs SINGIT_API_KEY.",
  examples: [
    [
      { name: "{{user}}", content: { text: "Search the web for the latest SingIt news." } },
      { name: "{{agent}}", content: { text: "Searching the web through SingIt.", actions: ["SINGIT_WEB_SEARCH"] } },
    ],
  ],
  validate: async (runtime, message) => {
    if (!readSetting(runtime, "SINGIT_API_KEY")) return false;
    return /search (the )?web|google|look up online|find.*online/i.test(message?.content?.text ?? "");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const apiKey = readSetting(runtime, "SINGIT_API_KEY");
    if (!apiKey) {
      const text = "SINGIT_WEB_SEARCH needs a SINGIT_API_KEY setting; none is configured.";
      await callback?.({ text, actions: ["SINGIT_WEB_SEARCH"] });
      return { text, success: false, error: "missing_api_key" };
    }
    const query = (message?.content?.text ?? "").replace(/^.*?(search|look up|find)\s*(the web|online)?\s*(for|about)?/i, "").trim() || message?.content?.text || "";
    const client = new SingItMcpClient({ url: readSetting(runtime, "SINGIT_MCP_URL") ?? DEFAULT_MCP_URL, apiKey });
    try {
      const result = await client.callTool("web_search", { query });
      const text = JSON.stringify(result);
      await callback?.({ text, actions: ["SINGIT_WEB_SEARCH"] });
      return { text, success: true, data: { query, result } };
    } catch (error) {
      const text = `SingIt web search failed: ${error.message}`;
      await callback?.({ text, actions: ["SINGIT_WEB_SEARCH"] });
      return { text, success: false, error: error.message };
    }
  },
};
