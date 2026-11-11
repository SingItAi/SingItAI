import test from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/models.js";
import { responsesToChatCompletions } from "../src/responses.js";

test("shared aliases honor model map first, free preference, fallbacks and unknown IDs", () => {
  const catalog = { default: "live", data: [{ id: "free/other" }, { id: "free/deepseek-v4.1-flash" }] };
  assert.equal(resolveModel("mapped", { modelMap: { mapped: "free" }, catalog }), "free/deepseek-v4.1-flash");
  assert.equal(resolveModel("auto", { modelMap: { auto: "explicit" }, catalog }), "explicit");
  assert.equal(resolveModel("free", { catalog: { data: [{ id: "free/other" }] } }), "free/other");
  for (const model of ["free", "singit/free", "auto", "singit/auto", "unknown"]) assert.equal(resolveModel(model), model);
  assert.equal(resolveModel("auto", { catalog: { data: [{ id: "sound" }, { id: "image" }, { id: "speech" }, { id: "chat" }] } }), "chat");
  assert.equal(responsesToChatCompletions({ model: "singit/free", input: "hello" }, { catalog }).model, "free/deepseek-v4.1-flash");
});
