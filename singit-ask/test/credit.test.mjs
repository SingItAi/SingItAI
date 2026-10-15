// SingIt credit: a top-up is offered at its amount plus one settlement fee, paid exactly, and never listed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { CREDIT_ROUTE, readCredit } from "../src/credit.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", model: "deepseek-v4.1-flash" };

function fakeFacilitator() {
  const calls = { settle: [] };
  return { calls,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE },
        { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88",
          receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: [], signers: {} };
    },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

async function serve(t) {
  const facilitator = fakeFacilitator();
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue: null, log: () => {},
    upstream: async () => { throw new Error("no model is asked for credit"); } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}${CREDIT_ROUTE}`, facilitator };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const decode = header => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const pay = (required, network) => ({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2,
  resource: required.resource, accepted: required.accepts.find(a => a.network === network),
  payload: { signature: "0xsigned" } })).toString("base64") });

test("credit is whole cents from $1 to $50", () => {
  assert.equal(readCredit({ amountAtomic: "5000000" }), "5000000");
  assert.equal(readCredit({ amountAtomic: 1_000_000 }), "1000000");
  for (const amountAtomic of ["999999", "50010000", "5000001", "05000000", "-1", "5e6", 5.5, null, ""]) {
    assert.equal(readCredit({ amountAtomic }), null, String(amountAtomic));
  }
  assert.equal(readCredit(null), null);
});

test("a top-up is offered exactly: the credit plus one settlement fee, to the revenue address", async (t) => {
  const { url, facilitator } = await serve(t);
  const unpaid = await post(url, { amountAtomic: "5000000" });
  assert.equal(unpaid.status, 402);
  const required = decode(unpaid.headers.get("payment-required"));
  assert.deepEqual(required.accepts.map(a => [a.scheme, a.network, a.amount, a.payTo]), [
    ["exact", SOLANA, "5002000", CONFIG.payToSolana], ["exact", BASE, "5001000", CONFIG.payToBase]]);
  assert.ok(required.accepts[0].extra.feePayer, "the facilitator pays the Solana fee");
  assert.equal(required.extensions?.bazaar, undefined, "not listed for discovery");
  assert.deepEqual(facilitator.calls.settle, []);
});

test("a paid top-up settles once and says what was bought", async (t) => {
  const { url, facilitator } = await serve(t);
  const body = { amountAtomic: "5000000" };
  const required = decode((await post(url, body)).headers.get("payment-required"));
  const paid = await post(url, body, pay(required, BASE));
  assert.equal(paid.status, 200);
  assert.deepEqual(await paid.json(), { object: "credit", amountAtomic: "5000000", feeAtomic: "1000",
    totalAtomic: "5001000", network: BASE, currency: "USDC" });
  assert.deepEqual(facilitator.calls.settle, [[BASE, "5001000"]]);
  assert.ok(paid.headers.get("payment-response"));
});

test("a payment for a smaller credit does not buy a larger one", async (t) => {
  const { url, facilitator } = await serve(t);
  const required = decode((await post(url, { amountAtomic: "1000000" })).headers.get("payment-required"));
  const paid = await post(url, { amountAtomic: "50000000" }, pay(required, BASE));
  assert.equal(paid.status, 402);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("an amount out of bounds is refused before any payment is asked", async (t) => {
  const { url, facilitator } = await serve(t);
  for (const body of [{}, { amountAtomic: "100" }, { amountAtomic: "60000000" }]) {
    const response = await post(url, body);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("payment-required"), null);
    assert.match((await response.json()).error.message, /amountAtomic/);
  }
  assert.deepEqual(facilitator.calls.settle, []);
});
