// A measurement knob (28 October): SINGIT_ASK_REASONING_EFFORT and SINGIT_ASK_REASONING_HEADROOM let one process ask
// Opus for reasoning_effort "low" with a smaller thinking reserve, for a single paid test. Unset, nothing changes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { askSurplus, parseReasoningEffort, UpstreamError } from "../src/app.mjs";
import { ceilingAtomic, parseReasoningHeadroom, reasoningHeadroom, setReasoningHeadroomOverrides, TERMS }
  from "../src/pricing.mjs";

const CONFIG = { surplusKey: "inf_test", surplusUrl: "https://surplus.test", model: "deepseek-v4.1-flash" };
const OPUS = { id: "claude-opus-5.5", promptUsdPerToken: 4e-6, completionUsdPerToken: 20e-6 };
const MESSAGES = [{ role: "user", content: "Say hello in five words." }];
const reply = (content = "ciao") => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 7 } } }), { status: 200 });
const refusal = () => new Response(JSON.stringify({ error: { code: "request_rejected",
  message: "Reasoning is mandatory for this endpoint and cannot be disabled." } }), { status: 400 });
afterEach(() => setReasoningHeadroomOverrides({}));

test("parseReasoningEffort: model=effort pairs, empty means none, anything else throws", () => {
  assert.deepEqual(parseReasoningEffort(undefined), {});
  assert.deepEqual(parseReasoningEffort(""), {});
  assert.deepEqual(parseReasoningEffort("claude-opus-5.5=low"), { "claude-opus-5.5": "low" });
  assert.deepEqual(parseReasoningEffort(" a=none , b.1=high "), { a: "none", "b.1": "high" });
  for (const bad of ["claude-opus-5.5", "claude-opus-5.5=", "claude-opus-5.5=loud", "=low", "a=low=high", "a b=low", "a=LOW"])
    assert.throws(() => parseReasoningEffort(bad), /SINGIT_ASK_REASONING_EFFORT/, bad);
});

test("parseReasoningHeadroom: model=tokens, whole numbers 0 to 2048", () => {
  assert.deepEqual(parseReasoningHeadroom(undefined), {});
  assert.deepEqual(parseReasoningHeadroom("claude-opus-5.5=128, x=0"), { "claude-opus-5.5": 128, x: 0 });
  for (const bad of ["claude-opus-5.5", "claude-opus-5.5=", "claude-opus-5.5=-1", "claude-opus-5.5=1.5", "claude-opus-5.5=2049",
    "claude-opus-5.5=abc", "=5", "a=1=2"])
    assert.throws(() => parseReasoningHeadroom(bad), /SINGIT_ASK_REASONING_HEADROOM/, bad);
});

test("headroom override replaces the model's table value in the ceiling and upstream max_tokens, others untouched", async () => {
  const size = { chars: 24, maxTokens: 150, messageCount: 1 };
  assert.equal(reasoningHeadroom("claude-opus-5.5"), 256);
  const before = ceilingAtomic(OPUS, size, TERMS);
  setReasoningHeadroomOverrides({ "claude-opus-5.5": 128 });
  assert.equal(reasoningHeadroom("claude-opus-5.5"), 128);
  assert.equal(reasoningHeadroom("gemini-3.1-pro-preview"), 1024);
  assert.equal(reasoningHeadroom("deepseek-v4.1-flash"), 0);
  assert.equal(reasoningHeadroom(undefined), 0);
  const after = ceilingAtomic(OPUS, size, TERMS);
  // 128 fewer output tokens at $20/M = 2560 micro-USD of list cost, +30% markup.
  assert.equal(BigInt(before) - BigInt(after), 2560n + 768n);
  let body;
  await askSurplus(CONFIG, MESSAGES, 150, async (_u, init) => { body = JSON.parse(init.body); return reply(); }, "claude-opus-5.5");
  assert.equal(body.max_tokens, 150 + 128);
  setReasoningHeadroomOverrides({});
  await askSurplus(CONFIG, MESSAGES, 150, async (_u, init) => { body = JSON.parse(init.body); return reply(); }, "claude-opus-5.5");
  assert.equal(body.max_tokens, 150 + 256, "unset, nothing differs");
});

