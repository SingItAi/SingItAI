// SingIt credit: a top-up of an account's API balance at app.singitai.app, bought over x402 `exact` by the
// account's own agent from the owner's limits. The payer names the amount (whole cents, within bounds) and pays it
// plus the network's settlement fee, once per top-up instead of once per answer.
//
// Nothing is kept here: the payment goes to SingIt's revenue address, and app.singitai.app credits a balance only
// for a payment its own agent made and saw settle. Anyone else paying this route only gives money away, so it is
// not listed for discovery.
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { BASE, ASSET, SOLANA, SOLANA_ASSET, TERMS, SOLANA_TERMS } from "./pricing.mjs";
import { withBuilderCode } from "./builder-code.mjs";

export const CREDIT_ROUTE = "/v1/credit";
export const CREDIT_LIMITS = Object.freeze({ minAtomic: 1_000_000, maxAtomic: 50_000_000, stepAtomic: 10_000 });
const FEES = { [BASE]: TERMS.settlementFeeAtomic, [SOLANA]: SOLANA_TERMS.settlementFeeAtomic };

// The credit asked for, as a string of USDC micro-units, or null.
export function readCredit(body) {
  const raw = body && typeof body === "object" ? body.amountAtomic : undefined;
  const text = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,9}$/.test(text)) return null;
  const amount = Number(text);
  const { minAtomic, maxAtomic, stepAtomic } = CREDIT_LIMITS;
  return amount >= minAtomic && amount <= maxAtomic && amount % stepAtomic === 0 ? text : null;
}

// What a top-up of `credit` costs on `network`: the credit and one settlement fee.
export const creditPrice = (credit, network) => (BigInt(credit) + BigInt(FEES[network])).toString();

export function addCreditRoute(app, config, { facilitatorClient }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  // The middleware prices the request again when the payment arrives; a body checked below always has a credit.
  const credit = ctx => readCredit(ctx.adapter.getBody()) ?? String(CREDIT_LIMITS.minAtomic);
  const offers = [
    { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 120,
      price: ctx => ({ asset: SOLANA_ASSET, amount: creditPrice(credit(ctx), SOLANA) }) },
    { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120,
      price: ctx => ({ asset: ASSET, amount: creditPrice(credit(ctx), BASE), extra: { name: "USD Coin", version: "2" } }) },
  ];
  const { minAtomic, maxAtomic, stepAtomic } = CREDIT_LIMITS;
  app.post(CREDIT_ROUTE, (req, res, next) => {
    if (readCredit(req.body)) return next();
    res.status(400).json({ error: { type: "invalid_request_error", message: `Send {"amountAtomic": "<USDC micro-units>"}: `
      + `${minAtomic} to ${maxAtomic}, in steps of ${stepAtomic}.` } });
  });
  app.use(paymentMiddleware(withBuilderCode({ [`POST ${CREDIT_ROUTE}`]: { accepts: offers, mimeType: "application/json",
    description: "SingIt credit: a top-up of an API balance at app.singitai.app, bought by the account's own agent." } },
  server), server));
  app.post(CREDIT_ROUTE, (req, res) => {
    const amountAtomic = readCredit(req.body);
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
    res.json({ object: "credit", amountAtomic, feeAtomic: FEES[network], totalAtomic: creditPrice(amountAtomic, network),
      network, currency: "USDC" });
  });
}
