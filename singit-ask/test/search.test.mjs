// SingIt search: Exa's price + 30% + the fee, Exa paid from the settlement wallet once, nothing charged without an
// answer, nothing sold while the wallet runs low.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { EXA_PAY_TO, SEARCH_TERMS, readSearch, searchPrice } from "../src/search.mjs";
import { ASSET } from "../src/pricing.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", model: "deepseek-v4.1-flash" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

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
      ], extensions: ["bazaar"], signers: {} };
    },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) {
      calls.settle.push([requirements.network, requirements.amount]);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network };
    } };
}

// Exa: an unpaid request gets its 402; a paid one is checked and answered (or not, as the test says).
function fakeExa({ amount = "7000", payTo = EXA_PAY_TO, paidStatus = 200 } = {}) {
  const calls = [];
  const offer = { x402Version: 2, resource: { url: "https://api.exa.ai/search" }, accepts: [
    { scheme: "exact", network: BASE, amount, payTo: "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC", asset: ASSET,
      maxTimeoutSeconds: 3600, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } },
    { scheme: "exact", network: BASE, amount, payTo, asset: ASSET, maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2", acceptId: "legacy" } }] };
  const fetchImpl = async (url, init) => {
    const signature = init.headers["PAYMENT-SIGNATURE"];
    calls.push({ url, body: JSON.parse(init.body), paid: signature ? decode(signature) : null });
    if (!signature) return new Response("{}", { status: 402, headers: { "payment-required": encode(offer) } });
    return new Response(JSON.stringify({ requestId: "r1", results: [{ title: "x402", url: "https://x402.org" }],
      costDollars: { total: 0.007 } }), { status: paidStatus, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

async function serve(t, { exa = fakeExa(), balance = 20_000_000n } = {}) {
  const facilitator = fakeFacilitator();
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = { address: account.address, signer: { address: account.address, signTypedData: (a) => account.signTypedData(a) },
    balance: async () => balance };
  const logs = [];
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue: null, log: (line) => logs.push(line),
    upstream: async () => { throw new Error("no model is asked"); }, settlementWallet: wallet, exaFetch: exa.fetchImpl });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return { url: `http://127.0.0.1:${listener.address().port}`, facilitator, exa, wallet, logs };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const pay = (required, network) => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network), payload: { signature: "0xsigned" },
  extensions: required.extensions }) });
const SEARCH = { query: "x402 facilitators", numResults: 5, contents: { text: { maxCharacters: 500 } } };

test("a search is offered at Exa's price + 30% + the network's fee, and listed for discovery", async (t) => {
  const { url, facilitator, exa } = await serve(t);
  const unpaid = await post(`${url}/v1/exa/search`, SEARCH);
  assert.equal(unpaid.status, 402);
  const required = decode(unpaid.headers.get("payment-required"));
  assert.deepEqual(required.accepts.map((a) => [a.scheme, a.network, a.amount, a.payTo]), [
    ["exact", SOLANA, "11100", CONFIG.payToSolana], ["exact", BASE, "10100", CONFIG.payToBase]]);
  assert.ok(required.extensions?.bazaar, "listed for discovery");
  assert.deepEqual(exa.calls.map((c) => c.paid), [null], "Exa was only asked its price");
  assert.deepEqual(facilitator.calls.settle, []);
  const known = await (await fetch(`${url}/.well-known/x402`)).json();
  assert.ok(known.resources.some((r) => r.endsWith("/v1/exa/search")));
});

