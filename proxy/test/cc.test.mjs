import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, installerEnv, claudeEnv, MODEL_ENV, backupClaudeSettings, restoreClaudeSettings } from "../src/cc.js";
import { readConfig } from "../src/config.js";
import { startProxy } from "../src/server.js";
import { terminalQr } from "../src/qr.js";

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "singit-cc-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home, SINGIT_HOME: path.join(home, ".singit"), SINGIT_PROXY_PORT: "0", PATH: process.env.PATH } };
}
const capture = () => ({ text: "", write(value) { this.text += value; } });
function assertPublic(output, env) {
  const { privateKey } = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8"));
  assert.match(output, /0x[\da-fA-F]{40}/);
  assert.match(output, /USDC on Base.*eip155:8453/);
  assert.match(output, /[█▀▄]/);
  assert.ok(!output.includes(privateKey));
  assert.ok(!output.includes(privateKey.slice(2)));
}

test("child environment replaces credentials and preserves model overrides", () => {
  const child = claudeEnv({ ANTHROPIC_API_KEY: "stale", ANTHROPIC_AUTH_TOKEN: "stale", ANTHROPIC_CUSTOM_SECRET: "secret", CLAUDE_CODE_OAUTH_TOKEN: "oauth", CLAUDE_CODE_OAUTH_OTHER: "oauth", SINGIT_WALLET_KEY: "secret" });
  assert.equal(child.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, "singit-proxy-handles-auth");
  assert.equal(child.ANTHROPIC_API_KEY, "singit-proxy-handles-auth");
  for (const [key, value] of Object.entries(MODEL_ENV)) assert.equal(child[key], value);
  for (const key of ["SINGIT_WALLET_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_OTHER", "ANTHROPIC_CUSTOM_SECRET"]) assert.equal(child[key], undefined);
  assert.equal(claudeEnv({ ANTHROPIC_MODEL: "custom" }).ANTHROPIC_MODEL, "custom");
});

test("installer defaults are independent of proxy defaults and user overrides", () => {
  assert.equal(readConfig({ env: {} }).maxPerCallUsd, 0.01);
  assert.equal(readConfig({ env: {} }).maxPerDayUsd, 1);
  const defaults = readConfig({ env: installerEnv({}) });
  assert.equal(defaults.maxPerCallUsd, 0.05);
  assert.equal(defaults.maxPerDayUsd, 2);
  assert.equal(defaults.client, "claude-code");
  assert.equal(defaults.network, "base");
  const override = installerEnv({ SINGIT_MAX_PER_CALL_USD: "0.03", SINGIT_MAX_PER_DAY_USD: "4", SINGIT_CLIENT: "continue" });
  assert.equal(override.SINGIT_MAX_PER_CALL_USD, "0.03");
  assert.equal(override.SINGIT_MAX_PER_DAY_USD, "4");
  assert.equal(override.SINGIT_CLIENT, "continue");
});

