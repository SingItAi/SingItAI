import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { statusLabel, summaryText, modelRows, railRows, numberRows, availabilityRows, tableRows, loadJson } from "../status.mjs";
const read = p => readFile(new URL(`../${p}`, import.meta.url), "utf8");
test("status labels and measured fixture rows", () => {
  assert.equal(statusLabel("down"), "Down"); assert.equal(statusLabel("bad"), "Unknown");
  const rail = { status: "up", basis: "settlements", settled: 2, failed: 0, lastSettledAt: null };
  const h = { models: { text: { status: "up", successes: 2, failures: 0, errorRatePct: 0 } },
    payments: { networks: { base: rail, solana: rail } } };
  assert.deepEqual(modelRows(h)[0].slice(0, 5), ["text", "Up", 2, 0, "0%"]);
  assert.equal(railRows(h)[0][0], "Base");
  assert.throws(() => numberRows(null)); assert.throws(() => modelRows(null));
});
test("fetch errors never become numbers", async () => {
  await assert.rejects(loadJson("https://example.test", async () => ({ ok: false })));
});
test("static status page and discovery are safe", async () => {
  const page = await read("status/index.html"), script = await read("status.mjs");
  assert.match(page, /<script type="module" src="\/status\.mjs\?v=2"><\/script>/);
  assert.match(page, /rel="canonical" href="https:\/\/singitai.app\/status\/"/);
  assert.doesNotMatch(page, /video|0x[a-f0-9]{40}/i);
  assert.doesNotMatch(script, /innerHTML/); assert.match(script, /textContent/);
  assert.match(await read("sitemap.xml"), /https:\/\/singitai.app\/status\//);
  assert.match(await read("llms.txt"), /Health and status:/);
  assert.match(await read("_redirects"), /\/numbers.json https:\/\/ask.singitai.app\/numbers.json 302/);
});

test("numbers retain observed zeros and mark only unavailable unique counts", () => {
  const values = { total: 0, last_24h: 0, last_7d: 0 };
  const rows = numberRows({ schema: 1, paid_calls: values, usdc_volume: values,
    unique_payers: { ...values, last_7d: null } });
  assert.deepEqual(rows[0], ["Paid calls", 0, 0, 0]);
  assert.deepEqual(rows[2], ["Unique payer wallets", 0, 0, "Not measurable"]);
});

test("empty and error states are single spanning cells", () => {
  assert.deepEqual(tableRows(modelRows({ models: {} }), 6,
    "No model answers recorded in the last 24 hours."),
    [[{ text: "No model answers recorded in the last 24 hours.", colspan: 6 }]]);
  for (const [columns, message] of [[6, "Could not load model status."],
    [6, "Could not load payment status."], [4, "Could not load measured numbers."],
    [2, "Could not load definitions."], [5, "Could not load availability."]]) {
    assert.deepEqual(tableRows([], columns, message), [[{ text: message, colspan: columns }]]);
  }
  assert.deepEqual(tableRows([[0, "<data>"]], 2, "Empty"),
    [[{ text: "0", colspan: 1 }, { text: "<data>", colspan: 1 }]]);
});

test("availability fixture filters endpoints and preserves measured window coverage", () => {
  const fixture = { endpoints: [
    { name: "ask-health", status: "up", windows: {
      "24h": { availability_pct: 100, covered: true, probes: 288 },
      "7d": { availability_pct: 99.5, covered: false, probes: 400 },
      "30d": { covered: false, probes: 400 }
    } },
    { name: "app-health", status: "down", windows: {
      "24h": { availability_pct: 0, covered: false, probes: 1 },
      "7d": { availability_pct: null, covered: true, probes: 0 }
    } },
    { name: "other-service", status: "up", windows: {} }
  ] };
  assert.deepEqual(availabilityRows(fixture), [
    ["ask-health", "Up", "100%", "99.5% (history does not yet cover this window)",
      "Not available (history does not yet cover this window)"],
    ["app-health", "Down", "0% (history does not yet cover this window)",
      "Not available", "Not available"]
  ]);
  assert.deepEqual(availabilityRows({ endpoints: [] }), []);
  assert.throws(() => availabilityRows(null), /Could not load availability/);
});

test("every status table uses pricing styling and row-based states", async () => {
  const page = await read("status/index.html"), script = await read("status.mjs");
  assert.match(page, /class="hero dev-hero"/);
  assert.match(page, /class="eyebrow">Status</);
  assert.equal((page.match(/<div class="table-wrap"><table class="mtable">/g) || []).length, 5);
  assert.equal((page.match(/<caption>/g) || []).length, 5);
  for (const id of ["models", "rails", "numbers", "definitions", "availability"]) {
    assert.match(page, new RegExp(`<tbody id="${id}"><tr><td colspan="[2456]">`));
    assert.doesNotMatch(script, new RegExp(`text\\("${id}"`));
  }
  assert.match(script, /loadJson\(AVAILABILITY_URL\)/);
  assert.match(script, /setInterval\(refresh, 60000\)/);
});

test("model labels accept only known string states", () => {
  assert.equal(statusLabel("insufficient_data"), "Not enough data");
  assert.equal(statusLabel("unavailable"), "Unavailable");
  for (const value of [null, {}, [], "constructor", "__proto__", "unexpected"])
    assert.equal(statusLabel(value), "Unknown");
});

test("old model rows retain all six columns", () => {
  const m = { status: "up", successes: 2, failures: 0, errorRatePct: 0, lastSuccessAt: null };
  assert.deepEqual(modelRows({ models: { text: m } }),
    [["text", "Up", 2, 0, "0%", "No success recorded"]]);
});

test("new model rows show validated details for each state", () => {
  const until = "2026-10-31T12:00:00Z";
  const base = { successes: 2, failures: 1, errorRatePct: 33.3, lastSuccessAt: until,
    windowHours: 24, attempts: 3, lastOutcome: "success", sellerFailures: 1,
    failureReasons: { no_healthy_sellers: 1, minimum_discount_not_met: 0, other: 0 } };
  const cases = [
    [{ status: "up" }, "Up"],
    [{ status: "unavailable", retryAfterSeconds: 30, unavailableUntil: until },
      `Unavailable (retry in 30 s, until ${until})`],
    [{ status: "unavailable" }, "Unavailable"],
    [{ status: "unavailable", retryAfterSeconds: 30 }, "Unavailable (retry in 30 s)"],
    [{ status: "unavailable", unavailableUntil: until }, `Unavailable (until ${until})`],
    [{ status: "unavailable", retryAfterSeconds: "30", unavailableUntil: "bad" }, "Unavailable"],
    [{ status: "unavailable", retryAfterSeconds: Infinity, unavailableUntil: {} }, "Unavailable"],
    [{ status: "insufficient_data" }, "Not enough data (3 attempts, 5 needed)"],
    [{ status: "insufficient_data", attempts: 0 }, "Not enough data (0 attempts, 5 needed)"],
    [{ status: "insufficient_data", attempts: "3" }, "Not enough data"],
    [{ status: "insufficient_data", attempts: 1.5 }, "Not enough data"],
    [{ status: "degraded", reason: "no_healthy_sellers" }, "Degraded (no healthy sellers)"],
    [{ status: "down", reason: "minimum_discount_not_met" }, "Down (minimum discount not met)"],
    [{ status: "down", reason: "other" }, "Down"],
    [{ status: "degraded", reason: "<untrusted>" }, "Degraded"]
  ];
  for (const [fields, label] of cases) assert.deepEqual(modelRows({ models: { text: { ...base, ...fields } } }),
    [["text", label, 2, 1, "33.3%", until]]);
});

test("malformed model entries render without throwing or coercing objects", () => {
  for (const entry of [null, false, "bad", [], {}, { status: {}, successes: {}, failures: [],
    errorRatePct: "0", lastSuccessAt: {} }]) {
    assert.deepEqual(modelRows({ models: { text: entry } }),
      [["text", "Unknown", "Not available", "Not available", "Not available", "No success recorded"]]);
  }
  for (const errorRatePct of [null, undefined, NaN, Infinity, {}, "10"])
    assert.equal(modelRows({ models: { text: { errorRatePct } } })[0][4], "Not available");
  assert.deepEqual(tableRows(modelRows({ models: { "<script>": { lastSuccessAt: "<img>" } } }), 6, "" )
    [0].map(cell => cell.text), ["<script>", "Unknown", "Not available", "Not available", "Not available", "<img>"]);
});

test("model summary requires all five non-negative integer counts", () => {
  const models_summary = { up: 5, degraded: 1, down: 0, insufficient_data: 2, unavailable: 1 };
  assert.equal(summaryText({ models_summary }),
    "Models: 5 up, 1 degraded, 0 down, 2 not enough data, 1 unavailable.");
  for (const health of [null, {}, { models: {} }, { models_summary: null }, { models_summary: [] }])
    assert.equal(summaryText(health), "");
  for (const key of Object.keys(models_summary)) {
    for (const value of [undefined, null, -1, 1.5, Infinity, NaN, "1", {}])
      assert.equal(summaryText({ models_summary: { ...models_summary, [key]: value } }), "");
  }
});
