// Plan item 3: the caller's spend limit in the 402 (X-SingIt-Limiter) and a receipt on every settled answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { UnknownModel } from "../src/catalogue.mjs";
import { SpendLimitReader, describeLimiter, offersAgainstLimit, receiptFor, BASE_USDC, LIMIT_HEADER, RECEIPT_HEADER } from "../src/spend-limit.mjs";

const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  payToBase: "0x1111111111111111111111111111111111111111", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
  model: "deepseek-v4.1-flash" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const MODEL = { id: "deepseek-v4.1-flash", name: "DeepSeek", provider: "deepseek", contextLength: 1e5, promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.3e-6 };
const catalogue = { async resolve(id) { if (id !== MODEL.id) throw new UnknownModel("no"); return MODEL; }, async canAnswer() { return true; }, async list() { return [MODEL]; } };
const LIMITER = "0x" + "ab".repeat(20);
const NOW = 1_790_000_000;   // seconds

function fakeFacilitator() {
  return {
    async getSupported() {
      return { kinds: [
        { x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } },
        { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
        { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
      ], extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} };
    },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_payload, requirements) { return { success: true, transaction: "0x" + "a".repeat(64), network: requirements.network, payer: "0x2222222222222222222222222222222222222222" }; },
  };
}

// A publicClient whose multicall answers like an AgentAllowance, field by field.
function fakeChain(over = {}) {
  const calls = [];
  const fields = { token: BASE_USDC, paused: false, expiry: BigInt(NOW + 86_400), dailyCap: 5_000_000n, perPurchaseCap: 2_000n,
    remainingToday: 4_000_000n, allowanceLeft: 9_000_000n, ...over };
  return { calls, async multicall({ contracts }) {
    calls.push(contracts[0].address);
    if (over.fail) return contracts.map(() => ({ status: "failure", error: new Error("revert") }));
    if (over.throws) throw new Error("rpc down");
    return contracts.map((c) => ({ status: "success", result: fields[c.functionName] }));
  } };
}
const reader = (publicClient, extra = {}) => new SpendLimitReader({ publicClient, now: () => NOW * 1000, ...extra });

async function serve(t, { spendLimits, upstream } = {}) {
  const answer = upstream ?? (async () => ({ content: "Hello there.", finishReason: "stop", usage: { total_tokens: 12, buyer_cost_micro: 100 } }));
  const app = createApp(CONFIG, { facilitatorClient: fakeFacilitator(), upstream: answer, log: () => {}, catalogue, spendLimits });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  return `http://127.0.0.1:${listener.address().port}`;
}
const BODY = { model: MODEL.id, max_tokens: 200, messages: [{ role: "user", content: "Say hello." }] };
const post = (url, headers = {}) => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(BODY) });
const pay = (required, scheme = "upto", network = BASE) => ({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource,
  accepted: required.accepts.find((a) => a.network === network && a.scheme === scheme), payload: { signature: "0xsigned" }, extensions: required.extensions }) });

test("describeLimiter: the smallest of the per-purchase cap, today's remainder and the allowance", () => {
  const got = { token: BASE_USDC, paused: false, expiry: BigInt(NOW + 10), dailyCap: 5_000_000n, perPurchaseCap: 2_000n, remainingToday: 1_500n, allowanceLeft: 9_000n };
  assert.equal(describeLimiter(LIMITER, got, NOW).spendableNowAtomic, "1500");
  assert.equal(describeLimiter(LIMITER, { ...got, remainingToday: 9_000_000n, allowanceLeft: 800n }, NOW).spendableNowAtomic, "800");
  assert.equal(describeLimiter(LIMITER, { ...got, paused: true }, NOW).spendableNowAtomic, "0");
  const expired = describeLimiter(LIMITER, { ...got, expiry: BigInt(NOW - 1) }, NOW);
  assert.equal(expired.expired, true); assert.equal(expired.spendableNowAtomic, "0");
});