test("setup reuses wallet and prints only public funding data", async t => {
  const { home, env } = fixture(t);
  const stdout = capture();
  await main(["setup"], { env, stdout });
  assertPublic(stdout.text, env);
  const original = readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8");
  await main(["setup"], { env, stdout });
  assert.equal(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8"), original);
  assert.equal(existsSync(path.join(home, ".claude/settings.json")), false);
  assert.equal(existsSync(path.join(home, ".claude.json")), false);
});

test("start invokes existing proxy and fake Claude with forwarded arguments", async t => {
  const { home, env } = fixture(t);
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  const record = path.join(home, "record.json");
  writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RECORD, JSON.stringify({env:process.env,argv:process.argv.slice(2)}));\n`, { mode: 0o700 });
  const stdout = capture();
  let config;
  await main(["setup"], { env, stdout: capture() });
  const { privateKey } = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8"));
  await main(["start", "--", "-p", "say hi", "--port", "9999"], {
    env: { ...env, PATH: `${bin}:${env.PATH}`, RECORD: record, SINGIT_WALLET_KEY: privateKey, ANTHROPIC_API_KEY: "stale", CLAUDE_CODE_OAUTH_TOKEN: "old" }, stdout,
    fetchImpl: () => { throw new Error("No network allowed"); },
    startProxyImpl: async options => { const proxy = await startProxy(options); config = proxy.config; return proxy; },
  });
  const child = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(child.argv, ["-p", "say hi", "--port", "9999"]);
  assert.match(child.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(child.env.ANTHROPIC_API_KEY, "singit-proxy-handles-auth");
  assert.equal(child.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(child.env.SINGIT_WALLET_KEY, undefined);
  assert.equal(config.client, "claude-code");
  assert.equal(config.port, 0);
  assertPublic(stdout.text, env);
  assert.equal(existsSync(path.join(home, ".claude/settings.json")), false);
  assert.equal(existsSync(path.join(home, ".claude.json")), false);
});

test("no-launch can be stopped and --client reaches proxy config", async t => {
  const { env } = fixture(t);
  let config;
  const result = await main(["--no-launch", "--client", "claude-code"], { env, stdout: capture(), startProxyImpl: async options => {
    const result = await startProxy(options); config = result.config; return result;
  } });
  assert.equal(config.client, "claude-code");
  result.stop("SIGTERM");
});

test("backup copies exclusively and rollback restores settings", t => {
  const { home } = fixture(t);
  const file = path.join(home, "settings.json");
  assert.equal(backupClaudeSettings(file), null);
  writeFileSync(file, '{"original":true}');
  const backup = backupClaudeSettings(file);
  assert.match(backup, /\.\d+\.bak$/);
  assert.equal(readFileSync(backup, "utf8"), '{"original":true}');
  writeFileSync(file, "broken");
  restoreClaudeSettings(backup, file);
  assert.equal(readFileSync(file, "utf8"), '{"original":true}');
});

test("installer dry run creates no wallet", t => {
  const { env } = fixture(t);
  const script = fileURLToPath(new URL("../../install/singit-cc-install.sh", import.meta.url));
  const result = spawnSync("bash", [script, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not on npm yet/);
  assert.match(result.stdout, /cd proxy && npm install && node src\/cc.js setup/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("doctor checks file existence without creating wallet", async t => {
  const { env } = fixture(t);
  const stdout = capture();
  await main(["doctor"], { env: { ...env, PATH: "" }, stdout, fetchImpl: async () => new Response("", { status: 402 }) });
  assert.match(stdout.text, /Node:.*OK/);
  assert.match(stdout.text, /Claude on PATH: false/);
  assert.match(stdout.text, /Session wallet file exists: false/);
  assert.match(stdout.text, /Proxy \/health: false/);
  assert.match(stdout.text, /\$0.05\/call, \$2\/day/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("QR contains terminal blocks", () => {
  assert.match(terminalQr(`0x${"a".repeat(40)}`), /[█▀▄]/);
});

test("model defaults match the Claude launcher catalog mapping", () => {
  assert.deepEqual(MODEL_ENV, {
    ANTHROPIC_MODEL: "deepseek-v4.1-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5.5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5.5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5.5",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash",
  });
});

test("missing Claude prints official install guidance and closes proxy", async t => {
  const { env } = fixture(t);
  const stderr = capture();
  let server;
  const previousCode = process.exitCode;
  try {
    await main([], { env: { ...env, PATH: "" }, stdout: capture(), stderr, startProxyImpl: async options => {
      const proxy = await startProxy(options); server = proxy.server; return proxy;
    } });
    assert.match(stderr.text, /https:\/\/claude\.ai\/install\.sh/);
    assert.match(stderr.text, /--no-launch/);
    assert.equal(process.exitCode, 1);
    assert.equal(server.listening, false);
  } finally { process.exitCode = previousCode; }
});

test("SIGINT and SIGTERM close no-launch proxy and remove signal handlers", async t => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const { env } = fixture(t);
    const initial = process.listenerCount(signal);
    const { server } = await main(["start", "--no-launch"], { env, stdout: capture() });
    assert.equal(server.listening, true);
    process.emit(signal);
    assert.equal(server.listening, false);
    assert.equal(process.listenerCount(signal), initial);
  }
});
