// Pay for actual usage: the payer authorizes a ceiling with x402 `upto`, and CDP settles only what the
// answer cost, after it came back. A request that ends in 400 or above is never charged.
//
// Buyers that only sign `exact` (no `upto` support) get the same per-question ceiling as a flat, fixed-amount
// offer instead: there is no partial settlement or refund for `exact` (the signature authorizes one amount,
// and a facilitator cannot settle an exact payment for less than what was signed), so it is priced at the full
// ceiling and that is disclosed in the offer's own `extra.billing.mode`. `upto` is unaffected and keeps paying
// only the answer's actual cost.
import { ExpressAdapter, paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer, setSettlementOverrides } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { BASE, ASSET, SOLANA, SOLANA_ASSET, TERMS, SOLANA_TERMS, billUsage, ceilingAtomic } from "./pricing.mjs";
import { THINKING_HEADROOM } from "./limits.mjs";

// Actual model cost + 30% + the network's settlement fee. Solana's upto escrows the ceiling, then
// settles the actual amount and refunds the rest: two transactions, hence its higher fee.
const TERMS_BY_NETWORK = { [BASE]: TERMS, [SOLANA]: SOLANA_TERMS };

// The ceiling is decided per question, from the model it asks for, so the offer's price is a function of the
// request. `quotes` remembers what each parsed body was offered: the middleware asks again when the payment
// arrives and must get the same answer.
export const baseOffer = (config, quotes) => ({
  // 120 s covers the model and settlement; after it, a lost answer's signature is provably unusable.
  scheme: "upto", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120,
  price: ctx => {
    const amount = quotes.get(ctx.adapter.getBody())?.[BASE] ?? TERMS.maxChargeAtomic;
    return { asset: ASSET, amount, extra: { name: "USD Coin", version: "2", billing: { ...TERMS, maxChargeAtomic: amount } } };
  },
});
export const solanaOffer = (config, quotes) => ({
  scheme: "upto", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 300,
  price: ctx => {
    const amount = quotes.get(ctx.adapter.getBody())?.[SOLANA] ?? SOLANA_TERMS.maxChargeAtomic;
    return { asset: SOLANA_ASSET, amount, extra: { billing: { ...SOLANA_TERMS, maxChargeAtomic: amount } } };
  },
});

// `exact` at the same per-question ceiling `upto` offers, charged flat (see the file header for why). Reuses the
// same `quotes` lookup as the `upto` offers above, so both schemes are always quoted the same ceiling for a
// question, and `mode: "exact_ceiling"` in the offer's billing tells buyers this one is not metered.
export const exactBaseOffer = (config, quotes) => ({
  scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120,
  price: ctx => {
    const amount = quotes.get(ctx.adapter.getBody())?.[BASE] ?? TERMS.maxChargeAtomic;
    return { asset: ASSET, amount, extra: { name: "USD Coin", version: "2",
      billing: { ...TERMS, mode: "exact_ceiling", maxChargeAtomic: amount } } };
  },
});
export const exactSolanaOffer = (config, quotes) => ({
  scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 300,
  price: ctx => {
    const amount = quotes.get(ctx.adapter.getBody())?.[SOLANA] ?? SOLANA_TERMS.maxChargeAtomic;
    return { asset: SOLANA_ASSET, amount, extra: { billing: { ...SOLANA_TERMS, mode: "exact_ceiling", maxChargeAtomic: amount } } };
  },
});

// The ceiling each network's offer carries for this question.
export function ceilings(info, input) {
  const size = { chars: input.chars, maxTokens: input.maxTokens, headroom: THINKING_HEADROOM };
  return Object.fromEntries(Object.entries(TERMS_BY_NETWORK).map(([net, terms]) =>
    [net, info ? ceilingAtomic(info, size, terms) : terms.maxChargeAtomic]));
}

// The terms of the network the payer chose, with the ceiling this question was offered, and which scheme they
// signed. The middleware has already matched the payment to an offer, so the network is one of ours; the ceiling
// is ours, never the payer's.
function paidTerms(req) {
  const header = req.get("payment-signature") ?? req.get("x-payment");
  const { network, scheme } = JSON.parse(Buffer.from(header, "base64").toString()).accepted ?? {};
  const terms = TERMS_BY_NETWORK[network];
  return terms && { terms: { ...terms, maxChargeAtomic: req.askCeilings[network] }, scheme };
}

// A request with no body at all: what a directory's crawler sends to see whether a route takes payment.
export const isEmptyBody = body => body === undefined || body === null
  || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);

// x402scan registers a route only if an empty, unpaid request gets the 402 challenge (docs/DISCOVERY.md in
// Merit-Systems/x402scan), rather than the validation error a real, malformed request would get for having no
// model or no question. A request that carries a payment attempt is never treated as a probe, empty body or not:
// it must still be validated and rejected without charging, same as any other malformed paid request.
export const isDiscoveryProbe = req => isEmptyBody(req.body) && !(req.get("payment-signature") ?? req.get("x-payment"));

// A GET/HEAD request never carries a real x402 payment attempt here, no matter what headers it sends: hiding
// payment-signature/x-payment, rather than branching on them, is what guarantees `discoveryChallenge` below can
// never find a payload to verify or settle.
class DiscoveryAdapter extends ExpressAdapter {
  getHeader(name) {
    return ["payment-signature", "x-payment"].includes(name.toLowerCase()) ? undefined : super.getHeader(name);
  }
}

