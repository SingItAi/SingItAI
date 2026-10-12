// Every text model Surplus sells, read from Surplus itself: a hand-kept list of 400+ models would be stale
// the day a seller adds one. The list is public; the prices are per token in USD.

const TTL_MS = 6 * 60 * 60 * 1000;
// The marketplace's cheapest offers move; the page showing them is public and large (about 1.7 MB), so ten minutes.
const MARKET_TTL_MS = 10 * 60 * 1000;

export class UnknownModel extends Error {}

// What a model can do, in the picker's own category keys (the ones Venice's list uses). Surplus says it through the
// inputs a model accepts and its features; coding models are mostly marked only by name.
const CODE_NAME = /coder|codex|devstral|(^|[-.])code([-.:]|$)/i;
export function capabilities(entry, inputs) {
  const features = new Set(entry?.supported_features ?? []);
  const tags = [];
  if (inputs.includes("image") || features.has("vision")) tags.push("vision");
  if (features.has("code") || CODE_NAME.test(String(entry?.id ?? ""))) tags.push("code");
  if (features.has("reasoning")) tags.push("reasoning");
  if (inputs.includes("video")) tags.push("video");
  if (inputs.includes("audio") || features.has("audio")) tags.push("audio");
  if (features.has("e2ee") || features.has("tee_attestation") || String(entry?.id ?? "").startsWith("e2ee-")) tags.push("private");
  return tags;
}

function parseModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data?.data) ? data.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const prompt = Number(entry?.pricing?.prompt);
    const completion = Number(entry?.pricing?.completion);
    const arch = entry?.architecture;
    // Text out and text accepted, and able to cap its answer: anything else cannot be priced or bounded here.
    // A model that also reads images or files (modality "text+image->text") still answers plain text questions.
    const [from, to] = String(arch?.modality ?? "").split("->");
    const inputs = arch?.input_modalities ?? from.split("+");
    const outputs = arch?.output_modalities ?? to?.split("+") ?? [];
    if (!id || !(prompt >= 0) || !(completion >= 0)) continue;
    if (!inputs.includes("text") || outputs.length !== 1 || outputs[0] !== "text") continue;
    if (!entry.supported_parameters?.includes("max_tokens")) continue;
    models.set(id, { id, name: String(entry.name || id), provider: String(entry.provider || ""),
      contextLength: Number(entry.context_length) || 0, promptUsdPerToken: prompt, completionUsdPerToken: completion,
      tags: capabilities(entry, inputs) });
  }
  return models;
}

// What Surplus's trusted sellers ask per model, as a share of list price (best_trusted_offer_discount_pct). Measured
// on 12 October it was the closest of Surplus's figures to what answers really cost; the best offer was not.
function parseMarket(data) {
  const market = new Map();
  for (const entry of Array.isArray(data?.data?.markets) ? data.data.markets : []) {
    const discount = entry?.best_trusted_offer_discount_pct;
    if (typeof entry?.model === "string" && typeof discount === "number" && discount >= 0 && discount <= 100)
      market.set(entry.model, { trustedShare: (100 - discount) / 100 });
  }
  return market;
}

// Both lists are read from Surplus, which takes a second or three; a visitor must never wait for that. What is
// cached is served at once even when it is old, and one refresh at a time runs in the background. Only the very
// first read, with nothing cached yet, waits.
export class ModelCatalogue {
  constructor({ url, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { url, fetchImpl, now });
    this.models = null;
    this.loadedAt = 0;
    this.prices = null;
    this.pricesAt = 0;
    this.loadingModels = null;
    this.loadingPrices = null;
  }

  // One request in flight at a time; a failed refresh keeps what was cached and is retried at the next read.
  loadModels() {
    this.loadingModels ??= (async () => {
      try {
        const response = await this.fetchImpl(`${this.url}/v1/models`, { signal: AbortSignal.timeout(10_000) });
        const models = response.ok ? parseModels(await response.json().catch(() => null)) : new Map();
        if (models.size) { this.models = models; this.loadedAt = this.now(); }
      } catch { /* keep the last list: a failed refresh must not take the endpoint down */ }
      finally { this.loadingModels = null; }
    })();
    return this.loadingModels;
  }

  loadPrices() {
    this.loadingPrices ??= (async () => {
      try {
        const response = await this.fetchImpl(`${this.url}/api/marketplace`, { signal: AbortSignal.timeout(15_000) });
        const prices = response.ok ? parseMarket(await response.json().catch(() => null)) : new Map();
        if (prices.size) { this.prices = prices; this.pricesAt = this.now(); }
      } catch { /* keep the last prices */ }
      finally { this.loadingPrices = null; }
    })();
    return this.loadingPrices;
  }

  async all() {
    if (!this.models) await this.loadModels();
    else if (this.now() - this.loadedAt >= TTL_MS) this.loadModels();
    if (!this.models) throw new UnknownModel("The model list is unavailable. Try again.");
    return this.models;
  }

  // The trusted sellers' share of list price per model id, or an empty map when the marketplace cannot be read.
  async market() {
    if (!this.prices) await this.loadPrices();
    else if (this.now() - this.pricesAt >= MARKET_TTL_MS) this.loadPrices();
    return this.prices ?? new Map();
  }

  // Read both now, then keep them fresh, so the first visitor after a start and every one after finds them ready.
  async warm(everyMs = MARKET_TTL_MS / 2) {
    await Promise.all([this.loadModels(), this.loadPrices()]);
    this.timer ??= setInterval(() => { this.loadModels(); this.loadPrices(); }, everyMs);
    this.timer.unref?.();
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
