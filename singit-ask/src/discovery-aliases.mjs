// SI-297: alternate public names a buyer may use for a catalog model (a vendor prefix, an undated id). Discovery
// only: GET /v1/models/<name> answers with the canonical card, and a chat request naming one is answered and billed
// as the canonical model. Not model-aliases.mjs, which maps public ids to upstream Surplus ids.
//
// Lookup order: the exact catalog id always wins (case-insensitive), then this table, then, for a name with a
// vendor prefix, its last path segment when that is itself a catalog id. Never map a name to a different model
// (kimi-k3 and kimi-k3.1-pro are two models).
import { MODEL_ROUTES } from "./model-routes.mjs";
import { MODEL_ALIAS_ROUTES } from "./model-alias-routes.mjs";

export const DISCOVERY_ALIASES = Object.freeze({
  "openai/gpt-6-luna": "gpt-6-luna",
  "google/gemini-4-argon": "gemini-4-argon",
  "moonshot/kimi-k3.1-pro": "kimi-k3.1-pro",
  "moonshotai/kimi-k3.1-pro": "kimi-k3.1-pro",
  "minimax/minimax-m3": "minimax-m3",
  "qwen3.8-max": "qwen3.8-max-0902",
  "qwen/qwen3.8-max": "qwen3.8-max-0902",
  "qwen/qwen3.8-max-0902": "qwen3.8-max-0902",
  "grok-imagine-image": "venice-grok-imagine",
  "xai/grok-imagine-image": "venice-grok-imagine",
});

// "free/<id>" is a different (free) offer and "singit/…" names our routers: neither falls back to its tail. A tail of
// chat or images is a D4 paid alias path (/v1/models/<id>/chat), not a vendor prefix.
const RESERVED_PREFIXES = new Set(["free", "singit"]);
const RESERVED_TAILS = new Set(["chat", "images"]);

const routed = new Set([...MODEL_ROUTES, ...MODEL_ALIAS_ROUTES].map(m => m.id.toLowerCase()));
for (const [alias, id] of Object.entries(DISCOVERY_ALIASES)) {
  if (alias !== alias.toLowerCase() || alias === id || Object.hasOwn(DISCOVERY_ALIASES, id) || routed.has(alias)
      || RESERVED_PREFIXES.has(alias.split("/")[0]) || RESERVED_TAILS.has(alias.split("/").at(-1))) {
    throw new Error(`discovery-aliases.mjs: invalid alias ${alias}`);
  }
}

// Other names to try for `id` after the exact id, best first.
export function aliasCandidates(id) {
  const name = String(id ?? "").trim().toLowerCase();
  const out = Object.hasOwn(DISCOVERY_ALIASES, name) ? [DISCOVERY_ALIASES[name]] : [];
  const parts = name.split("/");
  if (parts.length > 1 && parts.every(Boolean) && !RESERVED_PREFIXES.has(parts[0]) && !RESERVED_TAILS.has(parts.at(-1))) {
    out.push(parts.at(-1));
  }
  return out;
}

// The canonical id among `ids` that `id` names, or null.
export function resolveDiscoveryId(id, ids) {
  const all = [...ids];
  const name = String(id ?? "").trim();
  if (all.includes(name)) return name;
  const byLower = new Map(all.map(x => [x.toLowerCase(), x]));
  for (const candidate of [name.toLowerCase(), ...aliasCandidates(name)]) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return null;
}

// The table's alternate names for a canonical id (never the id itself).
export const aliasesFor = id => Object.keys(DISCOVERY_ALIASES).filter(alias => DISCOVERY_ALIASES[alias] === id);
