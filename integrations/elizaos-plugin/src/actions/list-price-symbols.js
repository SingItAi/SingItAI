import { SingItMcpClient, DEFAULT_MCP_URL } from "../mcp-client.js";
import { readSetting } from "../settings.js";

export const listSingitPriceSymbolsAction = {
  name: "SINGIT_LIST_PRICE_SYMBOLS",
  similes: ["LIST_PRICE_SYMBOLS", "SUPPORTED_SYMBOLS", "WHAT_PRICES"],
  description: "List every symbol SingIt's free get_price tool supports (no API key needed).",
  examples: [
    [
      { name: "{{user}}", content: { text: "What price symbols does SingIt support?" } },
      { name: "{{agent}}", content: { text: "Listing SingIt's supported price symbols.", actions: ["SINGIT_LIST_PRICE_SYMBOLS"] } },
    ],
  ],
  validate: async (_runtime, message) => /symbols?|which (prices|assets|coins)|what (prices|assets)/i.test(message?.content?.text ?? ""),
  handler: async (runtime, _message, _state, _options, callback) => {
    const client = new SingItMcpClient({ url: readSetting(runtime, "SINGIT_MCP_URL") ?? DEFAULT_MCP_URL });
    try {
      const result = await client.callTool("list_price_symbols");
      const text = JSON.stringify(result);
      await callback?.({ text, actions: ["SINGIT_LIST_PRICE_SYMBOLS"] });
      return { text, success: true, data: { result } };
    } catch (error) {
      const text = `Could not list SingIt's price symbols: ${error.message}`;
      await callback?.({ text, actions: ["SINGIT_LIST_PRICE_SYMBOLS"] });
      return { text, success: false, error: error.message };
    }
  },
};
