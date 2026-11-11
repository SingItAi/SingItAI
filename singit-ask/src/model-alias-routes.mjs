import { readFileSync } from "node:fs";
import { MAX_DESCRIPTION, payTail } from "./listing-copy.mjs";
const load = file => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const config = load("../config/model-aliases-wave1.json");
const names = new Map(load("../config/d4-model-aliases-first-wave.json").models.map(m => [m.id, m.name]));
export const aliasPath = m => `/v1/models/${m.id}/${m.suffix}`;
export function aliasDescription(m) {
  const text = `${m.name}: ${m.modality === "image" ? "Generate images" : "OpenAI-compatible chat API"}. ${payTail(m.modality === "image" ? "call" : "answer")} Models: GET /v1/catalog.`;
  if (text.length > MAX_DESCRIPTION || /ceiling|fee|markup|%|0x[a-fA-F0-9]{8,}|growth|on-chain limits/i.test(text)) throw new Error(`Invalid alias description: ${m.id}`);
  return text;
}
export const MODEL_ALIAS_ROUTES = Object.freeze(config.aliases.map(m => {
  if (!/^[a-z0-9._-]+$/.test(m.id) || !["chat", "image"].includes(m.modality)
      || m.suffix !== (m.modality === "chat" ? "chat" : "images")
      || m.base_path !== (m.modality === "chat" ? "/v1/chat/completions" : "/v1/images/generations") || !names.has(m.id)) throw new Error("Invalid alias config");
  const model = { ...m, name: names.get(m.id), provider: "model", family: [] };
  aliasDescription(model);
  return Object.freeze(model);
}));
if (new Set(MODEL_ALIAS_ROUTES.map(aliasPath)).size !== MODEL_ALIAS_ROUTES.length) throw new Error("Duplicate alias");
export const aliasPaths = catalogue => MODEL_ALIAS_ROUTES.filter(m => !catalogue?.isSuspended?.(m.id)).map(aliasPath);
export const aliasCopy = path => {
  const model = MODEL_ALIAS_ROUTES.find(m => aliasPath(m) === path);
  return model ? { description: aliasDescription(model), tags: [model.modality, model.id] } : null;
};
