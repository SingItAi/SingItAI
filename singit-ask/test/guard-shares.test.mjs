// A restart must not quote at list price until the first order-book pass ends (guard-shares.mjs), and what is read
// back must stay truthful: out of date, it can refuse an answer uncharged, but never charge above list or overrun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, SOLANA, createApp } from "../src/app.mjs";
import { ModelCatalogue, priceGuard } from "../src/catalogue.mjs";
import { GUARD_SHARES_MAX_AGE_MS, readGuardShares } from "../src/guard-shares.mjs";
import { ceilings } from "../src/metered.mjs";
import { minDiscountFor, TERMS } from "../src/pricing.mjs";

const OPUS = "claude-opus-5.5", OTHER = "gpt-5.5", MINUTE = 60_000;
const entry = (id, pricing = { prompt: "0.000004", completion: "0.00002" }) => ({ id, name: id, provider: "x", context_length: 1e6, pricing,
  architecture: { modality: "text->text" }, supported_parameters: ["max_tokens"] });
const book = (id, discount_pct) => ({ model: id, offers: [{ trusted: true, healthy: true, available: true, provider_id: "seller", cap_remaining: null, discount_pct }] });

// A fake Surplus: `market` is what each book says now (a discount, "down" for an unreadable book, "none" for a book
// with no qualifying offer); `answer` is what a paid question gets.
function surplus({ market = { [OPUS]: 69, [OTHER]: 60 }, models = [OPUS, OTHER].map((id) => entry(id)), answer } = {}) {
  const s = { market, reads: 0, asked: [], answer };
  s.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/models") return json({ data: models });
    if (path === "/api/marketplace") return json({ data: [] });
    if (path.startsWith("/api/markets/")) {
      s.reads++;
      const id = decodeURIComponent(path.slice("/api/markets/".length)), now = s.market[id];
      if (now === "down") return json({}, 500);
      if (now === "none") return json({ model: id, offers: [] });
      return json(book(id, now));
    }
    s.asked.push({ path, headers: init.headers });
    const [status, body] = s.answer();
    return json(body, status);
  };
  return s;
}

