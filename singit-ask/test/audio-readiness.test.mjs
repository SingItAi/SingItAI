import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioReadiness, AUDIO_CREDIT_TTL_MS } from '../src/audio-readiness.mjs';
import { AUDIO_MODELS } from '../src/audio-generation.mjs';

test('credit snapshot fails closed and pins model/price without discovery I/O', async () => {
  let time = 100, value = '240000', fail = false, calls = 0;
  const config = { audioSold: true, surplusKey: 'test-key', surplusUrl: 'https://surplus.test' };
  const helper = createAudioReadiness(config, { now: () => time, log: () => {}, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://surplus.test/v1/payments/balance');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    if (fail) throw new Error('unreadable');
    return Response.json({ credit_balance_usdc: value });
  } });
  const model = AUDIO_MODELS[0], check = () => helper.ready(model.upstream, model);
  assert.equal(check(), false);
  await helper.refresh();
  assert.equal(check(), true); assert.equal(calls, 1);
  assert.equal(helper.ready(model.upstream, { listAtomic: model.listAtomic + 1 }), false);
  assert.equal(helper.ready('unknown', model), false);
  time += AUDIO_CREDIT_TTL_MS + 1;
  assert.equal(check(), false);
  for (value of ['0', 'NaN', '', '-1', '0.02', null, 240000]) {
    await helper.refresh(); assert.equal(check(), false);
  }
  value = '240000'; await helper.refresh(); assert.equal(check(), true);
  fail = true; await helper.refresh(); assert.equal(check(), false);
  config.audioSold = false; assert.equal(check(), false);
});

test('allowlist accepts public or upstream ids; suspension and rejection still gate', async () => {
  for (const allow of [undefined, ['minimax/music-2'], ['venice-minimax-music-v2'], []]) {
    let blocked = false;
    const helper = createAudioReadiness({ audioSold: true, audioModels: allow, surplusKey: 'test', surplusUrl: 'https://surplus.test' }, {
      fetchImpl: async () => Response.json({ credit_balance_usdc: '999999' }), log: () => {},
      catalogue: { isSuspended: () => blocked, isUnservable: () => blocked, served: new Set(['chat-only']) },
    });
    await helper.refresh();
    assert.equal(helper.ready(AUDIO_MODELS[2].upstream, AUDIO_MODELS[2]), allow === undefined || allow.length > 0);
    blocked = true; assert.equal(helper.ready(AUDIO_MODELS[2].upstream, AUDIO_MODELS[2]), false);
  }
});

test('standard catalogue snapshot rejects price drift, duration billing and stale support', async () => {
  let time = 100;
  const model = AUDIO_MODELS[0];
  const entry = { pricing: { image: '0.02', media_unit: 'job' }, supported_parameters: ['async', 'sound-effects'] };
  const catalogue = { audioCatalogue: null, audioCatalogueAt: null };
  const helper = createAudioReadiness({ audioSold: true, surplusKey: 'test', surplusUrl: 'https://surplus.test' }, {
    catalogue, now: () => time, log: () => {}, fetchImpl: async () => Response.json({ credit_balance_usdc: '999999' }),
  });
  await helper.refresh();
  const check = () => helper.ready(model.upstream, model);
  assert.equal(check(), false);
  catalogue.audioCatalogue = new Map([[model.upstream, entry]]); catalogue.audioCatalogueAt = time;
  assert.equal(check(), true);
  entry.pricing.image = '0.03'; assert.equal(check(), false);
  entry.pricing.image = '0.02'; entry.pricing.media_unit = 'second'; assert.equal(check(), false);
  entry.pricing.media_unit = 'job'; entry.supported_parameters = []; assert.equal(check(), false);
  entry.supported_parameters = ['async', 'sound-effects']; time += 360001;
  await helper.refresh(); assert.equal(check(), false);
});
