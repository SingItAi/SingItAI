import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeClient, clientHeader, CLIENTS } from "../src/headers.js";
import { routeUpstream } from "../src/server.js";
import { readConfig } from "../src/config.js";

test("client labels are allowlisted short tokens; anything else becomes the fallback", () => {
  assert.equal(sanitizeClient(undefined), "singit-proxy");
  assert.equal(sanitizeClient(""), "singit-proxy");
  assert.equal(sanitizeClient("openclaw"), "openclaw");
  assert.equal(sanitizeClient("Continue"), "continue");
  assert.equal(sanitizeClient("singit-proxy/0.1.0"), "singit-proxy");
  assert.equal(sanitizeClient("codex"), "codex");
  assert.equal(sanitizeClient("codex/0.1.0"), "codex");
  assert.equal(sanitizeClient("not a label"), "singit-proxy");
  assert.equal(sanitizeClient("user@example.com"), "singit-proxy");
  assert.equal(sanitizeClient("x".repeat(40)), "singit-proxy");
  assert.equal(sanitizeClient("evil", null), null);
  assert.ok(CLIENTS.includes("openclaw") && CLIENTS.includes("continue") && CLIENTS.includes("codex"));
  assert.equal(CLIENTS.includes("singit-cc"), false);
});

test("the default header is singit-proxy/<version>; a configured product is sent as-is", () => {
  assert.equal(clientHeader("singit-proxy", "0.1.0"), "singit-proxy/0.1.0");
  assert.equal(clientHeader("openclaw", "0.1.0"), "openclaw");
  assert.equal(clientHeader("continue", "0.1.0"), "continue");
});

test("path-pinned chat is rewritten onto /v1/chat/completions", () => {
  assert.deepEqual(routeUpstream("/v1/chat/completions", { model: "singit/auto", messages: [] }),
    { path: "/v1/chat/completions", body: { model: "singit/auto", messages: [] } });
  assert.deepEqual(routeUpstream("/v1/chat/claude-opus-5.5", { messages: [{ role: "user", content: "Hi" }] }),
    { path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "Hi" }], model: "claude-opus-5.5" } });
  assert.deepEqual(routeUpstream("/v1/models/kimi-k3/chat", { messages: [] }),
    { path: "/v1/chat/completions", body: { messages: [], model: "kimi-k3" } });
  assert.equal(routeUpstream("/v1/images/generations", {}), null);
  assert.equal(routeUpstream("/chat/completions", {}), null);
});

test("readConfig rejects a non-allowlisted --client and accepts openclaw or codex", () => {
  assert.equal(readConfig({ env: { SINGIT_CLIENT: "openclaw" } }).client, "openclaw");
  assert.equal(readConfig({ env: { SINGIT_CLIENT: "codex" } }).client, "codex");
  assert.deepEqual(readConfig({ env: { SINGIT_MODEL_MAP: "haiku=free/deepseek-v4.1-flash" } }).modelMap, { haiku: "free/deepseek-v4.1-flash" });
  assert.throws(() => readConfig({ env: { SINGIT_CLIENT: "user@host" } }), /short product label/);
  assert.equal(readConfig({ argv: ["--port", "9001"] }).port, 9001);
});
