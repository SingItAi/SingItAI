import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, installerEnv, codexEnv, profilePath } from "../src/codex.js";
import { readConfig } from "../src/config.js";
import { startProxy } from "../src/server.js";
import { terminalQr } from "../src/qr.js";

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "singit-codex-"));
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
  assert.equal(defaults.client, "codex");
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

test("start invokes existing proxy and fake Codex with forwarded arguments", async t => {
  const { home, env } = fixture(t);
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  const record = path.join(home, "record.json");
  writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RECORD, JSON.stringify({env:process.env,argv:process.argv.slice(2)}));\n`, { mode: 0o700 });
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
  assert.deepEqual(child.argv, ["--profile", "singit", "-p", "say hi", "--port", "9999"]);
  assert.equal(child.env.SINGIT_WALLET_KEY, undefined);
  assert.equal(config.client, "codex");
  assert.equal(config.port, 0);
  assertPublic(stdout.text, env);
  assert.equal(existsSync(path.join(home, ".claude/settings.json")), false);
  assert.equal(existsSync(path.join(home, ".claude.json")), false);
});

test("no-launch can be stopped and --client reaches proxy config", async t => {
  const { env } = fixture(t);
  let config;
  const result = await main(["--no-launch", "--client", "codex"], { env, stdout: capture(), startProxyImpl: async options => {
    const result = await startProxy(options); config = result.config; return result;
  } });
  assert.equal(config.client, "codex");
  result.stop("SIGTERM");
});

test("installer dry run creates no wallet", t => {
  const { env } = fixture(t);
  const script = fileURLToPath(new URL("../../install/singit-codex-install.sh", import.meta.url));
  const result = spawnSync("bash", [script, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Install: npm i -g @singitai\/proxy/);
  assert.doesNotMatch(result.stdout, /NOT LIVE|Not on npm/);
  const checkout = spawnSync("bash", [script, "--dry-run"], { env: { ...env, SINGIT_CODEX_FROM: "checkout" }, encoding: "utf8" });
  assert.match(checkout.stdout, /cd proxy && npm install && node src\/codex.js setup/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("doctor checks file existence without creating wallet", async t => {
  const { env } = fixture(t);
  const stdout = capture();
  await main(["doctor"], { env: { ...env, PATH: "" }, stdout, fetchImpl: async () => new Response("", { status: 402 }) });
  assert.match(stdout.text, /Node:.*OK/);
  assert.match(stdout.text, /Codex on PATH: false/);
  assert.match(stdout.text, /Session wallet file exists: false/);
  assert.match(stdout.text, /Proxy \/health: false/);
  assert.match(stdout.text, /\$0.05\/call, \$2\/day/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
});

test("QR contains terminal blocks", () => {
  assert.match(terminalQr(`0x${"a".repeat(40)}`), /[█▀▄]/);
});

test("missing Codex prints official install guidance and closes proxy", async t => {
  const { env } = fixture(t);
  const stderr = capture();
  let server;
  const previousCode = process.exitCode;
  try {
    await main([], { env: { ...env, PATH: "" }, stdout: capture(), stderr, startProxyImpl: async options => {
      const proxy = await startProxy(options); server = proxy.server; return proxy;
    } });
    assert.match(stderr.text, /https:\/\/developers\.openai\.com\/codex/);
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

test("setup backs up profile and never changes base config; start preserves profile", async t => {
  const { home, env } = fixture(t);
  env.CODEX_HOME = path.join(home, "custom-codex");
  mkdirSync(env.CODEX_HOME);
  const base = path.join(env.CODEX_HOME, "config.toml");
  writeFileSync(base, 'model = "original"');
  const hash = () => createHash("sha256").update(readFileSync(base)).digest("hex");
  const before = hash();
  await main(["setup"], { env, stdout: capture() });
  const profile = profilePath(env);
  assert.match(readFileSync(profile, "utf8"), /wire_api = "responses"/);
  writeFileSync(profile, "# old profile");
  await main(["setup"], { env, stdout: capture() });
  const { readdirSync } = await import("node:fs");
  const backup = readdirSync(env.CODEX_HOME).find(file => /\.\d+\.bak$/.test(file));
  assert.equal(readFileSync(path.join(env.CODEX_HOME, backup), "utf8"), "# old profile");
  const content = readFileSync(profile, "utf8");
  const running = await main(["--no-launch"], { env, stdout: capture() });
  running.stop("SIGTERM");
  assert.equal(readFileSync(profile, "utf8"), content);
  assert.equal(hash(), before);
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

test("SIGINT and SIGTERM stop a running Codex child and the launcher", async t => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const { home, env } = fixture(t);
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    const ready = path.join(home, "ready");
    writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.READY, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const launcher = spawn(process.execPath, [fileURLToPath(new URL("../src/codex.js", import.meta.url))], {
      env: { ...env, PATH: `${bin}:${env.PATH}`, READY: ready }, stdio: "ignore",
    });
    t.after(() => launcher.kill("SIGKILL"));
    const exited = new Promise(resolve => launcher.once("exit", (code, signal) => resolve({ code, signal })));
    for (let attempt = 0; !existsSync(ready) && attempt < 200; attempt++) await delay(10);
    assert.ok(existsSync(ready), "Codex child started");
    const pid = Number(readFileSync(ready, "utf8"));
    t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } });
    launcher.kill(signal);
    const result = await Promise.race([exited, delay(5000).then(() => { throw new Error("launcher did not stop"); })]);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
  }
});

const codexFile = env => path.join(env.HOME, ".codex", "singit.config.toml");
const listing = dir => readdirSync(dir).sort();

test("uninstall restores the newest non-SingIt backup, keeps config.toml and the wallet", async t => {
  const { home, env } = fixture(t);
  const dir = path.join(home, ".codex");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "config.toml"), "model = \"base\"\n");
  writeFileSync(codexFile(env), "# user profile\n");
  await main(["setup"], { env, stdout: capture() });
  await main(["setup"], { env, stdout: capture() }); // second backup holds our own profile
  assert.match(readFileSync(codexFile(env), "utf8"), /model_providers\.singit/);
  const session = readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8");
  const stdout = capture();
  await main(["uninstall"], { env, stdout });
  assert.equal(readFileSync(codexFile(env), "utf8"), "# user profile\n");
  assert.equal(readFileSync(path.join(dir, "config.toml"), "utf8"), "model = \"base\"\n");
  assert.equal(readFileSync(path.join(env.SINGIT_HOME, "session"), "utf8"), session);
  assert.ok(listing(dir).some(name => name.endsWith(".bak")));
  assert.ok(!stdout.text.includes(JSON.parse(session).privateKey));
  assert.equal(existsSync(path.join(home, ".claude/settings.json")), false);
});

test("uninstall removes a profile we created and is a no-op when none exists", async t => {
  const { env } = fixture(t);
  const none = capture();
  await main(["uninstall"], { env, stdout: none });
  assert.match(none.text, /nothing to do/);
  assert.equal(existsSync(env.SINGIT_HOME), false);
  await main(["setup"], { env, stdout: capture() });
  assert.equal(existsSync(codexFile(env)), true);
  await main(["uninstall"], { env, stdout: capture() });
  assert.equal(existsSync(codexFile(env)), false);
  assert.equal(existsSync(path.join(env.SINGIT_HOME, "session")), true);
  assert.deepEqual(listing(path.join(env.HOME, ".codex")), []);
});

test("uninstall honours CODEX_HOME", async t => {
  const { home, env } = fixture(t);
  const custom = { ...env, CODEX_HOME: path.join(home, "alt") };
  await main(["setup"], { env: custom, stdout: capture() });
  assert.equal(existsSync(path.join(home, "alt", "singit.config.toml")), true);
  await main(["uninstall"], { env: custom, stdout: capture() });
  assert.equal(existsSync(path.join(home, "alt", "singit.config.toml")), false);
});

test("help lists uninstall", async () => {
  const stdout = capture();
  await main(["--help"], { stdout });
  assert.match(stdout.text, /uninstall/);
});
