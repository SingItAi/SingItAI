import { mapModel } from "./anthropic.js";
export const isAlias = model => ["auto", "singit/auto", "free", "singit/free"].includes(model);
export function resolveModel(id, { modelMap = {}, catalog } = {}) {
  const model = mapModel(id, modelMap);
  const rows = Array.isArray(catalog?.data) ? catalog.data : [];
  if (["auto", "singit/auto"].includes(model)) return catalog?.default || rows.find(item => typeof item?.id === "string" && !/music|sound|embed|image|video|speech|transcri/i.test(item.id))?.id || model;
  if (["free", "singit/free"].includes(model)) return rows.find(item => item?.id === "free/deepseek-v4.1-flash")?.id || rows.find(item => item?.id?.startsWith("free/"))?.id || model;
  return model;
}
