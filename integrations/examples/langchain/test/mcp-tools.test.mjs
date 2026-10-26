import test from "node:test";
import assert from "node:assert/strict";
import { startMockMcpServer } from "./helpers/mock-mcp-server.mjs";
import { runFreeMcpTools } from "../src/free-mcp-tools.mjs";

test("runFreeMcpTools lists SingIt's tools and calls the free get_price tool, no key needed", async () => {
  const mock = await startMockMcpServer();
  try {
    const result = await runFreeMcpTools({ mcpUrl: mock.url });
    assert.ok(result.toolNames.some(name => name.endsWith("get_price")));
    assert.ok(result.toolNames.some(name => name.endsWith("list_price_symbols")));
    assert.ok(result.price);
    assert.ok(mock.seenAuthorizationHeaders.every(header => header === null));
  } finally {
    await mock.close();
  }
});
