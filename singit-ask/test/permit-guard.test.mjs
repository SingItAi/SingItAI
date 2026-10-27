import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { x402ResourceServer } from "@x402/express";
import { createPermitGuard } from "../src/permit-guard.mjs";
import { addPaymentRoute, billWithDiagnostics } from "../src/metered.mjs";
import { TERMS, billUsage } from "../src/pricing.mjs";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const payload = (nonce = "7", from = "0xABC", asset = "0xDEF", spender = PERMIT2) => ({
  payload: { permit2Authorization: {} },
  extensions: { eip2612GasSponsoring: { info: { nonce, from, asset, spender } } },
});
const upto = (asset = "0xdef") => ({ scheme: "upto", network: "eip155:8453", asset });
// What a settled upto payment carrying this permit records: payer and asset bound to the settlement.
const settle = (guard, p) => guard.record(p, upto(p.extensions.eip2612GasSponsoring.info.asset),
  { payer: p.extensions.eip2612GasSponsoring.info.from.toLowerCase() });
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
function check(guard, header, name = "payment-signature") {
  let result = "next";
  const res = { status(code) { result = code; return this; }, json(body) { this.body = body; } };
  guard.middleware({ get: key => key === name ? header : undefined }, res, () => {});
  return { result, body: res.body };
}
test("consumed permits reject stale nonces and pass other or malformed payments", () => {
  const guard = createPermitGuard();
  settle(guard, payload());
  settle(guard, payload("5"));
  for (const nonce of ["6", "7"]) {
    const response = check(guard, encode(payload(nonce, "0xabc", "0xdef")));
    assert.equal(response.result, 409);
    assert.equal(response.body.error.code, "stale_payment_permit");
  }
  assert.equal(check(guard, encode(payload()), "x-payment").result, 409);
  for (const value of [payload("8"), payload("7", "other"), payload("7", "0xABC", "other"), {},
    payload("invalid"), null]) assert.equal(check(guard, encode(value)).result, "next");
  for (const header of [undefined, "not json", "bnVsbA=="]) assert.equal(check(guard, header).result, "next");
});
test("permit memory expires and evicts oldest entries", () => {
  let time = 0;
  const guard = createPermitGuard({ maxEntries: 2, ttlMs: 10, now: () => time });
  for (const owner of ["one", "two", "three"]) settle(guard, payload("7", owner));
  assert.equal(check(guard, encode(payload("7", "one"))).result, "next");
  assert.equal(check(guard, encode(payload("7", "two"))).result, 409);
  time = 10;
  assert.equal(check(guard, encode(payload("7", "two"))).result, "next");
});
test("payment hooks record settlement and log failures without addresses or signatures", async () => {
  const hooks = {}, logs = [];
  const server = new x402ResourceServer({ getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) });
  for (const name of ["onAfterSettle", "onSettleFailure", "onVerifyFailure"]) {
    server[name] = hook => { hooks[name] = hook; return server; };
  }
  const guard = createPermitGuard();
  const app = express();
  addPaymentRoute(app, { "POST /test": { accepts: [] } }, server,
    { log: line => logs.push(line), permitGuard: guard, discoverable: false });
  // The guard must be mounted ahead of the x402 middleware, so stale payments never reach verification.
  assert.equal(app.router.stack[0].route.stack[0].handle, guard.middleware);
  assert.equal(app.router.stack[1].route, undefined);
  assert.equal(check(guard, encode(payload())).result, "next");
  await hooks.onAfterSettle({ paymentPayload: payload(), requirements: upto(), result: { payer: "0xabc" } });
  assert.equal(check(guard, encode(payload())).result, 409);
  const address = "0x" + "ab".repeat(20), signature = "cd".repeat(65);
  const ctx = { requirements: { network: "eip155:8453", scheme: "upto", amount: "1500" },
    paymentPayload: { payer: address, signature },
    error: { errorReason: `invalid_permit ${address} ${signature}` } };
  await hooks.onSettleFailure(ctx);
  await hooks.onVerifyFailure({ ...ctx, error: new Error(`verification failed ${address}`) });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /POST \/test settle failed network=eip155:8453 scheme=upto amount=1500 reason=invalid_permit/);
  assert.match(logs[1], /verify failed.*verification failed/);
  assert.ok(logs.every(line => !line.includes(address) && !line.includes(signature)));
});
test("overrun error exposes computed total and logs usage", () => {
  assert.throws(() => billUsage({ buyer_cost_micro: 2000 }), error => {
    assert.equal(error.code, "ceiling_exceeded");
    assert.equal(error.totalAtomic, "3600");
    assert.equal(error.message, "Actual cost exceeds the authorized ceiling; payment refused.");
    return true;
  });
  const logs = [];
  assert.throws(() => billWithDiagnostics({ buyer_cost_micro: 2000, prompt_tokens: 12, completion_tokens: 16,
    completion_tokens_details: { reasoning_tokens: 8 } }, TERMS, false, "/test", "model", line => logs.push(line)));
  assert.equal(logs.length, 1);
  for (const value of ['"prompt_tokens":12', '"completion_tokens":16', '"reasoning_tokens":8',
    '"buyer_cost_micro":2000', `"ceiling":"${TERMS.maxChargeAtomic}"`]) assert.ok(logs[0].includes(value));
});

test("only permits an upto settlement consumed are remembered (no poisoning via unused extensions)", () => {
  const guard = createPermitGuard();
  const stale = () => check(guard, encode(payload("9", "0xVictim")));
  // exact (EIP-3009) settles without the permit: an extension naming another wallet must not be trusted.
  guard.record(payload("9", "0xVictim"), { ...upto(), scheme: "exact" }, { payer: "0xvictim" });
  // A settled payer that is not the permit's owner, another asset, another spender, no Permit2 payload, Solana.
  guard.record(payload("9", "0xVictim"), upto(), { payer: "0xattacker" });
  guard.record(payload("9", "0xVictim"), upto("0xother"), { payer: "0xvictim" });
  guard.record(payload("9", "0xVictim", "0xDEF", "0x1234"), upto(), { payer: "0xvictim" });
  guard.record({ ...payload("9", "0xVictim"), payload: {} }, upto(), { payer: "0xvictim" });
  guard.record(payload("9", "0xVictim"), { ...upto(), network: "solana:x" }, { payer: "0xvictim" });
  assert.equal(stale().result, "next");
  guard.record(payload("9", "0xVictim"), upto(), { payer: "0xVICTIM" });
  assert.equal(stale().result, 409);
});