function fixture(t, surplusOptions) {
  const dir = mkdtempSync(join(tmpdir(), "guard-shares-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, file: join(dir, "private", "guard-shares.json"), clock: 1_800_000_000_000, surplus: surplus(surplusOptions) };
  f.start = (options = {}) => new ModelCatalogue({ url: "https://surplus.test", fetchImpl: f.surplus.fetch, now: () => f.clock, guardSharesFile: f.file, ...options });
  f.pass = async (options) => { const c = f.start(options); await c.loadModels(); await c.loadServed(0); return c; };
  f.write = (text) => { mkdirSync(join(dir, "private"), { recursive: true }); writeFileSync(f.file, text); };
  return f;
}

const INPUT = { chars: 5, maxTokens: 200, messageCount: 1 };
async function quote(catalogue, id = OPUS) {
  const info = await catalogue.resolve(id);
  return ceilings(info, { ...INPUT, info, ...priceGuard(catalogue, id, 1) });
}
const LIST = Object.freeze({ share: 1, minDiscount: null });

test("before and after: without the file a restart quotes list price, with it the prices of the last pass", async (t) => {
  const f = fixture(t);
  const running = await f.pass();
  const before = await quote(running);
  f.clock += MINUTE;

  const without = f.start({ guardSharesFile: null });
  assert.deepEqual(priceGuard(without, OPUS, 1), LIST);
  const list = await quote(without);
  for (const scheme of ["exact", "upto"]) assert.ok(BigInt(list[scheme][BASE]) > BigInt(before[scheme][BASE]), scheme);

  const reads = f.surplus.reads;
  const restarted = f.start();
  assert.deepEqual(await quote(restarted), before);
  assert.deepEqual(priceGuard(restarted, OPUS, 1), priceGuard(running, OPUS, 1));
  assert.equal(f.surplus.reads, reads, "no order book was read: this is the file, before the first pass");
});

test("the first pass after a restart replaces what was restored, and a share moves with its book", async (t) => {
  const f = fixture(t);
  await f.pass();
  f.surplus.market[OPUS] = 80;
  f.clock += MINUTE;
  const restarted = await f.pass();
  assert.equal(priceGuard(restarted, OPUS, 1).minDiscount, 79);
  f.clock += MINUTE;
  assert.equal(priceGuard(f.start(), OPUS, 1).minDiscount, 79);
});

for (const [name, setup] of [
  ["missing", () => {}],
  ["empty", (f) => f.write("")],
  ["not JSON", (f) => f.write("{ not json")],
  ["null", (f) => f.write("null")],
  ["an array", (f) => f.write("[1,2]")],
  ["oversized", (f) => f.write(" ".repeat(2_000_001))],
  ["a directory", (f) => mkdirSync(f.file, { recursive: true })],
]) test(`a guard file that is ${name} means list price, and the first pass recovers`, async (t) => {
  const f = fixture(t);
  setup(f);
  assert.deepEqual(priceGuard(f.start(), OPUS, 1), LIST);
  assert.equal(f.start().guardShares.size, 0);
  assert.notDeepEqual(priceGuard(await f.pass(), OPUS, 1), LIST);
});

test("an entry is believed only with a usable share, a known id and an age within the limit", (t) => {
  const f = fixture(t);
  const now = f.clock, ok = { share: 0.31, readAt: now - MINUTE };
  const bad = { ...Object.fromEntries([{ share: "0.31", readAt: now }, { share: null, readAt: now }, { share: -0.01, readAt: now }, { share: 1.01, readAt: now },
    { readAt: now }, { share: 0.31 }, { share: 0.31, readAt: String(now) }, { share: 0.31, readAt: null }, { share: 0.31, readAt: now + 1 },
    { share: 0.31, readAt: now - GUARD_SHARES_MAX_AGE_MS - 1 }, "x", null, 7].map((value, i) => [`bad-${i}`, value])), "bad id with spaces": ok };
  f.write(JSON.stringify({ ...bad, good: ok, oldest: { share: 0.5, readAt: now - GUARD_SHARES_MAX_AGE_MS } }));
  assert.deepEqual([...readGuardShares(f.file, now).keys()].sort(), ["good", "oldest"]);
  assert.equal(readGuardShares(f.file, now).get("good").share, 0.31);
  assert.deepEqual([...readGuardShares(null, now)], []);
});

test("past the maximum age a restart falls back to list price", async (t) => {
  const f = fixture(t);
  await f.pass();
  f.clock += GUARD_SHARES_MAX_AGE_MS;
  assert.notDeepEqual(priceGuard(f.start(), OPUS, 1), LIST);
  f.clock += 1;
  assert.deepEqual(priceGuard(f.start(), OPUS, 1), LIST);
});

test("an unreadable book keeps its share in use but not its age: it cannot stay young across restarts", async (t) => {
  const f = fixture(t);
  await f.pass();
  const firstRead = f.clock;
  f.surplus.market[OTHER] = "down";
  f.clock += 20 * MINUTE;
  const running = await f.pass();
  assert.notDeepEqual(priceGuard(running, OTHER, 1), LIST, "the running process keeps the last answer, as before");
  const stored = JSON.parse(readFileSync(f.file, "utf8"));
  assert.equal(stored[OTHER].readAt, firstRead);
  assert.equal(stored[OPUS].readAt, f.clock);

  f.clock += 11 * MINUTE;  // 31 minutes after OTHER's book was last read, 11 after OPUS's
  const restarted = f.start();
  assert.deepEqual(priceGuard(restarted, OTHER, 1), LIST);
  assert.notDeepEqual(priceGuard(restarted, OPUS, 1), LIST);
});

test("a readable book with no qualifying offer drops the share from memory and from the file", async (t) => {
  const f = fixture(t);
  await f.pass();
  f.surplus.market[OTHER] = "none";
  const restarted = await f.pass();
  assert.deepEqual(priceGuard(restarted, OTHER, 1), LIST);
  assert.equal(OTHER in JSON.parse(readFileSync(f.file, "utf8")), false);
});

test("a pass that is thrown away changes neither the restored shares nor the file", async (t) => {
  const f = fixture(t);
  const before = priceGuard(await f.pass(), OPUS, 1);
  const stored = readFileSync(f.file, "utf8");
  f.surplus.market = { [OPUS]: "none", [OTHER]: "none" };  // would offer no model at all
  f.clock += MINUTE;
  const restarted = await f.pass();
  assert.equal(restarted.served, null);
  assert.deepEqual(priceGuard(restarted, OPUS, 1), before);
  assert.equal(readFileSync(f.file, "utf8"), stored);
});

test("the file is private, holds only ids, shares and read times, and a failed write does not fail a pass", async (t) => {
  const f = fixture(t);
  await f.pass();
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dir, "private")).mode & 0o777, 0o700);
  for (const value of Object.values(JSON.parse(readFileSync(f.file, "utf8")))) assert.deepEqual(Object.keys(value).sort(), ["readAt", "share"]);

  writeFileSync(join(f.dir, "blocker"), "a file, not a directory");
  const unwritable = await f.pass({ guardSharesFile: join(f.dir, "blocker", "guard-shares.json") });
  assert.notDeepEqual(priceGuard(unwritable, OPUS, 1), LIST);
});

