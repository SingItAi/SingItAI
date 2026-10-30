import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { statusLabel, modelRows, railRows, numberRows, availabilityRows, tableRows, loadJson } from "../status.mjs";
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
