#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isMain } from "./is-main.js";
import { sessionPath } from "@singitai/session-wallet";
import { startProxy, VERSION } from "./server.js";
import { readConfig } from "./config.js";

import path from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { newestBackup, printWallet } from "./cc.js";

export function installerEnv(env = process.env) {
  return { SINGIT_MAX_PER_CALL_USD: "0.05", SINGIT_MAX_PER_DAY_USD: "2", SINGIT_CLIENT: "codex", SINGIT_NETWORK: "base", ...env };
}
export function codexEnv(env) {
  const child = { ...env };
  delete child.SINGIT_WALLET_KEY;
  return child;
}
export function profilePath(env) {
  return path.join(env.CODEX_HOME || path.join(env.HOME || homedir(), ".codex"), "singit.config.toml");
}
export function writeProfile(env, port, overwrite = false) {
  const file = profilePath(env);
  if (existsSync(file)) {
    if (!overwrite) return;
    let timestamp = Date.now();
    while (existsSync(`${file}.${timestamp}.bak`)) timestamp++;
    copyFileSync(file, `${file}.${timestamp}.bak`, constants.COPYFILE_EXCL);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# Use: codex --profile singit
model = "singit/auto"
model_provider = "singit"

[model_providers.singit]
name = "SingIt"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false

[mcp_servers.singit]
url = "https://app.singitai.app/mcp"
bearer_token_env_var = "SINGIT_API_KEY"
startup_timeout_sec = 15
`, { mode: 0o600 });
}
export function uninstallProfile(env, { renameImpl = renameSync } = {}) {
  const file = profilePath(env);
  if (!existsSync(file)) return "none";
  const backup = newestBackup(file, text => text.includes("[model_providers.singit]"));
  if (!backup) { rmSync(file); return "removed"; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    copyFileSync(backup, temporary, constants.COPYFILE_EXCL);
    renameImpl(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return "restored";
}
export function hasCodex(env) {
  return !spawnSync("codex", ["--version"], { env: codexEnv(env), stdio: "ignore", timeout: 5000 }).error;
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch, startProxyImpl = startProxy } = {}) {
  const split = argv.indexOf("--");
  const options = split < 0 ? argv : argv.slice(0, split);
  const forwarded = split < 0 ? [] : argv.slice(split + 1);
  const command = options[0]?.startsWith("-") ? "start" : (options[0] || "start");
  if (options.includes("--help")) {
    stdout.write("Usage: singit-codex [start|setup|doctor|uninstall] [--no-launch] [--client label] [-- ...codex arguments]\nUses the one @singitai/proxy on 127.0.0.1:8787; Base only.\nuninstall: restores the newest singit.config.toml.<ts>.bak or removes the SingIt profile; config.toml and the wallet are never touched.\nTo remove the package too: npm uninstall -g @singitai/proxy\n");
    return;
  }
  if (options.includes("--version")) { stdout.write(`${VERSION}\n`); return; }
  if (!["start", "setup", "doctor", "uninstall"].includes(command)) throw new Error("Unknown command. Use --help.");
  if (command === "uninstall") {
    const result = uninstallProfile(env);
    stdout.write(`${{ none: "No SingIt profile found; nothing to do.", removed: "Removed the SingIt profile (no earlier backup).", restored: "Restored the previous singit.config.toml from backup." }[result]}\nconfig.toml and the wallet in ~/.singit/session were left in place.\nTo remove the package: npm uninstall -g @singitai/proxy\n`);
    return;
  }
  const configured = installerEnv(env);
  const clientIndex = options.indexOf("--client");
  if (clientIndex >= 0) {
    if (!options[clientIndex + 1]) throw new Error("--client requires a label.");
    configured.SINGIT_CLIENT = options[clientIndex + 1];
  }
  const config = readConfig({ env: configured });
  if (config.network !== "base") throw new Error("singit-codex supports Base only. Set SINGIT_NETWORK=base.");
  if (config.host !== "127.0.0.1") throw new Error("singit-codex requires SINGIT_PROXY_HOST=127.0.0.1.");
  if (command === "doctor") {
    let healthy = false;
    try { healthy = (await fetchImpl(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* unavailable */ }
    stdout.write(`Node: ${process.version} (${Number(process.versions.node.split(".")[0]) >= 20 ? "OK" : "need 20+"})\nCodex on PATH: ${hasCodex(configured)}\nSession wallet file exists: ${existsSync(sessionPath(configured))}\nProxy /health: ${healthy}\nSingIt profile: ${existsSync(profilePath(configured)) && readFileSync(profilePath(configured), "utf8").includes("[model_providers.singit]")}\nCaps: $${config.maxPerCallUsd}/call, $${config.maxPerDayUsd}/day\n`);
    return;
  }
  if (command === "setup") { printWallet(configured, stdout); writeProfile(configured, config.port, true); return; }
  const { server } = await startProxyImpl({ env: configured, fetchImpl, argv: [] });
  let child;
  let stopping = false;
  const cleanup = () => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  };
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    server.close();
    server.closeAllConnections?.();
    cleanup();
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  server.once("close", cleanup);
  try {
    writeProfile(configured, server.address().port);
    printWallet(configured, stdout);
    if (options.includes("--no-launch")) return { server, stop };
    child = spawn("codex", ["--profile", "singit", ...forwarded], { stdio: "inherit", env: codexEnv(configured) });
    await new Promise(resolve => {
      child.once("error", error => {
        stderr.write(error.code === "ENOENT" ? "Install Codex using the official guidance: https://developers.openai.com/codex or use --no-launch.\n" : "Could not launch Codex.\n");
        process.exitCode = 1;
        resolve();
      });
      child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); resolve(); });
    });
  } catch (error) {
    stop("SIGTERM");
    throw error;
  } finally {
    if (!options.includes("--no-launch")) stop("SIGTERM");
  }
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    // Upstream errors can contain sensitive configuration; never echo them.
    process.stderr.write("singit-codex could not start. Check Node 20+, Base configuration, port, and wallet permissions; use --help.\n");
    process.exitCode = 1;
  });
}
