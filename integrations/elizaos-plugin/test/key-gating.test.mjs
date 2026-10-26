import test from "node:test";
import assert from "node:assert/strict";
import { startMockMcpServer } from "./helpers/mock-mcp-server.mjs";
import { singitWebSearchAction } from "../src/actions/web-search.js";
import { singitReadPageAction } from "../src/actions/read-page.js";

function makeRuntime(settings = {}) {
  return { getSetting: key => (key in settings ? settings[key] : null) };
}

test("SINGIT_WEB_SEARCH validate() is false without SINGIT_API_KEY, even for matching phrasing", async () => {
  const ok = await singitWebSearchAction.validate(makeRuntime(), { content: { text: "search the web for SingIt" } });
  assert.equal(ok, false);
});

test("SINGIT_WEB_SEARCH handler refuses without a key and never calls the server", async () => {
  const mock = await startMockMcpServer();
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url });
    let callback;
    const result = await singitWebSearchAction.handler(
      runtime, { content: { text: "search the web for SingIt" } }, undefined, undefined, args => { callback = args; },
    );
    assert.equal(result.success, false);
    assert.equal(result.error, "missing_api_key");
    assert.match(callback.text, /needs a SINGIT_API_KEY/);
    assert.deepEqual(mock.seenAuthorizationHeaders, []); // the server was never called
  } finally {
    await mock.close();
  }
});

test("SINGIT_WEB_SEARCH sends exactly Authorization: Bearer <key> when configured", async () => {
  const mock = await startMockMcpServer({ apiKey: "sk_singit_abc123" });
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url, SINGIT_API_KEY: "sk_singit_abc123" });
    let callback;
    const result = await singitWebSearchAction.handler(
      runtime, { content: { text: "search the web for the latest SingIt news" } }, undefined, undefined, args => { callback = args; },
    );
    assert.equal(result.success, true);
    assert.deepEqual(mock.seenAuthorizationHeaders, ["Bearer sk_singit_abc123"]);
    assert.match(callback.text, /Result for/);
  } finally {
    await mock.close();
  }
});

test("SINGIT_WEB_SEARCH never leaks the API key in its error text when the key is rejected", async () => {
  const mock = await startMockMcpServer({ apiKey: "sk_singit_real" });
  try {
    const secretKey = "sk_singit_wrong_and_very_secret";
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url, SINGIT_API_KEY: secretKey });
    let callback;
    const result = await singitWebSearchAction.handler(
      runtime, { content: { text: "search the web for SingIt" } }, undefined, undefined, args => { callback = args; },
    );
    assert.equal(result.success, false);
    assert.ok(!JSON.stringify(result).includes(secretKey));
    assert.ok(!JSON.stringify(callback).includes(secretKey));
  } finally {
    await mock.close();
  }
});

test("SINGIT_READ_PAGE validate() is false without SINGIT_API_KEY", async () => {
  const ok = await singitReadPageAction.validate(makeRuntime(), { content: { text: "read https://singitai.app for me" } });
  assert.equal(ok, false);
});

test("SINGIT_READ_PAGE sends the Authorization header and reads a page once a key is configured", async () => {
  const mock = await startMockMcpServer({ apiKey: "sk_singit_abc123" });
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url, SINGIT_API_KEY: "sk_singit_abc123" });
    let callback;
    const result = await singitReadPageAction.handler(
      runtime, { content: { text: "read https://singitai.app for me" } }, undefined, undefined, args => { callback = args; },
    );
    assert.equal(result.success, true);
    assert.deepEqual(mock.seenAuthorizationHeaders, ["Bearer sk_singit_abc123"]);
    assert.match(callback.text, /Page text for https:\/\/singitai\.app/);
  } finally {
    await mock.close();
  }
});

test("SINGIT_READ_PAGE refuses without a URL in the message", async () => {
  const mock = await startMockMcpServer({ apiKey: "sk_singit_abc123" });
  try {
    const runtime = makeRuntime({ SINGIT_MCP_URL: mock.url, SINGIT_API_KEY: "sk_singit_abc123" });
    const result = await singitReadPageAction.handler(runtime, { content: { text: "read this for me" } }, undefined, undefined, () => {});
    assert.equal(result.success, false);
    assert.equal(result.error, "missing_url");
  } finally {
    await mock.close();
  }
});
