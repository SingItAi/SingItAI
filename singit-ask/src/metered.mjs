// Pay for actual usage: the payer authorizes a ceiling with x402 `upto`, and CDP settles only what the
// answer cost, after it came back. A request that ends in 400 or above is never charged.
import { paymentMiddleware, x402ResourceServer, setSettlementOverrides } from "@x402/express";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
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

// The ceiling each network's offer carries for this question.
export function ceilings(info, input) {
  const size = { chars: input.chars, maxTokens: input.maxTokens, headroom: THINKING_HEADROOM };
  return Object.fromEntries(Object.entries(TERMS_BY_NETWORK).map(([net, terms]) =>
    [net, info ? ceilingAtomic(info, size, terms) : terms.maxChargeAtomic]));
}

// The terms of the network the payer chose, with the ceiling this question was offered. The middleware has
// already matched the payment to an offer, so the network is one of ours; the ceiling is ours, never the payer's.
function paidTerms(req) {
  const header = req.get("payment-signature") ?? req.get("x-payment");
  const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
  const terms = TERMS_BY_NETWORK[network];
  return terms && { ...terms, maxChargeAtomic: req.askCeilings[network] };
}

// A request with no body at all: what a directory's crawler sends to see whether a route takes payment.
const isEmptyBody = body => body === undefined || body === null
  || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);

export function addUsageRoute(app, route, makeOffers, details, { facilitatorClient, config, readRequest, choose = async i => ({ ...i, model: config.model, info: null }), quotes = new WeakMap(), upstream, fetchImpl, log, offerEmptyProbe = false }) {
  const offers = makeOffers(quotes);
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new UptoEvmScheme())
    .register(SOLANA, new UptoSvmScheme({ withdrawDelay: 300 }));
  // An unreadable question, or a model that is not offered, is refused before any payment is asked for.
  app.post(route, async (req, res, next) => {
    // x402scan registers a route only if an empty, unpaid request gets the 402 challenge (docs/DISCOVERY.md in
    // Merit-Systems/x402scan). It gets the standing offer; paying it with no question is still refused below.
    if (offerEmptyProbe && isEmptyBody(req.body) && !(req.get("payment-signature") ?? req.get("x-payment"))) {
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
  app.use(paymentMiddleware({ [`POST ${route}`]: { accepts: offers, mimeType: "application/json", ...details } }, server));
  app.post(route, async (req, res) => {
    const started = Date.now();
    try {
      const terms = paidTerms(req);
      if (!terms) throw new Error("payment on an unknown network");
      const answer = await upstream(config, req.askInput.messages, req.askInput.maxTokens, fetchImpl, req.askInput.model);
      const billing = billUsage(answer.usage, terms);
      setSettlementOverrides(res, { amount: billing.totalAtomic });
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
