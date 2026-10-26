import { SingItMcpClient, DEFAULT_MCP_URL } from "../mcp-client.js";
import { readSetting } from "../settings.js";
import { extractPriceArgs } from "../price-args.js";

export const getSingitPriceAction = {
  name: "SINGIT_GET_PRICE",
  similes: ["GET_PRICE", "CRYPTO_PRICE", "CHECK_PRICE", "EXCHANGE_RATE"],
  description: "Look up a crypto, metal or FX price through SingIt's free MCP tool get_price (no API key needed).",
  examples: [
    [
      { name: "{{user}}", content: { text: "What's the price of BTC?" } },
      { name: "{{agent}}", content: { text: "Checking SingIt for the BTC price.", actions: ["SINGIT_GET_PRICE"] } },
    ],
    [
      { name: "{{user}}", content: { text: "What's the EUR to USD rate?" } },
      { name: "{{agent}}", content: { text: "Checking SingIt for the EUR/USD rate.", actions: ["SINGIT_GET_PRICE"] } },
    ],
  ],
  validate: async (_runtime, message) => /\bprice\b|\bworth\b|\bquote\b|exchange rate/i.test(message?.content?.text ?? ""),
  handler: async (runtime, message, _state, _options, callback) => {
    const args = extractPriceArgs(message?.content?.text);
    const client = new SingItMcpClient({ url: readSetting(runtime, "SINGIT_MCP_URL") ?? DEFAULT_MCP_URL });
    try {
      const result = await client.callTool("get_price", args);
      const text = `${JSON.stringify(result)}`;
      await callback?.({ text, actions: ["SINGIT_GET_PRICE"] });
      return { text, success: true, data: { args, result } };
    } catch (error) {
      const text = `Could not get that price from SingIt: ${error.message}`;
      await callback?.({ text, actions: ["SINGIT_GET_PRICE"] });
      return { text, success: false, error: error.message };
    }
  },
};