test("offersAgainstLimit marks Base offers fits or not, with a reason; Solana is not checked", () => {
  const info = describeLimiter(LIMITER, { token: BASE_USDC, paused: false, expiry: BigInt(NOW + 10), dailyCap: 5_000_000n,
    perPurchaseCap: 2_000n, remainingToday: 1_800n, allowanceLeft: 9_000n }, NOW);
  const accepts = [{ scheme: "upto", network: BASE, amount: "1500" }, { scheme: "exact", network: BASE, amount: "1900" },
    { scheme: "exact", network: BASE, amount: "2500" }, { scheme: "upto", network: SOLANA, amount: "1500" }];
  const out = offersAgainstLimit(info, accepts).offers;
  assert.deepEqual(out.map((o) => [o.fits, o.reason]), [[true, undefined], [false, "over_remaining_today"], [false, "over_per_purchase_cap"], [null, "not_checked"]]);
  assert.equal(offersAgainstLimit({ v: 1, error: "unreadable" }, accepts).error, "unreadable");
});

test("reader: reads once per ttl, shares an in-flight read, and refuses malformed addresses without an RPC call", async () => {
  const chain = fakeChain(); const r = reader(chain);
  assert.deepEqual(await r.read("0x12"), { v: 1, error: "invalid_address" });
  const [a, b] = await Promise.all([r.read(LIMITER), r.read(LIMITER.toUpperCase().replace("0X", "0x"))]);
  assert.equal(a.remainingTodayAtomic, "4000000"); assert.equal(b.remainingTodayAtomic, "4000000");
  await r.read(LIMITER);
  assert.equal(chain.calls.length, 1);
  assert.equal(r.peek(LIMITER).limiter, LIMITER);
});

test("reader: a contract that is not a limiter, another token, or a dead RPC give an error, not a throw", async () => {
  assert.equal((await reader(fakeChain({ fail: true })).read(LIMITER)).error, "not_an_allowance_limiter");
  assert.equal((await reader(fakeChain({ token: "0x" + "9".repeat(40) })).read(LIMITER)).error, "unsupported_token");
  const down = reader(fakeChain({ throws: true }));
  assert.equal((await down.read(LIMITER)).error, "unreadable");
  assert.equal(down.peek(LIMITER), null, "an error is never shown as a receipt's limit");
});

test("reader: fresh reads per minute are capped, so the header cannot spend the RPC budget", async () => {
  const chain = fakeChain(); const r = reader(chain, { perMinute: 2 });
  await r.read("0x" + "01".repeat(20)); await r.read("0x" + "02".repeat(20));
  assert.equal((await r.read("0x" + "03".repeat(20))).error, "busy");
  assert.equal(chain.calls.length, 2);
});

test("reader: a hanging RPC times out", async () => {
  const slow = { async multicall() { return new Promise(() => {}); } };
  assert.equal((await reader(slow, { timeoutMs: 20 }).read(LIMITER)).error, "unreadable");
});

test("a 402 without the header is byte-for-byte what it was: no new header, body {}", async (t) => {
  const chain = fakeChain();
  const url = await serve(t, { spendLimits: reader(chain) });
  const response = await post(url);
  assert.equal(response.status, 402);
  assert.equal(response.headers.get(LIMIT_HEADER), null);
  assert.deepEqual(await response.json(), {});
  assert.equal(chain.calls.length, 0);
});

test("a 402 with X-SingIt-Limiter carries the limit in a header and the body, and leaves the offers untouched", async (t) => {
  const url = await serve(t, { spendLimits: reader(fakeChain({ remainingToday: 1_200n })) });
  const plain = await post(url);
  const response = await post(url, { "X-SingIt-Limiter": LIMITER });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), plain.headers.get("payment-required"), "offers and extensions are unchanged");
  const header = JSON.parse(response.headers.get(LIMIT_HEADER));
  const body = await response.json();
  assert.deepEqual(body.singitSpendLimit, header);
  assert.equal(header.limiter, LIMITER); assert.equal(header.remainingTodayAtomic, "1200"); assert.equal(header.spendableNowAtomic, "1200");
  const accepts = decode(response.headers.get("payment-required")).accepts;
  assert.equal(header.offers.length, accepts.length);
  const uptoBase = header.offers.find((o) => o.scheme === "upto" && o.network === BASE);
  assert.equal(uptoBase.amountAtomic, "1500"); assert.equal(uptoBase.fits, false); assert.equal(uptoBase.reason, "over_remaining_today");
  assert.ok(header.offers.filter((o) => o.network === SOLANA).every((o) => o.fits === null));
});