test("a share restored for a reference-priced model is ignored: it is bought at an absolute price", async (t) => {
  const f = fixture(t, { models: [entry(OTHER, { prompt: "0", completion: "0" })] });
  f.write(JSON.stringify({ [OTHER]: { share: 0.3, readAt: f.clock } }));
  const c = f.start();
  await c.loadModels();
  assert.deepEqual(priceGuard(c, OTHER, 1), LIST);
});

// The paid route itself: a real app, a real catalogue restored from the file, a fake Surplus and facilitator.
const CONFIG = { payToSolana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", payToBase: "0x1111111111111111111111111111111111111111",
  surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash" };
const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const FEE_PAYER = "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88";

async function serve(t, f, catalogue) {
  const settled = [];
  const facilitator = {
    async getSupported() { return { kinds: [
      { x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: FEE_PAYER } },
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x" + "3".repeat(40) } },
      { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: FEE_PAYER, receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }],
      extensions: ["bazaar", "eip2612GasSponsoring"], signers: {} }; },
    async verify() { return { isValid: true, payer: "0x2222222222222222222222222222222222222222" }; },
    async settle(_p, r) { settled.push(r.amount); return { success: true, transaction: "0x" + "a".repeat(64), network: r.network }; },
  };
  const app = createApp(CONFIG, { facilitatorClient: facilitator, catalogue, fetchImpl: f.surplus.fetch, log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const post = (headers = {}) => fetch(`http://127.0.0.1:${listener.address().port}/v1/chat/completions`, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ model: OPUS, max_tokens: 200, messages: [{ role: "user", content: "Hi." }] }) });
  const offer = async (scheme) => {
    const required = decode((await post()).headers.get("payment-required"));
    return { required, accepted: required.accepts.find((a) => a.network === BASE && a.scheme === scheme) };
  };
  const pay = async (scheme) => {
    const { required, accepted } = await offer(scheme);
    return post({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource, accepted, payload: { signature: "0xsigned" }, extensions: required.extensions }) });
  };
  return { settled, offer, pay };
}
const ANSWER = (cost) => () => [200, { choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 5, buyer_cost_micro: cost } }];

