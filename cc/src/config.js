import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionDir } from "@singitai/session-wallet";
import { sanitizeClient, DEFAULT_CLIENT } from "./headers.js";

export const VERSION = "0.1.0";
export const DEFAULT_ASK_URL = "https://ask.singitai.app";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8403;
export const DEFAULT_MAX_PER_CALL_USD = 0.01;
export const DEFAULT_MAX_PER_DAY_USD = 1;
export const SOLANA_MIN_SUCCESS_PCT = 95;
// Ask's /v1/messages accepts up to 32000 and its 402 ceiling grows with max_tokens.
export const MAX_TOKENS_LIMIT = 32000;
export const DEFAULT_MAX_TOKENS = 8192;
// "auto" resolves to GET /v1/models `default`; this id is used when the catalogue cannot be read.
export const AUTO = "auto";
export const FALLBACK_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_FREE_MODEL = "free/deepseek-v4.1-flash";

export const configPath = (env = process.env) => path.join(sessionDir(env), "config.json");

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const model = name => raw => {
  if (typeof raw !== "string" || !MODEL_ID.test(raw)) throw new Error(`${name} must be a model id from GET /v1/models (or "auto").`);
  return raw;
};
const usd = name => raw => {
  const value = Number(raw);
  if (raw === "" || raw == null || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of USD.`);
  return value;
};

// Everything `singit-cc config set` may store in ~/.singit/config.json. There is deliberately no key
// for a wallet key, token or secret.
export const CONFIG_KEYS = {
  network: raw => {
    const value = String(raw).toLowerCase();
    if (value !== "base" && value !== "solana") throw new Error('network must be "base" (default) or "solana".');
    return value;
  },
  port: raw => {
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < 0 || value > 65535) throw new Error("port must be an integer 0–65535.");
    return value;
  },
  defaultModel: model("defaultModel"),
  sonnetModel: model("sonnetModel"),
  opusModel: model("opusModel"),
  haikuModel: model("haikuModel"),
  freeModel: raw => (raw === "" || raw === "none" ? "" : model("freeModel")(raw)),
  maxTokens: raw => {
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < 1 || value > MAX_TOKENS_LIMIT) throw new Error(`maxTokens must be 1 to ${MAX_TOKENS_LIMIT}.`);
    return value;
  },
  maxPerCallUsd: usd("maxPerCallUsd"),
  maxPerDayUsd: usd("maxPerDayUsd"),
  fallback: raw => {
    if (raw === true || raw === "true" || raw === "on") return true;
    if (raw === false || raw === "false" || raw === "off") return false;
    throw new Error("fallback must be true or false.");
  },
};

export const DEFAULTS = Object.freeze({
  network: "base", port: DEFAULT_PORT,
  defaultModel: AUTO, sonnetModel: AUTO, opusModel: AUTO, haikuModel: AUTO, freeModel: DEFAULT_FREE_MODEL,
  maxTokens: DEFAULT_MAX_TOKENS, maxPerCallUsd: DEFAULT_MAX_PER_CALL_USD, maxPerDayUsd: DEFAULT_MAX_PER_DAY_USD,
  fallback: true,
});

/** `sonnet-model` and `sonnetModel` both name the same key. */
export function configKey(name) {
  const key = String(name ?? "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!Object.hasOwn(CONFIG_KEYS, key)) {
    throw new Error(`Unknown config key "${name}". Keys: ${Object.keys(CONFIG_KEYS).join(", ")}.`);
  }
  return key;
}

/** The validated contents of ~/.singit/config.json ({} when there is none). Unknown keys are ignored. */
export function readStored(env = process.env) {
  const file = configPath(env);
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read ${file} (${error.code}).`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON; fix or remove it.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object.`);
  const stored = {};
  for (const [key, check] of Object.entries(CONFIG_KEYS)) {
    if (parsed[key] !== undefined) stored[key] = check(parsed[key]);
  }
  return stored;
}

export function writeStored(stored, env = process.env) {
  const file = configPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

/** Flags: `--name value` and bare booleans (`--no-launch`). Everything after `--` is left for claude. */
export function parseArgs(argv = []) {
  const flags = {}, positional = [];
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const BOOLEAN = new Set(["no-launch", "no-fallback", "json", "clear", "help", "version"]);
  for (let i = 0; i < own.length; i++) {
    const item = own[i];
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const [name, inline] = item.slice(2).split(/=(.*)/s);
    if (BOOLEAN.has(name)) flags[name] = true;
    else if (inline !== undefined) flags[name] = inline;
    else {
      if (i + 1 >= own.length) throw new Error(`--${name} needs a value.`);
      flags[name] = own[++i];
    }
  }
  return { flags, positional, passthrough: split === -1 ? [] : argv.slice(split + 1) };
}

/** Defaults < ~/.singit/config.json < environment < flags. */
export function readConfig({ env = process.env, flags = {} } = {}) {
  const stored = readStored(env);
  const pick = (key, envName, flag) => {
    const raw = flags[flag] ?? (envName && env[envName] !== "" ? env[envName] : undefined);
    return raw !== undefined ? CONFIG_KEYS[key](raw) : stored[key] ?? DEFAULTS[key];
  };
  const askUrl = (flags["ask-url"] || env.SINGIT_ASK_URL || DEFAULT_ASK_URL).replace(/\/$/, "");
  try { new URL(askUrl); } catch { throw new Error("SINGIT_ASK_URL / --ask-url must be an absolute URL."); }
  const clientRaw = flags.client ?? env.SINGIT_CLIENT;
  if (clientRaw != null && clientRaw !== "" && sanitizeClient(clientRaw, null) == null) {
    throw new Error("SINGIT_CLIENT / --client must be a short allowlisted product label.");
  }
  const override = flags.model ?? env.SINGIT_CC_MODEL;
  return {
    askUrl,
    host: flags.host || env.SINGIT_CC_HOST || DEFAULT_HOST,
    port: pick("port", "SINGIT_CC_PORT", "port"),
    network: pick("network", "SINGIT_NETWORK", "network"),
    client: sanitizeClient(clientRaw, DEFAULT_CLIENT),
    rpcUrl: env.SINGIT_RPC_URL || undefined,
    maxPerCallUsd: pick("maxPerCallUsd", "SINGIT_MAX_PER_CALL_USD", "max-per-call"),
    maxPerDayUsd: pick("maxPerDayUsd", "SINGIT_MAX_PER_DAY_USD", "max-per-day"),
    maxTokens: pick("maxTokens", "SINGIT_CC_MAX_TOKENS", "max-tokens"),
    // --model pins what "auto" (and a missing model) means for this run; config defaultModel is the stored form.
    defaultModel: override ? CONFIG_KEYS.defaultModel(override) : stored.defaultModel ?? DEFAULTS.defaultModel,
    sonnetModel: stored.sonnetModel ?? DEFAULTS.sonnetModel,
    opusModel: stored.opusModel ?? DEFAULTS.opusModel,
    haikuModel: stored.haikuModel ?? DEFAULTS.haikuModel,
    freeModel: stored.freeModel ?? DEFAULTS.freeModel,
    fallback: flags["no-fallback"] ? false : stored.fallback ?? DEFAULTS.fallback,
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
  // The gate is open, but ~/.singit/session holds a Base (EVM) key only; refuse rather than start a
  // proxy that cannot sign.
  throw new Error("Solana passed the paid-success gate, but this version signs with the Base wallet in ~/.singit/session only. Use Base (the default).");
}
