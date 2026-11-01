import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalogue, markUnservable, NEVER_HIDE } from '../src/catalogue.mjs';
const minute = 60000;
function fixture(options = {}) {
  let now = 1000000;
  const c = new ModelCatalogue({ url: 'unused', now: () => now, suspensionsFile: null, ...options });
  return { c, advance: ms => { now += ms; } };
}
test('consecutive rejection backoff, explicit trials and successful recovery', async () => {
  const { c, advance } = fixture();
  c.noteRejected('model');
  assert.equal(c.rejections.get('model').count, 1);
  assert.equal(c.isSuspended('model'), false);
  assert.equal(c.unservable.get('model') - c.now(), 15 * minute);
  advance(15 * minute);
  assert.equal(await c.listable('model'), true);
  for (const duration of [30, 60, 120, 120]) {
    c.noteRejected('model');
    assert.equal(c.isSuspended('model'), true);
    assert.equal(await c.listable('model'), false);
    assert.equal(await c.canAnswer('model'), false);
    assert.equal(c.unservable.get('model') - c.now(), duration * minute);
    assert.ok(c.unservableRetryAfter('model') <= 3600);
    advance(duration * minute);
    assert.equal(await c.canAnswer('model'), true);
    assert.equal(await c.listable('model'), false);
  }
  c.noteAnswered('model');
  assert.equal(await c.listable('model'), true);
  c.noteRejected('model');
  assert.equal(c.isSuspended('model'), false);
});
test('other errors do not count and never-hide models retain the base TTL', () => {
  const { c } = fixture({ neverHide: ['default', 'tier'] });
  for (const code of ['minimum_discount_not_met', '429', 'timeout']) markUnservable(c, 'model', { code }, () => {});
  assert.equal(c.rejections.size, 0);
  for (const id of [...NEVER_HIDE, 'default', 'tier']) {
    for (let n = 0; n < 5; n++) c.noteRejected(id);
    assert.equal(c.isSuspended(id), false);
    assert.equal(c.unservable.get(id) - c.now(), 15 * minute);
  }
});
test('persistence restores suspension and ignores expired marks and invalid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-suspensions-'));
  const file = join(dir, 'state.json');
  try {
    const { c } = fixture({ suspensionsFile: file });
    c.noteRejected('model'); c.noteRejected('model');
    await new Promise(resolve => setTimeout(resolve, 60));
    await c.suspensionsWrite;
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.model.count, 2);
    const restored = fixture({ suspensionsFile: file }).c;
    assert.equal(restored.isSuspended('model'), true);
    assert.equal(restored.isUnservable('model'), true);
    const expired = new ModelCatalogue({ url: 'unused', now: () => 1e12, suspensionsFile: file });
    assert.equal(expired.isSuspended('model'), true);
    assert.equal(expired.isUnservable('model'), false);
    for (const value of ['bad', JSON.stringify({ model: { ...stored.model, count: '2' } }), ' '.repeat(200001)]) {
      await writeFile(file, value);
      assert.equal(fixture({ suspensionsFile: file }).c.rejections.size, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('accepted seller changes release; identical sellers retain suspension', async () => {
  const { c } = fixture();
  c.models = new Map(['model', 'other'].map(id => [id, { id }]));
  c.rawModels = c.models;
  c.served = new Set(c.models.keys());
  c.sellers.set('model', new Set(['seller']));
  c.noteRejected('model'); c.noteRejected('model');
  let provider = 'seller', absent = false;
  c.fetchImpl = async url => ({ ok: true, json: async () => ({ offers: absent && url.endsWith('/model') ? [] : [{ provider_id: provider, trusted: true, healthy: true, available: true }] }) });
  await c.loadServed(0);
  assert.equal(c.isSuspended('model'), true);
  provider = 'new-seller';
  await c.loadServed(0);
  assert.equal(c.isSuspended('model'), false);
  c.noteRejected('model'); c.noteRejected('model');
  absent = true;
  await c.loadServed(0);
  assert.equal(c.rejections.get('model').gone, true);
  absent = false;
  await c.loadServed(0);
  assert.equal(c.isSuspended('model'), false);
});

test('a discarded book pass cannot release a suspension', async () => {
  const { c } = fixture();
  c.models = new Map(['model', 'a', 'b', 'c'].map(id => [id, { id }]));
  c.rawModels = c.models;
  c.served = new Set(c.models.keys());
  c.sellers.set('model', new Set(['seller']));
  c.noteRejected('model'); c.noteRejected('model');
  c.fetchImpl = async url => Response.json({ offers: url.endsWith('/model')
    ? [{ provider_id: 'new-seller', trusted: true, healthy: true, available: true }] : [] });
  await c.loadServed(0);
  assert.equal(c.isSuspended('model'), true);
  assert.deepEqual([...c.sellers.get('model')], ['seller']);
});
test('bounded rejection records and disabled TTL', () => {
  const { c } = fixture();
  for (let n = 0; n < 310; n++) c.noteRejected(`model-${n}`);
  assert.equal(c.rejections.size, 300);
  const disabled = fixture({ unservableTtlMs: 0 }).c;
  for (let n = 0; n < 5; n++) disabled.noteRejected('model');
  assert.equal(disabled.rejections.size, 0);
  assert.equal(disabled.isUnservable('model'), false);
});
test('failed persistence writes do not reject requests', async () => {
  const { c } = fixture({ suspensionsFile: '/dev/null/state.json' });
  c.noteRejected('model'); c.noteRejected('model');
  await new Promise(resolve => setTimeout(resolve, 60));
  await c.suspensionsWrite;
  assert.equal(c.isSuspended('model'), true);
});
test('an answer between two rejections keeps a flapping model listed', async () => {
  const { c, advance } = fixture();
  for (let n = 0; n < 6; n++) {
    c.noteRejected('flaky');
    assert.equal(c.isSuspended('flaky'), false);
    advance(15 * minute);
    assert.equal(await c.listable('flaky'), true);
    c.noteAnswered('flaky');
  }
});
test('one rejection older than a day is not the start of a streak, a recent one is', () => {
  const { c, advance } = fixture();
  c.noteRejected('slow');
  advance(25 * 60 * minute);
  c.noteRejected('slow');
  assert.equal(c.rejections.get('slow').count, 1);
  assert.equal(c.isSuspended('slow'), false);
  advance(15 * minute);
  c.noteRejected('slow');
  assert.equal(c.isSuspended('slow'), true);
  advance(48 * 60 * minute);
  c.noteRejected('slow');
  assert.equal(c.rejections.get('slow').count, 3);
});
test('a pre-payment refusal or probe is never an answer and does not release a suspension', async () => {
  const { c } = fixture();
  c.noteRejected('model'); c.noteRejected('model');
  assert.equal(c.isSuspended('model'), true);
  assert.equal(await c.canAnswer('model'), false);
  assert.equal(c.isSuspended('model'), true);
  assert.equal(c.rejections.get('model').count, 2);
});
test('an unreadable or foreign book is no evidence that a suspended model lost its sellers', async () => {
  const { c } = fixture();
  c.models = new Map(['m', 'other'].map(id => [id, { id }]));
  c.rawModels = c.models;
  c.served = new Set(c.models.keys());
  c.sellers.set('m', new Set(['seller']));
  c.noteRejected('m'); c.noteRejected('m');
  const good = [{ provider_id: 'seller', trusted: true, healthy: true, available: true }];
  for (const bad of [{ error: 'temporary failure' }, { model: 'other', offers: [] }, { data: {} }]) {
    c.fetchImpl = async url => Response.json(url.endsWith('/m') ? bad : { offers: good });
    await c.loadServed(0);
    assert.equal(c.rejections.get('m').gone, false);
  }
  c.fetchImpl = async () => Response.json({ offers: good });
  await c.loadServed(0);
  assert.equal(c.isSuspended('m'), true);
});
test('a book read before a rejection cannot release that rejection', async () => {
  const { c } = fixture();
  c.models = new Map(['m', 'other'].map(id => [id, { id }]));
  c.rawModels = c.models;
  c.served = new Set(c.models.keys());
  c.sellers.set('m', new Set(['seller']));
  c.noteRejected('m');
  c.fetchImpl = async url => {
    const response = Response.json({ offers: [{ provider_id: url.endsWith('/m') ? 'new-seller' : 'x', trusted: true, healthy: true, available: true }] });
    if (url.endsWith('/m')) c.noteRejected('m');
    return response;
  };
  await c.loadServed(0);
  assert.equal(c.isSuspended('m'), true);
});
test('stored provider lists are bounded so the file always restores', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'susp-'));
  try {
    const file = join(dir, 'state.json');
    const { c } = fixture({ suspensionsFile: file });
    c.sellers.set('m', new Set(Array.from({ length: 400 }, (_, n) => `seller-${n}`)));
    c.noteRejected('m'); c.noteRejected('m');
    assert.equal(c.rejections.get('m').providers.length, 50);
    assert.equal(c.rejections.get('m').truncated, true);
    await new Promise(r => setTimeout(r, 80)); await c.suspensionsWrite;
    const again = new ModelCatalogue({ url: 'unused', suspensionsFile: file });
    assert.equal(again.rejections.get('m').count, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a full provider snapshot does not treat an unchanged long seller list as new sellers', async () => {
  const { c } = fixture();
  c.models = new Map(['m', 'other'].map(id => [id, { id }]));
  c.rawModels = c.models;
  c.served = new Set(c.models.keys());
  const names = Array.from({ length: 51 }, (_, n) => `seller-${n}`);
  c.sellers.set('m', new Set(names));
  c.noteRejected('m'); c.noteRejected('m');
  c.fetchImpl = async () => Response.json({ offers: names.map(provider_id => ({ provider_id, trusted: true, healthy: true, available: true })) });
  await c.loadServed(0);
  assert.equal(c.isSuspended('m'), true);
});
test('free-list models are never suspended', async () => {
  const { c } = fixture();
  c.neverHide.add('free-model');
  c.noteRejected('free-model'); c.noteRejected('free-model');
  assert.equal(c.isSuspended('free-model'), false);
});
test('a complete provider list at the bound still releases on a new seller', async () => {
  const { c } = fixture();
  c.models = new Map(['m', 'other'].map(id => [id, { id }]));
  c.rawModels = c.models;
  c.served = new Set(c.models.keys());
  const names = Array.from({ length: 50 }, (_, n) => `seller-${n}`);
  c.sellers.set('m', new Set(names));
  c.noteRejected('m'); c.noteRejected('m');
  assert.equal(c.rejections.get('m').truncated, false);
  const offer = provider_id => ({ provider_id, trusted: true, healthy: true, available: true });
  c.fetchImpl = async () => Response.json({ offers: [...names, 'new-seller'].map(offer) });
  await c.loadServed(0);
  assert.equal(c.isSuspended('m'), false);
});
