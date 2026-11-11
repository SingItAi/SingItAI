import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, installerEnv, openclawEnv, profilePath, writeProfile, uninstallProfile } from "../src/openclaw.js";
import { readConfig } from "../src/config.js";
import { startProxy } from "../src/server.js";
import { terminalQr } from "../src/qr.js";

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "singit-openclaw-"));
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

test("installer defaults are independent of proxy defaults and user overrides", () => {
  assert.equal(readConfig({ env: {} }).maxPerCallUsd, 0.01);
  assert.equal(readConfig({ env: {} }).maxPerDayUsd, 1);
  const defaults = readConfig({ env: installerEnv({}) });
  assert.equal(defaults.maxPerCallUsd, 0.05);
  assert.equal(defaults.maxPerDayUsd, 2);
  assert.equal(defaults.client, "openclaw");
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

test("start invokes existing proxy and fake OpenClaw with forwarded arguments", async t => {
  const { home, env } = fixture(t);
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  const record = path.join(home, "record.json");
  writeFileSync(path.join(bin, "openclaw"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RECORD, JSON.stringify({env:process.env,argv:process.argv.slice(2)}));\n`, { mode: 0o700 });
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
  assert.equal(child.env.SINGIT_WALLET_KEY, undefined);
  assert.equal(config.client, "openclaw");
  assert.equal(config.port, 0);
  assertPublic(stdout.text, env);
  assert.equal(existsSync(path.join(home, ".claude/settings.json")), false);
  assert.equal(existsSync(path.join(home, ".claude.json")), false);
});

test("no-launch can be stopped and --client reaches proxy config", async t => {
  const { env } = fixture(t);
  let config;
  const result = await main(["--no-launch", "--client", "openclaw"], { env, stdout: capture(), startProxyImpl: async options => {
    const result = await startProxy(options); config = result.config; return result;
  } });
  assert.equal(config.client, "openclaw");
  result.stop("SIGTERM");
});

test("installer dry run creates no wallet", t => {
  const { env } = fixture(t);
  const script = fileURLToPath(new URL("../../install/singit-openclaw-install.sh", import.meta.url));
  const result = spawnSync("bash", [script, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Install: npm i -g @singitai\/proxy/);
  assert.doesNotMatch(result.stdout, /NOT LIVE|Not on npm/);
  const checkout = spawnSync("bash", [script, "--dry-run"], { env: { ...env, SINGIT_OPENCLAW_FROM: "checkout" }, encoding: "utf8" });
  assert.match(checkout.stdout, /cd proxy && npm install && node src\/openclaw.js setup/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("doctor checks file existence without creating wallet", async t => {
  const { env } = fixture(t);
  const stdout = capture();
  await main(["doctor"], { env: { ...env, PATH: "" }, stdout, fetchImpl: async () => new Response("", { status: 402 }) });
  assert.match(stdout.text, /Node:.*OK/);
  assert.match(stdout.text, /OpenClaw on PATH: false/);
  assert.match(stdout.text, /Session wallet file exists: false/);
  assert.match(stdout.text, /Proxy \/health: false/);
  assert.match(stdout.text, /\$0.05\/call, \$2\/day/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("QR contains terminal blocks", () => {
  assert.match(terminalQr(`0x${"a".repeat(40)}`), /[█▀▄]/);
});

test("missing OpenClaw prints official install guidance and closes proxy", async t => {
  const { env } = fixture(t);
  const stderr = capture();
  let server;
  const previousCode = process.exitCode;
  try {
    await main([], { env: { ...env, PATH: "" }, stdout: capture(), stderr, startProxyImpl: async options => {
      const proxy = await startProxy(options); server = proxy.server; return proxy;
    } });
    assert.match(stderr.text, /https:\/\/docs\.openclaw\.ai/);
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

test("setup merges, backs up and preserves unrelated keys and primary; start preserves provider", async t => {
  const { home, env } = fixture(t);
  env.OPENCLAW_HOME = path.join(home, "custom-openclaw");
  mkdirSync(env.OPENCLAW_HOME);
  const file = profilePath(env);
  const original = { unrelated: { nested: [1, "two"] }, agents: { defaults: { model: { primary: "existing" } } }, models: { providers: { other: { baseUrl: "local" } } } };
  writeFileSync(file, JSON.stringify(original));
  await main(["setup"], { env, stdout: capture() });
  const data = JSON.parse(readFileSync(file));
  assert.deepEqual(data.unrelated, original.unrelated);
  assert.deepEqual(data.models.providers.other, original.models.providers.other);
  assert.equal(data.agents.defaults.model.primary, "existing");
  assert.equal(data.models.mode, "merge");
  assert.equal(data.models.providers.singit.api, "openai-completions");
  assert.equal(data.models.providers.singit.auth, "none");
  assert.equal(data.mcp.servers.singit.transport, "streamable-http");
  const { readdirSync } = await import("node:fs");
  const backup = readdirSync(env.OPENCLAW_HOME).find(file => /\.\d+\.bak$/.test(file));
  assert.deepEqual(JSON.parse(readFileSync(path.join(env.OPENCLAW_HOME, backup))), original);
  const content = readFileSync(file, "utf8");
  const running = await main(["--no-launch"], { env, stdout: capture() });
  running.stop("SIGTERM");
  assert.equal(readFileSync(file, "utf8"), content);
  await main(["setup", "--default-model"], { env, stdout: capture() });
  assert.equal(JSON.parse(readFileSync(file)).agents.defaults.model.primary, "singit/auto");
});

test("--no-mcp omits MCP and malformed JSON remains untouched", async t => {
  const { env } = fixture(t);
  await main(["setup", "--no-mcp"], { env, stdout: capture() });
  assert.equal(JSON.parse(readFileSync(profilePath(env))).mcp, undefined);
  writeFileSync(profilePath(env), "{broken");
  await assert.rejects(() => main(["setup"], { env, stdout: capture() }));
  assert.equal(readFileSync(profilePath(env), "utf8"), "{broken");
});

test("skill setup dry run creates no wallet", t => {
  const { env } = fixture(t);
  const script = fileURLToPath(new URL("../../skills/singit/scripts/setup.sh", import.meta.url));
  const result = spawnSync("bash", [script, "--dry-run", "--default-model"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(env.SINGIT_HOME), false);
  assert.equal(existsSync(profilePath(env)), false);
});

test("start writes missing profile with actual port and custom client", async t => {
  const { env } = fixture(t);
  const result = await main(["--no-launch", "--client", "continue"], { env, stdout: capture() });
  t.after(() => result.stop("SIGTERM"));
  assert.match(readFileSync(profilePath(env), "utf8"), new RegExp(`127\\.0\\.0\\.1:${result.server.address().port}/v1`));
  const health = await (await fetch(`http://127.0.0.1:${result.server.address().port}/health`)).json();
  assert.equal(health.client, "continue");
});

test("launcher rejects non-Base and non-loopback configuration without creating wallet", async t => {
  const { env } = fixture(t);
  for (const override of [{ SINGIT_NETWORK: "solana" }, { SINGIT_PROXY_HOST: "0.0.0.0" }]) {
    await assert.rejects(() => main(["setup"], { env: { ...env, ...override }, stdout: capture() }));
  }
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("SIGINT and SIGTERM stop a running OpenClaw child and the launcher", async t => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const { home, env } = fixture(t);
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    const ready = path.join(home, "ready");
    writeFileSync(path.join(bin, "openclaw"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.READY, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const launcher = spawn(process.execPath, [fileURLToPath(new URL("../src/openclaw.js", import.meta.url))], {
      env: { ...env, PATH: `${bin}:${env.PATH}`, READY: ready }, stdio: "ignore",
    });
    t.after(() => launcher.kill("SIGKILL"));
    const exited = new Promise(resolve => launcher.once("exit", (code, signal) => resolve({ code, signal })));
    for (let attempt = 0; !existsSync(ready) && attempt < 200; attempt++) await delay(10);
    assert.ok(existsSync(ready), "OpenClaw child started");
    const pid = Number(readFileSync(ready, "utf8"));
    t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } });
    launcher.kill(signal);
    const result = await Promise.race([exited, delay(5000).then(() => { throw new Error("launcher did not stop"); })]);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
  }
});

test("a failed atomic config replacement restores the original and leaves no temporary file", async t => {
  const { env } = fixture(t);
  await main(["setup"], { env, stdout: capture() });
  const file = profilePath(env);
  const before = readFileSync(file, "utf8");
  assert.throws(() => writeProfile(env, 9000, true, {}, { renameImpl() { throw new Error("simulated write failure"); } }), /simulated write failure/);
  assert.equal(readFileSync(file, "utf8"), before);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(path.dirname(file));
  assert.ok(files.some(name => name.endsWith(".bak")));
  assert.ok(!files.some(name => name.endsWith(".tmp")));
});

const clawFile = env => path.join(env.HOME, ".openclaw", "openclaw.json");

test("uninstall restores the newest non-SingIt backup and leaves the wallet", async t => {
  const { home, env } = fixture(t);
  mkdirSync(path.dirname(clawFile(env)));
  const user = { agents: { defaults: { model: { primary: "anthropic/x" } } }, models: { providers: { other: { baseUrl: "http://o" } } } };
  writeFileSync(clawFile(env), JSON.stringify(user));
  await main(["setup", "--default-model"], { env, stdout: capture() });
  await main(["setup"], { env, stdout: capture() });
  const session = readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8");
  const stdout = capture();
  await main(["uninstall"], { env, stdout });
  assert.deepEqual(JSON.parse(readFileSync(clawFile(env), "utf8")), user);
  assert.equal(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8"), session);
  assert.ok(!stdout.text.includes(JSON.parse(session).privateKey));
  assert.equal(existsSync(path.join(home, ".claude/settings.json")), false);
});

test("uninstall without a backup removes only SingIt entries", async t => {
  const { env } = fixture(t);
  mkdirSync(path.dirname(clawFile(env)));
  writeFileSync(clawFile(env), "{}");
  await main(["setup", "--default-model"], { env, stdout: capture() });
  // Drop the backup setup made so the no-backup path runs against a SingIt-edited file.
  for (const name of readdirSync(path.dirname(clawFile(env)))) if (name.endsWith(".bak")) rmSync(path.join(path.dirname(clawFile(env)), name));
  const data = JSON.parse(readFileSync(clawFile(env), "utf8"));
  data.models.providers.other = { baseUrl: "http://o" };
  data.mcp.servers.mine = { url: "http://m" };
  data.agents.defaults.model.primary = "singit/auto";
  writeFileSync(clawFile(env), JSON.stringify(data));
  await main(["uninstall"], { env, stdout: capture() });
  assert.deepEqual(JSON.parse(readFileSync(clawFile(env), "utf8")), {
    models: { mode: "merge", providers: { other: { baseUrl: "http://o" } } },
    mcp: { servers: { mine: { url: "http://m" } } },
  });
});

test("uninstall deletes a file we created from scratch and keeps the wallet", async t => {
  const { env } = fixture(t);
  await main(["setup"], { env, stdout: capture() });
  assert.equal(existsSync(clawFile(env)), true);
  await main(["uninstall"], { env, stdout: capture() });
  assert.equal(existsSync(clawFile(env)), false);
  assert.equal(existsSync(path.join(env.SINGIT_HOME, "session")), true);
  const again = capture();
  await main(["uninstall"], { env, stdout: again });
  assert.match(again.text, /nothing to do/);
});

test("uninstall rejects invalid JSON without changing the file", async t => {
  const { env } = fixture(t);
  mkdirSync(path.dirname(clawFile(env)));
  writeFileSync(clawFile(env), "{ not json");
  await assert.rejects(main(["uninstall"], { env, stdout: capture() }), /not valid JSON/);
  assert.equal(readFileSync(clawFile(env), "utf8"), "{ not json");
});

test("a failed uninstall write keeps the original and leaves no temporary file", async t => {
  const { env } = fixture(t);
  mkdirSync(path.dirname(clawFile(env)));
  const body = JSON.stringify({ models: { providers: { singit: {}, other: {} } } });
  writeFileSync(clawFile(env), body);
  assert.throws(() => uninstallProfile(env, { renameImpl: () => { throw new Error("rename failed"); } }), /rename failed/);
  assert.equal(readFileSync(clawFile(env), "utf8"), body);
  assert.deepEqual(readdirSync(path.dirname(clawFile(env))), ["openclaw.json"]);
});
