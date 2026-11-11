// SINGIT-holder discount: tiers, the 24 h lookback, fail-closed lookups and the cost floor (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HolderDiscount, parseTiers, loadHolderConfig, applyDiscount, costFloorFromTotal, signedPayer, floorOf, holderBilling,
  DEFAULT_TIERS, DEFAULT_SINGIT_TOKEN_ADDRESS, BASE_NETWORK } from "../src/holder-discount.mjs";
import { TERMS, billUsage } from "../src/pricing.mjs";
import { checkedDescription, payTail } from "../src/listing-copy.mjs";

const ALICE = "0x" + "a1".repeat(20), BOB = "0x" + "b2".repeat(20);
const WEI = 10n ** 18n;
const NOW_MS = 1_790_000_000_000, LATEST = 20_000_000n;

// current/past: lowercase address -> whole tokens. `fail`: every read throws; `noHistory`: only "latest" reads work.
function fakeClient({ current = {}, past = {}, fail = false, noHistory = false, chain } = {}) {
  const calls = { read: 0, block: 0 };
  return { calls, ...(chain ? { chain } : {}),
    async getBlockNumber() { calls.block++; if (fail) throw new Error("rpc down"); return LATEST; },
    async getBlock({ blockNumber }) { return { timestamp: BigInt(NOW_MS / 1000 - Number(LATEST - blockNumber) * 2) }; },
    async readContract({ args, blockNumber }) {
      calls.read++;
      if (fail) throw new Error("rpc down");
      if (blockNumber !== undefined && noHistory) throw new Error("missing trie node");
      const table = blockNumber === undefined ? current : past;
      return BigInt(table[args[0].toLowerCase()] ?? 0) * WEI;
    } };
}
const holder = (client, extra = {}) => new HolderDiscount({ publicClient: client, config: loadHolderConfig({}), now: () => NOW_MS, ...extra });
const both = (tokens) => ({ current: { [ALICE]: tokens }, past: { [ALICE]: tokens } });
const ctxOf = (headers = {}, query = {}) => ({ adapter: {
  getHeader: (name) => headers[name.toLowerCase()], getQueryParam: (name) => query[name] } });
const pay = (from, amount, network = BASE_NETWORK, kind = "permit2Authorization") =>
  Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network, amount }, payload: { [kind]: { from } } })).toString("base64");

test("defaults: 20M / 50M / 150M tokens are 500 / 1000 / 1500 bps, and only the top tier raises the daily limit", () => {
  const tiers = parseTiers(DEFAULT_TIERS);
  assert.deepEqual(tiers.map((t) => [t.minTokens, t.discountBps, t.higherDailyLimit]),
    [[20_000_000n, 500, false], [50_000_000n, 1000, false], [150_000_000n, 1500, true]]);
  const h = holder(fakeClient());
  for (const [tokens, bps] of [[19_999_999, null], [20_000_000, 500], [49_999_999, 500], [50_000_000, 1000], [149_999_999, 1000], [150_000_000, 1500], [10 ** 12, 1500]])
    assert.equal(h.tierFor(BigInt(tokens))?.discountBps ?? null, bps, String(tokens));
});

test("tiers come from env, and a bad value falls back to the defaults with one log line", () => {
  const custom = loadHolderConfig({ SINGIT_ASK_HOLDER_TIERS: "1000:250,5000:700+daily" });
  assert.deepEqual(custom.tiers.map((t) => [t.minTokens, t.discountBps, t.higherDailyLimit]), [[1000n, 250, false], [5000n, 700, true]]);
  const logs = [];
  for (const bad of ["", "abc", "100:0", "100:10000", "100:500,100:600", "100:900,200:500", "0:500", "1.5:500", "100:500+weekly"]) {
    const config = loadHolderConfig({ SINGIT_ASK_HOLDER_TIERS: bad }, (line) => logs.push(line));
    assert.deepEqual(config.tiers, parseTiers(DEFAULT_TIERS), JSON.stringify(bad));
  }
  // An empty value is unset, not an error.
  assert.equal(logs.length, 8);
  assert.ok(logs.every((line) => !/0x/.test(line)));
  assert.equal(loadHolderConfig({ SINGIT_ASK_HOLDER_TIERS: "20000000:500" }).tiers.length, 1);
});

