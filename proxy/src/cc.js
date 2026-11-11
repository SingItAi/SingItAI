#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadOrCreateWallet, sessionPath } from "@singitai/session-wallet";
import { startProxy, VERSION } from "./server.js";
import { readConfig } from "./config.js";
import { terminalQr } from "./qr.js";

export const MODEL_ENV = {
  ANTHROPIC_MODEL: "deepseek-v4.1-flash",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5.5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5.5",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5.5",
  ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash",
};

export function installerEnv(env = process.env) {
  return { SINGIT_MAX_PER_CALL_USD: "0.05", SINGIT_MAX_PER_DAY_USD: "2", SINGIT_CLIENT: "claude-code", SINGIT_NETWORK: "base", ...env };
}

export function claudeEnv(env, port = 8787) {
  const child = { ...env };
  for (const name of Object.keys(child)) {
    if (name.startsWith("CLAUDE_CODE_OAUTH") || (name.startsWith("ANTHROPIC_") && !Object.hasOwn(MODEL_ENV, name)) || name === "SINGIT_WALLET_KEY") delete child[name];
  }
  for (const [name, value] of Object.entries(MODEL_ENV)) child[name] ??= value;
  child.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  child.ANTHROPIC_AUTH_TOKEN = "singit-proxy-handles-auth";
  child.ANTHROPIC_API_KEY = "singit-proxy-handles-auth";
  return child;
}

export function backupClaudeSettings(file) {
  if (!existsSync(file)) return null;
  const backup = `${file}.${Date.now()}.bak`;
  copyFileSync(file, backup, constants.COPYFILE_EXCL);
  return backup;
}

export function restoreClaudeSettings(backup, file) {
  if (backup) copyFileSync(backup, file);
}

export function printWallet(env, stdout = process.stdout) {
  const { address } = loadOrCreateWallet(env);
  stdout.write(`${address}\nTop up with USDC on Base (eip155:8453). The facilitator pays gas; no ETH needed.\n${terminalQr(address)}`);
}

export function hasClaude(env) {
  return !spawnSync("claude", ["--version"], { env: claudeEnv(env), stdio: "ignore", timeout: 5000 }).error;
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch, startProxyImpl = startProxy } = {}) {
  const split = argv.indexOf("--");
  const options = split < 0 ? argv : argv.slice(0, split);
  const forwarded = split < 0 ? [] : argv.slice(split + 1);
  const command = options[0]?.startsWith("-") ? "start" : (options[0] || "start");
  if (options.includes("--help")) {
    stdout.write("Usage: singit-cc [start|setup|doctor] [--no-launch] [--client label] [-- ...claude arguments]\nNot on npm yet. Uses the existing @singitai/proxy; Base only.\n");
    return;
  }
  if (options.includes("--version")) { stdout.write(`${VERSION}\n`); return; }
  if (!["start", "setup", "doctor"].includes(command)) throw new Error("Unknown command. Use --help.");
  const configured = installerEnv(env);
  const clientIndex = options.indexOf("--client");
  if (clientIndex >= 0) {
    if (!options[clientIndex + 1]) throw new Error("--client requires a label.");
    configured.SINGIT_CLIENT = options[clientIndex + 1];
  }
  const config = readConfig({ env: configured });
  if (config.network !== "base") throw new Error("singit-cc supports Base only. Set SINGIT_NETWORK=base.");
  if (config.host !== "127.0.0.1") throw new Error("singit-cc requires SINGIT_PROXY_HOST=127.0.0.1.");
  if (command === "doctor") {
    let healthy = false;
    try { healthy = (await fetchImpl(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* unavailable */ }
    stdout.write(`Node: ${process.version} (${Number(process.versions.node.split(".")[0]) >= 20 ? "OK" : "need 20+"})\nClaude on PATH: ${hasClaude(configured)}\nSession wallet file exists: ${existsSync(sessionPath(configured))}\nProxy /health: ${healthy}\nCaps: $${config.maxPerCallUsd}/call, $${config.maxPerDayUsd}/day\n`);
    return;
  }
  if (command === "setup") { printWallet(configured, stdout); return; }
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
    printWallet(configured, stdout);
    if (options.includes("--no-launch")) return { server, stop };
    child = spawn("claude", forwarded, { stdio: "inherit", env: claudeEnv(configured, server.address().port) });
    await new Promise(resolve => {
      child.once("error", error => {
        stderr.write(error.code === "ENOENT" ? "Install Claude Code using the official installer: https://claude.ai/install.sh or use --no-launch.\n" : "Could not launch Claude Code.\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Upstream errors can contain sensitive configuration; never echo them.
    process.stderr.write("singit-cc could not start. Check Node 20+, Base configuration, port, and wallet permissions; use --help.\n");
    process.exitCode = 1;
  });
}
