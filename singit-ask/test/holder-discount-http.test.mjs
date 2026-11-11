// SINGIT-holder discount end to end: 402 quotes, the payer re-check at verify, and billing (fake facilitator, fake chain).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { HolderDiscount, loadHolderConfig } from "../src/holder-discount.mjs";
import { setExaMarkupBps, parseExaMarkupBps } from "../src/search.mjs";
import { MAX_PAYMENT_REQUIRED_HEADER_BYTES } from "../src/payment-required-header.mjs";

const CONFIG = () => ({ payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const MODEL = { id: "deepseek-v4.1-flash", name: "DeepSeek", provider: "deepseek", contextLength: 1e5, promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.3e-6 };
const catalogue = { async resolve(id) { if (id !== MODEL.id) throw new UnknownModel("no"); return MODEL; }, async canAnswer() { return true; }, async list() { return [MODEL]; } };
const WHALE = "0x" + "a1".repeat(20), SMALL = "0x" + "b2".repeat(20), MID = "0x" + "c3".repeat(20);
const WEI = 10n ** 18n, NOW_MS = Date.now(), LATEST = 20_000_000n;

function fakeChain(current, past = current) {
  return {
    async getBlockNumber() { return LATEST; },
    async getBlock({ blockNumber }) { return { timestamp: BigInt(Math.floor(NOW_MS / 1000) - Number(LATEST - blockNumber) * 2) }; },
    async readContract({ args, blockNumber }) { return BigInt((blockNumber === undefined ? current : past)[args[0].toLowerCase()] ?? 0) * WEI; },
  };
}
const holderFor = (client, env = {}) => new HolderDiscount({ publicClient: client, config: loadHolderConfig(env) });

// verify answers like a real facilitator would: the payer is whoever the payload says signed it (or `payerOverride`).
function fakeFacilitator({ payerOverride } = {}) {
  const seen = { verify: [], settle: [] };
  return { seen,
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify(payload, requirements) {
      seen.verify.push(requirements.amount);
      return { isValid: true, payer: payerOverride ?? payload.payload?.permit2Authorization?.from ?? payload.payload?.authorization?.from };
    },
    async settle(payload, requirements) {
      seen.settle.push(requirements.amount);
      return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network, amount: requirements.amount,
        payer: payerOverride ?? payload.payload?.permit2Authorization?.from ?? payload.payload?.authorization?.from };
    },
  };
}

async function serve(t, { holder, facilitator = fakeFacilitator(), costMicro = 1000 } = {}) {
  const upstream = async () => ({ content: "Hello there.", finishReason: "stop", usage: { total_tokens: 12, buyer_cost_micro: costMicro } });
  const app = createApp(CONFIG(), { facilitatorClient: facilitator, upstream, log: () => {}, catalogue, holderDiscount: holder });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return `http://127.0.0.1:${listener.address().port}`;
}
const BODY = { model: MODEL.id, max_tokens: 200, messages: [{ role: "user", content: "Say hello." }] };
const post = (url, headers = {}, path = "/v1/chat/completions") => fetch(`${url}${path}`, { method: "POST",
  headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(BODY) });
const accept = (required, scheme = "upto", network = BASE) => required.accepts.find((a) => a.network === network && a.scheme === scheme);
const signed = (required, from, { scheme = "upto", acceptedFrom = required } = {}) => ({ "PAYMENT-SIGNATURE": encode({
  x402Version: 2, resource: required.resource, accepted: accept(acceptedFrom, scheme),
  payload: scheme === "upto" ? { signature: "0xsigned", permit2Authorization: { from } } : { signature: "0xsigned", authorization: { from } },
  extensions: required.extensions }) });
const quoted = async (url, headers) => decode((await post(url, headers)).headers.get("payment-required"));
const HINT = (address) => ({ "X-SingIt-Payer": address });

test("a Base 402 without a hint is the full price and lists the tiers; Solana is untouched", async (t) => {
  const url = await serve(t, { holder: holderFor(fakeChain({ [WHALE]: 200_000_000 })) });
  const plain = await post(url);
  assert.equal(plain.status, 402);
  const required = decode(plain.headers.get("payment-required"));
  const bodyRequired = await plain.json();
  for (const scheme of ["upto", "exact"]) {
    const base = accept(required, scheme);
    assert.equal(base.extra.holderDiscount.appliedBps, 0);
    assert.deepEqual(base.extra.holderDiscount.tiers.map((x) => [x.minTokens, x.discountBps]),
      [["20000000", 500], ["50000000", 1000], ["150000000", 1500]]);
    assert.equal(accept(required, scheme, SOLANA).extra?.holderDiscount, undefined);
  }
  assert.equal(accept(required).extra.holderDiscount.tiers[2].higherDailyLimit, true);
  assert.deepEqual(bodyRequired.accepts?.[0]?.extra?.holderDiscount ?? required.accepts[0].extra.holderDiscount, required.accepts[0].extra.holderDiscount);
  const text = JSON.stringify(required);
  assert.ok(!/markup/i.test(text) && !/30\s*%|30 percent|thirty percent/i.test(text), "no markup wording");
  assert.ok(!text.includes(WHALE));
});

test("a hinted holder is quoted less on Base; others and Solana pay the same; headers stay small", async (t) => {
  const url = await serve(t, { holder: holderFor(fakeChain({ [WHALE]: 200_000_000, [MID]: 25_000_000, [SMALL]: 5 })) });
  const full = await quoted(url);
  const top = await quoted(url, HINT(WHALE));
  const mid = await quoted(url, HINT(MID));
  const small = await quoted(url, HINT(SMALL));
  const junk = await quoted(url, HINT("not-an-address"));
  const viaQuery = decode((await fetch(`${url}/v1/chat/completions?payer=${WHALE}`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(BODY) })).headers.get("payment-required"));
  for (const scheme of ["upto", "exact"]) {
    const list = BigInt(accept(full, scheme).amount);
    assert.ok(BigInt(accept(top, scheme).amount) < list);
    assert.ok(BigInt(accept(mid, scheme).amount) < list);
    assert.ok(BigInt(accept(top, scheme).amount) < BigInt(accept(mid, scheme).amount));
    assert.equal(accept(top, scheme).extra.holderDiscount.appliedBps, 1500);
    assert.equal(accept(mid, scheme).extra.holderDiscount.appliedBps, 500);
    assert.equal(accept(small, scheme).amount, accept(full, scheme).amount);
    assert.equal(accept(junk, scheme).amount, accept(full, scheme).amount);
    assert.equal(accept(viaQuery, scheme).amount, accept(top, scheme).amount);
    assert.equal(accept(top, scheme, SOLANA).amount, accept(full, scheme, SOLANA).amount);
    // never below cost: the ceiling's provider part plus the 1000 fee is the floor
    assert.ok(BigInt(accept(top, scheme).amount) >= 1000n);
  }
  const res = await post(url, HINT(WHALE));
  assert.ok(res.headers.get("payment-required").length < MAX_PAYMENT_REQUIRED_HEADER_BYTES);
  assert.ok(!JSON.stringify(top).includes(WHALE));
});

