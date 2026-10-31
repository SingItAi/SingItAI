import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { snapshot } from "../../scripts/models-snapshot.mjs";
import { price, escapeHtml, safeSlug, modelTitle, modelDescription, mergeBlock, renderPages, visibleSnapshot, hiddenRedirects } from "../../scripts/generate-model-pages.mjs";
import { limits } from "../../scripts/templates/spending-limits.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const website = path.join(root, "website");
const fetchedAt = "2026-10-30T09:49:54Z";
const read = (file) => readFile(path.join(website, file), "utf8");
const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[key]);
function fixtures() {
  const models = { object: "list", fees: { markupPct: 30, perAnswerUsd: { "eip155:8453": 0.001, "solana:test": 0.002 } }, free: { models: ["free/fixture"], perVisitorPerDay: 20 }, data: [] };
  const pricing = { networks: { base: { chain: "eip155:8453", settlementFeeUsd: 0.001 }, solana: { chain: "solana:test", settlementFeeUsd: 0.002 } }, referenceRequest: { messages: 1, maxOutputTokens: 800 }, models: [] };
  for (let i = 0; i < 50; i++) {
    models.data.push({ id: `fixture-${i}`, name: `Fixture ${i}`, usdPerMillionTokens: { input: 1, output: 2 }, irrelevant: "omit" });
    pricing.models.push({ id: `fixture-${i}`, upto: { base: { usd: 0.0015 }, solana: { usd: 0.002 } }, exact: { base: { usd: 0.0015 }, solana: { usd: 0.002 } } });
  }
  models.data.push({ id: "singit-ask" }, { id: "free/fixture" },
    { id: "singit/auto", object: "model", owned_by: "singit" });
  pricing.models.push({ id: "singit/auto", name: "SingIt Auto", upto: null, exact: null });
  return { models, pricing };
}

test("prices strip float noise and round upward only at nine decimals", () => {
  for (const [input, output] of [
    [0.06760000000000001, "0.0676"],
    [1.0000000011, "1.000000002"],
    [1.000000001, "1.000000001"],
    [2.19908, "2.19908"],
    [0.0000000001, "0.000000001"],
    [4, "4"],
    [0.00201825, "0.00201825"],
  ]) assert.equal(price(input), output);
  for (const [input, output] of [[0, "0"], [10, "10"], [0.06760000000000001, "0.0676"], [0.049999999999999996, "0.05"], [0.00002339999999999867, "0.0000234"], [0.1234567891, "0.12345679"], [0.123456789, "0.123456789"], [1e-10, "0.000000001"], [1e-9, "0.000000001"]]) assert.equal(price(input), output);
  for (const bad of [NaN, Infinity, -1, "1", null]) assert.throws(() => price(bad));
});

test("template replacement never reprocesses model names and rejects unknown placeholders", async () => {
  const { models, pricing } = fixtures();
  models.data[0].name = "{{schema}}{{body}}";
  models.data[1].name = "<script>";
  const s = snapshot(models, pricing, fetchedAt);
  const shell = await readFile(path.join(root, "scripts/templates/model-shell.html"), "utf8");
  const pages = renderPages(s, shell);
  for (const [id, name] of [["fixture-0", "{{schema}}{{body}}"], ["fixture-1", "<script>"]]) {
    const html = pages.get(`models/${id}/index.html`);
    assert.ok(html.includes(`<h1>${escapeHtml(name)}: pay per request with x402</h1>`));
    assert.doesNotMatch(html, /&amp;lt;script&amp;gt;/);
    assert.equal((html.match(/<script type="application\/ld\+json">/g) ?? []).length, 1);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.equal((html.match(/<h2 class="section-title">Price<\/h2>/g) ?? []).length, 1);
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"];
    assert.equal(graph.find((node) => node["@type"] === "Product").name, name);
  }
  for (const key of ["unknown", "toString"]) assert.throws(() => renderPages(s, shell + `{{${key}}}`), /Unknown template placeholder/);
});

test("HTML escaping, path segments and short metadata", () => {
  assert.equal(escapeHtml(`<tag a="&">'</tag>`), "&lt;tag a=&quot;&amp;&quot;&gt;&#39;&lt;/tag&gt;");
  assert.equal(safeSlug("model_1.2-beta"), "model_1.2-beta");
  for (const id of ["all", ".", "..", "../x", "a/b", "A", "", "a?", "%2e", null]) assert.throws(() => safeSlug(id));
  const name = "Very long model name ".repeat(20);
  assert.ok(modelTitle(name).length <= 60);
  assert.ok(modelDescription({ name }).length <= 155);
  assert.equal(modelTitle("Short"), "Short API via x402: pay per call in USDC | SingIt");
});

