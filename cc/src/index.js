#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOrCreateWallet, sessionPath } from '@singitai/session-wallet';
import { NETWORKS } from '@singitai/sdk';
import { readConfig, parseArgs, assertNetworkAllowed, readStored, writeStored, configKey, CONFIG_KEYS, VERSION } from './config.js';
import { startProxy, fundingHint, createProxy } from './server.js';
import { readLedger, clearLedger, usd } from './ledger.js';
import { withClientHeader } from './headers.js';

export function claudeEnv(config, env = process.env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_(OAUTH|API|USE_|CUSTOM_HEADERS|AUTH))/i.test(key) || key === 'SINGIT_WALLET_KEY') delete cleaned[key];
  }
  return { ...cleaned, ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}/api`,
    ANTHROPIC_AUTH_TOKEN: 'singit-proxy-handles-auth', ANTHROPIC_MODEL: config.defaultModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.sonnetModel, ANTHROPIC_DEFAULT_OPUS_MODEL: config.opusModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.haikuModel };
}
export async function baseBalance(address, { config, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(config.rpcUrl || NETWORKS.base.defaultRpcUrl, { method: 'POST',
    signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: NETWORKS.base.asset,
      data: `0x70a08231${address.slice(2).padStart(64, '0')}` }, 'latest'] }) });
  const body = await r.json();
  if (!r.ok || !/^0x[0-9a-f]+$/i.test(body.result)) throw new Error('RPC unavailable');
  return BigInt(body.result);
}
export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  const { flags, positional, passthrough } = parseArgs(argv);
  const [command = 'start', action, key, value] = positional;
  if (flags.version) return console.log(VERSION);
  if (flags.help) return console.log('singit-cc: setup [base|solana], start [--no-launch --model ID --port N --no-fallback], models, balance, stats [--json|--clear], config set KEY VALUE|list|install-persistent, doctor');
  const config = readConfig({ env, flags });
  if (command === 'setup') {
    const network = CONFIG_KEYS.network(action || config.network);
    await assertNetworkAllowed(network, { askUrl: config.askUrl, fetchImpl });
    console.log(`Wallet: ${loadOrCreateWallet(env).address}\n${fundingHint}`);
  } else if (command === 'start') {
    const proxy = await startProxy({ env, fetchImpl, flags });
    console.log(`singit-cc/${VERSION} listening on http://127.0.0.1:${proxy.config.port}/api`);
    console.log(`Caps: $${config.maxPerCallUsd}/call, $${config.maxPerDayUsd}/day (UTC).`);
    console.log('Not on npm yet: run from the SingItAI checkout.');
    const stop = () => proxy.server.close();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (!flags['no-launch']) {
      try {
        const resolved = { ...proxy.config };
        for (const name of ['defaultModel', 'sonnetModel', 'opusModel', 'haikuModel']) resolved[name] = await proxy.resolveModel(resolved[name]);
        const child = spawn('claude', passthrough, { stdio: 'inherit', env: claudeEnv(resolved, env) });
        child.once('error', () => { console.error('Could not launch claude. Install Claude Code or use --no-launch.'); process.exitCode = 1; stop(); });
        child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); stop(); });
        const forward = signal => { child.kill(signal); stop(); };
        process.once('SIGINT', () => forward('SIGINT')); process.once('SIGTERM', () => forward('SIGTERM'));
      } catch (error) { stop(); throw error; }
    }
    return proxy;
  } else if (command === 'models') {
    const r = await withClientHeader(fetchImpl, { client: config.client, version: VERSION })(`${config.askUrl}/v1/models`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Catalogue returned HTTP ${r.status}`);
    for (const model of (await r.json()).data || []) console.log(model.id);
  } else if (command === 'balance') {
    await assertNetworkAllowed(config.network, { askUrl: config.askUrl, fetchImpl });
    const { address } = loadOrCreateWallet(env);
    try { const atomic = await baseBalance(address, { config, fetchImpl }); console.log(`${address}: ${atomic / 1000000n}.${(atomic % 1000000n).toString().padStart(6, '0')} USDC on Base`); }
    catch { console.log(`${address}: balance unknown (RPC unavailable).`); }
  } else if (command === 'stats') {
    if (flags.clear) clearLedger(env);
    const ledger = readLedger(env);
    console.log(flags.json ? JSON.stringify(ledger, null, 2) : `${ledger.calls} calls, ${usd(ledger.totalAtomic)} USDC\n${Object.entries(ledger.byModel).map(([m, row]) => `${m}: ${row.calls} calls, ${usd(row.atomic)}`).join('\n')}`);
  } else if (command === 'config') {
    if (action === 'set') {
      const name = configKey(key);
      writeStored({ ...readStored(env), [name]: CONFIG_KEYS[name](value) }, env);
      console.log(`Saved ${name}.`);
    } else if (action === 'list') console.log(JSON.stringify(config, null, 2));
    else if (action === 'install-persistent') {
      const file = path.join(env.HOME || os.homedir(), '.claude', 'settings.json');
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      let settings = {};
      if (existsSync(file)) {
        settings = JSON.parse(readFileSync(file, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be an object.');
        const backup = `${file}.${Date.now()}.bak`;
        copyFileSync(file, backup, 1); // COPYFILE_EXCL: never overwrite a backup
        console.log(`Backup: ${backup}`);
      }
      const model = await createProxy({ env, config, fetchImpl }).resolveModel(config.defaultModel);
      const childEnv = claudeEnv({ ...config, defaultModel: model }, {});
      settings.env = { ...settings.env, ANTHROPIC_BASE_URL: childEnv.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: childEnv.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL: model };
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      console.log('Persistent configuration installed. Keep singit-cc start --no-launch running; clear conflicting Claude auth environment variables.');
    } else throw new Error('Use config set KEY VALUE, list, or install-persistent.');
  } else if (command === 'doctor') {
    let healthy = false;
    try { const r = await fetchImpl(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) }); healthy = r.ok && (await r.json()).name === 'singit-cc'; } catch { /* offline */ }
    const claude = spawnSync('claude', ['--version'], { env: claudeEnv(config, env), timeout: 3000, stdio: 'ignore' });
    console.log(`Node: ${process.version} (requires 20+)\nProxy: ${healthy ? 'reachable' : 'offline; run start --no-launch'}\nWallet file: ${existsSync(sessionPath(env)) ? 'present' : 'absent; run setup base'}\nClaude on PATH: ${!claude.error ? 'yes' : 'no; install Claude Code'}`);
  } else throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`singit-cc: ${error.message}`); process.exitCode = 1; });
}
