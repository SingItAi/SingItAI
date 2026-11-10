// SingIt MCP server (stdio). Three tools over SingIt Ask (https://ask.singitai.app):
//   singit_wallet  the local wallet's address and how to fund it
//   singit_models  the model catalogue (free)
//   singit_chat    a chat completion, paid per call in USDC on Base over x402 from the local wallet
// With SINGIT_API_KEY set, requests carry that key instead and no wallet is created or read.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SingIt, NETWORKS } from "@singitai/sdk";
import { loadWallet, loadOrCreateWallet, sessionPath, NETWORK } from "./wallet.js";

export const VERSION = "0.1.0";

function withClientHeader(fetchImpl, value) {
  return (input, init) => {
    if (typeof Request !== "undefined" && input instanceof Request) {
      const headers = new Headers(input.headers);
      if (!headers.has("x-singit-client")) headers.set("x-singit-client", value);
      return fetchImpl(new Request(input, { headers }), init);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("x-singit-client")) headers.set("x-singit-client", value);
    return fetchImpl(input, { ...init, headers });
  };
}
export const DEFAULT_ASK_URL = "https://ask.singitai.app";
export const DEFAULT_APP_URL = "https://app.singitai.app";
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_MAX_PER_CALL_USD = 0.5;
export const DEFAULT_MAX_PER_DAY_USD = 5;

function usdLimit(env, name, fallback) {
  if (env[name] == null || env[name] === "") return fallback;
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of USD.`);
  return value;
}

export function readConfig(env = process.env) {
  const askUrl = (env.SINGIT_ASK_URL || DEFAULT_ASK_URL).replace(/\/$/, "");
  const appUrl = (env.SINGIT_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
  try { new URL(askUrl); } catch { throw new Error("SINGIT_ASK_URL must be an absolute URL."); }
  try { new URL(appUrl); } catch { throw new Error("SINGIT_APP_URL must be an absolute URL."); }
  return {
    askUrl,
    appUrl,
    apiKey: env.SINGIT_API_KEY || null,
    rpcUrl: env.SINGIT_RPC_URL || undefined,
    maxPerCallUsd: usdLimit(env, "SINGIT_MAX_PER_CALL_USD", DEFAULT_MAX_PER_CALL_USD),
    maxPerDayUsd: usdLimit(env, "SINGIT_MAX_PER_DAY_USD", DEFAULT_MAX_PER_DAY_USD),
  };
}

const json = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = message => ({ isError: true, content: [{ type: "text", text: message }] });

const fundingHint = address =>
  `Send USDC on Base (${NETWORK}, token ${NETWORKS.base.asset}) to ${address}. `
  + "Payments are signed authorizations, so no ETH is needed for gas. Prices per model: singit_models.";

async function failedBody(response) {
  const text = await response.text().catch(() => "");
  return text.slice(0, 300);
}

export function createServer({ env = process.env, fetchImpl = fetch } = {}) {
  const config = readConfig(env);
  const limits = { maxPerCallUsd: config.maxPerCallUsd, maxPerDayUsd: config.maxPerDayUsd };
  fetchImpl = withClientHeader(fetchImpl, `singit-mcp/${VERSION}`);
  const server = new McpServer({ name: "singit", version: VERSION });

  // One SingIt per process: its per-day ceiling is counted in memory on the instance.
  let singit = null;
  let singitAddress = null;
  function payer() {
    const { wallet } = loadOrCreateWallet(env);
    if (!singit || singitAddress !== wallet.address) {
      singit = new SingIt({ evmPrivateKey: wallet.privateKey, network: "base", baseUrl: config.askUrl,
        rpcUrl: config.rpcUrl, ...limits, fetchImpl });
      singitAddress = wallet.address;
    }
    return { singit, address: wallet.address };
  }

  server.registerTool("singit_wallet", {
    title: "SingIt wallet",
    description: "The local wallet that pays for singit_chat: its public address, network (Base) and how to fund it "
      + "with USDC. action \"status\" only reports; \"setup\" also creates the wallet if there is none. "
      + "Never returns the private key.",
    inputSchema: { action: z.enum(["setup", "status"]).default("status").describe("\"setup\" creates the wallet if missing; \"status\" only reports.") },
  }, async ({ action }) => {
    if (config.apiKey) {
      return json({ mode: "api_key", walletExists: false,
        message: "SINGIT_API_KEY is set: requests are billed to that key and there is no local wallet. "
          + "Unset SINGIT_API_KEY to pay from a local wallet instead." });
    }
    try {
      const found = action === "setup" ? loadOrCreateWallet(env) : loadWallet(env);
      if (!found) {
        return json({ mode: "wallet", walletExists: false, network: NETWORK, walletFile: sessionPath(env),
          message: "No wallet yet. Call singit_wallet with action \"setup\" (or just call singit_chat) to create one." });
      }
      return json({
        mode: "wallet", walletExists: true, ...(action === "setup" ? { created: found.created } : {}),
        address: found.address, network: NETWORK, asset: "USDC",
        keySource: found.source === "env" ? "SINGIT_WALLET_KEY" : sessionPath(env),
        limits, funding: fundingHint(found.address),
      });
    } catch (error) {
      return failure(error.message);
    }
  });

  server.registerTool("singit_models", {
    title: "SingIt models",
    description: "List the models SingIt Ask sells, with prices. Free: no payment and no key.",
    inputSchema: {},
  }, async () => {
    try {
      const response = await fetchImpl(`${config.askUrl}/v1/models`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) return failure(`GET /v1/models returned HTTP ${response.status}: ${await failedBody(response)}`);
      return json(await response.json());
    } catch (error) {
      return failure(`Could not reach ${config.askUrl}: ${error.message}`);
    }
  });

  server.registerTool("singit_chat", {
    title: "SingIt chat",
    description: `One chat completion from SingIt Ask (model ids: singit_models; default ${DEFAULT_MODEL}). `
      + "Paid per call in USDC on Base over x402 from the local wallet (created on first use), within the "
      + "configured per-call and per-day limits. Returns the completion with what was paid.",
    inputSchema: {
      model: z.string().min(1).default(DEFAULT_MODEL).describe("Model id from singit_models."),
      messages: z.array(z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      })).min(1).describe("OpenAI-style chat messages."),
      max_tokens: z.number().int().positive().optional(),
    },
  }, async ({ model, messages, max_tokens }) => {
    if (config.apiKey) {
      try {
        // Keys are billed at app.singitai.app/v1, not ask.singitai.app (ask is x402-only).
        const response = await fetchImpl(`${config.appUrl}/v1/chat/completions`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model, messages, ...(max_tokens != null ? { max_tokens } : {}), stream: false }),
        });
        // A 402 is a payment demand, not an answer.
        if (response.status === 402) {
          return failure("SingIt Ask answered HTTP 402 (payment required): the API key did not pay for this request, "
            + "so there is no answer. Check the key and its limits, or unset SINGIT_API_KEY to pay from a local wallet.");
        }
        if (!response.ok) return failure(`Request failed with HTTP ${response.status}: ${await failedBody(response)}`);
        return json(await response.json());
      } catch (error) {
        return failure(`Request failed: ${error.message}`);
      }
    }
    let address;
    try {
      const paying = payer();
      address = paying.address;
      // chat() resolves only with a 2xx body; a 402 it cannot pay, or any other status, throws.
      return json(await paying.singit.chat({ model, messages, max_tokens }));
    } catch (error) {
      return failure(address ? `${error.message}\n\nPaying wallet: ${address}. If it is empty: ${fundingHint(address)}` : error.message);
    }
  });

  return server;
}