test("config.reasoningEffort asks that model for the effort; every other model and the default stay at none", async () => {
  const config = { ...CONFIG, reasoningEffort: { "claude-opus-5.5": "low" } };
  const efforts = {};
  const spy = (model) => async (_u, init) => { efforts[model] = JSON.parse(init.body).reasoning_effort; return reply(); };
  await askSurplus(config, MESSAGES, 150, spy("claude-opus-5.5"), "claude-opus-5.5");
  await askSurplus(config, MESSAGES, 150, spy("claude-sonnet-5.5"), "claude-sonnet-5.5");
  await askSurplus(CONFIG, MESSAGES, 150, spy("opus-unset"), "claude-opus-5.5");
  assert.deepEqual(efforts, { "claude-opus-5.5": "low", "claude-sonnet-5.5": "none", "opus-unset": "none" });
});

test("the usage with reasoning_tokens reaches the caller, so a test can measure the thinking", async () => {
  const config = { ...CONFIG, reasoningEffort: { "claude-opus-5.5": "low" } };
  const answer = await askSurplus(config, MESSAGES, 150, async () => reply(), "claude-opus-5.5");
  assert.equal(answer.usage.completion_tokens_details.reasoning_tokens, 7);
});

test("a refusal of the asked effort is an error, not a retry; a refusal of none still falls back to low", async () => {
  const config = { ...CONFIG, reasoningEffort: { "claude-opus-5.5": "medium" } };
  const seen = [];
  await assert.rejects(askSurplus(config, MESSAGES, 150, async (_u, init) => { seen.push(JSON.parse(init.body).reasoning_effort);
    return refusal(); }, "claude-opus-5.5"), UpstreamError);
  assert.deepEqual(seen, ["medium"]);
  const fallback = [];
  await askSurplus(CONFIG, MESSAGES, 150, async (_u, init) => { fallback.push(JSON.parse(init.body).reasoning_effort);
    return fallback.length === 1 ? refusal() : reply(); }, "claude-opus-5.5");
  assert.deepEqual(fallback, ["none", "low"]);
});

test("the REASONING_OFF extras go with none only", async () => {
  const config = { ...CONFIG, reasoningEffort: { "deepseek-v4-pro": "low" } };
  let body;
  await askSurplus(config, MESSAGES, 150, async (_u, init) => { body = JSON.parse(init.body); return reply(); }, "deepseek-v4-pro");
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.thinking, undefined);
  await askSurplus(CONFIG, MESSAGES, 150, async (_u, init) => { body = JSON.parse(init.body); return reply(); }, "deepseek-v4-pro");
  assert.equal(body.enable_thinking, false);
});

test("server.mjs refuses to start on an unreadable value, before it listens", () => {
  const env = { PATH: process.env.PATH, HOME: "/nonexistent", SINGIT_ASK_PAY_TO_SOLANA: "x", SINGIT_ASK_PAY_TO_BASE: "0x1",
    SURPLUS_API_KEY: "inf_x", CDP_API_KEY_ID: "x", CDP_API_KEY_SECRET: "x", SINGIT_ASK_PORT: "0" };
  for (const bad of [{ SINGIT_ASK_REASONING_EFFORT: "claude-opus-5.5=loud" }, { SINGIT_ASK_REASONING_HEADROOM: "claude-opus-5.5=lots" }]) {
    const run = spawnSync(process.execPath, ["src/server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...env, ...bad },
      encoding: "utf8", timeout: 20000 });
    assert.notEqual(run.status, 0, JSON.stringify(bad));
    assert.match(run.stderr, /SINGIT_ASK_REASONING_(EFFORT|HEADROOM): cannot read/);
  }
});
