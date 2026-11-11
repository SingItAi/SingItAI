#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sessionPath } from "@singitai/session-wallet";
import { startProxy, VERSION } from "./server.js";
import { readConfig } from "./config.js";

import path from "node:path";
import { homedir } from "node:os";
import { printWallet } from "./cc.js";

export function installerEnv(env = process.env) {
  return { SINGIT_MAX_PER_CALL_USD: "0.05", SINGIT_MAX_PER_DAY_USD: "2", SINGIT_CLIENT: "openclaw", SINGIT_NETWORK: "base", ...env };
}
export function openclawEnv(env) {
  const child = { ...env };
  delete child.SINGIT_WALLET_KEY;
  return child;
}
export function profilePath(env) {
  return path.join(env.OPENCLAW_HOME || path.join(env.HOME || homedir(), ".openclaw"), "openclaw.json");
}
export function provider(port) {
  return { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", auth: "none", models: [{ id: "auto", name: "SingIt Auto (x402)" }, { id: "free", name: "SingIt Free tier" }] };
}
export function writeProfile(env, port, overwrite = false, { defaultModel = false, mcp = true } = {}, { renameImpl = renameSync } = {}) {
  const file = profilePath(env);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const present = data.models?.providers?.singit;
  if (present && !overwrite && !defaultModel) return;
  data.models ??= {};
  data.models.mode = "merge";
  data.models.providers ??= {};
  if (overwrite || !present) data.models.providers.singit = provider(port);
  if (defaultModel) {
    data.agents ??= {}; data.agents.defaults ??= {}; data.agents.defaults.model ??= {};
    data.agents.defaults.model.primary = "singit/auto";
  }
  if (mcp) {
    data.mcp ??= {}; data.mcp.servers ??= {};
    data.mcp.servers.singit = { url: "https://app.singitai.app/mcp", transport: "streamable-http" };
  }
  mkdirSync(path.dirname(file), { recursive: true });
  let backup;
  if (existsSync(file)) {
    let timestamp = Date.now();
    while (existsSync(`${file}.${timestamp}.bak`)) timestamp++;
    backup = `${file}.${timestamp}.bak`;
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameImpl(temporary, file);
  } catch (error) {
    if (backup) {
      copyFileSync(backup, temporary);
      renameSync(temporary, file);
    }
    throw error;
  } finally { rmSync(temporary, { force: true }); }
}
export function validProfile(env, port) {
  try {
    const p = JSON.parse(readFileSync(profilePath(env), "utf8")).models?.providers?.singit;
    return p?.baseUrl === provider(port).baseUrl && p?.api === "openai-completions" && p?.auth === "none";
  } catch { return false; }
}
export function hasOpenClaw(env) {
  return !spawnSync("openclaw", ["--version"], { env: openclawEnv(env), stdio: "ignore", timeout: 5000 }).error;
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch, startProxyImpl = startProxy } = {}) {
  const split = argv.indexOf("--");
  const options = split < 0 ? argv : argv.slice(0, split);
  const forwarded = split < 0 ? [] : argv.slice(split + 1);
  const command = options[0]?.startsWith("-") ? "start" : (options[0] || "start");
  if (options.includes("--help")) {
    stdout.write("Usage: singit-openclaw [start|setup|doctor] [--no-launch] [--client label] [--default-model] [--mcp|--no-mcp] [-- ...openclaw arguments]\nNot on npm yet. Uses the existing @singitai/proxy; Base only.\n");
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
  const writeOptions = { defaultModel: options.includes("--default-model"), mcp: !options.includes("--no-mcp") };
  const config = readConfig({ env: configured });
  if (config.network !== "base") throw new Error("singit-openclaw supports Base only. Set SINGIT_NETWORK=base.");
  if (config.host !== "127.0.0.1") throw new Error("singit-openclaw requires SINGIT_PROXY_HOST=127.0.0.1.");
  if (command === "doctor") {
    let healthy = false;
    try { healthy = (await fetchImpl(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* unavailable */ }
    stdout.write(`Node: ${process.version} (${Number(process.versions.node.split(".")[0]) >= 20 ? "OK" : "need 20+"})\nOpenClaw on PATH: ${hasOpenClaw(configured)}\nSession wallet file exists: ${existsSync(sessionPath(configured))}\nProxy /health: ${healthy}\nSingIt profile: ${validProfile(configured, config.port)}\nCaps: $${config.maxPerCallUsd}/call, $${config.maxPerDayUsd}/day\n`);
    return;
  }
  if (command === "setup") { printWallet(configured, stdout); writeProfile(configured, config.port, true, writeOptions); stdout.write("SINGIT_API_KEY is only needed for paid MCP tools.\n"); return; }
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
    writeProfile(configured, server.address().port, false, writeOptions);
    stdout.write("SINGIT_API_KEY is only needed for paid MCP tools.\n");
    printWallet(configured, stdout);
    if (options.includes("--no-launch")) return { server, stop };
    child = spawn("openclaw", forwarded, { stdio: "inherit", env: openclawEnv(configured) });
    await new Promise(resolve => {
      child.once("error", error => {
        stderr.write(error.code === "ENOENT" ? "Install OpenClaw using the official guidance: https://docs.openclaw.ai or use --no-launch.\n" : "Could not launch OpenClaw.\n");
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
    process.stderr.write("singit-openclaw could not start. Check Node 20+, Base configuration, port, and wallet permissions; use --help.\n");
    process.exitCode = 1;
  });
}