test("a 402 with a limiter that fits says fits: true; a bad address or non-limiter says why, still 402", async (t) => {
  const url = await serve(t, { spendLimits: reader(fakeChain()) });
  const fits = JSON.parse((await post(url, { "X-SingIt-Limiter": LIMITER })).headers.get(LIMIT_HEADER));
  assert.equal(fits.offers.find((o) => o.scheme === "upto" && o.network === BASE).fits, true);
  const bad = await post(url, { "X-SingIt-Limiter": "not-an-address" });
  assert.equal(bad.status, 402);
  assert.equal(JSON.parse(bad.headers.get(LIMIT_HEADER)).error, "invalid_address");
  const other = await serve(t, { spendLimits: reader(fakeChain({ fail: true })) });
  const notLimiter = await post(other, { "X-SingIt-Limiter": LIMITER });
  assert.equal(notLimiter.status, 402);
  assert.equal(JSON.parse(notLimiter.headers.get(LIMIT_HEADER)).error, "not_an_allowance_limiter");
});

test("without a reader the header is ignored", async (t) => {
  const url = await serve(t, { spendLimits: null });
  const response = await post(url, { "X-SingIt-Limiter": LIMITER });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get(LIMIT_HEADER), null);
});

test("a settled upto answer carries X-SingIt-Receipt with what was billed, next to PAYMENT-RESPONSE", async (t) => {
  const url = await serve(t, { spendLimits: reader(fakeChain()) });
  const required = decode((await post(url)).headers.get("payment-required"));
  const response = await post(url, pay(required));
  assert.equal(response.status, 200);
  const answer = await response.json();
  const receipt = JSON.parse(response.headers.get(RECEIPT_HEADER));
  const settled = decode(response.headers.get("payment-response"));
  assert.equal(receipt.v, 1);
  assert.equal(receipt.tx, settled.transaction); assert.equal(receipt.ref, answer.id);
  assert.equal(receipt.network, BASE); assert.equal(receipt.scheme, "upto");
  assert.equal(receipt.payer, "0x2222222222222222222222222222222222222222");
  assert.equal(receipt.chargedAtomic, answer.billing.totalAtomic);
  assert.equal(receipt.ceilingAtomic, required.accepts.find((a) => a.scheme === "upto" && a.network === BASE).amount);
  assert.equal(receipt.limit, undefined, "no limit block without the header");
});

test("exact: the receipt's charge is the flat ceiling; with the limiter header the cached limit is included", async (t) => {
  const url = await serve(t, { spendLimits: reader(fakeChain()) });
  const first = await post(url, { "X-SingIt-Limiter": LIMITER });
  const required = decode(first.headers.get("payment-required"));
  const response = await post(url, { ...pay(required, "exact"), "X-SingIt-Limiter": LIMITER });
  assert.equal(response.status, 200);
  const receipt = JSON.parse(response.headers.get(RECEIPT_HEADER));
  const flat = required.accepts.find((a) => a.scheme === "exact" && a.network === BASE).amount;
  assert.equal(receipt.chargedAtomic, flat);
  assert.equal(receipt.limit.limiter, LIMITER);
  assert.equal(receipt.limit.remainingTodayBeforeAtomic, "4000000");
});

test("an answer that is not settled (>= 400) has no receipt", async (t) => {
  const url = await serve(t, { spendLimits: reader(fakeChain()), upstream: async () => { throw new Error("upstream down"); } });
  const required = decode((await post(url)).headers.get("payment-required"));
  const response = await post(url, pay(required));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get(RECEIPT_HEADER), null);
  assert.equal(response.headers.get("payment-response"), null);
});

test("receiptFor ignores a failed settlement", () => {
  assert.equal(receiptFor({ get: () => undefined }, { locals: {} }, { success: false }), null);
});
