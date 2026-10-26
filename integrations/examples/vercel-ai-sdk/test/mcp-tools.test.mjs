import test from "node:test";
import assert from "node:assert/strict";
import { startMockMcpServer } from "./helpers/mock-mcp-server.mjs";
import { runFreeMcpTools } from "../src/free-mcp-tools.mjs";

test("runFreeMcpTools lists SingIt's tools and calls the free get_price tool, no key needed", async () => {
  const mock = await startMockMcpServer();
  try {
    const result = await runFreeMcpTools({ mcpUrl: mock.url });
    assert.ok(result.toolNames.includes("get_price"));
    assert.ok(result.toolNames.includes("list_price_symbols"));
    assert.ok(result.price);
    assert.equal(result.price.symbol, "BTC");
    assert.ok(mock.seenAuthorizationHeaders.every(header => header === null));
  } finally {
    await mock.close();
  }
});
