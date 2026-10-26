import { SingItMcpClient, DEFAULT_MCP_URL } from "../mcp-client.js";
import { readSetting } from "../settings.js";

const URL_RE = /https?:\/\/\S+/i;

// Paid (needs the key's "search" scope), billed per call from the key's own SingIt limits. Absent
// a SINGIT_API_KEY setting, validate() returns false so the action is never offered or run.
export const singitReadPageAction = {
  name: "SINGIT_READ_PAGE",
  similes: ["READ_PAGE", "READ_URL", "FETCH_PAGE"],
  description: "Read a web page's text through SingIt's paid MCP tool read_page (Exa). Needs SINGIT_API_KEY.",
  examples: [
    [
      { name: "{{user}}", content: { text: "Read https://singitai.app for me." } },
      { name: "{{agent}}", content: { text: "Reading that page through SingIt.", actions: ["SINGIT_READ_PAGE"] } },
    ],
  ],
  validate: async (runtime, message) => {
    if (!readSetting(runtime, "SINGIT_API_KEY")) return false;
    return URL_RE.test(message?.content?.text ?? "") && /read|open|fetch|summarize/i.test(message?.content?.text ?? "");
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const apiKey = readSetting(runtime, "SINGIT_API_KEY");
    if (!apiKey) {
      const text = "SINGIT_READ_PAGE needs a SINGIT_API_KEY setting; none is configured.";
      await callback?.({ text, actions: ["SINGIT_READ_PAGE"] });
      return { text, success: false, error: "missing_api_key" };
    }
    const url = URL_RE.exec(message?.content?.text ?? "")?.[0];
    if (!url) {
      const text = "SINGIT_READ_PAGE needs a URL in the message.";
      await callback?.({ text, actions: ["SINGIT_READ_PAGE"] });
      return { text, success: false, error: "missing_url" };
    }
    const client = new SingItMcpClient({ url: readSetting(runtime, "SINGIT_MCP_URL") ?? DEFAULT_MCP_URL, apiKey });
    try {
      const result = await client.callTool("read_page", { url });
      const text = JSON.stringify(result);
      await callback?.({ text, actions: ["SINGIT_READ_PAGE"] });
      return { text, success: true, data: { url, result } };
    } catch (error) {
      const text = `SingIt page read failed: ${error.message}`;
      await callback?.({ text, actions: ["SINGIT_READ_PAGE"] });
      return { text, success: false, error: error.message };
    }
  },
};
