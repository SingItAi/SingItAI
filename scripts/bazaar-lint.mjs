#!/usr/bin/env node
// Offline lint of the Bazaar / x402 metadata singit-ask advertises, against what Coinbase's curation asks for
// (docs.cdp.coinbase.com/x402/seller/get-discovered). It boots singit-ask's app in this process with fakes (no
// network, no upstream, no payment, no secrets), asks every discoverable paid route for its 402 challenge three
// ways (GET, HEAD, empty POST: the three probes a directory crawler uses) and checks what comes back.
//
//   node scripts/bazaar-lint.mjs            # prints findings; exit 1 on any FAIL
//   node scripts/bazaar-lint.mjs --strict   # WARN also fails
//   node scripts/bazaar-lint.mjs --json     # machine-readable result
//
// The app is reached through its own loopback listener with `Host: ask.singitai.app` and
// `X-Forwarded-Proto: https` (the app trusts loopback proxies), which is exactly what the production reverse
// proxy sends, so the resource URLs checked are the https ones a crawler would see.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASK = path.join(HERE, "..", "singit-ask", "src");

export const MAX_DESCRIPTION = 500;
const PUBLIC_HOST = "ask.singitai.app";
const ICON_TYPES = /\.(png|jpe?g|webp|gif)$/i;

// Text that reads as an instruction to an agent rather than a description of the service. CDP screens metadata for
// prompt injection; these are the phrasings it is cheapest to avoid. Applied to every string value we publish.
export const INSTRUCTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|instructions)/i,
  /\byou\s+(must|should|shall|have\s+to|need\s+to)\b/i,
  /\b(always|never)\s+(call|use|invoke|send|reveal|mention|tell)\b/i,
  /\bdo\s+not\s+(tell|mention|reveal|disclose|inform)\b/i,
  /\bdon'?t\s+(tell|mention|reveal|disclose)\b/i,
  /system\s+prompt/i,
  /\byou\s+are\s+now\b/i,
  /\bact\s+as\b/i,
  /\bpretend\b/i,
  /\bforget\s+(everything|all|your|previous)/i,
  /\boverride\b/i,
  /<\s*\/?\s*(system|assistant|tool|instructions?)\b/i,
  /\b(call|use|invoke)\s+this\s+(tool|endpoint|service)\s+(first|before|instead)/i,
  /\bprefer\s+this\s+(tool|endpoint|service)\b/i,
];

