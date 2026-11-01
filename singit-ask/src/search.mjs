// SingIt search: Exa's web search, page contents and cited answers, sold over x402 at Exa's list price plus a flat $0.001 settlement fee
// on both Base and Solana, and bought from Exa with SingIt's own Exa API key, as BlockRun does
// (docs/singit-gateway-spec.md, 4.2).
//
// The price is worked out from the request and Exa's price list before the payer is asked; the payer's payment is
// verified, Exa answers, and only then is the payment settled: no answer, no charge. A request whose list price is
// above SEARCH_TERMS.maxExaAtomic is not sold. Exa's own cost report is kept here; if it ever exceeds the list price
// we charged against, that is logged.
import crypto from "node:crypto";
import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { addPaymentRoute, isDiscoveryProbe } from "./metered.mjs";
import { ASSET, BASE, SOLANA, SOLANA_ASSET, SERVICE_NAMES, ICON_URL, discoveryTags } from "./pricing.mjs";

export const EXA_URL = "https://api.exa.ai";
export const SEARCH_ROUTES = { "/v1/exa/search": "/search", "/v1/exa/contents": "/contents", "/v1/exa/answer": "/answer" };
export const SEARCH_TERMS = Object.freeze({ markupBps: 0, maxExaAtomic: 50_000 });  // never sell above $0.05 at Exa
// Exa's prices (exa.ai/pricing, 16 October 2026), in micro-USD: a search of up to 10 results by type, each result past
// 10, each page per content kind (text, highlights, summary), an answer.
export const EXA_PRICES = Object.freeze({ search: { instant: 4000, fast: 7000, auto: 7000 }, result: 1000, page: 1000,
  answer: 5000 });
export const EXA_DEFAULT_FEE_ATOMIC = "1000";
// Invalid environment values fall back independently to zero markup and the default settlement fee.
export function parseExaMarkupBps(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) <= 10000 ? Number(text) : 0;
}
export function parseExaFeeAtomic(value) {
  const parts = String(value ?? "").trim().split(",").map((part) => part.trim());
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) return [EXA_DEFAULT_FEE_ATOMIC, EXA_DEFAULT_FEE_ATOMIC];
  return [BigInt(parts[0]).toString(), BigInt(parts[1] ?? parts[0]).toString()];
}
let markupBps = SEARCH_TERMS.markupBps;
let fees = [EXA_DEFAULT_FEE_ATOMIC, EXA_DEFAULT_FEE_ATOMIC];  // one fee per call on either network
export function setExaMarkupBps(value) { markupBps = parseExaMarkupBps(value); }
export function setExaFeeAtomic(value) { fees = parseExaFeeAtomic(Array.isArray(value) ? value.join(",") : value); }

