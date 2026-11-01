// The developer pages' helpers: how prices read, which models show, and in what order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { choosable, filterModels, formatUsd, isEstimate, pickPopular, providerLabel, rowHtml, shownSaving,
  sortModels, tagsOf } from "../dev.mjs";

const OPUS = { id: "claude-opus-5.5", name: "Claude Opus 5.5", owned_by: "anthropic", tags: ["vision", "code"],
  usdPerMillionTokens: { input: 4, output: 20 }, expectedUsdPerMillionTokens: { input: 0.78, output: 3.9, basis: "observed" },
  singitUsdPerMillionTokens: { input: 1.014, output: 5.07 }, savingsVsListPct: 75 };
const GEMINI = { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", owned_by: "google", tags: ["vision"],
  usdPerMillionTokens: { input: 2, output: 12 }, expectedUsdPerMillionTokens: { input: 0.006, output: 0.036, basis: "trusted" },
  singitUsdPerMillionTokens: { input: 0.0078, output: 0.047 }, savingsVsListPct: 100 };
const PLAIN = { id: "plain-model", name: "Plain <b>Model</b>", owned_by: "someone", tags: [],
  usdPerMillionTokens: { input: 1, output: 2 } };
const LIST = { free: { models: ["free/deepseek-v4.1-flash"] },
  data: [{ id: "singit-ask", object: "model" }, { id: "singit/auto", object: "model" }, OPUS, GEMINI, PLAIN] };

test("prices read short and never invent a price", () => {
  assert.equal(formatUsd(20), "$20.00");
  assert.equal(formatUsd(5.07), "$5.07");
  assert.equal(formatUsd(0.488), "$0.488");
  assert.equal(formatUsd(0.0193), "$0.019");
  assert.equal(formatUsd(0.0013), "$0.0013");
  assert.equal(formatUsd(0), "—");
  assert.equal(formatUsd(undefined), "—");
});

test("a saving never reads as free, and estimates are marked", () => {
  assert.equal(shownSaving(100), 99);
  assert.equal(shownSaving(75), 75);
  assert.equal(shownSaving(0), null);
  assert.equal(shownSaving(undefined), null);
  assert.equal(isEstimate(GEMINI), true);
  assert.equal(isEstimate(OPUS), false);
  const row = rowHtml(GEMINI);
  assert.match(row, /&minus;99%/);
  assert.doesNotMatch(row, /100%/);
  assert.match(row, /est\./);
  assert.doesNotMatch(rowHtml(OPUS), /est\./);
});

test("the standing entry is not a choice, and popular models keep their order", () => {
  assert.deepEqual(choosable(LIST).map((m) => m.id), ["claude-opus-5.5", "gemini-3.1-pro-preview", "plain-model"]);
  assert.deepEqual(pickPopular(choosable(LIST), ["plain-model", "gemini-3.1-pro-preview", "claude-opus-5.5"]).map((m) => m.id),
    ["gemini-3.1-pro-preview", "claude-opus-5.5"], "a model with no price of ours is left out");
});

test("search, capability and free filters", () => {
  const models = choosable(LIST);
  assert.deepEqual(filterModels(models, { query: "anthropic" }).map((m) => m.id), ["claude-opus-5.5"]);
  assert.deepEqual(filterModels(models, { query: "GEMINI" }).map((m) => m.id), ["gemini-3.1-pro-preview"]);
  assert.deepEqual(filterModels(models, { tag: "code" }).map((m) => m.id), ["claude-opus-5.5"]);
  assert.deepEqual(filterModels(models, { tag: "free", free: ["plain-model"] }).map((m) => m.id), ["plain-model"]);
  assert.deepEqual(tagsOf(models), ["vision", "code"]);
});

test("sorting by saving, price and name", () => {
  const models = choosable(LIST);
  assert.deepEqual(sortModels(models, "saving", "descending").map((m) => m.id),
    ["gemini-3.1-pro-preview", "claude-opus-5.5", "plain-model"]);
  assert.deepEqual(sortModels(models, "price", "ascending").map((m) => m.id),
    ["gemini-3.1-pro-preview", "plain-model", "claude-opus-5.5"], "a model without our price sorts by its list price");
  assert.deepEqual(sortModels(models, "name", "ascending").map((m) => m.id),
    ["claude-opus-5.5", "gemini-3.1-pro-preview", "plain-model"]);
});

test("featured order: popular first, then priced models, then the rest, by name", () => {
  const models = choosable(LIST);
  assert.deepEqual(sortModels(models, "featured").map((m) => m.id), ["claude-opus-5.5", "gemini-3.1-pro-preview", "plain-model"]);
});

test("rows escape what the model list says and mark the free model", () => {
  const row = rowHtml(PLAIN, { free: ["plain-model"] });
  assert.match(row, /Plain &lt;b&gt;Model&lt;\/b&gt;/);
  assert.match(row, /Free to try/);
  assert.equal(providerLabel("anthropic"), "Anthropic");
  assert.equal(providerLabel("x-ai"), "xAI");
  assert.equal(providerLabel("someone"), "Someone");
});

test("zero token prices are absent from popular picks, rankings and rows", () => {
  const zero = { ...OPUS, singitUsdPerMillionTokens: { input: 0, output: 0 }, savingsVsListPct: 100 };
  assert.deepEqual(pickPopular([zero]), []);
  assert.equal(sortModels([zero, GEMINI], "featured")[0], GEMINI);
  assert.equal(sortModels([zero, GEMINI], "saving")[0], GEMINI);
  assert.doesNotMatch(rowHtml(zero), /\$0|100%|99%/);
});

test("free list input keeps a positive SingIt output visible", () => {
  const model = { ...OPUS, usdPerMillionTokens: { input: 0, output: 20 },
    singitUsdPerMillionTokens: { input: 0, output: 5.07 } };
  assert.deepEqual(pickPopular([model]), [model]);
  assert.match(rowHtml(model), /\$5\.07/);
  assert.equal(sortModels([PLAIN, model], "featured")[0], model);
});
