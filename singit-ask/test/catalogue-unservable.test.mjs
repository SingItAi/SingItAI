import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalogue, canServe, cheapestShare, markUnservable } from "../src/catalogue.mjs";

const offer = { trusted: true, healthy: true, available: true, provider_id: "venice", cap_remaining: null,
  discount_pct: 50 };
const blocked = new Set();
test("books must name the requested model and offers must be reachable and have capacity", () => {
  for (const book of [{ model: "MODEL", offers: [offer] }, { offers: [offer] }]) {
    assert.equal(canServe(book, blocked, "model"), true);
    assert.equal(cheapestShare(book, blocked, "model"), 0.5);
  }
  const wrong = { model: "other", offers: [offer] };
  assert.equal(canServe(wrong, blocked, "model"), false);
  assert.equal(cheapestShare(wrong, blocked, "model"), null);
  for (const change of [{ trusted: false }, { healthy: false }, { available: false }, { cap_remaining: 0 },
    { cap_remaining: -1 }, { trusted: undefined }]) {
    const book = { model: "model", offers: [{ ...offer, ...change }] };
    assert.equal(canServe(book, blocked, "model"), false);
    assert.equal(cheapestShare(book, blocked, "model"), null);
  }
  assert.equal(canServe({ offers: [offer] }, new Set(["venice"]), "model"), false);
});

test("negative cache expires on the injected clock, precedes served and is bounded", async () => {
  let clock = 100;
  const catalogue = new ModelCatalogue({ url: "https://unused.test", now: () => clock, unservableTtlMs: 1000 });
  catalogue.served = new Set(["model"]);
  catalogue.servedAt = clock;
  catalogue.markUnservable("model");
  assert.equal(await catalogue.canAnswer("model"), false);
  clock += 999;
  assert.equal(catalogue.isUnservable("model"), true);
  assert.equal(catalogue.unservableRetryAfter("model"), 30);
  clock++;
  assert.equal(await catalogue.canAnswer("model"), true);
  assert.equal(catalogue.unservable.size, 0);
  for (let n = 0; n < 1100; n++) catalogue.markUnservable(`model-${n}`);
  assert.equal(catalogue.unservable.size, 1000);
  assert.equal(catalogue.isUnservable("model-0"), false);
  catalogue.markUnservable("custom", 2000);
  clock += 1000;
  catalogue.markUnservable("fresh");
  assert.equal(catalogue.unservable.size, 2);
  const disabled = new ModelCatalogue({ url: "https://unused.test", unservableTtlMs: 0 });
  disabled.markUnservable("model");
  disabled.markUnservable("model", 1000);
  assert.equal(await disabled.canAnswer("model"), true);
});

test("only no_healthy_sellers marks and logs the model", () => {
  const catalogue = new ModelCatalogue({ url: "https://unused.test" });
  const logs = [];
  for (const code of ["upstream_error", "unreachable", "429"]) {
    markUnservable(catalogue, "model", { code }, (line) => logs.push(line));
    assert.equal(catalogue.isUnservable("model"), false);
  }
  markUnservable(catalogue, "model", { code: "no_healthy_sellers" }, (line) => logs.push(line));
  assert.deepEqual(logs, ["singit-ask: model model marked unservable for 15 min (no_healthy_sellers)"]);
});

test("loadServed passes each requested id to book and guard validation", async () => {
  const catalogue = new ModelCatalogue({ url: "https://unused.test", now: () => 100,
    fetchImpl: async (url) => new Response(JSON.stringify({
      model: url.endsWith("wrong") ? "different" : "right", offers: [offer],
    })) });
  catalogue.models = new Map([["wrong", {}], ["right", {}]]);
  catalogue.guardShares.set("wrong", 0.1);
  await catalogue.loadServed(0);
  assert.equal(await catalogue.canAnswer("wrong"), false);
  assert.equal(catalogue.guardShare("wrong"), null);
  assert.equal(await catalogue.canAnswer("right"), true);
  assert.equal(catalogue.guardShare("right"), 0.5);
});

test("offer identities must match, while anonymous offers still count", () => {
  for (const field of ["model", "model_id"]) {
    const wrong = { ...offer, [field]: "other", discount_pct: 90 };
    const matching = { ...offer, [field]: "MODEL" };
    assert.equal(canServe({ model: "model", offers: [wrong] }, blocked, "model"), false);
    assert.equal(cheapestShare({ offers: [wrong] }, blocked, "model"), null);
    for (const valid of [matching, offer]) {
      const book = { model: "model", offers: [wrong, valid] };
      assert.equal(canServe(book, blocked, "model"), true);
      assert.equal(cheapestShare(book, blocked, "model"), 0.5);
    }
  }
});
