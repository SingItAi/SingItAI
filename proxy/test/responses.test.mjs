import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatCompletions as translate, chatCompletionToResponse } from "../src/responses.js";
import { responseToSse, openaiSseToResponsesSse, parseSseData, responsesErrorSse } from "../src/sse.js";

test("Responses request golden: instructions, messages, calls, results and tools", () => {
  assert.deepEqual(translate({
    model: "alias", instructions: "Be brief", stream: true, store: false, reasoning: {},
    input: ["Hi", { role: "developer", content: [{ type: "input_text", text: "Rule" }] },
      { type: "function_call", id: "item", call_id: "call", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "result" }, { type: "reasoning" }],
    tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "lookup" }, parallel_tool_calls: false,
    max_output_tokens: 32, temperature: 0, top_p: 1, stop: ["END"],
  }, { modelMap: { alias: "real" } }), {
    model: "real", messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hi" },
      { role: "system", content: "Rule" }, { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call", content: "result" }],
    stream: true, temperature: 0, top_p: 1, stop: ["END"], parallel_tool_calls: false, max_tokens: 32,
    tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
  });
});

test("model mapping precedes catalog resolution; unknown ids pass through", () => {
  const catalog = { default: "live", data: [{ id: "fallback" }] };
  for (const model of ["auto", "singit/auto"]) assert.equal(translate({ model, input: "Hi" }, { catalog }).model, "live");
  assert.equal(translate({ model: "alias", input: "Hi" }, { modelMap: { alias: "auto" }, catalog }).model, "live");
  assert.equal(translate({ model: "auto", input: "Hi" }).model, "auto");
  assert.equal(translate({ model: "unknown", input: "Hi" }, { catalog }).model, "unknown");
  assert.equal(translate({ model: "auto", input: "Hi" }, { catalog: { data: [{ id: "embeddings" }, { id: "chat" }] } }).model, "chat");
  assert.equal(translate({ model: "x", input: "Hi", tools: [{ type: "function", function: { name: "f" } }] }).tools[0].function.name, "f");
  const mixed = translate({
    model: "x", input: "Hi",
    tools: [
      { type: "web_search" },
      { type: "function", name: "lookup", parameters: { type: "object" } },
      { type: "apply_patch" },
    ],
  });
  assert.equal(mixed.tools.length, 1);
  assert.equal(mixed.tools[0].function.name, "lookup");
  assert.equal(translate({ model: "x", input: "Hi", tools: [{ type: "web_search" }] }).tools, undefined);
});

const completion = {
  id: "c1", model: "model", choices: [{ message: { content: "Hello", tool_calls: [{ id: "call", function: { name: "lookup", arguments: '{"q":"hi"}' } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 3 }, billing: { totalAtomic: "1" },
};
test("completion JSON and SSE preserve text, calls, usage and billing in order", () => {
  const response = chatCompletionToResponse(completion);
  assert.equal(response.object, "response");
  assert.equal(response.output[0].content[0].text, "Hello");
  assert.equal(response.output[1].call_id, "call");
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 3, total_tokens: 13 });
  assert.deepEqual(response.billing, completion.billing);
  const events = parseSseData(responseToSse(response));
  assert.equal(events[0].event, "response.created");
  assert.equal(events.at(-1).event, "response.completed");
  assert.equal(events.at(-1).data.response.id, "c1");
  assert.deepEqual(events.at(-1).data.response.usage, response.usage);
  const added = events.findIndex(item => item.event === "response.output_item.added");
  assert.ok(added < events.findIndex(item => item.event === "response.output_text.delta"));
  assert.equal(events.filter(item => item.event === "response.output_item.done").length, 2);
  assert.ok(events.some(item => item.event === "response.function_call_arguments.delta"));
  const plain = chatCompletionToResponse({ ...completion, choices: [{ message: { content: "plain" } }] });
  assert.equal(plain.output.length, 1);
});

test("chat SSE accumulates fragmented tools, text and usage", () => {
  const chunks = [
    { id: "s1", choices: [{ delta: { content: "Hi", tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
  ];
  const events = parseSseData(openaiSseToResponsesSse(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"));
  const response = events.at(-1).data.response;
  assert.equal(response.output[0].content[0].text, "Hi");
  assert.equal(response.output[1].arguments, "{}");
  assert.equal(response.usage.total_tokens, 3);
});
test("errors fail and invalid requests throw status 400", () => {
  for (const body of [null, {}, { model: "x", input: [null] }, { model: "x", input: [] }, { model: "x", input: [{ type: "message", role: "bad" }] }]) {
    assert.throws(() => translate(body), error => error.status === 400);
  }
  for (const sse of [responsesErrorSse("failed"), openaiSseToResponsesSse('data: {"error":{"message":"failed"}}\n\n')]) {
    assert.match(sse, /response.failed/);
    assert.doesNotMatch(sse, /response.completed/);
  }
});