test("marker merges are idempotent and preserve all outside bytes", () => {
  for (const [original, anchor] of [["<?xml?>\n<urlset>\n</urlset>\n", "</urlset>"], ["# Existing\n\nKeep this.\n", undefined]]) {
    const first = mergeBlock(original, "generated", anchor);
    assert.equal(mergeBlock(first, "generated", anchor), first);
    const second = mergeBlock(first, "replacement", anchor);
    assert.equal(second.replace("replacement", "generated"), first);
    const removed = first.replace(/<!-- generated:model-pages:start -->[\s\S]*?<!-- generated:model-pages:end -->\n/, "");
    assert.equal(removed, original);
  }
  assert.throws(() => mergeBlock("<!-- generated:model-pages:start -->", "x"));
});

test("snapshot fixtures filter, whitelist, preserve absence and reject malformed data", () => {
  const { models, pricing } = fixtures();
  models.data[0].expectedUsdPerMillionTokens = { input: 999, output: 999, basis: "observed" };
  models.data[0].singitUsdPerMillionTokens = { input: 1.3, output: 2.6 };
  const s = snapshot(models, pricing, fetchedAt);
  assert.equal(s.models.length, 50);
  assert.equal(s.models.some((m) => m.id === "singit/auto"), false);
  assert.equal(s.models[0].irrelevant, undefined);
  assert.deepEqual(s.models[0].expectedUsdPerMillionTokens, { basis: "observed" });
  assert.deepEqual(s.models[0].singitUsdPerMillionTokens, { input: 1.3, output: 2.6 });
  assert.equal(Object.hasOwn(s.models[1], "singitUsdPerMillionTokens"), false);
  assert.equal(Object.hasOwn(s.models[1], "contextLength"), false);
  assert.equal(Object.hasOwn(s.models[1], "owned_by"), false);
  assert.deepEqual(s.models.map((m) => m.id), s.models.map((m) => m.id).sort());
  assert.throws(() => snapshot({ ...models, data: models.data.slice(0, 49) }, pricing, fetchedAt), /fewer than 50/);
  assert.throws(() => snapshot({ ...models, data: {} }, pricing, fetchedAt), /Invalid response/);
  assert.throws(() => snapshot(models, { ...pricing, networks: {} }, fetchedAt), /fees/);
  assert.throws(() => snapshot(models, pricing, "invalid"), /fetchedAt/);
  const invalid = structuredClone(models);
  invalid.data[0].usdPerMillionTokens.input = "1";
  assert.throws(() => snapshot(invalid, pricing, fetchedAt), /token prices/);
});

test("snapshot CLI reads fixture files without network", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "model-snapshot-"));
  try {
    const { models, pricing } = fixtures();
    await writeFile(path.join(dir, "models.json"), JSON.stringify(models));
    await writeFile(path.join(dir, "pricing.json"), JSON.stringify(pricing));
    await exec(process.execPath, [path.join(root, "scripts/models-snapshot.mjs"), "--models-input", path.join(dir, "models.json"), "--pricing-input", path.join(dir, "pricing.json"), "--fetched-at", fetchedAt, "--out", path.join(dir, "out.json")]);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "out.json"), "utf8")), snapshot(models, pricing, fetchedAt));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("renderer handles hostile source text and changed snapshot values deterministically", async () => {
  const { models, pricing } = fixtures();
  models.data[0] = { ...models.data[0], name: '<script>alert("x")</script> $&', tags: ["video", "vision"], owned_by: "Fixture", contextLength: 1000, recommendedScheme: "upto", recommendedSchemeWhy: "<read> & decide", singitUsdPerMillionTokens: { input: 1.3, output: 2.6 } };
  const s = snapshot(models, pricing, fetchedAt);
  s.fees.markupPct = 40;
  s.fees.perAnswerUsd["eip155:8453"] = 0.003;
  const shell = await readFile(path.join(root, "scripts/templates/model-shell.html"), "utf8");
  const pages = renderPages(s, shell);
  assert.deepEqual(pages, renderPages(s, shell));
  const html = pages.get("models/fixture-0/index.html");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; $&amp;"));
  assert.ok(html.includes("40% markup"));
  assert.ok(html.includes("$0.003 on Base"));
  assert.ok(html.includes("&lt;read&gt; &amp; decide"));
  assert.ok(html.includes("\\u003cscript>"));
  assert.doesNotMatch(html, /\bvideo\b/);
  assert.throws(() => renderPages({ ...s, models: [{ ...s.models[0], id: "../escape" }, ...s.models.slice(1)] }, shell), /Unsafe/);
});

