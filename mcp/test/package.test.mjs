import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers/client.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("manifest: @singitai/mcp, public, bin singit-mcp, explicit file allowlist", () => {
  assert.equal(pkg.name, "@singitai/mcp");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(Object.hasOwn(pkg, "private"), false);
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual(pkg.bin, { "singit-mcp": "src/index.js" });
  assert.deepEqual(pkg.files, ["src", "README.md", "LICENSE"]);
  assert.match(readFileSync(entry, "utf8"), /^#!\/usr\/bin\/env node\n/);
  assert.ok(statSync(entry).mode & 0o111, "bin entry is executable");
});

test("the CLI speaks MCP over stdio and lists the three tools without creating a wallet", async t => {
  const home = tempHome(t);
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, SINGIT_HOME: home, SINGIT_ASK_URL: "http://127.0.0.1:9" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = [];
  let buffer = "";
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply from singit-mcp")), 15000);
    const poll = () => {
      if (lines.length) { clearTimeout(timer); resolve(JSON.parse(lines.shift())); } else setTimeout(poll, 10);
    };
    poll();
  });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    lines.push(...parts.filter(Boolean));
  });
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const init = await next();
  assert.equal(init.result.serverInfo.name, "singit");
  assert.equal(init.result.serverInfo.version, pkg.version);
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const tools = (await next()).result.tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ["singit_chat", "singit_models", "singit_wallet"]);
  assert.throws(() => statSync(home), { code: "ENOENT" });
});
