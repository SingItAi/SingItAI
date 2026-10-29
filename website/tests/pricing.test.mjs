// /pricing/: SingIt vs BlockRun. Pure matching/math against fixtures, the committed snapshot's own schema,
// and that the built page carries no hard-coded SingIt price (every number there comes from a live fetch).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bareId, blockrunPrice, formatUsd, matchModels, providerOf, rowHtml, validPricing, validSnapshot }
  from "../pricing.mjs";

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
    { id: "no-blockrun-match", name: "Only on SingIt",
      upto: { base: { priceAtomic: "1500", usd: 0.0015 }, solana: { priceAtomic: "1500", usd: 0.0015 } },
      exact: { base: { ceilingAtomic: "1500", usd: 0.0015 }, solana: { ceilingAtomic: "1500", usd: 0.0015 } } },
  ],
};
const SNAPSHOT = {
  source: "https://blockrun.ai/api/v1/models", fetchedAt: "2026-10-24T15:07:00Z", transactionFeeUsd: 0.001,
  models: [
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 },
    { id: "openai/only-on-blockrun", name: "Only on BlockRun", inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  ],
};

test("provider and bare id come from BlockRun's \"provider/id\" shape", () => {
  assert.equal(providerOf("anthropic/claude-opus-5.5"), "anthropic");
  assert.equal(bareId("anthropic/claude-opus-5.5"), "claude-opus-5.5");
  assert.equal(providerOf("no-slash"), "no-slash");
  assert.equal(bareId("no-slash"), "no-slash");
});

test("BlockRun price: provider cost at the reference request's token counts, plus the flat fee", () => {
  const model = { inputUsdPerMillion: 10, outputUsdPerMillion: 50 };
  const price = blockrunPrice(model, REFERENCE_REQUEST, 0.001);
  // 35 input tokens * $10/1e6 + 800 output tokens * $50/1e6 + $0.001 fee
  assert.equal(price, (35 * 10) / 1e6 + (800 * 50) / 1e6 + 0.001);
});

test("only models both sides list are matched, by bare id; sorted by provider then id", () => {
  const rows = matchModels(PRICING_JSON, SNAPSHOT);
  assert.deepEqual(rows.map((r) => r.id), ["claude-opus-5.5", "deepseek-v4.1-flash"]);
  assert.deepEqual(rows.map((r) => r.provider), ["anthropic", "deepseek"]);
});

test("each matched row carries SingIt's real upto/exact numbers and BlockRun's computed price", () => {
  const [opus] = matchModels(PRICING_JSON, SNAPSHOT);
  assert.equal(opus.singitUptoUsd, 0.054);
  assert.equal(opus.singitExactUsd, 0.036);
  const expectedBlockrun = (35 * 10) / 1e6 + (800 * 50) / 1e6 + 0.001;
  assert.equal(opus.blockrunUsd, expectedBlockrun);
  assert.equal(opus.differenceUsd, expectedBlockrun - 0.054);
});

test("formatUsd trims trailing zeros and never rounds a sub-cent price to $0", () => {
  assert.equal(formatUsd(0.054), "$0.054");
  assert.equal(formatUsd(0.0018), "$0.0018");
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(-0.0007), "−$0.0007");
  assert.equal(formatUsd(undefined), "—");
});

test("row html escapes the name and marks a real saving, never a negative one as a saving", () => {
  const cheaper = { id: "m", name: "Model", provider: "x", singitUptoUsd: 0.01, singitExactUsd: 0.02,
    blockrunUsd: 0.05, differenceUsd: 0.04 };
  assert.match(rowHtml(cheaper), /class="saving"/);
  const pricier = { ...cheaper, name: "<b>x</b>", differenceUsd: -0.01 };
  const row = rowHtml(pricier);
  assert.match(row, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(row, /class="saving"/);
});

test("validPricing and validSnapshot refuse data missing what matchModels/blockrunPrice need", () => {
  assert.equal(validPricing(PRICING_JSON), true);
  assert.equal(validPricing({ models: [] }), false);
  assert.equal(validSnapshot(SNAPSHOT), true);
  assert.equal(validSnapshot({ ...SNAPSHOT, transactionFeeUsd: "0.001" }), false);
  assert.equal(validSnapshot({ ...SNAPSHOT, models: [{ id: "a/b" }] }), false);
});

test("the committed BlockRun snapshot itself is schema-valid and non-empty", async () => {
  const snapshot = JSON.parse(await readFile(path.join(website, "data", "blockrun-prices.json"), "utf8"));
  assert.ok(validSnapshot(snapshot), "website/data/blockrun-prices.json fails its own schema");
  assert.ok(snapshot.models.length > 0, "the committed snapshot lists no models");
});

test("/pricing/ has no hard-coded SingIt price: every number is fetched live", async () => {
  const html = await readFile(path.join(website, "pricing", "index.html"), "utf8");
  assert.doesNotMatch(html, /\$\d/, "a literal dollar amount was found in the page source");
  assert.ok(html.includes('data-pricing-page'), "the page wires up pricing.mjs's init()");
});

test("build output contains /pricing/, the snapshot data file, and the sitemap lists it", async () => {
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
    assert.ok((await stat(path.join(out, "data", "blockrun-prices.json"))).isFile(),
      "data/blockrun-prices.json missing from the build output");

    const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("<loc>https://singitai.app/pricing/</loc>"), "sitemap missing /pricing/");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a model the API recommends upto for says so next to its exact price; others do not", () => {
  const withAdvice = { ...PRICING_JSON, models: PRICING_JSON.models.map((m) =>
    (m.id === "claude-opus-5.5" ? { ...m, recommendedScheme: "upto" } : m)) };
  const [opus, deepseek] = matchModels(withAdvice, SNAPSHOT);
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