const forbidden = /0x[a-f\d]{40,}|\b[a-f\d]{64}\b|0xfa8f|\b(?:video|BlockRun|OpenRouter|Surplus|cheapest|best|guaranteed|audited|unlimited|revolutionary|hackathon|safe|secure)\b|run by bots|AI team|AI agents run SingIt|absolutely (?:safe|secure)|payments feed|Builder Code|(?:third.party|other people.s) agents/is;

test("all committed pages are current, crawlable and follow content rules", async () => {
  await exec(process.execPath, [path.join(root, "scripts/generate-model-pages.mjs"), "--check"]);
  const s = JSON.parse(await read("data/models-snapshot.json"));
  assert.ok(s.models.length >= 50);
  const sitemap = await read("sitemap.xml");
  const llms = await read("llms.txt");
  const generatedLlms = llms.split("<!-- generated:model-pages:start -->")[1].split("<!-- generated:model-pages:end -->")[0];
  assert.doesNotMatch(generatedLlms, forbidden);
  assert.doesNotMatch(generatedLlms, /\$\d/);
  const hidden = JSON.parse(await readFile(path.join(root, "scripts/hidden-models.json"), "utf8")).hidden;
  s.models = s.models.filter((m) => !hidden.some((h) => h.id === m.id));
  const dirs = [...s.models.map((m) => `models/${m.id}`), "models/all", ...limits.map((p) => p.slug)];
  for (const dir of dirs) {
    const html = await read(`${dir}/index.html`);
    const url = `https://singitai.app/${dir}/`;
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), dir);
    assert.ok((dir.startsWith("models/") && dir !== "models/all" ? await read("llms-models.txt") : generatedLlms).includes(`](${url})`), dir);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, dir);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), dir);
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`), dir);
    const nav = html.match(/<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/)[1];
    assert.equal((nav.match(/href="\/pricing\/"/g) ?? []).length, 1, dir);
    assert.ok(decode(html.match(/<title>(.*?)<\/title>/)[1]).length <= 60, dir);
    assert.ok(decode(html.match(/<meta name="description" content="([^"]*)">/)[1]).length <= 155, dir);
    assert.doesNotMatch(html, forbidden, dir);
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"];
    assert.equal(graph.find((n) => n["@type"] === "BreadcrumbList").itemListElement.at(-1).item, url);
    const faq = graph.find((n) => n["@type"] === "FAQPage");
    if (faq) {
      const questions = [...html.matchAll(/<dt><h3>(.*?)<\/h3><\/dt>/g)].map((m) => decode(m[1]));
      const answers = [...html.matchAll(/<dd class="faq-answer">(.*?)<\/dd>/g)].map((m) => decode(m[1]));
      assert.deepEqual(faq.mainEntity.map((q) => q.name), questions);
      assert.deepEqual(faq.mainEntity.map((q) => q.acceptedAnswer.text), answers);
    }
    const model = s.models.find((m) => dir === `models/${m.id}`);
    if (model) {
      const product = graph.find((n) => n["@type"] === "Product");
      assert.ok(product);
      if (model.singitUsdPerMillionTokens) {
        assert.deepEqual(product.offers.map((o) => o.priceSpecification.price), [price(model.singitUsdPerMillionTokens.input), price(model.singitUsdPerMillionTokens.output)]);
        for (const offer of product.offers) {
          assert.equal(offer.priceSpecification["@type"], "UnitPriceSpecification");
          assert.equal(offer.priceSpecification.priceCurrency, "USD");
        }
      } else {
        assert.equal(product.offers, undefined);
        assert.ok(html.includes("No per-token price is listed for this model."));
        assert.doesNotMatch(html, /\$0(?:[^.\d]|\.0+(?:[^\d]|$))/);
      }
      for (const scheme of ["upto", "exact"]) for (const network of ["base", "solana"]) assert.ok(html.includes(`$${price(model[scheme][network].usd)}`));
      assert.ok(html.includes("max_tokens&quot;:200"));
      assert.ok(html.includes(new Date(s.fetchedAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")));
    } else if (dir !== "models/all") {
      const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
      assert.ok(visible.split(/\s+/).length >= 350, dir);
      const brief = limits.find((p) => p.slug === dir);
      assert.ok(html.includes(`<h1>${escapeHtml(brief.h1)}</h1>`));
      assert.ok(html.includes(`utm_campaign=${dir}&amp;utm_content=hero`));
    }
  }
  const index = await read("models/all/index.html");
  for (const m of s.models) assert.ok(index.includes(`href="/models/${m.id}/"`));
});

test("retired singular spending page redirects and is absent from discovery", async () => {
  await assert.rejects(read("ai-agent-spending-limit/index.html"), { code: "ENOENT" });
  const { stat } = await import("node:fs/promises");
  await assert.rejects(stat(path.join(website, "ai-agent-spending-limit")), { code: "ENOENT" });
  for (const file of ["sitemap.xml", "llms.txt"]) assert.doesNotMatch(await read(file), /\/ai-agent-spending-limit(?:\/|[?#\s<)])/);
  const rules = (await read("_redirects")).split("\n");
  assert.ok(rules.includes("/ai-agent-spending-limit /agent-spending-limits/ 301"));
  assert.ok(rules.includes("/ai-agent-spending-limit/ /agent-spending-limits/ 301"));
});

test("limits copy distinguishes Base emergency stop and Solana server checks", async () => {
  const permanent = "Pause is a permanent emergency stop. To change limits, revoke and set up a new allowance.";
  const server = "The daily limit, the per-purchase limit and the expiry are enforced by SingIt's server, not on-chain.";
  const descriptions = [
    "Set a per-purchase cap, a daily cap and an expiry once. Your agent spends USDC only inside them, and you can stop it at any time.",
    "Step by step: approve USDC, set caps and expiry, watch receipts, and stop the agent at any time.",
  ];
  for (const [i, brief] of limits.entries()) {
    const html = await read(`${brief.slug}/index.html`);
    assert.doesNotMatch(html, /one click|anytime|pause it|pause in one/i);
    const solana = html.match(/<h2>Solana[^<]*<\/h2>([\s\S]*?)(?=<h2>|<\/section>)/)[1];
    assert.ok(decode(solana).includes(server));
    assert.doesNotMatch(solana, /permanent|contract|reject/i);
    for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      if (/Solana/i.test(match[1])) assert.doesNotMatch(match[1], /rejected on-chain|reject/i);
    }
    if (i < 2) {
      assert.ok(html.includes(permanent));
      assert.ok(html.includes("The daily limit resets at 00:00 UTC."));
      assert.equal(brief.description, descriptions[i]);
      for (const tag of ["meta name=\"description\"", "meta property=\"og:description\""]) {
        assert.ok(html.includes(`<${tag} content="${escapeHtml(descriptions[i])}">`));
      }
      const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"];
      assert.equal(graph.find((n) => n["@type"] === "WebPage").description, descriptions[i]);
    }
  }
});

test("consolidated page preserves the published spend excerpt and comparison structure", async () => {
  const html = await read("agent-spending-limits/index.html");
  for (const id of ["problem", "how", "pays-for"]) assert.ok(html.includes(`class="lp-section" id="${id}"`));
  assert.ok(html.includes('class="mtable"'));
  assert.match(html, /<th scope="row">Who enforces the limits<\/th>\s*<td>[^<]*<\/td>\s*<td>SingIt's server \(on-chain: only the total SPL delegate amount\)<\/td>/);
  const excerpt = decode(html.match(/<code id="code-spend">([\s\S]*?)<\/code>/)[1].replace(/<[^>]+>/g, ""));
  const contract = await readFile(path.join(root, "agent-allowance/src/AgentAllowance.sol"), "utf8");
  let offset = contract.indexOf("function spend(");
  for (const line of excerpt.split("\n").map((line) => line.trim()).filter((line) => line && line !== "// ...")) {
    const at = contract.indexOf(line, offset);
    assert.ok(at >= offset, line);
    offset = at + line.length;
  }
});


test("the eight visible named chat model pages contain only neutral technical copy", async () => {
  const ids = [
    "deepseek-v4.1-flash-uncensored",
    "e2ee-gemma-4-26b-a4b-uncensored-p",
    "e2ee-qwen3-6-35b-a3b-uncensored-p",
    "gemma-4-uncensored",
    "glm-4.7-flash-heretic",
    "qwen3.6-plus-uncensored",
    "venice-uncensored-1.2",
    "venice-uncensored-role-play",
  ];
  const snapshot = JSON.parse(await read("data/models-snapshot.json"));
  const models = ids.map((id) => {
    const model = snapshot.models.find((m) => m.id === id);
    assert.ok(model?.name, `Missing model: ${id}`);
    return model;
  });
  const allowed = models.flatMap(({ id, name }) => [
    name, escapeHtml(name), id, safeSlug(id), `/models/${id}/`,
    `https://singitai.app/models/${id}/`,
  ]).sort((a, b) => b.length - a.length);
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namesAndUrls = new RegExp(allowed.map(escapeRegex).join("|"), "gi");
  const forbiddenWords = /uncensored|heretic|role[- ]?play|nsfw|adult|explicit|erotic|sexual|unfiltered|jailbreak|no censorship/i;
  assert.match("venice-uncensored-1X2".replace(namesAndUrls, ""), forbiddenWords);
  for (const id of ids) {
    const html = (await read(`models/${id}/index.html`)).replace(namesAndUrls, "");
    assert.doesNotMatch(html, forbiddenWords, id);
  }
});