test("paid after a restart: the quote is the last pass's, the floor goes upstream with it, the price is what was quoted", async (t) => {
  const f = fixture(t, { answer: ANSWER(3) });
  const before = await quote(await f.pass());
  f.clock += MINUTE;
  const restarted = f.start();
  await restarted.loadModels();
  const s = await serve(t, f, restarted);
  const { accepted } = await s.offer("exact");
  const info = await restarted.resolve(OPUS);
  const guarded = { ...INPUT, chars: 3, info, ...priceGuard(restarted, OPUS, 1) };
  assert.equal(accepted.amount, ceilings(info, guarded).exact[BASE]);
  assert.ok(BigInt(accepted.amount) <= BigInt(before.exact[BASE]));

  const paid = await s.pay("exact");
  assert.equal(paid.status, 200);
  assert.equal(f.surplus.asked.at(-1).headers["X-Min-Discount"], String(priceGuard(restarted, OPUS, 1).minDiscount));
  assert.deepEqual(s.settled, [accepted.amount]);
});

for (const scheme of ["exact", "upto"]) test(`${scheme}: a restored share the market has moved above is refused and nothing is settled`, async (t) => {
  const f = fixture(t, { market: { [OPUS]: 95, [OTHER]: 60 }, answer: () => [404, { error: { type: "not_found", code: "minimum_discount_not_met",
    message: "Best otherwise-eligible estimated discount is 50%" } }] });
  await f.pass();
  const restarted = f.start();
  await restarted.loadModels();
  const s = await serve(t, f, restarted);
  const stale = (await s.offer(scheme)).accepted.amount;

  const paid = await s.pay(scheme);
  assert.equal(paid.status, 503);
  assert.match(JSON.stringify(await paid.json()), /not charged/);
  assert.deepEqual(s.settled, []);
  assert.equal(f.surplus.asked.at(-1).headers["X-Min-Discount"], "94");

  // Learned from the refusal: the next quote is truthful, and still not above list.
  const info = await restarted.resolve(OPUS);
  const list = ceilings(info, { ...INPUT, chars: 3, info, share: 1, minDiscount: null })[scheme][BASE];
  const next = (await s.offer(scheme)).accepted.amount;
  assert.ok(BigInt(next) > BigInt(stale));
  assert.ok(BigInt(next) <= BigInt(list));
});

test("upto: an answer dearer than a stale ceiling is refused, never settled above what was signed", async (t) => {
  const f = fixture(t, { market: { [OPUS]: 95, [OTHER]: 60 }, answer: ANSWER(1_000_000) });
  await f.pass();
  const restarted = f.start();
  await restarted.loadModels();
  const s = await serve(t, f, restarted);
  const paid = await s.pay("upto");
  assert.equal(paid.status, 503);
  assert.deepEqual(s.settled, []);
});

test("a restored share the market has moved below costs at most list price, and the first pass corrects it", async (t) => {
  const f = fixture(t, { market: { [OPUS]: 10, [OTHER]: 60 } });
  await f.pass();
  f.surplus.market[OPUS] = 69;
  const restarted = f.start();
  const stale = await quote(restarted);
  const list = await quote(f.start({ guardSharesFile: null }));
  for (const scheme of ["exact", "upto"]) assert.ok(BigInt(stale[scheme][BASE]) <= BigInt(list[scheme][BASE]), scheme);

  await restarted.loadServed(0);
  const fresh = await quote(restarted);
  for (const scheme of ["exact", "upto"]) assert.ok(BigInt(fresh[scheme][BASE]) < BigInt(stale[scheme][BASE]), scheme);
});

test("a restored share below 1 always comes with its floor when the ceiling needs one", async (t) => {
  const f = fixture(t);
  await f.pass();
  const c = f.start();
  const info = await c.resolve(OPUS);
  const input = { ...INPUT, info, ...priceGuard(c, OPUS, 1) };
  assert.ok(input.share < 1);
  assert.equal(input.minDiscount, 100 - Math.round(input.share * 100));
  for (const scheme of ["exact", "upto"]) {
    const terms = { ...TERMS, maxChargeAtomic: ceilings(info, input)[scheme][BASE] };
    assert.equal(minDiscountFor(input, terms), input.minDiscount, scheme);
  }
});
