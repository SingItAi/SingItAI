import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { x402ResourceServer } from "@x402/express";
import { METERED_ROUTE } from "../src/pricing.mjs";
import { addPaymentRoute } from "../src/metered.mjs";
import { HealthStats, numbersBody } from "../src/health-stats.mjs";

test("shared resource server records each event once and resolves its actual route", () => {
  const app = express(), server = new x402ResourceServer({ getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) });
  const after = [], failed = [];
  server.onAfterSettle = fn => { after.push(fn); return server; };
  server.onSettleFailure = fn => { failed.push(fn); return server; };
  app.locals.healthStats = new HealthStats({ isPublicRoute: r => ["/one", "/two"].includes(r) });
  const guard = { record() {}, middleware(_req, _res, next) { next(); } };
  for (const path of ["/one", "/two", METERED_ROUTE]) addPaymentRoute(app,
    { [`POST ${path}`]: { accepts: [] } }, server, { discoverable: false, permitGuard: guard, log() {} });
  const event = path => ({ transportContext: { request: { path } }, paymentPayload: { resource: { url: `https://example.test${path}` } },
    requirements: { network: "eip155:8453", scheme: "exact", amount: "1000" },
    result: { success: true, payer: "test-payer" } });
  for (const path of ["/two", METERED_ROUTE, "/unknown"]) for (const fn of after) fn(event(path));
  assert.equal(numbersBody(app.locals.healthStats).paid_calls.total, 1);
  assert.equal(app.locals.healthStats.rails().base.settled, 3);
  // Diagnostic failure hooks also exist per route; only the single stats hook changes these counters.
  for (const fn of failed) fn(event("/two"));
  assert.equal(app.locals.healthStats.rails().base.failed, 1);
  // Client resource metadata cannot select a different route or hide a public payment.
  for (const resource of [undefined, { url: "https://example.test/one" }]) {
    const ctx = event("/two"); ctx.paymentPayload.resource = resource;
    for (const fn of after) fn(ctx);
  }
  const internal = event(METERED_ROUTE);
  internal.paymentPayload.resource.url = "https://example.test/one";
  for (const fn of after) fn(internal);
  const missingPath = event("/one"); delete missingPath.transportContext;
  for (const fn of after) fn(missingPath);
  assert.equal(numbersBody(app.locals.healthStats).paid_calls.total, 3);
  // Upto without an override must not turn the authorization ceiling into volume.
  const upto = event("/two"); upto.requirements.scheme = "upto";
  for (const fn of after) fn(upto);
  assert.equal(numbersBody(app.locals.healthStats).usdc_volume.calls_without_amount, 1);
  upto.transportContext.responseHeaders = { "Settlement-Overrides": JSON.stringify({ amount: "123" }) };
  upto.requirements.amount = "123";
  for (const fn of after) fn(upto);
  assert.equal(numbersBody(app.locals.healthStats).usdc_volume.total, 0.003123);
  upto.result.amount = "100";
  for (const fn of after) fn(upto);
  assert.equal(numbersBody(app.locals.healthStats).usdc_volume.total, 0.003223);
  app.locals.healthStats.recordSettlement = () => { throw new Error("stats offline"); };
  for (const fn of after) assert.doesNotThrow(() => fn(event("/two")));
});

test("app read endpoints preserve legacy fields, CORS and private public-only measurements offline", async () => {
  const { createApp, ROUTE, BASE } = await import("../src/app.mjs");
  const client = { getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) };
  const app = createApp({ model: "text", payToBase: "0x" + "1".repeat(40),
    payToSolana: "1".repeat(32) }, { facilitatorClient: client, catalogue: null, log() {} });
  const stats = app.locals.healthStats, payer = "private-test-payer";
  stats.recordModel("text", { ok: true });
  stats.recordSettlement({ route: ROUTE, network: BASE, scheme: "exact", ok: true, amount: "1000", payer });
  stats.recordSettlement({ route: "/internal", network: BASE, scheme: "exact", ok: true, amount: "1000", payer });
  const read = path => {
    const layers = (app._router?.stack ?? app.router.stack).find(l => l.route?.path === path).route.stack;
    const headers = {}; let body;
    const response = { set(k, v) { headers[k.toLowerCase()] = v; return this; }, json(v) { body = v; } };
    let i = 0;
    const next = () => layers[i++]?.handle({}, response, next);
    next(); return { headers, body };
  };
  const h = read("/health"), n = read("/numbers.json");
  for (const key of ["ok", "service", "model", "facilitator", "pricing", "free", "metered"])
    assert.ok(Object.hasOwn(h.body, key));
  assert.equal(h.body.ok, true); assert.equal(h.body.models.text.successes, 1);
  assert.equal(h.body.payments.networks.base.settled, 2);
  assert.equal(n.body.paid_calls.total, 1); assert.equal(n.body.usdc_volume.total, 0.001);
  assert.equal(n.body.unique_payers.total, 1);
  assert.equal(h.headers["access-control-allow-origin"], "*");
  assert.equal(n.headers["access-control-allow-origin"], "*");
  assert.equal(h.headers["cache-control"], "no-store");
  assert.equal(n.headers["cache-control"], "public, max-age=60");
  assert.ok(!JSON.stringify([h.body, n.body]).includes(payer));
});
