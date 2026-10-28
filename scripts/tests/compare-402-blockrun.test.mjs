import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_NETWORK, BASE_USDC, MODELS, compareModel, parseAccepts, renderText, run } from "../compare-402-blockrun.mjs";

const offer = (scheme, atomic, network = BASE_NETWORK, asset = BASE_USDC) => ({ scheme, network, asset, amount: String(atomic), atomic: String(atomic) });
const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const header = (accepts) => new Headers({ "payment-required": encode({ x402Version: 2, accepts }) });

test("accepts are read from the PAYMENT-REQUIRED header, the X- form, or the JSON body", () => {
  const accepts = [offer("upto", 3767), offer("exact", 1500)];
  assert.deepEqual(parseAccepts({ status: 402, headers: header(accepts) }).offers.map((o) => o.atomic), ["3767", "1500"]);
  assert.equal(parseAccepts({ status: 402, headers: new Headers({ "x-payment-required": encode({ accepts }) }) }).offers.length, 2);
  assert.equal(parseAccepts({ status: 402, headers: new Headers(), body: { accepts: [{ scheme: "exact", network: BASE_NETWORK, asset: BASE_USDC, maxAmountRequired: "2152" }] } }).offers[0].atomic, "2152");
  assert.equal(parseAccepts({ status: 200, headers: new Headers() }).error, "http_200");
  assert.equal(parseAccepts({ status: 402, headers: new Headers(), body: { nope: 1 } }).error, "no_accepts");
  assert.equal(parseAccepts({ status: 402, headers: header([{ scheme: "exact", network: BASE_NETWORK, asset: BASE_USDC, amount: "12.5" }]) }).error, "no_amounts");
});

test("the cheapest Base offer of each side is compared; a dearer SingIt alerts", () => {
  const ours = { offers: [offer("upto", 3767), offer("exact", 2037), offer("exact", 1, "solana:x")] };
  const theirs = { offers: [offer("exact", 2152)] };
  const row = compareModel("claude-opus-5.5", ours, theirs);
  assert.equal(row.oursCheapestUsd, 0.002037);
  assert.equal(row.theirsCheapestUsd, 0.002152);
  assert.equal(row.verdict, "cheaper");
  assert.equal(row.alert, false);
  const dearer = compareModel("claude-opus-5.5", { offers: [offer("upto", 3767), offer("exact", 3767)] }, theirs);
  assert.equal(dearer.verdict, "dearer");
  assert.equal(dearer.alert, true);
  assert.equal(dearer.ratio, 1.7505);
  assert.deepEqual(dearer.exactVsExact, { oursUsd: 0.003767, theirsUsd: 0.002152, ratio: 1.7505 });
});

test("a tolerance keeps a small difference from alerting, and equal prices are not an alert", () => {
  const theirs = { offers: [offer("exact", 2000)] };
  assert.equal(compareModel("m", { offers: [offer("exact", 2030)] }, theirs, { tolerance: 0.02 }).alert, false);
  assert.equal(compareModel("m", { offers: [offer("exact", 2050)] }, theirs, { tolerance: 0.02 }).alert, true);
  const same = compareModel("m", { offers: [offer("exact", 2000)] }, theirs);
  assert.equal(same.verdict, "same");
  assert.equal(same.alert, false);
});

test("a probe that failed, or a side with no Base offer, is unknown and never an alert", () => {
  assert.equal(compareModel("m", { error: "timeout" }, { offers: [offer("exact", 1)] }).alert, false);
  assert.equal(compareModel("m", { error: "timeout" }, { offers: [offer("exact", 1)] }).verdict, "unknown");
  const none = compareModel("m", { offers: [offer("exact", 5, "solana:x")] }, { offers: [offer("exact", 1)] });
  assert.equal(none.ours, "no_base_offer");
  assert.equal(none.verdict, "unknown");
});

function fakeFetch(prices, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    const ours = url.startsWith("https://ask.singitai.app/v1/chat/");
    const model = ours ? url.split("/").pop() : body.model.split("/").pop();
    const amount = prices[model]?.[ours ? 0 : 1];
    if (amount === "down") throw Object.assign(new Error("boom"), { name: "TimeoutError" });
    return new Response("{}", { status: 402, headers: header([offer("exact", amount)]) });
  };
}