test("the token address: SINGIT_ASK_ over SIGN402_ over the shared default; lookback and cache are bounded env ints", () => {
  const other = "0x" + "c3".repeat(20), third = "0x" + "d4".repeat(20);
  assert.equal(loadHolderConfig({}).token, DEFAULT_SINGIT_TOKEN_ADDRESS);
  assert.equal(loadHolderConfig({ SIGN402_SINGIT_TOKEN_ADDRESS: other }).token, other);
  assert.equal(loadHolderConfig({ SINGIT_ASK_SINGIT_TOKEN_ADDRESS: third, SIGN402_SINGIT_TOKEN_ADDRESS: other }).token, third);
  assert.equal(loadHolderConfig({ SINGIT_ASK_SINGIT_TOKEN_ADDRESS: "nope" }).token, DEFAULT_SINGIT_TOKEN_ADDRESS);
  assert.equal(loadHolderConfig({}).lookbackSeconds, 86_400);
  assert.equal(loadHolderConfig({}).cacheMs, 60_000);
  assert.equal(loadHolderConfig({ SINGIT_ASK_HOLDER_LOOKBACK_SECONDS: "7200", SINGIT_ASK_HOLDER_CACHE_MS: "5000" }).lookbackSeconds, 7200);
  assert.equal(loadHolderConfig({ SINGIT_ASK_HOLDER_LOOKBACK_SECONDS: "5" }).lookbackSeconds, 86_400);
});

test("tier by balance: 20M, 50M and 150M tokens held now and a day ago", async () => {
  for (const [tokens, bps] of [[19_000_000, 0], [20_000_000, 500], [50_000_000, 1000], [150_000_000, 1500]]) {
    const h = holder(fakeClient(both(tokens)));
    assert.equal(await h.bpsFor(ALICE), bps, String(tokens));
  }
});

test("flash-loan guard: the smaller of the balance now and a day ago decides", async () => {
  const highNowLowThen = holder(fakeClient({ current: { [ALICE]: 200_000_000 }, past: { [ALICE]: 1_000 } }));
  assert.equal(await highNowLowThen.bpsFor(ALICE), 0);
  const lowNowHighThen = holder(fakeClient({ current: { [ALICE]: 1_000 }, past: { [ALICE]: 200_000_000 } }));
  assert.equal(await lowNowHighThen.bpsFor(ALICE), 0);
  const mixed = holder(fakeClient({ current: { [ALICE]: 200_000_000 }, past: { [ALICE]: 60_000_000 } }));
  assert.equal(await mixed.bpsFor(ALICE), 1000, "the lower of the two sets the tier");
});

test("the old block is about a day back and never younger than that", async () => {
  const seen = [];
  const client = fakeClient(both(30_000_000));
  const read = client.readContract.bind(client);
  client.readContract = async (args) => { if (args.blockNumber !== undefined) seen.push(args.blockNumber); return read(args); };
  await holder(client).bpsFor(ALICE);
  assert.equal(seen.length, 1);
  const ageSeconds = Number(LATEST - seen[0]) * 2;
  assert.ok(ageSeconds >= 86_400 && ageSeconds < 86_400 + 600, `age ${ageSeconds}`);
});

