import { readSetting } from "../settings.js";

// Tells the agent which SingIt tools/actions it currently has, based on configured settings —
// so the model does not try SINGIT_WEB_SEARCH or SINGIT_PAID_CHAT when they are not configured.
export const singitToolsProvider = {
  name: "SINGIT_TOOLS",
  description: "Which SingIt actions (free MCP tools, paid MCP tools, x402 paid chat) are available right now.",
  get: async (runtime, _message, _state) => {
    const hasApiKey = Boolean(readSetting(runtime, "SINGIT_API_KEY"));
    const hasWallet = Boolean(readSetting(runtime, "SINGIT_EVM_PRIVATE_KEY"));
    const hasCaps = readSetting(runtime, "SINGIT_MAX_PER_CALL_USD") != null
      && readSetting(runtime, "SINGIT_MAX_PER_DAY_USD") != null;
    const free = ["SINGIT_GET_PRICE", "SINGIT_LIST_PRICE_SYMBOLS", "SINGIT_LIST_MODELS"];
    const paid = hasApiKey ? ["SINGIT_WEB_SEARCH", "SINGIT_READ_PAGE"] : [];
    const x402 = hasWallet && hasCaps ? ["SINGIT_PAID_CHAT"] : [];
    const available = [...free, ...paid, ...x402];
    const lines = [
      `Always available (no key): ${free.join(", ")}.`,
      hasApiKey ? `API-key tools available: ${paid.join(", ")}.` : "API-key tools unavailable: set SINGIT_API_KEY to enable SINGIT_WEB_SEARCH and SINGIT_READ_PAGE.",
      x402.length
        ? `x402 paid chat available: ${x402.join(", ")}.`
        : "x402 paid chat unavailable: set SINGIT_EVM_PRIVATE_KEY, SINGIT_MAX_PER_CALL_USD and SINGIT_MAX_PER_DAY_USD to enable SINGIT_PAID_CHAT.",
    ];
    return { text: lines.join(" "), values: { singitAvailableActions: available }, data: { hasApiKey, hasWallet, hasCaps, available } };
  },
};
