import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToChatCompletions, chatCompletionToMessage, estimateTokenCount, mapModel } from "../src/anthropic.js";
import { completionToOpenAiSse, messageToAnthropicSse, openaiSseToAnthropicSse } from "../src/sse.js";

test("mapModel passes unknown ids through and applies SINGIT_MODEL_MAP-style rewrites", () => {
  assert.equal(mapModel("deepseek-v4.1-flash", { haiku: "free/x" }), "deepseek-v4.1-flash");
  assert.equal(mapModel("claude-haiku-5.5", { "claude-haiku-5.5": "deepseek-v4.1-flash" }), "deepseek-v4.1-flash");
  assert.equal(mapModel("Haiku", { haiku: "free/deepseek-v4.1-flash" }), "free/deepseek-v4.1-flash");
});

test("anthropicToChatCompletions maps system, tools and tool_result turns", () => {
  const out = anthropicToChatCompletions({
    model: "claude-haiku-5.5",
    max_tokens: 64,
    system: "Be brief.",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ],
    tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    tool_choice: { type: "auto" },
  }, { modelMap: { "claude-haiku-5.5": "deepseek-v4.1-flash" } });
  assert.equal(out.model, "deepseek-v4.1-flash");
  assert.equal(out.max_tokens, 64);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].role, "user");
  assert.equal(out.messages[2].role, "assistant");
  assert.equal(out.messages[2].tool_calls[0].function.name, "lookup");
  assert.equal(out.messages[3].role, "tool");
  assert.equal(out.messages[3].tool_call_id, "toolu_1");
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tool_choice, "auto");
});

test("chatCompletionToMessage maps tool_calls to tool_use", () => {
  const message = chatCompletionToMessage({
    id: "cmpl_1", model: "deepseek-v4.1-flash",
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"hi"}' } }] },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  assert.equal(message.type, "message");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0].type, "tool_use");
  assert.equal(message.content[0].name, "lookup");
  assert.deepEqual(message.content[0].input, { q: "hi" });
});

test("estimateTokenCount is a positive character-based estimate", () => {
  const n = estimateTokenCount({ model: "x", messages: [{ role: "user", content: "Hello world from SingIt" }] });
  assert.equal(typeof n.input_tokens, "number");
  assert.ok(n.input_tokens >= 1);
});

test("OpenAI SSE synthesizes [DONE] and Anthropic SSE includes the required events", () => {
  const openai = completionToOpenAiSse({
    id: "cmpl_1", created: 1, model: "deepseek-v4.1-flash",
    choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
  });
  assert.match(openai, /chat\.completion\.chunk/);
  assert.match(openai, /data: \[DONE\]/);
  const anthropic = messageToAnthropicSse({
    id: "msg_1", type: "message", role: "assistant", model: "deepseek-v4.1-flash",
    content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn",
  });
  assert.match(anthropic, /event: message_start/);
  assert.match(anthropic, /event: content_block_delta/);
  assert.match(anthropic, /event: message_stop/);
  const translated = openaiSseToAnthropicSse(openai);
  assert.match(translated, /event: message_start/);
  assert.match(translated, /Hi/);
  assert.match(translated, /event: message_stop/);
});
