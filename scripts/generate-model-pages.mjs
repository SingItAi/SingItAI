import { DEFAULT_FREE_EXAMPLE } from "../singit-ask/src/free.mjs";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderLlms } from "./generate-llms.mjs";
import { limits } from "./templates/spending-limits.mjs";

const hasTokenPrice = (m) => ["input", "output"].every((key) => {
  const v = m.singitUsdPerMillionTokens?.[key];
  return Number.isFinite(v) && v >= 0 && (v > 0 || m.usdPerMillionTokens?.[key] === 0);
}) && ["input", "output"].some((key) => m.singitUsdPerMillionTokens?.[key] > 0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://singitai.app";
export const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const e = escapeHtml;
export function safeSlug(id) {
  if (typeof id !== "string" || !/^[a-z0-9._-]+$/.test(id) || [".", "..", "all"].includes(id)) throw new Error(`Unsafe model id: ${id}`);
  return id;
}
export function price(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid price");
  // Treat digits beyond 12 significant digits as binary float noise (e.g.
  // 0.052 * 1.3 = 0.06760000000000001): normalize with Number(toPrecision(12)).
  // On its decimal string, keep up to nine decimals, rounding UP with string/
  // integer arithmetic when more remain, then trim trailing zeros.
  const clean = Number(value.toPrecision(12)).toString();
  const [coefficient, exponent = "0"] = clean.split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const shift = 9 + Number(exponent) - fraction.length;
  let units = BigInt(whole + fraction);
  if (shift >= 0) units *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    units = (units + divisor - 1n) / divisor;
  }
  const text = units.toString().padStart(10, "0");
  return `${text.slice(0, -9)}.${text.slice(-9)}`.replace(/\.?0+$/, "");
}
export function truncateWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundary = cut.lastIndexOf(" ");
  return boundary > 0 ? cut.slice(0, boundary) : text.slice(0, max);
}
export function modelTitle(name) {
  const full = `${name} API via x402: pay per call in USDC | SingIt`;
  if (full.length <= 60) return full;
  const suffix = " x402 API | SingIt";
  return truncateWords(name, 60 - suffix.length) + suffix;
}
export function modelDescription(m) {
  const suffix = hasTokenPrice(m) ? ` Price: $${price(m.singitUsdPerMillionTokens.input)}/1M input, $${price(m.singitUsdPerMillionTokens.output)}/1M output tokens.` : "";
  const ending = " with no account or API key. Pay per request in USDC on Base via x402.";
  const full = `Call ${m.name ?? m.id}${ending}${suffix}`;
  if (full.length <= 155) return full;
  return `Call ${truncateWords(m.name ?? m.id, 155 - 5 - ending.length)}${ending}`;
}
export function mergeBlock(text, content, before) {
  const start = "<!-- generated:model-pages:start -->";
  const end = "<!-- generated:model-pages:end -->";
  const block = `${start}\n${content}\n${end}`;
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 && b < 0) {
    if (before) {
      const at = text.indexOf(before);
      if (at < 0) throw new Error("Missing insertion anchor");
      return text.slice(0, at) + block + "\n" + text.slice(at);
    }
    return text + block + "\n";
  }
  if (a < 0 || b < a || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) throw new Error("Malformed generated markers");
  return text.slice(0, a) + block + text.slice(b + end.length);
}
const link = (url, text) => `<a href="${e(url)}">${e(text)}</a>`;
const section = (title, body) => `<section class="lp-section"><div class="shell"><h2 class="section-title">${e(title)}</h2>\n${body}\n</div></section>`;
const limitLinks = () => limits.map((p) => link(`/${p.slug}/`, p.title.replace(" | SingIt", ""))).join(" · ");
const modelLink = (m) => link(`/models/${safeSlug(m.id)}/`, m.name ?? m.id);
function faqHtml(faq) {
  return section("FAQ", `<dl class="faq">${faq.map(([q, a]) => `<div class="faq-item"><dt><h3>${e(q)}</h3></dt><dd class="faq-answer">${e(a)}</dd></div>`).join("\n")}</dl>`);
}
function page(shell, { slug, title, h1, description, body, faq = [], nodes = [] }) {
  const url = `${origin}/${slug}/`;
  const head = `<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://singitai.app/assets/singit-social-preview-v3.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@SingItAgent">`;
  const graph = [
    { "@type": "WebPage", url, name: title, description, inLanguage: "en" },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "SingIt", item: `${origin}/` },
      ...(slug.startsWith("models/") && slug !== "models/all" ? [{ "@type": "ListItem", position: 2, name: "Models", item: `${origin}/models/all/` }] : []),
      { "@type": "ListItem", position: slug.startsWith("models/") && slug !== "models/all" ? 3 : 2, name: h1, item: url },
    ] },
    ...nodes,
    ...(faq.length ? [{ "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }] : []),
  ];
  const schema = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2).replaceAll("<", "\\u003c")}</script>`;
  const hero = `<section class="hero dev-hero"><div class="shell"><div class="hero-copy"><h1>${e(h1)}</h1><p class="hero-sub">${e(description)}</p></div></div></section>`;
  const replacements = { head, schema, body: hero + body + (faq.length ? faqHtml(faq) : "") };
  // Only inspect the shell: inserted source text and dollar signs stay literal.
  return shell.replace("<body>", "<body>\n<!-- Generated by scripts/generate-model-pages.mjs -->").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown template placeholder: ${key}`);
    return replacements[key];
  });
}
function table(headers, rows) {
  return `<div class="table-wrap"><table class="mtable"><thead><tr>${headers.map((v) => `<th scope="col">${e(v)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v, i) => i ? `<td>${e(v)}</td>` : `<th scope="row">${e(v)}</th>`).join("")}</tr>`).join("\n")}</tbody></table></div>`;
}
function modelPage(shell, s, m) {
  const name = m.name ?? m.id;
  const p = hasTokenPrice(m) ? m.singitUsdPerMillionTokens : null;
  const priceTable = m.priceBasis === "reference" ? table(["Conservative reference estimate per 1M tokens", "Input", "Output"], [
    ["Surplus lists this model at 0; no list-price savings claimed", `$${price(m.usdPerMillionTokens.input)}`, `$${price(m.usdPerMillionTokens.output)}`],
  ]) : p ? table(["USD per 1M tokens", "Input", "Output"], [
    ["SingIt price (expected, markup included)", `$${price(p.input)}`, `$${price(p.output)}`],
    ["List price of the model (for reference)", `$${price(m.usdPerMillionTokens.input)}`, `$${price(m.usdPerMillionTokens.output)}`],
  ]) : "<p>No per-token price is listed for this model. A request costs the minimum request price below.</p>";
  const basis = m.expectedUsdPerMillionTokens?.basis;
  const basisText = basis === "observed" ? "based on what answers from this model have cost us" : "estimate from sellers' quotes, not yet confirmed by answers we paid for, so the real price can be higher";
  const facts = [m.owned_by !== undefined && `Provider: ${e(m.owned_by)}`, m.contextLength !== undefined && `Context window: ${m.contextLength.toLocaleString("en-US")} tokens`, m.tags?.filter((t) => t.toLowerCase() !== "video").length && `Tags: ${m.tags.filter((t) => t.toLowerCase() !== "video").map(e).join(", ")}`].filter(Boolean).join(" · ");
  const date = new Date(s.fetchedAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const request = JSON.stringify({ model: m.id, max_tokens: 200, messages: [{ role: "user", content: "Hello" }] });
  const curl = `curl -i https://ask.singitai.app/v1/chat/completions \\\n  -H 'Content-Type: application/json' \\\n  -d '${request}'`;
  const faq = [
    ["What is x402?", "x402 is an HTTP payment protocol. An unpaid request returns HTTP 402 with a payment offer; sign one offer and retry the same request with proof of payment."],
    ["Do I need an account?", "No account or API key is needed for these x402 calls."],
    ["Which network? Base?", "Base or Solana, paid in USDC. This page focuses on Base."],
  ];
  let body = section("Pay per request", `<p>Send a request to ask.singitai.app, get HTTP 402 with the exact price, pay in USDC on Base, get the answer. No signup, no monthly plan.</p>${facts ? `<p>${facts}</p>` : ""}`);
  body += section("Price", priceTable + (basis ? `<p>The expected price is ${e(basisText)}. It is an expected price, not a guarantee; you pay what each answer actually used.</p>` : "") +
    `<p>Price = what the provider charges for the answer + ${price(s.fees.markupPct)}% markup + a settlement fee per request ($${price(s.fees.perAnswerUsd[s.networks.base.chain])} on Base, $${price(s.fees.perAnswerUsd[s.networks.solana.chain])} on Solana).</p>
<h3>Per request, reference request</h3>
<p>${s.referenceRequest.messages === 1 ? "One short message" : `${e(s.referenceRequest.messages)} messages`}, max_tokens ${e(s.referenceRequest.maxOutputTokens)}${s.referenceRequest.chars !== undefined ? ` (${e(s.referenceRequest.chars)} characters)` : ""}${s.referenceRequest.inputTokens !== undefined ? `, ${e(s.referenceRequest.inputTokens)} input tokens` : ""}. upto settles actual usage, so a real answer normally costs less; exact is flat, with no refund.</p>` +
    table(["Network", "upto ceiling (USD)", "exact flat price (USD)"], ["base", "solana"].map((n) => [n === "base" ? "Base" : "Solana", `$${price(m.upto[n].usd)}`, `$${price(m.exact[n].usd)}`])) +
    (m.recommendedScheme === "upto" && m.recommendedSchemeWhy !== undefined ? `<p>Recommended: upto. ${e(m.recommendedSchemeWhy)}</p>` : "") +
    `<p>Prices as of ${date} (snapshot of ask.singitai.app/v1/models and /pricing.json). Live: ${link(s.sources[0], "/v1/models")} and ${link(s.sources[1], "/pricing.json")}. Live values are authoritative and the 402 response states the exact price.</p>`);
  body += section("Call it with x402", `<div class="code"><pre><code>${e(curl)}</code></pre></div>
<p>The unpaid POST returns HTTP 402 and a PAYMENT-REQUIRED header: base64 JSON, x402 v2. Sign one offer (upto first, then exact; Base then Solana) and retry the same request with the PAYMENT-SIGNATURE header. HTTP 200 returns choices[0].message.content and billing.totalAtomic.</p>
<p>Follow the ${link("https://github.com/SingItAi/SingItAI/blob/main/docs/first-paid-call.md", "first paid call walkthrough")}, ${link("/developers/", "developer guide")} and ${link("https://singitai.app/llms.txt", "llms.txt")}.</p>` +
    (s.free?.models?.length ? `<p>For a free try, choose from ${e(s.free.models.length)} free models, for example <code>${e("free/" + DEFAULT_FREE_EXAMPLE)}</code>: ${e(s.free.perVisitorPerDay)} answers a day per network, no wallet. The shared daily cost cap is $${e(s.free.budgetUsdPerDay)}; free answers may run out for the day (free_budget_exhausted) and return at midnight UTC.</p>` : ""));
  body += section("Use it from an agent", `<p>MCP: ${link("https://app.singitai.app/mcp", "https://app.singitai.app/mcp")}. Free tools without a key: list_models, get_price, list_price_symbols.</p><p>The elizaOS plugin ${link("https://github.com/SingItAi/SingItAI/tree/main/integrations/elizaos-plugin", "@singitai/plugin-singit")} has a paid-chat action that pays on Base. Its per-call and per-day caps are held in the plugin's memory: in-process, reset on restart, not on-chain, not enforced by SingIt's servers. It does not use AgentAllowance.</p>`);
  body += section("Give your agent a budget", `<p>${limitLinks()}</p>`);
  const related = m.owned_by === undefined ? [] : s.models.filter((other) => other.id !== m.id && other.owned_by === m.owned_by).slice(0, 8);
  body += section("Related models", `<ul>${related.map((other) => `<li>${modelLink(other)}</li>`).join("\n")}</ul><p>${link("/models/all/", "All model pages")}</p>`);
  const product = { "@type": "Product", name, description: modelDescription(m), url: `${origin}/models/${m.id}/` };
  if (p) product.offers = ["input", "output"].map((direction) => ({ "@type": "Offer", name: `${direction} tokens (expected price)`, priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", price: price(p[direction]), priceCurrency: "USD", unitText: `1M ${direction} tokens`, referenceQuantity: { "@type": "QuantitativeValue", value: 1000000, unitText: `${direction} tokens` } } }));
  return page(shell, { slug: `models/${safeSlug(m.id)}`, title: modelTitle(name), h1: `${name}: pay per request with x402`, description: modelDescription(m), body, faq, nodes: [product] });
}
export function visibleSnapshot(s, hold = { hidden: [] }, warn = console.warn) {
  if (!Array.isArray(hold?.hidden)) throw new Error("Invalid hidden models list");
  const ids = new Set();
  for (const entry of hold.hidden) {
    safeSlug(entry?.id);
    if (typeof entry.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.since)
        || typeof entry.reason !== "string" || !entry.reason.trim() || ids.has(entry.id)) {
      throw new Error("Invalid hidden model entry");
    }
    ids.add(entry.id);
    if (s.models.some(m => m.id === entry.id) && Date.parse(s.fetchedAt) > Date.parse(entry.since))
      warn(`Hidden model is listed live again: ${entry.id}; remove it from scripts/hidden-models.json`);
    if (!s.models.some((m) => m.id === entry.id)) warn(`Hidden model absent from snapshot: ${entry.id}`);
  }
  return { ...s, models: s.models.filter((m) => !ids.has(m.id)) };
}

export function hiddenRedirects(text, hold) {
  const start = "# generated:hidden-models:start", end = "# generated:hidden-models:end";
  const block = [start, "# Temporarily hidden, see scripts/hidden-models.json",
    ...hold.hidden.flatMap(({ id }) => [
      `/models/${safeSlug(id)} /models/all/ 302`, `/models/${safeSlug(id)}/ /models/all/ 302`,
    ]), end].join("\n");
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 && b < 0) return text + (text.endsWith("\n") ? "" : "\n") + block + "\n";
  if (a < 0 || b < a || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) {
    throw new Error("Malformed hidden model markers");
  }
  return text.slice(0, a) + block + text.slice(b + end.length);
}

export function renderPages(s, shell, hold = { hidden: [] }) {
  if (!Array.isArray(s.models) || s.models.length < 50 || !Number.isFinite(Date.parse(s.fetchedAt))) throw new Error("Invalid snapshot");
  s = visibleSnapshot(s, hold);
  const files = new Map();
  const ids = new Set();
  for (const m of s.models) {
    safeSlug(m.id);
    if (ids.has(m.id)) throw new Error("Duplicate model id");
    ids.add(m.id);
    files.set(`models/${m.id}/index.html`, modelPage(shell, s, m));
  }
  const groups = new Map();
  for (const m of s.models) {
    const provider = m.owned_by ?? "Provider not listed";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(m);
  }
  const index = `<p>${link("/models/", "Live filterable model table")}. Prices and availability can change; each model page identifies its snapshot.</p>` + [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([provider, models]) => section(provider, `<ul>${models.map((m) => `<li>${modelLink(m)}${m.contextLength !== undefined ? ` — ${m.contextLength.toLocaleString("en-US")} token context window` : ""}</li>`).join("\n")}</ul>`)).join("\n");
  files.set("models/all/index.html", page(shell, { slug: "models/all", title: "All model API pages: x402 in USDC | SingIt", h1: "A static page for every model", description: "Browse model API pages grouped by provider, with context windows and snapshot prices. Pay per request over x402 in USDC on Base or Solana.", body: section("Model directory", index) }));
  for (const p of limits) files.set(`${p.slug}/index.html`, page(shell, { ...p, body: section("Set a budget", `<p>${link(`https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=${p.slug}&utm_content=hero`, "Open SingIt and set limits")}</p>`) + (p.sections ?? "") + `<section class="lp-section"><div class="shell">${p.body}</div></section>` + section("Continue reading", `<p>${limits.filter((v) => v.slug !== p.slug).map((v) => link(`/${v.slug}/`, v.title.replace(" | SingIt", ""))).join(" · ")} · ${link("/models/all/", "All model pages")}</p><p>${link("/x402-gift-cards-esims/", "Gift cards and eSIMs")}</p>`) }));
  return files;
}
export async function generate(check = false) {
  const website = path.join(root, "website");
  const s = JSON.parse(await readFile(path.join(website, "data/models-snapshot.json"), "utf8"));
  const shell = await readFile(path.join(root, "scripts/templates/model-shell.html"), "utf8");
  const hold = JSON.parse(await readFile(path.join(root, "scripts/hidden-models.json"), "utf8"));
  const files = renderPages(s, shell, hold);
  const visible = visibleSnapshot(s, hold);
  const urls = [...files.keys()].map((f) => `${origin}/${f.replace(/index\.html$/, "")}`);
  const sitemap = await readFile(path.join(website, "sitemap.xml"), "utf8");
  const llms = await readFile(path.join(website, "llms.txt"), "utf8");
  files.set("sitemap.xml", mergeBlock(sitemap, urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n"), "</urlset>"));
  const routes = JSON.parse(await readFile(path.join(website, "data/ask-routes.json"), "utf8"));
  for (const [file, content] of renderLlms(llms, visible, routes, price)) files.set(file, content);
  files.set("_redirects", hiddenRedirects(await readFile(path.join(website, "_redirects"), "utf8"), hold));
  const stale = [];
  // Model directories belong to this generator; removed models must not linger.
  for (const dir of await readdir(path.join(website, "models"), { withFileTypes: true })) {
    if (dir.isDirectory() && !files.has(`models/${dir.name}/index.html`)) {
      const directory = path.join(website, "models", dir.name);
      const entries = await readdir(directory);
      const html = entries.includes("index.html") ? await readFile(path.join(directory, "index.html"), "utf8") : "";
      if (entries.length !== 1 || !html.includes("<!-- Generated by scripts/generate-model-pages.mjs -->")) throw new Error(`Unrecognized model directory: ${dir.name}`);
      stale.push(`models/${dir.name}/`);
      if (!check) await rm(directory, { recursive: true });
    }
  }
  for (const [file, content] of files) {
    let current;
    try { current = await readFile(path.join(website, file), "utf8"); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (current === content) continue;
    stale.push(file);
    if (!check) {
      await mkdir(path.dirname(path.join(website, file)), { recursive: true });
      await writeFile(path.join(website, file), content);
    }
  }
  if (check && stale.length) throw new Error(`Generated files differ: ${stale.join(", ")}`);
  return { pages: urls.length, changed: stale.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((v) => v !== "--check")) throw new Error("Usage: generate-model-pages.mjs [--check]");
  generate(process.argv.includes("--check")).then((result) => console.log(`${result.pages} pages; ${result.changed} files ${process.argv.includes("--check") ? "differ" : "updated"}`)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
