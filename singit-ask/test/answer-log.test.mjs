import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.mjs";
import { AnswerLog, acceptedOf, recordWhenSettled, tokensOf, answerLogFor } from "../src/answer-log.mjs";
import { BASE, PAY_TO, METERED_ROUTE } from "../src/pricing.mjs";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = (v) => JSON.parse(Buffer.from(v, "base64").toString());
const account = privateKeyToAccount("0x" + "11".repeat(32));  // public unfunded fixture
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "answer-log-")), "answers.jsonl");
const read = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
// The log is written after the response and off the answer path: wait for it (up to 2 s) instead of racing it.
async function lines(file, count = 1) {
  for (let i = 0; i < 100 && !(fs.existsSync(file) && fs.readFileSync(file, "utf8").trim().split("\n").length >= count); i++) await new Promise((r) => setTimeout(r, 20));
  await answerLogFor({ answerLogFile: file })?.flush();
  return fs.existsSync(file) ? read(file) : [];
}

test("a line keeps tokens, money and an hour; nothing else", async () => {
  const file = tmp();
  const log = new AnswerLog({ file, now: () => Date.parse("2026-10-28T15:47:31Z") });
  const usage = { prompt_tokens: 40, completion_tokens: 210, buyer_cost_micro: 1700, completion_tokens_details: { reasoning_tokens: 12 },
    content: "SECRET ANSWER", payer: "0xPAYER" };
  assert.equal(log.record({ route: "/v1/chat/claude-opus-5.5", model: "claude-opus-5.5", scheme: "upto", network: BASE, maxTokens: 500, usage,
    billing: { totalAtomic: "3350", maxChargeAtomic: "3767", providerCostAtomic: "1700", payTo: "0xDEST" } }), true);
  await log.flush();
  const [line] = read(file);
  assert.deepEqual(line, { hour: "2026-10-28T15:00Z", route: "/v1/chat/claude-opus-5.5", model: "claude-opus-5.5", scheme: "upto", network: BASE,
    maxTokens: 500, promptTokens: 40, completionTokens: 210, reasoningTokens: 12, upstreamMicro: 1700, billedAtomic: 3350, ceilingAtomic: 3767, overrunAtomic: 0 });
  const raw = fs.readFileSync(file, "utf8");
  for (const leak of ["SECRET", "0xPAYER", "0xDEST", "15:47"]) assert.ok(!raw.includes(leak), leak);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("free-form or hostile values are dropped to null, never written", async () => {
  const file = tmp();
  const log = new AnswerLog({ file });
  log.record({ route: "/v1/chat/x\nINJECT", model: "a b <script>", scheme: { x: 1 }, network: "e".repeat(200), maxTokens: -5,
    usage: { prompt_tokens: "12abc", completion_tokens: 1.5 }, billing: { totalAtomic: "NaN" } });
  await log.flush();
  const [line] = read(file);
  for (const key of ["route", "model", "scheme", "network", "maxTokens", "promptTokens", "completionTokens", "billedAtomic"]) assert.equal(line[key], null, key);
});

test("both usage shapes give the token counts", () => {
  assert.deepEqual(tokensOf({ input_tokens: 9, output_tokens: 8, output_tokens_details: { reasoning_tokens: 7 } }), { promptTokens: 9, completionTokens: 8, reasoningTokens: 7 });
  assert.deepEqual(tokensOf(undefined), { promptTokens: null, completionTokens: null, reasoningTokens: null });
});

test("off without a file; never throws; stops at the size cap instead of filling a disk", async () => {
  assert.equal(new AnswerLog({}).record({ model: "m" }), false);
  assert.equal(answerLogFor({}), null);
  const messages = [];
  const bad = new AnswerLog({ file: "/etc/hostname/nope/answers.jsonl", log: (m) => messages.push(m) });
  assert.doesNotThrow(() => bad.record({ model: "m" }));
  await bad.flush();
  assert.match(messages.join(), /write failed/);
  const capMessages = [];
  const small = new AnswerLog({ file: tmp(), maxBytes: 300, log: (m) => capMessages.push(m) });
  let written = 0;
  for (let i = 0; i < 10; i++) if (small.record({ model: "m", usage: { prompt_tokens: i } })) written++;
  await small.flush();
  assert.ok(written >= 1 && written < 10);
  assert.equal(capMessages.length, 1);
  assert.ok(fs.statSync(small.file).size <= 300);
});

test("record returns before the disk is touched, and a backlog is bounded", async () => {
  const log = new AnswerLog({ file: tmp() });
  assert.equal(log.record({ model: "m" }), true);
  assert.equal(fs.existsSync(log.file), false, "nothing is written synchronously");
  await log.flush();
  assert.equal(fs.existsSync(log.file), true);
  let accepted = 0;
  for (let i = 0; i < 1000; i++) if (log.record({ model: "m" })) accepted++;
  assert.ok(accepted <= 200, `${accepted} queued`);
  await log.flush();
});

test("a failing disk does not use up the size budget", async () => {
  const log = new AnswerLog({ file: "/etc/hostname/nope/answers.jsonl", maxBytes: 400, log: () => {} });
  for (let i = 0; i < 30; i++) { log.record({ model: "m" }); await log.flush(); }
  assert.equal(log.warned, false);
  assert.equal(log.size + log.queued, 0);
});

test("the log resumes when room or the disk comes back: full is not permanent, and a partial write is counted from the real size", async () => {
  const file = tmp();
  const log = new AnswerLog({ file, maxBytes: 600, log: () => {} });
  while (log.record({ model: "m" })) { /* fill to the cap */ }
  await log.flush();
  assert.equal(log.record({ model: "m" }), false);
  fs.truncateSync(file, 0);                 // room appears (rotation by an operator)
  log.size = 0;
  assert.equal(log.record({ model: "m" }), true, "not permanently disabled");
  await log.flush();
  // a rejected append that wrote part of a line: the size is re-read from the file
  const partial = new AnswerLog({ file: tmp(), log: () => {} });
  fs.writeFileSync(partial.file, "x".repeat(50));
  const real = fs.promises.appendFile;
  fs.promises.appendFile = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  try { partial.record({ model: "m" }); await partial.flush(); } finally { fs.promises.appendFile = real; }
  assert.equal(partial.size, 50);
  assert.equal(partial.queued, 0);
  // and when the file cannot be re-read either, the failed line is still counted (it may have been written)
  const blind = new AnswerLog({ file: tmp(), log: () => {} });
  const realStat = fs.promises.stat;
  fs.promises.appendFile = async () => { throw Object.assign(new Error("io"), { code: "EIO" }); };
  fs.promises.stat = async () => { throw Object.assign(new Error("io"), { code: "EIO" }); };
  try { blind.record({ model: "m" }); await blind.flush(); } finally { fs.promises.appendFile = real; fs.promises.stat = realStat; }
  assert.ok(blind.size > 0);
});

test("recordWhenSettled records on the facilitator's success result, even if the client is gone, and never on a failure", async () => {
  const file = tmp();
  const log = new AnswerLog({ file });
  const make = () => { const headers = {}; return { res: { setHeader: (k, v) => { headers[k] = v; } }, headers }; };
  const ok = Buffer.from(JSON.stringify({ success: true, transaction: "0xtx" })).toString("base64");
  const bad = Buffer.from(JSON.stringify({ success: false, errorReason: "x", transaction: "" })).toString("base64");
  const a = make(); recordWhenSettled(a.res, log, { model: "settled" });
  a.res.setHeader("Content-Type", "application/json"); a.res.setHeader("PAYMENT-RESPONSE", ok); a.res.setHeader("payment-response", ok);
  const b = make(); recordWhenSettled(b.res, log, { model: "failed" });
  b.res.setHeader("PAYMENT-RESPONSE", bad); b.res.setHeader("PAYMENT-RESPONSE", "not base64 json");
  await log.flush();
  assert.deepEqual(read(file).map((l) => l.model), ["settled"], "once, and only the settled one");
  assert.equal(a.headers["PAYMENT-RESPONSE"], ok, "the header still goes out unchanged");
});

test("acceptedOf reads the signed scheme and network, and tolerates junk", () => {
  const req = (v) => ({ get: (k) => (k === "payment-signature" ? v : undefined) });
  assert.deepEqual(acceptedOf(req(encode({ accepted: { scheme: "exact", network: BASE, amount: "1" } }))), { scheme: "exact", network: BASE });
  assert.deepEqual(acceptedOf(req("not base64 json")), {});
  assert.deepEqual(acceptedOf(req(undefined)), {});
});

async function paidAnswer(t, { scheme, answerLogFile, maxTokens = 500, upstreamUsage, settleOk = true }) {
  const facilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu" } },
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x2A89407a98A0732b7fD578c4E156B7166540EB5A" } },
      { x402Version: 2, scheme: "upto", network: SOL, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }],
      extensions: ["eip2612GasSponsoring"], signers: {} }),
    verify: async () => ({ isValid: true, payer: account.address }),
    settle: async () => (settleOk ? { success: true, network: BASE, transaction: "0x" + "aa".repeat(32), payer: account.address }
      : { success: false, errorReason: "insufficient_funds", network: BASE, transaction: "" }) };
  const app = createApp({ payToBase: PAY_TO, payToSolana: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu", model: "test", answerLogFile },
    { facilitatorClient: facilitator, upstream: async () => ({ content: "Hello", finishReason: "stop", usage: upstreamUsage }), log: () => {} });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}${METERED_ROUTE}`;
  const send = (headers) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ messages: [{ role: "user", content: "a private question" }], max_tokens: maxTokens }) });
  const first = await send({});
  const q = decode(first.headers.get("payment-required"));
  const accepted = q.accepts.find((a) => a.scheme === scheme && a.network === BASE);
  const paid = await send({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: q.resource, accepted, payload: { signature: "0xsigned" }, extensions: q.extensions }) });
  return { paid, accepted };
}

for (const scheme of ["upto", "exact"]) {
  test(`a settled ${scheme} answer on the metered route is logged once, with its tokens and without the question`, async (t) => {
    const file = tmp();
    const { paid, accepted } = await paidAnswer(t, { scheme, answerLogFile: file, upstreamUsage: { prompt_tokens: 20, completion_tokens: 31, buyer_cost_micro: 100 } });
    assert.equal(paid.status, 200);
    const [line] = await lines(file);
    assert.equal(line.scheme, scheme);
    assert.equal(line.network, BASE);
    assert.equal(line.maxTokens, 500);
    assert.equal(line.completionTokens, 31);
    assert.equal(line.ceilingAtomic, Number(accepted.amount));
    assert.equal(line.billedAtomic, scheme === "upto" ? 1130 : Number(accepted.amount));
    assert.ok(!fs.readFileSync(file, "utf8").includes("private question"));
  });
}

test("an answer whose payment did not settle leaves no line", async (t) => {
  const file = tmp();
  const { paid } = await paidAnswer(t, { scheme: "upto", answerLogFile: file, settleOk: false, upstreamUsage: { prompt_tokens: 20, completion_tokens: 31, buyer_cost_micro: 100 } });
  assert.notEqual(paid.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await lines(file, 0), []);
});

test("an answer that could not be billed leaves no line, and no log file means no change", async (t) => {
  const file = tmp();
  const { paid } = await paidAnswer(t, { scheme: "upto", answerLogFile: file, upstreamUsage: { buyer_cost_micro: undefined } });
  assert.equal(paid.status, 503);
  assert.deepEqual(await lines(file, 0), []);
  const off = await paidAnswer(t, { scheme: "upto", answerLogFile: null, upstreamUsage: { buyer_cost_micro: 100 } });
  assert.equal(off.paid.status, 200);
});

test("the Messages route logs its settled answer with the Anthropic-style token counts", async (t) => {
  const file = tmp();
  const SONNET = { id: "claude-sonnet-5.5", name: "Sonnet", provider: "anthropic", contextLength: 1e6, promptUsdPerToken: 3e-6, completionUsdPerToken: 15e-6 };
  const catalogue = { async resolve(id) { if (id !== SONNET.id) throw new Error("no"); return SONNET; }, async canAnswer() { return true; },
    async list() { return [SONNET]; }, async imageModels() { return new Map(); } };
  const fetchImpl = async () => new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 12, output_tokens: 30, buyer_cost_micro: 2000 } }), { status: 200, headers: { "content-type": "application/json" } });
  const facilitator = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE },
      { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu" } },
      { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x2A89407a98A0732b7fD578c4E156B7166540EB5A" } },
      { x402Version: 2, scheme: "upto", network: SOL, extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } }],
      extensions: ["eip2612GasSponsoring"], signers: {} }),
    verify: async () => ({ isValid: true, payer: account.address }),
    settle: async () => ({ success: true, network: BASE, transaction: "0x" + "bb".repeat(32), payer: account.address }) };
  const app = createApp({ payToBase: PAY_TO, payToSolana: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu", surplusKey: "inf_test", surplusUrl: "https://surplus.test",
    model: "test", answerLogFile: file }, { facilitatorClient: facilitator, catalogue, fetchImpl, log: () => {}, upstream: async () => { throw new Error("not asked"); } });
  const listener = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  t.after(() => listener.close());
  const body = JSON.stringify({ model: "claude-sonnet-5.5", max_tokens: 300, messages: [{ role: "user", content: "What is x402?" }] });
  const call = (headers = {}) => fetch(`http://127.0.0.1:${listener.address().port}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  const required = decode((await call()).headers.get("payment-required"));
  const accepted = required.accepts.find((a) => a.scheme === "upto" && a.network === BASE);
  const paid = await call({ "PAYMENT-SIGNATURE": encode({ x402Version: 2, resource: required.resource, accepted, payload: { signature: "0xsigned" }, extensions: required.extensions }) });
  assert.equal(paid.status, 200);
  const [line] = await lines(file);
  assert.deepEqual([line.route, line.model, line.scheme, line.maxTokens, line.promptTokens, line.completionTokens, line.upstreamMicro],
    ["/v1/messages", "claude-sonnet-5.5", "upto", 300, 12, 30, 2000]);
  assert.equal(line.billedAtomic, Number((await paid.json()).billing.totalAtomic));
  assert.ok(!fs.readFileSync(file, "utf8").includes("x402?"));
});
