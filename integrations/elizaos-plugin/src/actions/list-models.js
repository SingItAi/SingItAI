import { SingItMcpClient, DEFAULT_MCP_URL } from "../mcp-client.js";
import { readSetting } from "../settings.js";

export const listSingitModelsAction = {
  name: "SINGIT_LIST_MODELS",
  similes: ["LIST_MODELS", "AVAILABLE_MODELS", "WHICH_MODELS"],
  description: "List the AI models available through SingIt and their prices (no API key needed).",
  examples: [
    [
      { name: "{{user}}", content: { text: "Which models does SingIt offer?" } },
      { name: "{{agent}}", content: { text: "Listing SingIt's available models.", actions: ["SINGIT_LIST_MODELS"] } },
    ],
  ],
  validate: async (_runtime, message) => /models?|llms?/i.test(message?.content?.text ?? ""),
  handler: async (runtime, _message, _state, _options, callback) => {
    const client = new SingItMcpClient({ url: readSetting(runtime, "SINGIT_MCP_URL") ?? DEFAULT_MCP_URL });
    try {
      const result = await client.callTool("list_models");
      const text = JSON.stringify(result);
      await callback?.({ text, actions: ["SINGIT_LIST_MODELS"] });
      return { text, success: true, data: { result } };
    } catch (error) {
      const text = `Could not list SingIt's models: ${error.message}`;
      await callback?.({ text, actions: ["SINGIT_LIST_MODELS"] });
      return { text, success: false, error: error.message };
    }
  },
};