test("run sends one unpaid POST per model per side, to the two hosts only, with no payment or auth header", async () => {
  const seen = [];
  const prices = Object.fromEntries(MODELS.map(([id], i) => [id, [1500 + i, 2000]]));
  const report = await run({ fetchImpl: fakeFetch(prices, seen), now: () => new Date("2026-10-28T08:00:00Z") });
  assert.equal(seen.length, MODELS.length * 2);
  assert.deepEqual([...new Set(seen.map((s) => new URL(s.url).hostname))].sort(), ["ask.singitai.app", "blockrun.ai"]);
  for (const { init } of seen) {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    const names = Object.keys(init.headers).map((h) => h.toLowerCase());
    assert.deepEqual(names.sort(), ["content-type", "user-agent"]);
    assert.equal(JSON.parse(init.body).max_tokens, 500);
  }
  assert.equal(report.at, "2026-10-28T08:00:00.000Z");
  assert.deepEqual(report.alerts, []);
  assert.equal(report.cheaper, MODELS.length);
});

test("run reports which models cost more and which probes failed", async () => {
  const [[a], [b], [c]] = MODELS;
  const prices = { [a]: [3767, 2152], [b]: [1600, 2000], [c]: ["down", 2000] };
  const report = await run({ fetchImpl: fakeFetch(prices), maxTokens: 300 });
  assert.deepEqual(report.alerts, [a]);
  assert.equal(report.errors.length, 2);   // gpt-5.5 timed out, deepseek has no price in the fake
  assert.equal(report.errors[0].ours, "timeout");
  assert.equal(report.maxTokens, 300);
  const text = renderText(report);
  assert.match(text, /claude-opus-5\.5 .*dearer {2}← ALERT/);
  assert.match(text, /gpt-5\.5 .*unknown \(ours: timeout/);
});

test("a host that is not on the list is refused", async () => {
  const report = await run({ fetchImpl: fakeFetch({}), oursBase: "https://evil.example", models: [MODELS[0]] });
  assert.equal(report.errors[0].ours, "host_not_allowed");
});

test("an x402 v1 challenge (network \"base\", maxAmountRequired) is compared, not skipped", () => {
  const v1 = parseAccepts({ status: 402, headers: new Headers(), body: { x402Version: 1, accepts: [{ scheme: "exact", network: "base", asset: BASE_USDC.toUpperCase().replace("0X", "0x"), maxAmountRequired: "3767" }] } });
  const row = compareModel("m", v1, { offers: [offer("exact", 2152)] });
  assert.equal(row.verdict, "dearer");
  assert.equal(row.alert, true);
});

test("an offer in another token on Base is never taken as a dollar price", () => {
  const other = { offers: [offer("exact", 1, BASE_NETWORK, "0x4200000000000000000000000000000000000006"), offer("exact", 2000)] };
  assert.equal(compareModel("m", other, { offers: [offer("exact", 2000)] }).oursCheapestUsd, 0.002);
  const onlyOther = { offers: [offer("exact", 1, BASE_NETWORK, "0x4200000000000000000000000000000000000006")] };
  assert.equal(compareModel("m", onlyOther, { offers: [offer("exact", 2000)] }).verdict, "unknown");
  assert.equal(compareModel("m", { offers: [{ scheme: "exact", network: BASE_NETWORK, asset: "", atomic: "1" }] }, { offers: [offer("exact", 2000)] }).verdict, "unknown");
});

test("the tolerance boundary is exact: 13% over at tolerance 0.13 is not an alert, one atomic more is", () => {
  const theirs = { offers: [offer("exact", 100)] };
  assert.equal(compareModel("m", { offers: [offer("exact", 113)] }, theirs, { tolerance: 0.13 }).alert, false);
  assert.equal(compareModel("m", { offers: [offer("exact", 114)] }, theirs, { tolerance: 0.13 }).alert, true);
  assert.equal(compareModel("m", { offers: [offer("exact", 2152)] }, { offers: [offer("exact", 2152)] }, { tolerance: 0 }).alert, false);
});
