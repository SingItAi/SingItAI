import { sanitizeClient } from "./headers.js";

export const VERSION = "0.1.0";
export const DEFAULT_ASK_URL = "https://ask.singitai.app";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_PER_CALL_USD = 0.01;
export const DEFAULT_MAX_PER_DAY_USD = 1;
export const SOLANA_MIN_SUCCESS_PCT = 95;

function usdLimit(raw, name, fallback) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of USD.`);
  }
  return value;
}

function arg(argv, name) {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export function readConfig({ env = process.env, argv = [] } = {}) {
  const askUrl = (arg(argv, "ask-url") || env.SINGIT_ASK_URL || DEFAULT_ASK_URL).replace(/\/$/, "");
  try { new URL(askUrl); } catch { throw new Error("SINGIT_ASK_URL / --ask-url must be an absolute URL."); }
  const portRaw = arg(argv, "port") || env.SINGIT_PROXY_PORT || String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer 0–65535.");
  const host = arg(argv, "host") || env.SINGIT_PROXY_HOST || DEFAULT_HOST;
  const network = (arg(argv, "network") || env.SINGIT_NETWORK || "base").toLowerCase();
  if (network !== "base" && network !== "solana") {
    throw new Error('network must be "base" (default) or "solana".');
  }
  const clientRaw = arg(argv, "client") ?? env.SINGIT_CLIENT;
  if (clientRaw != null && clientRaw !== "" && sanitizeClient(clientRaw, null) == null) {
    throw new Error("SINGIT_CLIENT / --client must be a short product label (for example openclaw or continue).");
  }
  return {
    askUrl,
    host,
    port,
    network,
    client: sanitizeClient(clientRaw, "singit-proxy"),
    rpcUrl: env.SINGIT_RPC_URL || undefined,
    maxPerCallUsd: usdLimit(arg(argv, "max-per-call") ?? env.SINGIT_MAX_PER_CALL_USD, "SINGIT_MAX_PER_CALL_USD", DEFAULT_MAX_PER_CALL_USD),
    maxPerDayUsd: usdLimit(arg(argv, "max-per-day") ?? env.SINGIT_MAX_PER_DAY_USD, "SINGIT_MAX_PER_DAY_USD", DEFAULT_MAX_PER_DAY_USD),
  };
}

/** Solana is allowed only when ask.singitai.app reports paid success at or above SOLANA_MIN_SUCCESS_PCT.
 *  A missing or unpublished figure is treated as below the gate (Base stays the default). */
export async function assertNetworkAllowed(network, { askUrl, fetchImpl = fetch } = {}) {
  if (network === "base") return;
  let pct = null;
  try {
    const response = await fetchImpl(`${askUrl}/numbers.json`, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const body = await response.json();
      const reported = body?.paid_call_success?.last_7d?.solana?.success_pct
        ?? body?.paid_call_success?.last_24h?.solana?.success_pct;
      if (typeof reported === "number" && Number.isFinite(reported)) pct = reported;
    }
  } catch { /* treated as unknown below */ }
  if (pct == null || pct < SOLANA_MIN_SUCCESS_PCT) {
    const seen = pct == null ? "unknown" : `${pct}%`;
    throw new Error(`Solana is not enabled until paid success is at least ${SOLANA_MIN_SUCCESS_PCT}% (currently ${seen}). Use Base (the default).`);
  }
}