test("a paid search pays Exa once from the settlement wallet, at Exa's address, then settles the payer", async (t) => {
  const { url, facilitator, exa, wallet } = await serve(t);
  const required = decode((await post(`${url}/v1/exa/search`, SEARCH)).headers.get("payment-required"));
  const paid = await post(`${url}/v1/exa/search`, SEARCH, pay(required, BASE));
  assert.equal(paid.status, 200);
  const body = await paid.json();
  assert.equal(body.results[0].url, "https://x402.org");
  assert.equal(body.costDollars, undefined, "Exa's own cost stays here");
  assert.deepEqual(body.billing, { exaAtomic: "7000", markupAtomic: "2100", feeAtomic: "1000", totalAtomic: "10100", currency: "USDC" });
  const toExa = exa.calls.filter((c) => c.paid);
  assert.equal(toExa.length, 1);
  assert.equal(toExa[0].paid.accepted.payTo, EXA_PAY_TO);
  assert.equal(toExa[0].paid.accepted.amount, "7000");
  assert.equal(toExa[0].paid.payload.authorization.from.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(toExa[0].paid.payload.authorization.to.toLowerCase(), EXA_PAY_TO.toLowerCase());
  assert.deepEqual(toExa[0].body, SEARCH);
  assert.deepEqual(facilitator.calls.settle, [[BASE, "10100"]]);

  const again = await post(`${url}/v1/exa/search`, SEARCH, pay(required, BASE));
  assert.equal(again.status, 409, "the same payment buys nothing twice");
  assert.equal(exa.calls.filter((c) => c.paid).length, 1);
});

test("no answer from Exa, no charge to the payer", async (t) => {
  const { url, facilitator } = await serve(t, { exa: fakeExa({ paidStatus: 500 }) });
  const required = decode((await post(`${url}/v1/exa/search`, SEARCH)).headers.get("payment-required"));
  const paid = await post(`${url}/v1/exa/search`, SEARCH, pay(required, SOLANA));
  assert.equal(paid.status, 502);
  assert.deepEqual(facilitator.calls.settle, []);
});

test("Exa asking to be paid elsewhere, or too much, sells nothing", async (t) => {
  for (const exa of [fakeExa({ payTo: "0x" + "9".repeat(40) }), fakeExa({ amount: "60000" })]) {
    const { url, facilitator } = await serve(t, { exa });
    const unpaid = await post(`${url}/v1/exa/search`, SEARCH);
    assert.ok([400, 503].includes(unpaid.status));
    assert.equal(unpaid.headers.get("payment-required"), null);
    assert.deepEqual(facilitator.calls.settle, []);
  }
});

test("a settlement wallet under its floor pauses search before anyone pays", async (t) => {
  const { url, exa, logs } = await serve(t, { balance: BigInt(SEARCH_TERMS.pauseBelowAtomic) - 1n });
  const unpaid = await post(`${url}/v1/exa/search`, SEARCH);
  assert.equal(unpaid.status, 503);
  assert.match((await unpaid.json()).error.message, /paused/);
  assert.deepEqual(exa.calls, []);
  assert.ok(logs.some((l) => /paused/.test(l)));
});

test("page contents too, and what is not sold is refused before any price is asked", async (t) => {
  const { url, exa } = await serve(t);
  const contents = await post(`${url}/v1/exa/contents`, { urls: ["https://x402.org"], text: true });
  assert.equal(contents.status, 402);
  for (const [path, body] of [["/v1/exa/search", {}], ["/v1/exa/search", { query: "x", type: "deep" }],
    ["/v1/exa/search", { query: "x", numResults: 100 }], ["/v1/exa/search", { query: "x", research: true }],
    ["/v1/exa/contents", { urls: [] }], ["/v1/exa/contents", { urls: Array(11).fill("https://a.test") }]]) {
    const refused = await post(`${url}${path}`, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(exa.calls.length, 1, "only the valid contents request was priced");
});

test("prices and bounds", () => {
  assert.deepEqual(searchPrice("7000", SOLANA), { exaAtomic: "7000", markupAtomic: "2100", feeAtomic: "2000", totalAtomic: "11100" });
  assert.equal(searchPrice("1", BASE).markupAtomic, "1");
  assert.throws(() => readSearch("/v1/exa/search", null), /JSON/);
});

test("without a settlement wallet there is no search", async (t) => {
  const app = createApp(CONFIG, { facilitatorClient: fakeFacilitator(), catalogue: null, log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const response = await post(`http://127.0.0.1:${listener.address().port}/v1/exa/search`, SEARCH);
  assert.equal(response.status, 404);
});