test("without a chain client there is no discount and no holder extra", async (t) => {
  const url = await serve(t, { holder: null });
  const required = await quoted(url, HINT(WHALE));
  assert.equal(accept(required).extra.holderDiscount, undefined);
});

test("a lookup failure quotes the full price and is never a 500", async (t) => {
  const broken = { async getBlockNumber() { throw new Error("rpc down"); }, async getBlock() { throw new Error("x"); }, async readContract() { throw new Error("x"); } };
  const url = await serve(t, { holder: holderFor(broken) });
  const res = await post(url, HINT(WHALE));
  assert.equal(res.status, 402);
  const required = decode(res.headers.get("payment-required"));
  assert.equal(accept(required).extra.holderDiscount.appliedBps, 0);
});

test("upto: the holder signs the lower ceiling, is verified, and is billed with the same discount and floor", async (t) => {
  const facilitator = fakeFacilitator();
  const url = await serve(t, { holder: holderFor(fakeChain({ [WHALE]: 200_000_000 })), facilitator, costMicro: 100 });
  const required = await quoted(url, HINT(WHALE));
  const listed = BigInt(accept(await quoted(url)).amount);
  const lowered = BigInt(accept(required).amount);
  assert.ok(lowered < listed);
  const res = await post(url, signed(required, WHALE));
  assert.equal(res.status, 200);
  const answer = await res.json();
  // 100 provider + 30 + 1000 fee = 1130 at list; 15% off is 960, below cost (1100): floored at 1100.
  assert.equal(answer.billing.totalAtomic, "1100");
  assert.equal(answer.billing.holderDiscountBps, 1500);
  assert.ok(!("markupAtomic" in answer.billing) && !("markupBps" in answer.billing));
  assert.equal(facilitator.seen.settle.at(-1), "1100", "settled the discounted bill, within the signed ceiling");
  assert.equal(facilitator.seen.verify.at(-1), lowered.toString());
});

test("upto: a bigger answer is discounted by the tier, fits the lowered ceiling, and never goes below cost", async (t) => {
  const facilitator = fakeFacilitator();
  const url = await serve(t, { holder: holderFor(fakeChain({ [MID]: 25_000_000 })), facilitator, costMicro: 300 });
  const required = await quoted(url, HINT(MID));
  const lowered = BigInt(accept(required).amount);
  const res = await post(url, signed(required, MID));
  const answer = await res.json();
  assert.equal(res.status, 200);
  // 300 + 90 + 1000 = 1390 at list; 5% off is 1320 (above the 1300 cost floor).
  assert.equal(answer.billing.totalAtomic, "1320");
  assert.ok(BigInt(answer.billing.totalAtomic) <= lowered);
});

