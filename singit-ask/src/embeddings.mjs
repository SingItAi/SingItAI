import { readBoundedJson, validImage, validEmbedding } from "./media-response.mjs";
// E5: embeddings; exact price on a conservative input estimate, settled after upstream success.
import { paymentDigest, reservations as used } from "./media-payment-replay.mjs";
import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { UnknownModel } from "./catalogue.mjs";
import { addPaymentRoute, isDiscoveryProbe, perRequest } from "./metered.mjs";
import { ASSET, BASE, SOLANA, SOLANA_ASSET, ICON_URL, discoveryTags } from "./pricing.mjs";

export const ROUTE = "/v1/embeddings";
import { imagePrice } from "./images.mjs";

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Keep discovery descriptions within 160 characters, capability first (see app.mjs).
const DESCRIPTION = "Text embeddings API in OpenAI format. String or batch input, float or base64 output. USDC on Base or Solana, no key.";

import { readEmbeddingRequest, INPUT_SCHEMA, EXAMPLE, OUTPUT_SCHEMA, OUTPUT_EXAMPLE, listAtomic as estimateListAtomic, maxListAtomic, catalogueCeiling } from "./embeddings-request.mjs";
export const REQUEST_BODY = () => ({ required: true, content: { "application/json": { schema: { type: "object", ...INPUT_SCHEMA }, example: EXAMPLE } } });

export function addRoutes(app, config, { facilitatorClient, publicClient, catalogue, fetchImpl = fetch, log = console.error, open }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  const priced = new WeakMap();   // parsed body -> { request, listAtomic }

  // The discovery probes (GET/HEAD and the empty, unpaid POST) are offered what EXAMPLE, the body declared to
  // Bazaar below, is offered right now: the price CDP's Bazaar records for this route and what vet402 compares its
  // empty POST against (price_mismatch otherwise). The model-list ceiling only when it cannot be quoted right now.
  const probeList = perRequest(async () => {
    try {
      const model = await catalogue.resolveEmbedding(EXAMPLE.model);
      const listAtomic = estimateListAtomic(model, readEmbeddingRequest(EXAMPLE, model, config));
      return listAtomic;
    } catch {
      return catalogueCeiling(catalogue, config);
    }
  });
  const price = (network) => async (ctx) => {
    const quote = priced.get(ctx.adapter.getBody());
    const amount = imagePrice(quote?.listAtomic ?? await probeList(ctx), network).totalAtomic;
    return network === BASE ? { asset: ASSET, amount, extra: { name: "USD Coin", version: "2" } } : { asset: SOLANA_ASSET, amount };
  };
  app.post(ROUTE, async (req, res, next) => {
    // x402scan's empty, unpaid probe gets the example's offer (`probeList`), not a model-lookup 404;
    // paying it with no input is still refused once a signature arrives, in the handler below.
    if (isDiscoveryProbe(req)) return next();
    try {
      const model = await catalogue.resolveEmbedding(req.body?.model);
      const request = readEmbeddingRequest(req.body, model, config);
      const listAtomic = estimateListAtomic(model, request);
      if (!Number.isSafeInteger(listAtomic) || listAtomic < 0 || listAtomic > maxListAtomic(model, config)) throw new RequestError(422, "This request exceeds the price ceiling.");
      priced.set(req.body, { request, listAtomic });
      next();
    } catch (error) {
      const status = error instanceof UnknownModel ? 404 : error.status ?? 503;
      if (status === 503) res.set("Retry-After", "30");
      res.status(status).json({ error: { type: status === 503 ? "upstream_error" : "invalid_request_error",
        code: status === 404 ? "model_not_found" : status === 503 ? "upstream_unavailable" : "invalid_request", message: status === 503 ? "Try again shortly." : error.message } });
    }
  });
  addPaymentRoute(app, { [`POST ${ROUTE}`]: {
    // exact on Base first: the simplest offer for a buyer that only inspects accepts[0].
    accepts: [
      { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 180, price: price(BASE) },
      { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 180, price: price(SOLANA) },
    ],
    mimeType: "application/json", description: DESCRIPTION, serviceName: "SingIt Embeddings", iconUrl: ICON_URL,
    tags: discoveryTags("embeddings", "text", "openai-compatible", "pay-per-use", "solana",
                        "base", "singit"),
    extensions: declareDiscoveryExtension({ bodyType: "json",
      input: EXAMPLE,
      inputSchema: INPUT_SCHEMA, output: { example: OUTPUT_EXAMPLE, schema: OUTPUT_SCHEMA } }),
  } }, server, { log, publicClient });
  app.post(ROUTE, async (req, res) => {
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const payment = JSON.parse(Buffer.from(header, "base64").toString());
    const network = payment.accepted?.network;
    const seen = paymentDigest(payment);
    if (used.has(seen)) return res.status(409).json({ error: { type: "invalid_request_error", code: "payment_duplicate", message: "This payment was already used." } });
    used.set(seen, Date.now());
    for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
    const { request, listAtomic } = priced.get(req.body);
    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(`${config.surplusUrl}${ROUTE}`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.surplusKey}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(150_000) });
    } catch (error) {
      log(`singit-ask: upstream unreachable`);
      return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "no_billable_answer", message: "No embeddings were returned. You were not charged." } });
    }
    const data = await readBoundedJson(response, config.maxEmbeddingResponseBytes ?? 8 * 1024 * 1024).catch(() => null);
    const embeddings = Array.isArray(data?.data) ? data.data.filter((d, index) =>
      d && d.index === index && validEmbedding(d.embedding, request.encoding_format)) : [];
    if (!response.ok || embeddings.length !== (Array.isArray(request.input) ? request.input.length : 1)) {
      log(`singit-ask: upstream returned no usable result`);
      return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "no_billable_answer", message: "No embeddings were returned. You were not charged." } });
    }
    const cost = Number(response.headers.get("x-si-buyer-cost-micro"));
    if (Number.isFinite(cost) && cost > listAtomic) log(`singit-ask: upstream cost ${cost} micro-USD, listed ${listAtomic}`);
    const billing = { ...imagePrice(listAtomic, network), currency: "USDC" };
    log(`singit-ask: ${embeddings.length} embedding(s) in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC`);
    res.json({ object: "list", data: embeddings, model: request.model, usage: data.usage, billing });
  });
}
