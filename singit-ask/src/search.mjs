// SingIt search: Exa's web search and page contents, sold over x402 at Exa's own x402 price + 30% + the network's
// settlement fee, and bought from Exa with SingIt's settlement wallet (docs/singit-gateway-spec.md, 4.2 and 4.6).
//
// Exa is asked for its price before the payer is (it answers an unpaid request with a 402, for free), the payer's
// payment is verified, Exa is paid and answers, and only then is the payer's payment settled: no answer, no charge.
// Exa is paid only at its own address on Base, never above the price it quoted, and once per payment.
//
// The settlement wallet holds SingIt's own float, never a user's money. It is kept small and topped up by hand;
// below SEARCH_TERMS.pauseBelowAtomic nothing more is sold.
import crypto from "node:crypto";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ASSET, BASE, SOLANA, SOLANA_ASSET, TERMS, SOLANA_TERMS } from "./pricing.mjs";

export const EXA_URL = "https://api.exa.ai";
export const EXA_PAY_TO = "0x6d6E695b09861467c7d462f5AAF31cF3540B9192";  // Exa's own x402 address on Base ("legacy")
export const SEARCH_ROUTES = { "/v1/exa/search": "/search", "/v1/exa/contents": "/contents" };
export const SEARCH_TERMS = Object.freeze({
  markupBps: 3000,
  maxExaAtomic: 50_000,          // never buy from Exa above $0.05 a request
  pauseBelowAtomic: 2_500_000,   // stop selling under $2.50 in the settlement wallet (5% of $50)
  warnBelowAtomic: 12_500_000,   // and warn under $12.50 (25%)
});
const FEES = { [BASE]: TERMS.settlementFeeAtomic, [SOLANA]: SOLANA_TERMS.settlementFeeAtomic };
const QUOTE_SECONDS = 60;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export class SearchError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SEARCH_TYPES = new Set(["instant", "fast", "auto"]);
const SEARCH_FIELDS = new Set(["query", "numResults", "type", "category", "includeDomains", "excludeDomains",
  "startPublishedDate", "endPublishedDate", "startCrawlDate", "endCrawlDate", "userLocation", "contents"]);
const CONTENTS_FIELDS = new Set(["urls", "ids", "text", "highlights", "summary", "maxAgeHours"]);

// What is sent on to Exa: its own request shape, within what is sold here. A RequestError-like SearchError otherwise.
export function readSearch(path, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SearchError(400, "Send a JSON body.");
  const allowed = path === "/v1/exa/search" ? SEARCH_FIELDS : CONTENTS_FIELDS;
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length) throw new SearchError(400, `Not offered here: ${unknown.slice(0, 3).join(", ")}.`);
  if (path === "/v1/exa/search") {
    if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 2000) {
      throw new SearchError(400, "Send a query of up to 2000 characters.");
    }
    if (body.numResults !== undefined && (!Number.isInteger(body.numResults) || body.numResults < 1 || body.numResults > 25)) {
      throw new SearchError(400, "numResults must be 1 to 25.");
    }
    if (body.type !== undefined && !SEARCH_TYPES.has(body.type)) throw new SearchError(400, "type must be instant, fast or auto.");
  } else {
    const pages = body.urls ?? body.ids;
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > 10 || (body.urls && body.ids)
        || pages.some((p) => typeof p !== "string" || p.length > 2000)) {
      throw new SearchError(400, "Send urls (or ids): 1 to 10 of them.");
    }
  }
  return body;
}