// The public range covers both networks, from one contents page to the list-price cap.
export function exaPriceRange() {
  const totals = (exa) => [BASE, SOLANA].map((network) => BigInt(searchPrice(exa, network).totalAtomic));
  const usd = (atomic) => `${atomic / 1000000n}.${(atomic % 1000000n).toString().padStart(6, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
  return { min: usd(totals(EXA_PRICES.page).reduce((a, b) => a < b ? a : b)),
    max: usd(totals(SEARCH_TERMS.maxExaAtomic).reduce((a, b) => a > b ? a : b)) };
}

export class SearchError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const FIELDS = {
  "/v1/exa/search": new Set(["query", "numResults", "type", "category", "includeDomains", "excludeDomains",
    "startPublishedDate", "endPublishedDate", "startCrawlDate", "endCrawlDate", "userLocation", "contents"]),
  "/v1/exa/contents": new Set(["urls", "ids", "text", "highlights", "summary", "maxAgeHours"]),
  "/v1/exa/answer": new Set(["query", "text", "model", "systemPrompt", "userLocation"]),
};
const kinds = (options) => (options && typeof options === "object"
  ? ["text", "highlights", "summary"].filter((kind) => options[kind]).length : 0);

// Exa's list price for this request, in micro-USD, after checking it is one sold here. SearchError otherwise.
export function exaPrice(path, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SearchError(400, "Send a JSON body.");
  const unknown = Object.keys(body).filter((k) => !FIELDS[path].has(k));
  if (unknown.length) throw new SearchError(400, `Not offered here: ${unknown.slice(0, 3).join(", ")}.`);
  const query = () => {
    if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 2000) {
      throw new SearchError(400, "Send a query of up to 2000 characters.");
    }
  };
  let price;
  if (path === "/v1/exa/search") {
    query();
    const results = body.numResults ?? 10;
    if (!Number.isInteger(results) || results < 1 || results > 25) throw new SearchError(400, "numResults must be 1 to 25.");
    const base = EXA_PRICES.search[body.type ?? "auto"];
    if (base === undefined) throw new SearchError(400, "type must be instant, fast or auto.");
    price = base + Math.max(0, results - 10) * EXA_PRICES.result + results * kinds(body.contents) * EXA_PRICES.page;
  } else if (path === "/v1/exa/contents") {
    const pages = body.urls ?? body.ids;
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > 10 || (body.urls && body.ids)
        || pages.some((p) => typeof p !== "string" || p.length > 2000)) {
      throw new SearchError(400, "Send urls (or ids): 1 to 10 of them.");
    }
    price = pages.length * Math.max(1, kinds(body)) * EXA_PRICES.page;
  } else {
    query();
    if (body.model !== undefined && !["exa", "exa-fast"].includes(body.model)) throw new SearchError(400, "model must be exa or exa-fast.");
    price = EXA_PRICES.answer;
  }
  if (price > SEARCH_TERMS.maxExaAtomic) {
    throw new SearchError(400, `This request costs ${(price / 1e6).toFixed(3)} USDC at Exa, more than is sold here. Ask for fewer results or less content.`);
  }
  return price;
}

// What the payer pays for a request Exa lists at `exaAtomic`, on `network`.
export function searchPrice(exaAtomic, network) {
  const exa = BigInt(exaAtomic);
  const markup = (exa * BigInt(markupBps) + 9999n) / 10000n;
  const fee = fees[network === SOLANA ? 1 : 0];
  return { exaAtomic: exa.toString(), markupAtomic: markup.toString(), feeAtomic: fee,
           totalAtomic: (exa + markup + BigInt(fee)).toString() };
}

// <=300 characters, opening with the category words and naming the brand once, later (see app.mjs's
// DISCOVERY_DESCRIPTION for why): each route does something different, so each gets its own text, and its own tags.
const DESCRIPTIONS = {
  "/v1/exa/search": "Web search API from Exa: up to 25 results with optional page contents. Call it when an agent "
    + "needs current web results, with no API key or account. Served by SingIt.",
  "/v1/exa/contents": "Web page contents from Exa: page text, highlights or a summary from up to 10 URLs. Call it when "
    + "an agent already has URLs and needs their content, with no API key or account. Served by SingIt.",
  "/v1/exa/answer": "Web answers with citations from Exa: a cited answer to a question. Call it when an agent needs a "
    + "sourced answer rather than raw search results, with no API key or account. Served by SingIt.",
};
const TAGS = {
  "/v1/exa/search": discoveryTags("web-search", "search", "exa", "web-results", "page-contents", "pay-per-use",
                                  "solana", "base", "singit"),
  "/v1/exa/contents": discoveryTags("web-page-contents", "web-scraping", "page-contents", "exa", "web-search",
                                    "pay-per-use", "solana", "base", "singit"),
  "/v1/exa/answer": discoveryTags("web-search", "answers", "citations", "exa", "search", "pay-per-use", "solana",
                                  "base", "singit"),
};
const EXAMPLES = {
  "/v1/exa/search": { query: "x402 payment facilitators", numResults: 5 },
  "/v1/exa/contents": { urls: ["https://x402.org"], text: true },
  "/v1/exa/answer": { query: "What is x402?" },
};

const STRING_LIST = (description, max) => ({ type: "array", items: { type: "string" }, maxItems: max, description });
const CONTENT_OPTION = (what) => ({ description: `${what} Each kind asked for adds Exa's per-page price.`, oneOf: [{ type: "boolean" }, { type: "object" }] });
const QUERY = { type: "string", minLength: 1, maxLength: 2000 };
const INPUT_SCHEMAS = {
  "/v1/exa/search": { properties: {
    query: { ...QUERY, description: "What to search the web for." },
    numResults: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Results beyond 10 cost extra." },
    type: { type: "string", enum: ["instant", "fast", "auto"], default: "auto",
      description: "Search mode: instant is lowest latency, fast adds page excerpts, auto picks per query." },
    category: { type: "string", description: "Exa's category filter, e.g. news or research paper." },
    includeDomains: STRING_LIST("Only these domains.", 100), excludeDomains: STRING_LIST("Not these domains.", 100),
    startPublishedDate: { type: "string", description: "Only pages published on or after this ISO 8601 date." },
    endPublishedDate: { type: "string", description: "Only pages published on or before this ISO 8601 date." },
    startCrawlDate: { type: "string", description: "Only pages Exa crawled on or after this ISO 8601 date." },
    endCrawlDate: { type: "string", description: "Only pages Exa crawled on or before this ISO 8601 date." },
    userLocation: { type: "string", description: "Two-letter country code." },
    contents: { type: "object", description: "Page contents to return with each result (text, highlights, summary)." },
  }, required: ["query"] },
  "/v1/exa/contents": { properties: {
    urls: { ...STRING_LIST("Pages to fetch (1 to 10). Send urls or ids, not both.", 10), minItems: 1 },
    ids: { ...STRING_LIST("Exa result ids (1 to 10), instead of urls.", 10), minItems: 1 },
    text: CONTENT_OPTION("Return the page text."), highlights: CONTENT_OPTION("Return highlights."),
    summary: CONTENT_OPTION("Return a summary."),
    maxAgeHours: { type: "integer", description: "Accept a cached copy no older than this." },
  } },
  "/v1/exa/answer": { properties: {
    query: { ...QUERY, description: "The question to answer with citations." },
    text: { type: "boolean", description: "Include the text of the cited pages." },
    model: { type: "string", enum: ["exa", "exa-fast"] },
    systemPrompt: { type: "string", description: "Guidance for the answer's style." },
    userLocation: { type: "string", description: "Two-letter country code." },
  }, required: ["query"] },
};
// A route's request body as openapi.json documents it: the same schema and example the Bazaar listing declares.
export const exaRequestBody = (route) => ({ required: true, content: { "application/json": {
  schema: { type: "object", ...INPUT_SCHEMAS[route] }, example: EXAMPLES[route] } } });
// Example billing uses the current Base settings, just like the example body's offer.
const billing = (exa) => ({ ...searchPrice(exa, BASE), currency: "USDC" });
const outputExamples = () => ({
  "/v1/exa/search": { requestId: "example", results: [{ id: "https://x402.org", url: "https://x402.org", title: "x402",
    publishedDate: null, author: null }], billing: billing(7000) },
  "/v1/exa/contents": { requestId: "example", results: [{ id: "https://x402.org", url: "https://x402.org", title: "x402",
    text: "x402 is an open payment standard…" }], billing: billing(1000) },
  "/v1/exa/answer": { answer: "x402 is an open standard for paying for an API call with a stablecoin over HTTP 402.",
    citations: [{ id: "https://x402.org", url: "https://x402.org", title: "x402" }], billing: billing(5000) },
});
const OUTPUT_SCHEMA = { type: "object", required: ["billing"], properties: {
  billing: { type: "object", description: "What was charged, in USDC micro-units", properties: {
    exaAtomic: { type: "string" }, markupAtomic: { type: "string" }, feeAtomic: { type: "string" },
    totalAtomic: { type: "string", description: "The amount settled" }, currency: { type: "string", const: "USDC" } } } } };

export function addSearchRoutes(app, config, { facilitatorClient, exaKey, fetchImpl = fetch, log = console.error }) {
  const server = new x402ResourceServer(facilitatorClient)
    .register(BASE, new ExactEvmScheme())
    .register(SOLANA, new ExactSvmScheme());
  const prices = new WeakMap();        // parsed body -> Exa's list price, for the middleware's price functions
  const used = new Map();              // payment signature digest -> when: one payment, one request to Exa
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  // The discovery probes (GET/HEAD and the empty, unpaid POST) are offered what the route's own Bazaar example body
  // is offered: the price CDP's Bazaar records for the route and what vet402 compares its empty POST against
  // (price_mismatch otherwise). Exa's list price is static, so this is the same on every probe.
  const probePrice = (route) => {
    try { return exaPrice(route, EXAMPLES[route]); } catch { return SEARCH_TERMS.maxExaAtomic; }
  };
  const price = (route, network) => (ctx) => {
    const amount = searchPrice(prices.get(ctx.adapter.getBody()) ?? probePrice(route), network).totalAtomic;
    return network === BASE ? { asset: ASSET, amount, extra: { name: "USD Coin", version: "2" } } : { asset: SOLANA_ASSET, amount };
  };
  // exact on Base first: the simplest offer for a buyer that only inspects accepts[0].
  const offers = (route) => [
    { scheme: "exact", network: BASE, payTo: config.payToBase, maxTimeoutSeconds: 120, price: price(route, BASE) },
    { scheme: "exact", network: SOLANA, payTo: config.payToSolana, maxTimeoutSeconds: 120, price: price(route, SOLANA) },
  ];
  for (const route of Object.keys(SEARCH_ROUTES)) {
    app.post(route, (req, res, next) => {
      // x402scan's empty, unpaid probe gets the example's offer (`probePrice`), not a "Send a JSON body" 400.
      if (isDiscoveryProbe(req)) return next();
      try {
        prices.set(req.body, exaPrice(route, req.body));
        next();
      } catch (error) {
        res.status(error.status ?? 400).json({ error: { type: "invalid_request_error", code: "invalid_request", message: error.message } });
      }
    });
  }
  addPaymentRoute(app, Object.fromEntries(Object.keys(SEARCH_ROUTES).map((route) => [`POST ${route}`, {
    accepts: offers(route), mimeType: "application/json", description: DESCRIPTIONS[route],
    serviceName: SERVICE_NAMES[route], iconUrl: ICON_URL, tags: TAGS[route],
    extensions: declareDiscoveryExtension({ bodyType: "json", input: EXAMPLES[route], inputSchema: INPUT_SCHEMAS[route],
      output: { example: outputExamples()[route], schema: OUTPUT_SCHEMA } }),
  }])), server, { log });
  for (const [route, exaPath] of Object.entries(SEARCH_ROUTES)) {
    app.post(route, async (req, res) => {
      const header = req.get("payment-signature") ?? req.get("x-payment");
      const network = JSON.parse(Buffer.from(header, "base64").toString()).accepted?.network;
      const seen = digest(header);
      if (used.has(seen)) {
        return res.status(409).json({ error: { type: "invalid_request_error", code: "payment_duplicate", message: "This payment was already used." } });
      }
      used.set(seen, Date.now());
      for (const [k, at] of used) if (Date.now() - at > 3_600_000) used.delete(k);
      const listed = prices.get(req.body);
      const started = Date.now();
      let answer;
      try {
        answer = await fetchImpl(`${EXA_URL}${exaPath}`, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", "x-api-key": exaKey,
                     "User-Agent": "SingIt-Search/1.0 (+https://singitai.app)" },
          body: JSON.stringify(req.body), signal: AbortSignal.timeout(60000) });
      } catch (error) {
        log(`singit-ask: Exa ${exaPath} unreachable (${error.name})`);
        return res.set("Retry-After", "30").status(503).json({ error: { type: "upstream_error", code: "upstream_unavailable", message: "Exa did not answer. You were not charged." } });
      }
      const data = await answer.json().catch(() => null);
      if (answer.status !== 200 || !data || typeof data !== "object") {
        // 401/402 from Exa means SingIt's own key or Exa credit: not the payer's fault, and not charged.
        log(`singit-ask: Exa ${exaPath} answered HTTP ${answer.status}`);
        if (answer.status !== 400) res.set("Retry-After", "30");
        return res.status(answer.status === 400 ? 400 : 503).json({ error: { type: answer.status === 400
          ? "invalid_request_error" : "upstream_error", message: answer.status === 400
          ? "Exa refused the request. You were not charged." : "Exa did not answer. You were not charged." } });
      }
      const reported = Math.ceil(Number(data.costDollars?.total ?? 0) * 1e6);
      if (reported > listed) log(`singit-ask: Exa ${exaPath} cost ${reported} micro-USD, listed ${listed}`);
      delete data.costDollars;
      const billing = { ...searchPrice(listed, network), currency: "USDC" };
      log(`singit-ask: Exa ${exaPath} answered in ${Date.now() - started} ms for ${billing.totalAtomic} micro-USDC`);
      res.json({ ...data, billing });
    });
  }
}
