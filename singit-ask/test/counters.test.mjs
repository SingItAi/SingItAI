import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as countersMain } from '../scripts/ask-counters.mjs';
import { parseOwnPayers } from '../src/own-payers.mjs';
import { HealthStats, privateStatsBody, numbersBody, HOUR } from '../src/health-stats.mjs';
import { createApp, ROUTE, BASE, SOLANA } from '../src/app.mjs';
const own = '0x' + 'a'.repeat(40), external = '0x' + 'b'.repeat(40);
const settle = (s, payer) => s.recordSettlement({ route: ROUTE, network: BASE, ok: true, amount: '1000', payer });
test('own parser trims, comments, dedupes EVM but preserves base58 case', () => {
  assert.deepEqual(parseOwnPayers(` # comment\n ${own.toUpperCase()} # inline\n${own}\n\nFakeBase58Abc\nFakeBase58abc\nFakeBase58Abc`), [own, 'FakeBase58Abc', 'FakeBase58abc']);
});
test('retroactive unique removal persists; CLI is read-only and hides identifiers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-counters-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'stats.json'), ownFile = join(dir, 'own.txt');
  const s = new HealthStats({ file }); settle(s, own); settle(s, external); s.flush();
  const before = readFileSync(file, 'utf8'), mtime = statSync(file).mtimeMs;
  writeFileSync(ownFile, own);
  const env = { ...process.env, SINGIT_ASK_STATS_FILE: file, SINGIT_ASK_OWN_PAYERS_FILE: ownFile };
  let output; countersMain({ env, args: [], print: value => { output = value; } });
  const body = JSON.parse(output); assert.equal(body.external_payers.unique.total, 1);
  assert.equal(body.external_payers.paid_calls.total, 2);
  assert.doesNotMatch(output, /[a-f0-9]{16}/); assert.ok(!output.includes(own) && !output.includes(external));
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(statSync(file).mtimeMs, mtime);
  countersMain({ env, args: ['--text'], print: value => { output = value; } });
  assert.match(output, /Own payers configured: true/);
  const updated = new HealthStats({ file, ownPayers: [own] }); assert.equal(updated.numbers().total.unique, 1);
  assert.ok(updated.timer); updated.flush();
  const reload = new HealthStats({ file, ownPayers: [own] }); assert.equal(reload.numbers().day.unique, 1); assert.equal(reload.timer, undefined);
});
test('402 windows, caps, safe keys, old files and malformed counters', t => {
  let now = Date.UTC(2026, 9, 31);
  const s = new HealthStats({ now: () => now, isPaidRoute: () => true });
  s.recordChallenge({ route: '/__proto__', method: 'POST', challenge: true });
  s.recordChallenge({ route: '__proto__', method: 'GET', challenge: true });
  s.recordChallenge({ route: '/refused', method: 'POST', challenge: false });
  assert.equal(s.state.c402.routes['/__proto__'], 1); assert.equal(s.state.c402.routes.other, 1);
  for (let i = 0; i < 110; i++) s.recordChallenge({ route: `/route-${i}`, method: 'HEAD', challenge: true });
  assert.equal(Object.keys(s.state.c402.routes).length, 100);
  assert.equal(privateStatsBody(s).issued_402.total.all, 113);
  now += 25 * HOUR; assert.equal(privateStatsBody(s).issued_402.last_24h.all, 0); assert.equal(privateStatsBody(s).issued_402.last_7d.all, 113);
  now += 168 * HOUR; assert.equal(privateStatsBody(s).issued_402.last_7d.all, 0);
  const dir = mkdtempSync(join(tmpdir(), 'ask-old-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'stats.json'); const fresh = new HealthStats(); settle(fresh, external);
  delete fresh.state.c402; for (const b of Object.values(fresh.state.buckets)) delete b.c402;
  writeFileSync(file, JSON.stringify(fresh.state)); const loaded = new HealthStats({ file }); assert.equal(loaded.numbers().total.calls, 1);
  loaded.recordChallenge({ route: '/x', method: 'POST', challenge: true }); loaded.file = null;
  const old = JSON.parse(readFileSync(file));
  for (const bad of [{ post: -1, probe: 0, refused: 0, routes: {} }, { post: 0, probe: 0, refused: 0, routes: { '/x': '1' } }, []]) {
    writeFileSync(file, JSON.stringify({ ...old, c402: bad })); assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
    const bucket = Object.keys(old.buckets)[0]; writeFileSync(file, JSON.stringify({ ...old, buckets: { [bucket]: { ...old.buckets[bucket], c402: bad } } }));
    assert.equal(new HealthStats({ file }).numbers().total.calls, 0);
  }
});
const config = { payToBase: '0x' + 'a'.repeat(40), payToSolana: 'A'.repeat(43), model: 'fake-model' };
const facilitator = { async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }, { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: 'A'.repeat(43) } }, { x402Version: 2, scheme: 'upto', network: BASE, extra: { facilitatorAddress: '0x' + 'c'.repeat(40) } }, { x402Version: 2, scheme: 'upto', network: SOLANA, extra: { feePayer: 'A'.repeat(43), receiverAuthorizer: 'B'.repeat(43) } }], extensions: [], signers: {} }; } };
async function serve(t, token) {
  const app = createApp({ ...config, statsToken: token }, { facilitatorClient: facilitator, catalogue: null, log: () => {}, fetchImpl: () => { throw Error('offline'); } });
  // Insert test refusal before the app's final 404 handler, exercising the production observer.
  const stack = app.router.stack; const fallback = stack.pop();
  app.post('/test-refusal', (_req, res) => res.status(402).json({ error: { code: 'payment_failed' } })); stack.push(fallback);
  const server = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); }); t.after(() => server.close());
  return { app, url: `http://127.0.0.1:${server.address().port}` };
}
test('private endpoint auth, public shape and finish middleware challenges', async t => {
  const token = 'test-token-'.repeat(4), { app, url } = await serve(t, token);
  for (const authorization of ['', 'Bearer wrong']) assert.equal((await fetch(`${url}/internal/stats`, { headers: { authorization } })).status, 401);
  assert.equal((await fetch(`${url}/unknown`)).status, 404);
  assert.equal((await fetch(`${url}${ROUTE}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 402);
  assert.equal((await fetch(`${url}${ROUTE}`)).status, 402);
  assert.equal((await fetch(`${url}/test-refusal`, { method: 'POST' })).status, 402);
  settle(app.locals.healthStats, external);
  const response = await fetch(`${url}/internal/stats`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const text = await response.text(), b = JSON.parse(text);
  assert.deepEqual(b.issued_402.total, { post: 1, probe: 1, refused: 1, all: 3 }); assert.equal(b.issued_402.by_route.total[ROUTE], 2);
  assert.doesNotMatch(text, /[a-f0-9]{16}/); assert.ok(!text.includes(own) && !text.includes(external));
  const numbers = await (await fetch(`${url}/numbers.json`)).json(); assert.equal(numbers.own_payers_configured, false); assert.equal(numbers.issued_402, undefined);
  assert.equal(numbersBody(app.locals.healthStats).own_payers_configured, false);
  const doc = await (await fetch(`${url}/openapi.json`)).json(); assert.equal(doc.paths['/internal/stats'], undefined);
  assert.equal(doc.paths['/numbers.json'].get.responses[200].content['application/json'].schema.properties.own_payers_configured.type, 'boolean');
});
test('private route absent without valid token', async t => {
  for (const token of [undefined, 'short']) { const { url } = await serve(t, token); assert.equal((await fetch(`${url}/internal/stats`)).status, 404); }
});

test('private auth, observer and public schemas offline without sockets', async () => {
  const { EventEmitter } = await import('node:events');
  const { generateOpenapi } = await import('../scripts/generate-openapi.mjs');
  const token = 'fake-token-'.repeat(4);
  const app = createApp({ ...config, statsToken: token }, { facilitatorClient: facilitator, catalogue: null, log() {} });
  const stats = app.locals.healthStats;
  settle(stats, external);
  const observer = app.router.stack[1].handle;
  for (const [method, challenge, statusCode, path] of [['POST', true, 402, ROUTE], ['GET', true, 402, ROUTE], ['HEAD', true, 402, ROUTE], ['POST', false, 402, '/unknown'], ['GET', false, 404, '/unknown']]) {
    const res = Object.assign(new EventEmitter(), { statusCode, hasHeader: () => challenge });
    observer({ method, path }, res, () => {}); res.emit('finish');
  }
  const route = app.router.stack.find(l => l.route?.path === '/internal/stats').route.stack[0].handle;
  const read = authorization => {
    const headers = {}; let status = 200, body;
    route({ get: () => authorization }, { set(k, v) { headers[k] = v; return this; }, status(n) { status = n; return this; }, json(b) { body = b; } });
    return { status, body, headers };
  };
  for (const auth of [undefined, 'Bearer wrong']) assert.equal(read(auth).status, 401);
  const { status, body, headers } = read(`Bearer ${token}`);
  assert.equal(status, 200); assert.equal(headers['Cache-Control'], 'no-store'); assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  assert.deepEqual(body.issued_402.total, { post: 1, probe: 2, refused: 1, all: 4 });
  assert.equal(body.issued_402.by_route.total[ROUTE], 3);
  assert.doesNotMatch(JSON.stringify(body), /[a-f0-9]{16}/);
  assert.equal(numbersBody(stats).issued_402, undefined);
  stats.recordChallenge = () => { throw Error('ignored'); };
  const response = Object.assign(new EventEmitter(), { statusCode: 402, hasHeader: () => true });
  observer({ method: 'POST', path: ROUTE }, response, () => {}); assert.doesNotThrow(() => response.emit('finish'));
  for (const statsToken of [undefined, 'short']) {
    const a = createApp({ ...config, statsToken }, { facilitatorClient: facilitator, catalogue: null, log() {} });
    assert.equal(a.router.stack.some(l => l.route?.path === '/internal/stats'), false);
  }
  const doc = await generateOpenapi(); assert.equal(doc.paths['/internal/stats'], undefined);
  assert.equal(doc.paths['/numbers.json'].get.responses[200].content['application/json'].schema.properties.own_payers_configured.type, 'boolean');
});

test('issued challenges survive persistence and retain only 720 hourly buckets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-challenges-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'stats.json'); let now = Date.UTC(2026, 9, 31);
  const s = new HealthStats({ file, now: () => now, isPaidRoute: r => r === ROUTE });
  s.recordChallenge({ route: ROUTE, method: 'POST', challenge: true }); s.flush();
  const loaded = new HealthStats({ file, now: () => now });
  assert.deepEqual(privateStatsBody(loaded).issued_402, privateStatsBody(s).issued_402);
  assert.equal(loaded.timer, undefined);
  now += 720 * HOUR;
  loaded.recordChallenge({ route: '/unknown', method: 'POST', challenge: false }); loaded.flush();
  assert.equal(Object.keys(loaded.state.buckets).length, 1);
  assert.equal(privateStatsBody(loaded).issued_402.total.all, 2);
  const readOnly = new HealthStats({ file, readOnly: true, now: () => now });
  const before = readFileSync(file, 'utf8'); readOnly.recordChallenge({ method: 'GET', challenge: true }); readOnly.flush();
  assert.equal(readOnly.timer, null); assert.equal(readFileSync(file, 'utf8'), before);
});
