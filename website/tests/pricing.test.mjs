// /pricing/: live SingIt reference rows, formatting and discovery.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatUsd, pricingRows, rowHtml, validPricing } from "../pricing.mjs";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REFERENCE_REQUEST = { messages: 1, chars: 31, inputTokens: 35, maxOutputTokens: 800 };
const PRICING_JSON = {
  generatedAt: "2026-10-24T15:00:00.000Z",
  currency: "USDC",
  referenceRequest: REFERENCE_REQUEST,
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5",
      upto: { base: { priceAtomic: "54000", usd: 0.054 }, solana: { priceAtomic: "54500", usd: 0.0545 } },
      exact: { base: { ceilingAtomic: "36000", usd: 0.036 }, solana: { ceilingAtomic: "36500", usd: 0.0365 } } },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
      upto: { base: { priceAtomic: "1800", usd: 0.0018 }, solana: { priceAtomic: "1900", usd: 0.0019 } },
      exact: { base: { ceilingAtomic: "1500", usd: 0.0015 }, solana: { ceilingAtomic: "1500", usd: 0.0015 } } },
    { id: "singit-only", name: "Only on SingIt",
      upto: { base: { priceAtomic: "1500", usd: 0.0015 }, solana: { priceAtomic: "1500", usd: 0.0015 } },
      exact: { base: { ceilingAtomic: "1500", usd: 0.0015 }, solana: { ceilingAtomic: "1500", usd: 0.0015 } } },
  ],
};

test("all fixture models are included and sorted by id without mutating input", () => {
  const input = { ...PRICING_JSON, models: [...PRICING_JSON.models].reverse() };
  const before = structuredClone(input);
  const rows = pricingRows(input);
  assert.deepEqual(rows.map(r => r.id), ["claude-opus-5.5", "deepseek-v4.1-flash", "singit-only"]);
  assert.equal(rows[0].singitUptoUsd, 0.054);
  assert.equal(rows[0].singitExactUsd, 0.036);
  assert.deepEqual(input, before);
  assert.equal(validPricing(input), true);
  assert.equal(validPricing({ models: [] }), false);
});
test("row values are escaped and unavailable prices are explicit", () => {
  const row = rowHtml({ id: '<id>', name: '<b>x</b>' });
  assert.match(row, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(row, /&lt;id&gt;/);
  assert.match(row, /—/);
});
test("formatUsd trims trailing zeros and never rounds a sub-cent price to $0", () => {
  assert.equal(formatUsd(0.054), "$0.054");
  assert.equal(formatUsd(0.0018), "$0.0018");
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(-0.0007), "−$0.0007");
  assert.equal(formatUsd(undefined), "—");
});


test("page and module contain only our reference prices; discovery stays linked", async () => {
  const html = await readFile(path.join(website, "pricing/index.html"), "utf8");
  const module = await readFile(path.join(website, "pricing.mjs"), "utf8");
  for (const text of [html, module]) assert.doesNotMatch(text, /BlockRun|save|Difference|vs BlockRun/i);
  assert.doesNotMatch(html, /\$\d/);
  assert.deepEqual([...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map(m => m[1]),
    ["Model", "SingIt upto", "SingIt exact"]);
  assert.match(html, /colspan="3"/);
  assert.match(html, /data-pricing-page/);
  assert.match(html, /href="\/pricing\/" aria-current="page"/);
  for (const file of ["llms.txt", "llms-full.txt", "SKILL.md"])
    assert.doesNotMatch(await readFile(path.join(website, file), "utf8"), /BlockRun/i);
});
test("build output contains /pricing/, the sitemap lists it", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "singit-pricing-"));
  try {
    const built = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(website, "build.mjs"), out], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout))));
    });
    assert.equal(built, out);

    const page = path.join(out, "pricing", "index.html");
    assert.ok((await stat(page)).isFile(), "pricing/index.html missing from the build output");
    const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("<loc>https://singitai.app/pricing/</loc>"), "sitemap missing /pricing/");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a model the API recommends upto for says so next to its exact price; others do not", () => {
  const withAdvice = { ...PRICING_JSON, models: PRICING_JSON.models.map((m) =>
    (m.id === "claude-opus-5.5" ? { ...m, recommendedScheme: "upto" } : m)) };
  const [opus, deepseek] = pricingRows(withAdvice);
  assert.equal(opus.recommendedScheme, "upto");
  assert.equal(deepseek.recommendedScheme, undefined);
  assert.match(rowHtml(opus), /\$0\.036 <span class="fine">sign upto<\/span>/);
  assert.doesNotMatch(rowHtml(deepseek), /sign upto/);
  // Nothing about the numbers moves: the advice is a label, the figures still come from pricing.json.
  assert.equal(opus.singitUptoUsd, 0.054);
  assert.equal(opus.singitExactUsd, 0.036);
});

test("the pricing page, llms.txt and the developers first-paid-call tab tell Opus buyers to sign upto", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
  assert.match(await read("pricing/index.html"), /for Claude Opus it carries room for the model's thinking tokens, so sign upto there/);
  assert.match(await read("llms.txt"), /For Claude Opus, sign `upto`/);
  assert.match(await read("developers/index.html"), /For Claude Opus sign <span class="mono">upto<\/span>/);
});