test("fail closed: RPC errors, no historical state, wrong chain, bad addresses and no client mean no discount", async () => {
  assert.equal(await holder(fakeClient({ ...both(200_000_000), fail: true })).bpsFor(ALICE), 0);
  assert.equal(await holder(fakeClient({ ...both(200_000_000), noHistory: true })).bpsFor(ALICE), 0);
  assert.equal(await holder(fakeClient({ ...both(200_000_000), chain: { id: 1 } })).bpsFor(ALICE), 0);
  assert.equal(await holder(fakeClient({ ...both(200_000_000), chain: { id: 8453 } })).bpsFor(ALICE), 1500);
  assert.equal(await holder(null).bpsFor(ALICE), 0);
  const h = holder(fakeClient(both(200_000_000)));
  for (const bad of ["", "0x123", "not an address", undefined, null, ALICE.replace("0x", "0X") + "00", "0x" + "ab".repeat(19) + "zz"])
    assert.equal(await h.bpsFor(bad), 0, String(bad));
  // A wrong EIP-55 mixed-case checksum is not an address.
  assert.equal(await h.bpsFor("0xAb" + "a1".repeat(19)), 0);
});

test("a failed lookup is cached briefly, so a dying RPC is not hammered, and still quotes full price", async () => {
  let t = NOW_MS;
  const client = fakeClient({ ...both(200_000_000), fail: true });
  const h = holder(client, { now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(await h.bpsFor(ALICE), 0);
  assert.equal(client.calls.block, 1);
  t += 31_000;
  await h.bpsFor(ALICE);
  assert.equal(client.calls.block, 2, "retried after the short failure TTL");
});

test("lookups are cached per address for the cache TTL, the old block longer, and the cache is bounded", async () => {
  let t = NOW_MS;
  const client = fakeClient(both(200_000_000));
  const h = holder(client, { now: () => t, maxEntries: 3 });
  await Promise.all([h.bpsFor(ALICE), h.bpsFor(ALICE), h.bpsFor(ALICE)]);
  assert.equal(client.calls.read, 2, "one pair of reads, shared by the concurrent callers");
  t += 30_000;
  await h.bpsFor(ALICE);
  assert.equal(client.calls.read, 2);
  t += 31_000;
  await h.bpsFor(ALICE);
  assert.equal(client.calls.read, 4);
  assert.equal(client.calls.block, 1, "the old block number is kept for minutes");
  for (let i = 0; i < 6; i++) await h.bpsFor("0x" + String(i).repeat(40));
  assert.ok(h.cache.size <= 3);
});

test("a flood of hints cannot spend unlimited RPC: past the per-minute budget it is full price", async () => {
  const client = fakeClient(both(200_000_000));
  const h = holder(client, { perMinute: 2 });
  assert.equal(await h.bpsFor(ALICE), 1500);
  await h.bpsFor(BOB);
  assert.equal(await h.bpsFor("0x" + "c3".repeat(20)), 0);
  assert.equal(await h.bpsFor(ALICE), 1500, "an address already cached is still served");
});

test("applyDiscount rounds down and never goes below the cost floor or above list", () => {
  assert.equal(applyDiscount(14_000n, 11_000n, 500), 13_300n);
  assert.equal(applyDiscount("14000", "11000", 1500), 11_900n);
  assert.equal(applyDiscount(14_000n, 13_000n, 1500), 13_000n, "15% would be 11900: floored at cost");
  assert.equal(applyDiscount(14_000n, 14_000n, 1500), 14_000n, "zero margin: list is the floor");
  assert.equal(applyDiscount(14_000n, 20_000n, 1500), 14_000n, "a floor above list never raises the price");
  assert.equal(applyDiscount(14_000n, 0n, 0), 14_000n);
  assert.equal(applyDiscount(1_001n, 0n, 500), 950n);
});

test("the cost floor derived from a quoted chat ceiling is the provider cost plus the fee, or a hair above", () => {
  for (const provider of [1n, 2n, 7n, 999n, 1_000n, 123_457n, 5_000_000n]) {
    const markup = (provider * BigInt(TERMS.markupBps) + 9999n) / 10000n;
    const total = provider + markup + BigInt(TERMS.settlementFeeAtomic);
    const floor = costFloorFromTotal(total, TERMS.markupBps, TERMS.settlementFeeAtomic);
    const cost = provider + BigInt(TERMS.settlementFeeAtomic);
    assert.ok(floor >= cost && floor <= cost + 1n, `${provider}: ${floor} vs ${cost}`);
    assert.ok(applyDiscount(total, floor, 1500) >= cost, "never below cost");
  }
  assert.equal(costFloorFromTotal(900n, 3000, "1000"), 900n);
});

test("billing a holder: the same answer costs less, never below cost, and a discounted ceiling still fits", () => {
  const usage = { buyer_cost_micro: 1000 };
  const full = billUsage(usage, { ...TERMS, maxChargeAtomic: "3000" });
  assert.equal(full.totalAtomic, "2300");
  const held = billUsage(usage, { ...TERMS, maxChargeAtomic: "2185" }, { holderBps: 500 });
  assert.equal(held.totalAtomic, "2185");
  assert.equal(held.holderDiscountBps, 500);
  // 15% off 2300 would be 1955, below the provider's 1000 plus the 1000 fee: the bill stops at cost.
  assert.equal(billUsage(usage, { ...TERMS, maxChargeAtomic: "2000" }, { holderBps: 1500 }).totalAtomic, "2000");
  const cheap = billUsage({ buyer_cost_micro: 100 }, { ...TERMS, maxChargeAtomic: "1500" }, { holderBps: 1500 });
  assert.ok(BigInt(cheap.totalAtomic) >= 1100n);
  assert.throws(() => billUsage(usage, { ...TERMS, maxChargeAtomic: "1900" }, { holderBps: 1500 }), { code: "ceiling_exceeded" });
  assert.equal(billUsage(usage, { ...TERMS, maxChargeAtomic: "2300" }, { holderBps: 0 }).holderDiscountBps, undefined);
});

test("quote: no hint is full price with the tiers listed; a qualifying hint is discounted; applied bps is reported", async () => {
  const h = holder(fakeClient(both(60_000_000)));
  const none = await h.quote(ctxOf(), "14000", 11_000n);
  assert.equal(none.amount, "14000");
  assert.equal(none.extra.holderDiscount.appliedBps, 0);
  assert.deepEqual(none.extra.holderDiscount.tiers, [
    { minTokens: "20000000", discountBps: 500 }, { minTokens: "50000000", discountBps: 1000 },
    { minTokens: "150000000", discountBps: 1500, higherDailyLimit: true }]);
  assert.equal(none.extra.holderDiscount.network, BASE_NETWORK);
  assert.equal(none.extra.holderDiscount.header, "X-SingIt-Payer");
  assert.equal(none.extra.holderDiscount.query, "payer");
  assert.equal(none.extra.holderDiscount.lookbackSeconds, 86_400);

  const hinted = await h.quote(ctxOf({ "x-singit-payer": ALICE }), "14000", 11_000n);
  assert.equal(hinted.amount, "12600");
  assert.equal(hinted.extra.holderDiscount.appliedBps, 1000);
  const queried = await h.quote(ctxOf({}, { payer: ALICE }), "14000", 11_000n);
  assert.equal(queried.amount, "12600");
  const bad = await h.quote(ctxOf({ "x-singit-payer": "0xnope" }), "14000", 11_000n);
  assert.equal(bad.amount, "14000");
  const below = await h.quote(ctxOf({ "x-singit-payer": BOB }), "14000", 11_000n);
  assert.equal(below.amount, "14000");
  assert.equal(below.extra.holderDiscount.appliedBps, 0);
});

test("quote with no markup (floor equals list) gives a holder no cheaper price", async () => {
  const h = holder(fakeClient(both(200_000_000)));
  const exa = await h.quote(ctxOf({ "x-singit-payer": ALICE }), "8000", floorOf({ exaAtomic: "7000", feeAtomic: "1000" }));
  assert.equal(exa.amount, "8000");
  assert.equal(exa.extra.holderDiscount.appliedBps, 0);
});

test("once a payment is attached the price follows the signer, not the hint", async () => {
  const h = holder(fakeClient({ current: { [ALICE]: 200_000_000 }, past: { [ALICE]: 200_000_000 } }));
  // BOB signs but hints ALICE's address: no discount for BOB.
  const spoof = await h.quote(ctxOf({ "x-singit-payer": ALICE, "payment-signature": pay(BOB, "14000") }), "14000", 11_000n);
  assert.equal(spoof.amount, "14000");
  // ALICE signs the discounted amount: it is quoted back.
  const signed = await h.quote(ctxOf({ "payment-signature": pay(ALICE, "11900") }), "14000", 11_000n);
  assert.equal(signed.amount, "11900");
  // ALICE signs list: still accepted at list (overpaying is fine), shown as full price.
  const over = await h.quote(ctxOf({ "payment-signature": pay(ALICE, "14000") }), "14000", 11_000n);
  assert.equal(over.amount, "14000");
  assert.equal(over.extra.holderDiscount.appliedBps, 0);
  // Above list is never echoed; a Solana payment or a garbled one gets the full Base price.
  assert.equal((await h.quote(ctxOf({ "payment-signature": pay(ALICE, "99999") }), "14000", 11_000n)).amount, "11900");
  assert.equal((await h.quote(ctxOf({ "payment-signature": pay(ALICE, "11900", "solana:x") }), "14000", 11_000n)).amount, "14000");
  assert.equal((await h.quote(ctxOf({ "payment-signature": "%%%", "x-singit-payer": ALICE }), "14000", 11_000n)).amount, "14000");
});

test("quote never throws: a broken adapter or client is full price", async () => {
  const h = holder(fakeClient(both(200_000_000)));
  assert.equal((await h.quote({}, "14000", 11_000n)).amount, "14000");
  assert.equal((await h.quote(undefined, "14000", 11_000n)).amount, "14000");
  assert.equal((await holder(fakeClient({ fail: true })).quote(ctxOf({ "x-singit-payer": ALICE }), "14000", 11_000n)).amount, "14000");
});

test("signedPayer reads the signer from a permit2 or EIP-3009 payload on Base only", () => {
  assert.equal(signedPayer(JSON.parse(Buffer.from(pay(ALICE, "5"), "base64"))).from, ALICE);
  assert.equal(signedPayer(JSON.parse(Buffer.from(pay(ALICE, "5", BASE_NETWORK, "authorization"), "base64"))).from, ALICE);
  assert.equal(signedPayer(JSON.parse(Buffer.from(pay(ALICE, "5", "solana:x"), "base64"))).from, null);
  assert.equal(signedPayer(null).from, null);
  assert.equal(signedPayer({ accepted: { network: BASE_NETWORK }, payload: {} }).from, null);
});

test("holderBilling shows what was signed and the tier, only for a discounted Base payment", () => {
  const priced = { listAtomic: "10000", feeAtomic: "1000", totalAtomic: "14000" };
  assert.deepEqual(holderBilling(priced, {}), priced);
  assert.deepEqual(holderBilling(priced, { singitHolderBps: 1000, singitSignedAtomic: "12600" }),
    { ...priced, totalAtomic: "12600", holderDiscountBps: 1000 });
});

test("public copy: the extra and the description carry no markup field, no 30 percent text and no address", async () => {
  const h = holder(fakeClient(both(200_000_000)));
  const { extra } = await h.quote(ctxOf({ "x-singit-payer": ALICE }), "14000", 11_000n);
  const text = JSON.stringify(extra);
  assert.ok(!/markup/i.test(text), text);
  assert.ok(!/30\s*%|30 percent|thirty percent/i.test(text));
  assert.ok(!/0x[0-9a-fA-F]{8,}/.test(text));
  assert.ok(!text.includes(ALICE));
  const description = `Chat API. ${payTail("answer")}`;
  assert.ok(description.length >= 1 && description.length <= 500);
  assert.equal(checkedDescription(description), description);
  assert.ok(!/0x[0-9a-fA-F]{8,}|markup|%/i.test(payTail("call", "Base")));
  assert.ok(!/\b(you (should|must)|call it when)\b/i.test(payTail("call")));
});
