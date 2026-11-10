import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { claudeEnv, baseBalance, main } from '../src/index.js';
import { readConfig, readStored } from '../src/config.js';
import { messageToSSE } from '../src/sse.js';
const cli = new URL('../src/index.js', import.meta.url).pathname;
function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'singit-cc-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { ...process.env, SINGIT_HOME: dir, HOME: dir, SINGIT_CC_PORT: '0', SINGIT_ASK_URL: 'http://127.0.0.1:1' };
}
const run = (args, env) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 5000 });
test('setup, doctor and start --no-launch never print the session key', async t => {
  const env = home(t);
  const setup = run(['setup', 'base'], env);
  assert.equal(setup.status, 0); assert.match(setup.stdout, /0x[0-9a-fA-F]{40}/); assert.match(setup.stdout, /USDC on Base/);
  const { privateKey } = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, 'session')));
  const doctor = run(['doctor'], env);
  assert.equal(doctor.status, 0); assert.match(doctor.stdout, /Wallet file: present/);
  const child = spawn(process.execPath, [cli, 'start', '--no-launch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('start timeout')), 5000);
    child.stdout.on('data', () => { if (out.includes('Not on npm yet')) { clearTimeout(timer); resolve(); } });
  });
  child.kill('SIGTERM'); await once(child, 'exit');
  for (const raw of [setup.stdout, setup.stderr, doctor.stdout, doctor.stderr, out, err]) assert.ok(!raw.includes(privateKey.slice(2)));
});
test('Solana setup refuses without making a wallet', async t => {
  const env = home(t);
  const r = run(['setup', 'solana'], env);
  assert.equal(r.status, 1); assert.match(r.stderr, /Solana/);
  assert.ok(!readdirSync(env.SINGIT_HOME).includes('session'));
});
test('Claude environment removes conflicting auth and wallet secrets', () => {
  const result = claudeEnv(readConfig({ env: {} }), { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_CUSTOM_HEADERS: 'secret', SINGIT_WALLET_KEY: 'secret' });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(result.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8403/api');
});
test('persistent config backs up and preserves existing settings; stats clear', async t => {
  const env = home(t);
  const file = path.join(env.HOME, '.claude', 'settings.json'); mkdirSync(path.dirname(file));
  const original = JSON.stringify({ permissions: { allow: [] }, env: { KEEP: 'yes' } }); writeFileSync(file, original);
  assert.equal(run(['config', 'set', 'sonnet-model', 'test-model'], env).status, 0);
  assert.equal(readStored(env).sonnetModel, 'test-model');
  await main(['config', 'install-persistent'], { env, fetchImpl: async () => Response.json({ default: 'catalogue-model' }) });
  const settings = JSON.parse(readFileSync(file));
  assert.equal(settings.env.KEEP, 'yes'); assert.equal(settings.env.ANTHROPIC_MODEL, 'catalogue-model');
  assert.deepEqual(settings.permissions, { allow: [] });
  const backup = readdirSync(path.dirname(file)).find(f => f.endsWith('.bak'));
  assert.equal(readFileSync(path.join(path.dirname(file), backup), 'utf8'), original);
  assert.equal(JSON.parse(run(['stats', '--clear', '--json'], env).stdout).calls, 0);
});
test('balance RPC is read-only and mockable', async () => {
  const address = `0x${'12'.repeat(20)}`;
  assert.equal(await baseBalance(address, { config: {}, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.method, 'eth_call'); assert.match(body.params[0].data, /12121212$/);
    return Response.json({ result: '0xf4240' });
  } }), 1000000n);
});
test('SSE synthesizes text and tool_use events', () => {
  const result = messageToSSE({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { city: 'Prague' } }], usage: { output_tokens: 4 }, billing: { totalAtomic: '100' } });
  const events = result.trim().split('\n\n').map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.deepEqual(events.map(e => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[2].delta.text, 'Hello');
  assert.deepEqual(JSON.parse(events[5].delta.partial_json), { city: 'Prague' });
  assert.equal(events[4].content_block.name, 'lookup'); assert.equal(events[7].billing.totalAtomic, '100');
});
test('installer dry-run exits zero without installing anything', () => {
  const result = spawnSync('bash', [new URL('../../install/singit-cc-install.sh', import.meta.url).pathname, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /Not on npm yet/); assert.match(result.stdout, /Node 20/); assert.match(result.stdout, /setup/);
});
test('start launches Claude with resolved models, clean auth and forwarded arguments', async t => {
  const env = home(t);
  const bin = path.join(env.HOME, 'bin'); mkdirSync(bin);
  const record = path.join(env.HOME, 'child.json');
  const fake = path.join(bin, 'claude');
  writeFileSync(fake, `#!${process.execPath}
import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL,
  model: process.env.ANTHROPIC_MODEL, sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  token: process.env.ANTHROPIC_AUTH_TOKEN, staleKey: !!process.env.ANTHROPIC_API_KEY,
  staleOAuth: !!process.env.CLAUDE_CODE_OAUTH_TOKEN, walletKey: !!process.env.SINGIT_WALLET_KEY
})));\n`);
  chmodSync(fake, 0o700);
  const child = spawn(process.execPath, [cli, 'start', '--model', 'test-model', '--', '--print', 'Hello'], {
    env: { ...env, PATH: `${bin}:${env.PATH}`, ANTHROPIC_API_KEY: 'stale-secret', CLAUDE_CODE_OAUTH_TOKEN: 'stale-secret' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, output);
  const captured = JSON.parse(readFileSync(record));
  assert.deepEqual(captured.args, ['--print', 'Hello']);
  assert.match(captured.base, /^http:\/\/127\.0\.0\.1:\d+\/api$/);
  assert.equal(captured.model, 'test-model'); assert.equal(captured.sonnet, 'test-model');
  assert.equal(captured.token, 'singit-proxy-handles-auth');
  assert.equal(captured.staleKey, false); assert.equal(captured.staleOAuth, false); assert.equal(captured.walletKey, false);
  const session = JSON.parse(readFileSync(path.join(env.SINGIT_HOME, 'session')));
  assert.ok(!output.includes(session.privateKey.slice(2))); assert.ok(!output.includes('stale-secret'));
});