test("Ask README does not claim all uncensored models are never sold", async () => {
  const readme = await readFile(path.join(root, "singit-ask/README.md"), "utf8");
  assert.ok(!readme.includes("Uncensored models are never sold."));
});

test("hold list removes pages and related links and maintains temporary redirects", async () => {
  const { models, pricing } = fixtures();
  const s = snapshot(models, pricing, fetchedAt);
  s.models[0].owned_by = s.models[1].owned_by = "Fixture";
  const id = s.models[0].id;
  const hold = { hidden: [{ id, since: "2026-10-30", reason: "No seller" }] };
  const shell = await readFile(path.join(root, "scripts/templates/model-shell.html"), "utf8");
  const pages = renderPages(s, shell, hold);
  assert.equal(pages.has(`models/${id}/index.html`), false);
  for (const html of pages.values()) assert.ok(!html.includes(`/models/${id}/`));
  assert.equal(s.models.length, 50, "the raw snapshot is preserved");
  assert.equal(visibleSnapshot(s, hold).models.length, 49);
  const original = "/existing /target 301\n";
  const redirects = hiddenRedirects(original, hold);
  assert.ok(redirects.startsWith(original));
  assert.ok(redirects.includes(`/models/${id} /models/all/ 302`));
  assert.ok(redirects.includes(`/models/${id}/ /models/all/ 302`));
  assert.equal(hiddenRedirects(redirects, hold), redirects);
  assert.ok(!hiddenRedirects(redirects, { hidden: [] }).includes(`/models/${id}`));
  assert.throws(() => visibleSnapshot(s, { hidden: [{}] }), /Unsafe/);
  assert.throws(() => visibleSnapshot(s, { hidden: {} }), /Invalid/);
  assert.throws(() => visibleSnapshot(s, { hidden: [{ ...hold.hidden[0], reason: "" }] }), /Invalid/);
  const warnings = [];
  visibleSnapshot(s, { hidden: [{ ...hold.hidden[0], id: "absent" }] }, (line) => warnings.push(line));
  assert.equal(warnings.length, 1);
});

