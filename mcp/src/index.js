#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol; anything for a human goes to stderr.
try {
  await createServer().connect(new StdioServerTransport());
} catch (error) {
  console.error(`singit-mcp: ${error.message}`);
  process.exit(1);
}
