import { getSingitPriceAction } from "./actions/get-price.js";
import { listSingitPriceSymbolsAction } from "./actions/list-price-symbols.js";
import { listSingitModelsAction } from "./actions/list-models.js";
import { singitWebSearchAction } from "./actions/web-search.js";
import { singitReadPageAction } from "./actions/read-page.js";
import { singitPaidChatAction } from "./actions/paid-chat.js";
import { singitToolsProvider } from "./providers/singit-tools-provider.js";

export { SingItMcpClient, SingItMcpError, DEFAULT_MCP_URL } from "./mcp-client.js";
export { SingItPaymentError, BASE_PIN, DEFAULT_ASK_BASE_URL } from "./x402/guards.js";
export { payAskRequest } from "./x402/pay.js";
export {
  getSingitPriceAction, listSingitPriceSymbolsAction, listSingitModelsAction,
  singitWebSearchAction, singitReadPageAction, singitPaidChatAction, singitToolsProvider,
};

/**
 * @type {import("@elizaos/core").Plugin}
 */
export const singitPlugin = {
  name: "singit",
  description: "SingIt tools for ElizaOS agents: free crypto/FX prices and model listing via "
    + "SingIt's MCP server, optional paid web search/page reading with a SingIt API key, and "
    + "optional x402-paid chat on SingIt Ask (Base) when a wallet key and spending caps are set.",
  actions: [
    getSingitPriceAction,
    listSingitPriceSymbolsAction,
    listSingitModelsAction,
    singitWebSearchAction,
    singitReadPageAction,
    singitPaidChatAction,
  ],
  providers: [singitToolsProvider],
};

export default singitPlugin;
