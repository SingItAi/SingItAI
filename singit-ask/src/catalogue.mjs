// Every text model Surplus sells, read from Surplus itself: a hand-kept list of 400+ models would be stale
// the day a seller adds one. The list is public; the prices are per token in USD.

const TTL_MS = 6 * 60 * 60 * 1000;

export class UnknownModel extends Error {}

function parseModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    const arch = entry?.architecture;
    // Text in, text out, and able to cap its answer: anything else cannot be priced or bounded here.
    if (!id || !(prompt >= 0) || !(completion >= 0)) continue;
    if (arch?.modality !== "text->text" || !entry.supported_parameters?.includes("max_tokens")) continue;
    models.set(id, { id, name: String(entry.name || id), provider: String(entry.provider || ""),
      contextLength: Number(entry.context_length) || 0, promptUsdPerToken: prompt, completionUsdPerToken: completion });
  }
  return models;
}

export class ModelCatalogue {
  constructor({ url, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { url, fetchImpl, now });
    this.models = null;
    this.loadedAt = 0;
  }

  async all() {
    if (this.models && this.now() - this.loadedAt < TTL_MS) return this.models;
    try {
      const response = await this.fetchImpl(`${this.url}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      const models = response.ok ? parseModels(await response.json().catch(() => null)) : new Map();
      if (models.size) { this.models = models; this.loadedAt = this.now(); }
    } catch { /* keep the last list: a failed refresh must not take the endpoint down */ }
    if (!this.models) throw new UnknownModel("The model list is unavailable. Try again.");
    return this.models;
  }

  async resolve(id) {
    const model = (await this.all()).get(String(id ?? "").trim());
    if (!model) throw new UnknownModel("That model is not available.");
    return model;
  }

  async list() {
    return [...(await this.all()).values()].sort((a, b) => a.completionUsdPerToken - b.completionUsdPerToken);
  }
}
