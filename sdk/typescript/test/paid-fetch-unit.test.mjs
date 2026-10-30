import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SingIt } from "../src/index.js";
import { NETWORKS } from "../src/pins.js";
const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64");
function setup(receiptOverrides = {}, { scheme = "exact", billed = "4000" } = {}) {
  const payer = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey());
  const url = "http://localhost/v1/chat/completions";
  let sent = 0;
  const client = new SingIt({
    evmAccount: payer, network: "base-sepolia", baseUrl: "http://localhost",
    payTo: payee.address, maxPerCallUsd: 0.004, maxPerDayUsd: 0.006,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.redirect, "error");
      if (!request.headers.has("payment-signature")) return new Response("{}", {
        status: 402, headers: { "payment-required": encode({
          x402Version: 2, resource: { url }, accepts: [{
            scheme, network: NETWORKS["base-sepolia"].caip,
            asset: NETWORKS["base-sepolia"].asset, payTo: payee.address,
            amount: "4000", maxTimeoutSeconds: 120,
            extra: { facilitatorAddress: payee.address },
          }],
        }) },
      });
      sent++;
      assert.equal((await request.json()).stream, false);
      return new Response(JSON.stringify({ billing: { totalAtomic: billed } }), {
        headers: { "payment-response": encode({ network: NETWORKS["base-sepolia"].caip, payer: payer.address, transaction: "0xreceipt", ...receiptOverrides }) },
      });
    },
  });
  client._sign = async (_scheme, offer) => ({
    accepted: offer, payload: { authorization: { from: payer.address } },
  });
  return { client, url, sent: () => sent };
}
const send = (client, url) => client.paidFetch({ scheme: "exact" })(
  new Request(url, { method: "POST", body: '{"stream":false}' }),
);
test("paidFetch replays a Request body once and settles a valid invoice", async () => {
  const { client, url, sent } = setup();
  assert.equal((await (await send(client, url)).json()).billing.totalAtomic, "4000");
  assert.equal(client.limiter.remainingAtomic(), 2000n);
  assert.equal(sent(), 1);
});
for (const [mismatch, receipt] of [
  ["network", { network: "wrong-network" }],
  ["payer", { payer: "0x000000000000000000000000000000000000dead" }],
]) {
  for (const method of ["paidFetch", "chat"]) {
    test(`${method} rejects a wrong receipt ${mismatch} and keeps the full reservation`, async () => {
      const { client, url, sent } = setup(receipt);
      const invoke = () => method === "paidFetch" ? send(client, url)
        : client.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
      await assert.rejects(invoke(), /settlement receipt/);
      assert.equal(client.limiter.remainingAtomic(), 2000n);
      await assert.rejects(invoke(), /Daily spend cap/);
      assert.equal(sent(), 1);
    });
  }
}
for (const method of ["paidFetch", "chat"]) {
  test(`${method} validates the receipt exactly once`, async () => {
    const { client, url } = setup();
    const check = client._checkReceipt.bind(client);
    let checks = 0;
    client._checkReceipt = (...args) => { checks++; return check(...args); };
    if (method === "paidFetch") await send(client, url);
    else {
      const result = await client.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
      assert.equal(result.payment.txHash, "0xreceipt");
    }
    assert.equal(checks, 1);
    assert.equal(client.limiter.remainingAtomic(), 2000n);
  });
}
test("paidFetch passes a free answer through without signing", async () => {
  const { client, url } = setup();
  client.fetchImpl = async () => new Response("free");
  client._sign = () => assert.fail("unexpected signing");
  assert.equal(await (await send(client, url)).text(), "free");
});

for (const method of ["paidFetch", "chat"]) {
  for (const billed of ["1000", "4001"]) {
    test(`${method} keeps an exact authorization fully counted when billed ${billed}`, async () => {
      const { client, url, sent } = setup({}, { billed });
      const invoke = () => method === "paidFetch" ? send(client, url)
        : client.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
      await assert.rejects(invoke(), /invoice does not match.*unresolved/);
      assert.equal(client.limiter.remainingAtomic(), 2000n);
      await assert.rejects(invoke(), /Daily spend cap/);
      assert.equal(sent(), 1);
    });
  }
  for (const billed of ["1000", "4001"]) {
    test(`${method} preserves upto billing rules for ${billed}`, async () => {
      const { client, url } = setup({}, { scheme: "upto", billed });
      const invoke = () => method === "paidFetch"
        ? client.paidFetch({ scheme: "upto" })(new Request(url, { method: "POST", body: '{"stream":false}' }))
        : client.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "upto" });
      if (billed === "1000") {
        await invoke();
        assert.equal(client.limiter.remainingAtomic(), 5000n);
      } else {
        await assert.rejects(invoke(), /invoice does not match/);
        assert.equal(client.limiter.remainingAtomic(), 2000n);
      }
    });
  }
}
