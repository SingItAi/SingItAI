import { test } from "node:test";
import assert from "node:assert/strict";
import { slimPaymentRequired, paymentRequiredHeaderMiddleware } from "../src/payment-required-header.mjs";
const minimal = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };
const challenge = () => ({ x402Version: 2, error: "payment_required",
  resource: { url: "https://example.test/paid", description: "Example", tags: ["example"] },
  accepts: [{ scheme: "exact", amount: "100" }],
  extensions: Object.fromEntries(["bazaar", "eip2612GasSponsoring", "builder-code"].map(key => [key, {
    info: { input: { body: { prompt: "Example" } }, output: { example: { result: "Example" } } },
    schema: { type: "object", properties: { input: { description: "Detailed schema".repeat(1000) } } },
    routeTemplate: "/paid",
  }])) });

test("slimming preserves info, offers and resource without mutating the original", () => {
  const full = challenge();
  full.extensions.other = { info: { enabled: true } };
  full.extensions.flag = true;
  const original = structuredClone(full);
  const slim = slimPaymentRequired(full);
  assert.deepEqual(full, original);
  assert.deepEqual(slim.accepts, full.accepts);
  assert.deepEqual(slim.resource, full.resource);
  assert.equal(slim.x402Version, full.x402Version);
  assert.equal(slim.error, full.error);
  for (const key of ["bazaar", "eip2612GasSponsoring", "builder-code"]) {
    assert.deepEqual(slim.extensions[key], { ...full.extensions[key], schema: minimal });
  }
  assert.deepEqual(slim.extensions.other, full.extensions.other);
  assert.equal(slim.extensions.flag, true);
});
function response(log = () => {}) {
  const headers = new Map();
  const res = { locals: {}, statusCode: 402,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name) { return headers.get(name.toLowerCase()); }, json(body) { return body; } };
  paymentRequiredHeaderMiddleware({ log })({}, res, () => {});
  return res;
}
for (const name of ["PAYMENT-REQUIRED", "payment-required"]) test(`middleware slims ${name} and attaches full extensions to 402`, () => {
  const res = response();
  const full = challenge();
  res.setHeader(name, Buffer.from(JSON.stringify(full)).toString("base64"));
  assert.deepEqual(JSON.parse(Buffer.from(res.getHeader(name), "base64")), slimPaymentRequired(full));
  assert.deepEqual(res.locals.singitPaymentRequiredFull, full);
  const body = { error: "payment_required", code: "payment_required", x402Version: 2,
    accepts: full.accepts, singitSpendLimit: { available: true } };
  assert.deepEqual(res.json(body), { ...body, extensions: full.extensions });
  assert.equal(res.json(null), null);
  res.statusCode = 200;
  assert.deepEqual(res.json(body), body);
});
test("invalid challenges pass through with safe logging even if the logger throws", () => {
  const logs = [];
  const res = response(line => { logs.push(line); throw new Error("logger failed"); });
  for (const value of ["malformed", Buffer.from("null").toString("base64")]) {
    res.setHeader("payment-required", value);
    assert.equal(res.getHeader("payment-required"), value);
    assert.equal(res.locals.singitPaymentRequiredFull, undefined);
  }
  assert.deepEqual(logs, Array(2).fill("singit-ask: payment-required header slimming skipped"));
  res.setHeader("other", "unchanged");
  assert.equal(res.getHeader("other"), "unchanged");
});