test("held model has no page or discovery links and both temporary redirects exist", async () => {
  const hold = JSON.parse(await readFile(path.join(root, "scripts/hidden-models.json"), "utf8"));
  const { stat } = await import("node:fs/promises");
  const rules = (await read("_redirects")).split("\n");
  for (const { id } of hold.hidden) {
    await assert.rejects(stat(path.join(website, "models", id)), { code: "ENOENT" });
    for (const file of ["sitemap.xml", "llms-models.txt", "models/all/index.html"]) {
      assert.ok(!(await read(file)).includes(`/models/${id}/`), file);
    }
    assert.ok(rules.includes(`/models/${id} /models/all/ 302`));
    assert.ok(rules.includes(`/models/${id}/ /models/all/ 302`));
  }
});


test("returned DeepSeek model has a page and discovery links without temporary redirects", async () => {
  const id = "deepseek-v4.1-flash-uncensored";
  const hold = JSON.parse(await readFile(path.join(root, "scripts/hidden-models.json"), "utf8"));
  assert.deepEqual(hold, { hidden: [] });
  assert.ok((await read(`models/${id}/index.html`)).includes(`/models/${id}/`));
  for (const file of ["sitemap.xml", "llms-models.txt", "models/all/index.html"]) {
    assert.ok((await read(file)).includes(`/models/${id}/`), file);
  }
  assert.ok(!(await read("_redirects")).includes(`/models/${id}`));
});

test('published free model snapshot matches Ask defaults and the shared cap', async () => {
  const { DEFAULT_FREE_MODELS, FREE_DEFAULTS } = await import('../../singit-ask/src/free.mjs');
  const s = JSON.parse(await readFile(path.join(website, 'data/models-snapshot.json'), 'utf8'));
  assert.deepEqual(s.free.models, DEFAULT_FREE_MODELS.map(id => `free/${id}`));
  assert.equal(s.free.budgetUsdPerDay, FREE_DEFAULTS.budgetUsdPerDay);
});