test("exact: the holder pays the lowered flat amount; paying full price is accepted too", async (t) => {
  const facilitator = fakeFacilitator();
  const url = await serve(t, { holder: holderFor(fakeChain({ [WHALE]: 200_000_000 })), facilitator });
  const hinted = await quoted(url, HINT(WHALE));
  const res = await post(url, signed(hinted, WHALE, { scheme: "exact" }));
  assert.equal(res.status, 200);
  const answer = await res.json();
  assert.equal(answer.billing.totalAtomic, accept(hinted, "exact").amount);
  assert.equal(facilitator.seen.settle.at(-1), accept(hinted, "exact").amount);
  // The same holder signs the list price from a hint-less quote.
  const plain = await quoted(url);
  const over = await post(url, signed(plain, WHALE, { scheme: "exact" }));
  assert.equal(over.status, 200);
  assert.equal(facilitator.seen.settle.at(-1), accept(plain, "exact").amount);
});

test("a payer who does not qualify cannot pay a discounted amount, with the hint on or off", async (t) => {
  const facilitator = fakeFacilitator();
  const url = await serve(t, { holder: holderFor(fakeChain({ [WHALE]: 200_000_000 })), facilitator });
  const discounted = await quoted(url, HINT(WHALE));
  const before = facilitator.seen.verify.length;
  // SMALL copies the whale's discounted quote and signs it, even with the whale's hint attached.
  for (const scheme of ["upto", "exact"]) {
    const res = await post(url, { ...signed(discounted, SMALL, { scheme }), ...HINT(WHALE) });
    assert.equal(res.status, 402, scheme);
    assert.equal(accept(decode(res.headers.get("payment-required")), scheme).extra.holderDiscount.appliedBps, 0,
      "the new quote is the full price");
  }
  assert.equal(facilitator.seen.verify.length, before, "nothing reached the facilitator");
  assert.equal(facilitator.seen.settle.length, 0);
  // They can ask without a hint and pay full price.
  const plain = await quoted(url);
  const ok = await post(url, signed(plain, SMALL, { scheme: "exact" }));
  assert.equal(ok.status, 200);
  assert.equal(facilitator.seen.settle.at(-1), accept(plain, "exact").amount);
});

test("the verified payer must be the signer: a facilitator answering with someone else refuses the discount", async (t) => {
  const facilitator = fakeFacilitator({ payerOverride: SMALL });
  const url = await serve(t, { holder: holderFor(fakeChain({ [WHALE]: 200_000_000 })), facilitator });
  const discounted = await quoted(url, HINT(WHALE));
  const res = await post(url, signed(discounted, WHALE, { scheme: "exact" }));
  assert.equal(res.status, 402);
  assert.equal(facilitator.seen.settle.length, 0, "nothing was charged");
});

test("a holder who sold their tokens (or whose lookup now fails) is refused before the facilitator, not charged", async (t) => {
  const balances = { [WHALE]: 200_000_000 };
  const facilitator = fakeFacilitator();
  const holder = holderFor(fakeChain(balances), { SINGIT_ASK_HOLDER_CACHE_MS: "1000" });
  const url = await serve(t, { holder, facilitator });
  const discounted = await quoted(url, HINT(WHALE));
  holder.cache.clear();
  balances[WHALE] = 0;
  const res = await post(url, signed(discounted, WHALE, { scheme: "exact" }));
  assert.equal(res.status, 402);
  assert.equal(facilitator.seen.settle.length, 0);
});

// Other Base routes go through the same helper (search shown): with no markup the cost floor is the list price.
test("search: a holder gets no cheaper price while Exa has no markup, and a lower one above cost once it has", async (t) => {
  const app = createApp(CONFIG(), { facilitatorClient: fakeFacilitator(), catalogue: null, log: () => {},
    upstream: async () => { throw new Error("no model"); }, exaKey: "exa_test_key", exaFetch: async () => new Response("{}"),
    holderDiscount: holderFor(fakeChain({ [WHALE]: 200_000_000 })) });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => { listener.close(); setExaMarkupBps(0); });
  const ask = async (headers) => decode((await fetch(`http://127.0.0.1:${listener.address().port}/v1/exa/search`, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ query: "x402" }) })).headers.get("payment-required"));
  const plain = await ask({}), hinted = await ask(HINT(WHALE));
  assert.equal(hinted.accepts[0].amount, plain.accepts[0].amount);
  assert.equal(hinted.accepts[0].extra.holderDiscount.appliedBps, 0);
  setExaMarkupBps(parseExaMarkupBps("3000"));
  const list = BigInt((await ask({})).accepts[0].amount), lowered = BigInt((await ask(HINT(WHALE))).accepts[0].amount);
  assert.ok(lowered < list && lowered >= list - (list * 3000n) / 13000n - 1000n, "lower, and not below Exa's cost plus the fee");
});