// x402scan, Coinbase's Bazaar and 402 Index probe a paid route with GET and HEAD before listing it, not just an
// empty POST; Express has no handler for those verbs on a POST-only route and answers with its own 404, which
// reads as "not for sale" to a crawler that only checks GET/HEAD. This answers them with the exact 402 an empty,
// unpaid POST gets from `httpServer`'s own route config: same offers, same Bazaar extension, same resource url.
// `context.method` is pinned to POST (never the request's real GET/HEAD) so the enriched extension and the
// resource both describe the route the one way it is actually called.
//
// The POST middleware loads the facilitator's supported kinds (fee payer, facilitator address) before its first
// challenge, and retries that load while it keeps failing; a GET that arrives first must not answer with a challenge
// missing those, so it waits for the same load. Once loaded, it is never reloaded from here: `initialize()` clears
// the kinds before fetching them again, which a concurrent POST must never see.
function discoveryChallenge(httpServer) {
  let loading = null;
  const ready = () => httpServer.ResourceServer.supportedResponsesMap?.size > 0 ? null
    : (loading ??= httpServer.initialize().finally(() => { loading = null; }));
  return async (req, res, next) => {
    const context = { adapter: new DiscoveryAdapter(req), path: req.path, decodedPath: req.path, method: "POST" };
    let result;
    try {
      await ready();
      result = await httpServer.processHTTPRequest(context);
    } catch {
      return res.status(503).json({ error: { message: "Try again shortly.", type: "upstream_error" } });
    }
    // With no payment header ever reaching it, processHTTPRequest never verifies or settles: anything but the
    // challenge (no route matched) is left to Express's own 404.
    if (result.type !== "payment-error") return next();
    const { response } = result;
    res.status(response.status);
    // Sent the way the POST middleware sends it, so a browser opening the URL gets the same paywall page.
    for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value);
    if (response.isHtml) res.send(response.body);
    else res.json(response.body || {});
  };
}

// One `x402HTTPResourceServer` per call, shared by the POST route(s) it pays for and their free GET/HEAD discovery
// challenge: `routes` is `paymentMiddleware`'s own shape, `{ "POST /the/route": { accepts, mimeType, ... } }`.
// `discoverable` should mirror whichever check already grants that route's empty-POST probe the same 402 (see
// `isDiscoveryProbe` above) — a route that does not offer that probe should not advertise itself over GET either.
export function addPaymentRoute(app, routes, server, { discoverable = true } = {}) {
  if (!server.hasExtension("bazaar")) server.registerExtension(bazaarResourceServerExtension);
  const httpServer = new x402HTTPResourceServer(server, routes);
  app.use(paymentMiddlewareFromHTTPServer(httpServer));
  if (discoverable) {
    for (const pattern of Object.keys(routes)) {
      const [verb, route] = pattern.split(" ");
      if (verb === "POST") app.get(route, discoveryChallenge(httpServer));
    }
  }
  return httpServer;
}

export function addUsageRoute(app, route, makeOffers, details, { facilitatorClient, config, readRequest, choose = async i => ({ ...i, model: config.model, info: null }), quotes = new WeakMap(), upstream, fetchImpl, log, offerEmptyProbe = false }) {
  const offers = makeOffers(quotes);
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new UptoEvmScheme())
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new UptoSvmScheme({ withdrawDelay: 300 }))
    .register(SOLANA, new ExactSvmScheme());
  // An unreadable question, or a model that is not offered, is refused before any payment is asked for.
  app.post(route, async (req, res, next) => {
    // It gets the standing offer; paying it with no question is still refused below.
    if (offerEmptyProbe && isDiscoveryProbe(req)) {
      req.askCeilings = ceilings(null, {});
      return next();
    }
    try {
      req.askInput = await choose(readRequest(req.body));
      req.askCeilings = ceilings(req.askInput.info, req.askInput);
      quotes.set(req.body, req.askCeilings);
      next();
    } catch (error) {
      if (!error.status) log(`singit-ask: model list failure (${error.name})`);
      res.status(error.status ?? 503).json({ error: { message: error.status ? error.message : "Try again shortly.",
        type: error.status ? "invalid_request_error" : "upstream_error" } });
    }
  });
  addPaymentRoute(app, { [`POST ${route}`]: { accepts: offers, mimeType: "application/json", ...details } }, server,
    { discoverable: offerEmptyProbe });
  app.post(route, async (req, res) => {
    const started = Date.now();
    try {
      const paid = paidTerms(req);
      if (!paid) throw new Error("payment on an unknown network");
      const answer = await upstream(config, req.askInput.messages, req.askInput.maxTokens, fetchImpl, req.askInput.model);
      const usage = billUsage(answer.usage, paid.terms);
      // `exact` already settled the full ceiling it was offered: there is no lower amount to settle to, and no
      // way to refund the unused part, so the override below is only ever for `upto`.
      const billing = paid.scheme === "exact" ? { ...usage, mode: "exact_ceiling", totalAtomic: paid.terms.maxChargeAtomic } : usage;
      if (paid.scheme !== "exact") setSettlementOverrides(res, { amount: billing.totalAtomic });
      log(`singit-ask: answered in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC`);
      res.json({ id: `singit-ask-${started}`, object: "chat.completion", created: Math.floor(started / 1000),
        model: "singit-ask", choices: [{ index: 0, message: { role: "assistant", content: answer.content },
          finish_reason: answer.finishReason }], usage: answer.usage, billing });
    } catch (error) {
      // Not settled: on Base nothing moves, on Solana the escrowed ceiling is refunded in full.
      log(`singit-ask: no billable answer after ${Date.now() - started} ms (${error.name})`);
      res.status(502).json({ error: { message: "No billable answer was produced. You were not charged; try again.",
        type: "upstream_error" } });
    }
  });
}