// Exa's price for this exact request, from its unpaid 402: the one option paid in USDC on Base to Exa's address.
export async function quoteExa(path, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${EXA_URL}${SEARCH_ROUTES[path]}`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "User-Agent": "SingIt-Search/1.0 (+https://singitai.app)" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { throw new SearchError(503, "Exa did not answer. Nothing was paid; try again."); }
  const header = response.headers.get("payment-required");
  if (response.status !== 402 || !header) throw new SearchError(503, "Exa did not quote a price. Nothing was paid.");
  let required;
  try { required = JSON.parse(Buffer.from(header, "base64").toString("utf8")); }
  catch { throw new SearchError(503, "Exa sent an unreadable price. Nothing was paid."); }
  const accepted = (required.accepts ?? []).find((a) => a?.scheme === "exact" && a.network === BASE && same(a.asset, ASSET)
    && same(a.payTo, EXA_PAY_TO) && a.extra?.name === "USD Coin" && a.extra?.version === "2");
  if (!accepted || !/^[1-9][0-9]{0,9}$/.test(String(accepted.amount))) {
    throw new SearchError(503, "Exa asked to be paid somewhere unexpected. Nothing was paid.");
  }
  if (BigInt(accepted.amount) > BigInt(SEARCH_TERMS.maxExaAtomic)) {
    throw new SearchError(400, "This request costs more at Exa than is sold here. Nothing was paid.");
  }
  return { required, accepted, exaAtomic: BigInt(accepted.amount) };
}

// What the payer pays for a request Exa sells for `exaAtomic`, on `network`.
export function searchPrice(exaAtomic, network) {
  const exa = BigInt(exaAtomic);
  const markup = (exa * BigInt(SEARCH_TERMS.markupBps) + 9999n) / 10000n;
  return { exaAtomic: exa.toString(), markupAtomic: markup.toString(), feeAtomic: FEES[network],
           totalAtomic: (exa + markup + BigInt(FEES[network])).toString() };
}

// The settlement wallet: signs Exa's payment and reports its own USDC, read at most once a minute.
export function settlementWallet({ account, publicClient }) {
  let cached = { at: 0, atomic: null };
  return {
    address: account.address,
    signer: { address: account.address, signTypedData: (args) => account.signTypedData(args) },
    async balance(now = Date.now()) {
      if (cached.atomic !== null && now - cached.at < 60_000) return cached.atomic;
      const atomic = await publicClient.readContract({ address: ASSET, functionName: "balanceOf", args: [account.address],
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] });
      cached = { at: now, atomic: BigInt(atomic) };
      return cached.atomic;
    },
  };
}

const DESCRIPTION = "Web search and page contents from Exa, paid per request over x402 in USDC on Base or Solana: "
  + "Exa's price + 30% + a settlement fee (0.001 USDC on Base, 0.002 on Solana). Search: about 0.0101 USDC on Base. "
  + "Exa's own request format. Nothing is charged without an answer.";
const EXAMPLE = { input: { query: "x402 payment facilitators", numResults: 5, contents: { text: { maxCharacters: 1000 } } },
  output: { requestId: "…", results: [{ title: "…", url: "https://…", text: "…" }],
    billing: { exaAtomic: "7000", markupAtomic: "2100", feeAtomic: "1000", totalAtomic: "10100", currency: "USDC" } } };

export function addSearchRoutes(app, config, { facilitatorClient, wallet, fetchImpl = fetch, log = console.error }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  const quotes = new WeakMap();        // parsed body -> Exa's quote, for the middleware's price functions
  const recent = new Map();            // body digest -> { quote, at }: one quote serves the payment that follows it
  const used = new Map();              // payment signature digest -> when: Exa is paid once per payment
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const price = (network) => (ctx) => {
    const quote = quotes.get(ctx.adapter.getBody());
    const amount = quote ? searchPrice(quote.exaAtomic, network).totalAtomic : searchPrice(SEARCH_TERMS.maxExaAtomic, network).totalAtomic;
    return network === BASE ? { asset: ASSET, amount, extra: { name: "USD Coin", version: "2" } } : { asset: SOLANA_ASSET, amount };
  };
  const offers = [
    { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 120, price: price(SOLANA) },
    { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120, price: price(BASE) },
  ];

  for (const [route] of Object.entries(SEARCH_ROUTES)) {
    app.post(route, async (req, res, next) => {
      try {
        const body = readSearch(route, req.body);
        const funds = await wallet.balance().catch(() => null);
        if (funds === null || funds < BigInt(SEARCH_TERMS.pauseBelowAtomic)) {
          if (funds !== null) log(`singit-ask: search paused, settlement wallet holds ${funds} micro-USDC`);
          throw new SearchError(503, "Search is paused for now. Nothing was paid; try again later.");
        }
        if (funds < BigInt(SEARCH_TERMS.warnBelowAtomic)) log(`singit-ask: settlement wallet low, ${funds} micro-USDC`);
        const key = digest(route + JSON.stringify(body));
        let held = recent.get(key);
        if (!held || Date.now() - held.at > QUOTE_SECONDS * 1000) {
          held = { quote: await quoteExa(route, body, fetchImpl), at: Date.now() };
          recent.set(key, held);
          for (const [k, v] of recent) if (Date.now() - v.at > QUOTE_SECONDS * 1000) recent.delete(k);
        }
        quotes.set(req.body, held.quote);
        req.searchQuote = held.quote;
        next();
      } catch (error) {
        res.status(error.status ?? 503).json({ error: { type: error.status === 400 ? "invalid_request_error" : "upstream_error",
          message: error.status ? error.message : "Try again shortly." } });
      }
    });
  }
  const routes = Object.fromEntries(Object.keys(SEARCH_ROUTES).map((route) => [`POST ${route}`, {
    accepts: offers, mimeType: "application/json", description: `SingIt Search: ${DESCRIPTION}`,
    extensions: declareDiscoveryExtension({ bodyType: "json", input: route === "/v1/exa/search" ? EXAMPLE.input
      : { urls: ["https://x402.org"], text: true }, output: { example: EXAMPLE.output } }),
  }]));
  app.use(paymentMiddleware(routes, server));
  for (const [route, exaPath] of Object.entries(SEARCH_ROUTES)) {
    app.post(route, async (req, res) => {
      const header = req.get("payment-signature") ?? req.get("x-payment");
      const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
      const seen = digest(header);
      if (used.has(seen)) {
        return res.status(409).json({ error: { type: "invalid_request_error", message: "This payment was already used." } });
      }
      used.set(seen, Date.now());
      for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
      const { required, accepted, exaAtomic } = req.searchQuote;
      const started = Date.now();
      let answer;
      try {
        const signed = await new ExactEvmClient(wallet.signer).createPaymentPayload(2, accepted, {});
        const payload = { x402Version: 2, accepted, resource: required.resource, payload: signed.payload };
        answer = await fetchImpl(`${EXA_URL}${exaPath}`, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", "User-Agent": "SingIt-Search/1.0 (+https://singitai.app)",
                     "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") },
          body: JSON.stringify(req.body), signal: AbortSignal.timeout(60000) });
      } catch (error) {
        // Signed and maybe sent: Exa may or may not have been paid. The payer is not charged either way.
        log(`singit-ask: Exa ${exaPath} unreachable after paying was attempted (${error.name})`);
        return res.status(502).json({ error: { type: "upstream_error", message: "Exa did not answer. You were not charged." } });
      }
      const data = await answer.json().catch(() => null);
      if (answer.status !== 200 || !data || typeof data !== "object") {
        log(`singit-ask: Exa ${exaPath} answered HTTP ${answer.status} after payment`);
        return res.status(502).json({ error: { type: "upstream_error", message: "Exa did not answer. You were not charged." } });
      }
      delete data.costDollars;
      const billing = { ...searchPrice(exaAtomic, network), currency: "USDC" };
      log(`singit-ask: Exa ${exaPath} answered in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC`);
      res.json({ ...data, billing });
    });
  }
}