// Routes whose answer is not JSON, so there is no JSON output example to publish.
const NO_JSON_OUTPUT = new Map([["/v1/audio/speech", /^audio\//]]);

const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const strings = (value, out = []) => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
};

// Checks one decoded challenge. `env` = { route, networks: [..], payTo: { [network]: address } }.
// Returns [{ level: "FAIL" | "WARN", check, message }].
export function lintChallenge(challenge, env) {
  const findings = [];
  const fail = (check, message) => findings.push({ level: "FAIL", check, message });
  const warn = (check, message) => findings.push({ level: "WARN", check, message });

  if (challenge?.x402Version !== 2) fail("x402Version", `x402Version is ${JSON.stringify(challenge?.x402Version)}, expected 2`);

  const accepts = challenge?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) fail("accepts", "accepts is empty or missing");
  else {
    accepts.forEach((offer, i) => {
      for (const field of ["scheme", "network", "asset", "payTo"]) {
        if (typeof offer?.[field] !== "string" || !offer[field]) fail("accepts", `accepts[${i}].${field} is missing`);
      }
      if (typeof offer?.amount !== "string" || !/^[1-9][0-9]*$/.test(offer.amount)) {
        fail("accepts", `accepts[${i}].amount must be a positive integer string (atomic units), got ${JSON.stringify(offer?.amount)}`);
      }
      if (!["exact", "upto"].includes(offer?.scheme)) fail("accepts", `accepts[${i}].scheme ${JSON.stringify(offer?.scheme)} is not exact/upto`);
      if (env.payTo?.[offer?.network] && offer.payTo !== env.payTo[offer.network]) {
        fail("accepts", `accepts[${i}].payTo is not the configured ${offer.network} address`);
      }
      if (!Number.isInteger(offer?.maxTimeoutSeconds) || offer.maxTimeoutSeconds <= 0) {
        fail("accepts", `accepts[${i}].maxTimeoutSeconds is missing`);
      }
    });
    const listed = new Set(accepts.map((offer) => offer?.network));
    for (const network of env.networks) if (!listed.has(network)) fail("networks", `no offer on ${network}`);
  }

  const resource = challenge?.resource;
  if (!resource || typeof resource.url !== "string") fail("resource", "resource.url is missing");
  else {
    let url;
    try { url = new URL(resource.url); } catch { fail("resource", `resource.url is not a URL: ${resource.url}`); }
    if (url) {
      if (url.protocol !== "https:") fail("resource", `resource.url is not https: ${resource.url}`);
      if (url.pathname !== env.route) fail("resource", `resource.url path ${url.pathname} is not ${env.route}`);
      if (url.search || url.hash) fail("resource", "resource.url carries a query or fragment");
    }
  }

  const description = resource?.description;
  if (typeof description !== "string" || !description.trim()) fail("description", "description is missing");
  else if (description.length > MAX_DESCRIPTION) fail("description", `description is ${description.length} chars, the limit is ${MAX_DESCRIPTION}`);
  if (typeof resource?.serviceName !== "string" || !resource.serviceName.trim()) warn("serviceName", "serviceName is missing");
  if (!Array.isArray(resource?.tags) || resource.tags.length === 0) warn("tags", "tags are missing");
  if (typeof resource?.mimeType !== "string" || !resource.mimeType) fail("mimeType", "resource.mimeType is missing");

  // Everything a crawler or an agent reads, not just the description.
  const published = [["description", description], ["serviceName", resource?.serviceName], ["tags", resource?.tags],
    ["extensions.bazaar", challenge?.extensions?.bazaar]];
  for (const [where, value] of published) {
    for (const text of strings(value)) {
      const hit = INSTRUCTION_PATTERNS.find((pattern) => pattern.test(text));
      if (hit) fail("instruction-like", `${where} reads as an instruction (${hit}): "${text.slice(0, 80)}"`);
    }
  }

  const iconUrl = resource?.iconUrl;
  if (iconUrl === undefined) warn("iconUrl", "no iconUrl: CDP shows the service without an icon (PNG/JPG/WebP/GIF over https, never SVG)");
  else if (typeof iconUrl !== "string" || !iconUrl.startsWith("https://")) fail("iconUrl", "iconUrl is not an https URL");
  else if (/\.svg(\?|#|$)/i.test(iconUrl)) fail("iconUrl", "iconUrl is an SVG, which CDP rejects");
  else if (!ICON_TYPES.test(new URL(iconUrl).pathname)) warn("iconUrl", "iconUrl does not end in png/jpg/webp/gif");

  const bazaar = challenge?.extensions?.bazaar;
  if (!bazaar) fail("bazaar", "extensions.bazaar is missing");
  else {
    const input = bazaar.info?.input;
    if (!input || input.type !== "http") fail("bazaar", "bazaar.info.input is missing");
    const body = bazaar.schema?.properties?.input?.properties?.body;
    const fields = body?.properties ?? {};
    if (Object.keys(fields).length === 0) fail("bazaar.inputSchema", "the input schema describes no body fields");
    else {
      for (const [name, def] of Object.entries(fields)) {
        if (!def || typeof def !== "object" || (!def.type && !def.oneOf && !def.description)) fail("bazaar.inputSchema", `field "${name}" has no type or description`);
        else if (!def.description && name !== "model") warn("bazaar.inputSchema", `field "${name}" has no description`);
      }
      const example = input?.body;
      if (!example || typeof example !== "object") fail("bazaar.inputExample", "the input example is missing");
      else {
        for (const key of Object.keys(example)) if (!(key in fields)) fail("bazaar.inputExample", `example field "${key}" is not in the schema`);
        for (const key of body.required ?? []) if (!(key in example)) fail("bazaar.inputExample", `example lacks required field "${key}"`);
      }
    }
    const jsonOut = !NO_JSON_OUTPUT.has(env.route);
    if (jsonOut) {
      if (!bazaar.info?.output?.example || typeof bazaar.info.output.example !== "object") fail("bazaar.outputExample", "no output example");
    } else if (!NO_JSON_OUTPUT.get(env.route).test(resource?.mimeType ?? "")) {
      fail("bazaar.outputExample", `${env.route} has no JSON output example, so its mimeType must say what it returns`);
    }
  }
  return findings;
}

// Boots singit-ask with fakes and returns { routes: [{ route, probes: { GET, HEAD, POST }, findings }], global: [] }.
export async function lintApp({ resourcesFile = path.join(HERE, "bazaar-resources.json") } = {}) {
  const { BASE, SOLANA, ROUTE, createApp } = await import(pathToFileURL(path.join(ASK, "app.mjs")));
  const { FORMAT_ROUTES } = await import(pathToFileURL(path.join(ASK, "formats.mjs")));
  const { IMAGE_ROUTE } = await import(pathToFileURL(path.join(ASK, "images.mjs")));
  const { SPEECH_ROUTE } = await import(pathToFileURL(path.join(ASK, "speech.mjs")));
  const { SEARCH_ROUTES } = await import(pathToFileURL(path.join(ASK, "search.mjs")));
  const { VIDEO_ROUTE } = await import(pathToFileURL(path.join(ASK, "video.mjs")));

  const never = () => { throw new Error("offline lint: no upstream is ever called"); };
  const feePayer = "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88";
  const facilitatorClient = {
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: `0x${"3".repeat(40)}` } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer, receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    verify: never, settle: never,
  };
  const catalogue = { resolve: never, canAnswer: async () => true, list: async () => [], imageModels: async () => new Map(),
    resolveImage: never, voiceModels: async () => ({ speech: new Map(), transcription: new Map() }), resolveSpeech: never,
    videoModels: async () => new Map(), resolveVideo: never };
  const config = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
    surplusKey: "inf_lint", surplusUrl: "https://surplus.invalid", model: "deepseek-v4.1-flash" };
  const app = createApp(config, { facilitatorClient, catalogue, exaKey: "lint", fetchImpl: never, exaFetch: never, log: () => {}, upstream: never });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });

  const routes = [ROUTE, ...Object.keys(FORMAT_ROUTES), IMAGE_ROUTE, SPEECH_ROUTE, ...Object.keys(SEARCH_ROUTES)];
  const global = [];
  const results = [];
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { host: PUBLIC_HOST, "x-forwarded-proto": "https" };
    for (const route of routes) {
      const findings = [];
      const probes = {};
      const challenges = {};
      for (const method of ["GET", "HEAD", "POST"]) {
        const response = await fetch(base + route, { method, headers, redirect: "manual" });
        probes[method] = response.status;
        if (response.status !== 402) { findings.push({ level: "FAIL", check: "probe", message: `${method} answered ${response.status}, expected 402` }); continue; }
        const header = response.headers.get("payment-required");
        if (!header) { findings.push({ level: "FAIL", check: "probe", message: `${method}: no PAYMENT-REQUIRED header` }); continue; }
        try { challenges[method] = decode(header); } catch { findings.push({ level: "FAIL", check: "probe", message: `${method}: PAYMENT-REQUIRED is not base64 JSON` }); }
      }
      const reference = challenges.POST ?? challenges.GET ?? challenges.HEAD;
      if (reference) {
        for (const [method, challenge] of Object.entries(challenges)) {
          if (JSON.stringify(challenge) !== JSON.stringify(reference)) findings.push({ level: "FAIL", check: "probe", message: `${method} challenge differs from the POST one` });
        }
        findings.push(...lintChallenge(reference, { route, networks: [BASE, SOLANA], payTo: { [BASE]: config.payToBase, [SOLANA]: config.payToSolana } }));
      }
      results.push({ route, probes, findings });
    }
    // Not listed on purpose: a 402 here would let a directory index a route that cannot complete.
    const hidden = await fetch(base + VIDEO_ROUTE, { method: "GET", headers });
    if (hidden.status === 402) global.push({ level: "FAIL", check: "hidden", message: `${VIDEO_ROUTE} is advertising a 402 but is meant to stay unlisted` });
  } finally {
    server.close();
  }

  // The committed list CDP's validator reads must be the routes the code advertises, and nothing else.
  const listed = JSON.parse(readFileSync(resourcesFile, "utf8")).resources ?? [];
  const listedPaths = new Map();
  for (const entry of listed) {
    let url;
    try { url = new URL(entry.url); } catch { global.push({ level: "FAIL", check: "resources", message: `bazaar-resources.json: not a URL: ${entry.url}` }); continue; }
    if (url.protocol !== "https:") global.push({ level: "FAIL", check: "resources", message: `bazaar-resources.json: not https: ${entry.url}` });
    if (!["GET", "POST"].includes(entry.method)) global.push({ level: "FAIL", check: "resources", message: `bazaar-resources.json: method of ${entry.url} must be GET or POST` });
    listedPaths.set(url.pathname, entry);
  }
  for (const route of routes) if (!listedPaths.has(route)) global.push({ level: "FAIL", check: "resources", message: `bazaar-resources.json does not list ${route}` });
  for (const route of listedPaths.keys()) if (!routes.includes(route)) global.push({ level: "FAIL", check: "resources", message: `bazaar-resources.json lists ${route}, which the app does not advertise` });
  return { routes: results, global };
}

export function summarize(result, { strict = false } = {}) {
  const all = [...result.global, ...result.routes.flatMap((r) => r.findings)];
  const count = (level) => all.filter((f) => f.level === level).length;
  const fails = count("FAIL"), warns = count("WARN");
  return { fails, warns, ok: fails === 0 && (!strict || warns === 0) };
}

function print(result, summary) {
  for (const { route, probes, findings } of result.routes) {
    const status = findings.some((f) => f.level === "FAIL") ? "FAIL" : findings.length ? "WARN" : "ok";
    console.log(`${status.padEnd(4)} ${route}  (GET ${probes.GET}, HEAD ${probes.HEAD}, POST ${probes.POST})`);
    for (const f of findings) console.log(`       ${f.level} [${f.check}] ${f.message}`);
  }
  for (const f of result.global) console.log(`${f.level} [${f.check}] ${f.message}`);
  console.log(`\n${result.routes.length} routes, ${summary.fails} failure(s), ${summary.warns} warning(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const result = await lintApp();
  const summary = summarize(result, { strict: args.includes("--strict") });
  if (args.includes("--json")) console.log(JSON.stringify({ ...summary, ...result }, null, 2));
  else print(result, summary);
  process.exit(summary.ok ? 0 : 1);
}
