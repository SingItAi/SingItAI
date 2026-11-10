// Configuration only. All inference goes through the existing local proxy.
export function resolveAlias(id, catalog) {
  const rows = Array.isArray(catalog?.data) ? catalog.data : [];
  if (["auto", "singit/auto"].includes(id)) return catalog?.default || rows.find(row => typeof row?.id === "string" && !/music|sound|embed|image|video|speech|transcri/i.test(row.id))?.id || id;
  if (["free", "singit/free"].includes(id)) return rows.find(row => row?.id === "free/deepseek-v4.1-flash")?.id || rows.find(row => row?.id?.startsWith("free/"))?.id || id;
  return id;
}
export function createProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const port = env.SINGIT_PROXY_PORT || "8787";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid SINGIT_PROXY_PORT");
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  let catalog;
  let pending;
  const model = id => ({ id: resolveAlias(id, catalog), name: id, provider: "singit", api: "openai-completions", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 });
  async function load() {
    pending ??= fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : undefined).catch(() => undefined);
    catalog = await pending;
  }
  return {
    id: "singit", label: "SingIt", baseUrl, api: "openai-completions", auth: [],
    catalog: { order: "simple", async run() {
      await load();
      const ids = catalog?.data?.map(row => row.id).filter(id => typeof id === "string") || ["auto", "free"];
      return { provider: { baseUrl, api: "openai-completions", auth: "none", models: ids.map(model) } };
    } },
    resolveDynamicModel: ctx => model(ctx.modelId),
    async prepareDynamicModel(ctx) { await load(); return model(ctx.modelId); },
  };
}
export default { id: "singit", name: "SingIt", register(api) { api.registerProvider(createProvider()); } };
