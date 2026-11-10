import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MODEL_ALIAS_ROUTES, aliasPath } from '../../singit-ask/src/model-alias-routes.mjs';
import { catalogSlug } from '../../scripts/generate-model-pages.mjs';
const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
test('every D3 catalog entry has a page, modality, snapshot price, curl and sitemap URL', async () => {
  const catalog = JSON.parse(await read('data/catalog-snapshot.json'));
  const sitemap = await read('sitemap.xml');
  const hold = JSON.parse(await readFile(new URL('../../scripts/hidden-models.json', import.meta.url), 'utf8'));
  for (const model of catalog.data.filter(m => m.modality !== 'video' && !hold.hidden.some(h => h.id === m.id))) {
    const slug = catalogSlug(model.id);
    const html = await read(`models/${slug}/index.html`);
    assert.ok(html.includes(`Modality: ${model.modality}`), model.id);
    assert.ok(html.includes('curl -i'), model.id);
    assert.ok(html.includes('Price') || html.includes('Snapshot price'), model.id);
    assert.ok(sitemap.includes(`https://singitai.app/models/${slug}/`), model.id);
    const alias = MODEL_ALIAS_ROUTES.find(m => m.id === model.id);
    if (alias) assert.ok(html.includes(`https://ask.singitai.app${aliasPath(alias)}`), model.id);
    else assert.ok(html.includes(model.route), model.id);
  }
});
test('generated agent guide lists aliases within the compact guide budget', async () => {
  assert.ok(Buffer.byteLength(await read('llms.txt')) <= 14000);
  const full = await read('llms-models.txt');
  const catalog = JSON.parse(await read('data/catalog-snapshot.json'));
  const hold = JSON.parse(await readFile(new URL('../../scripts/hidden-models.json', import.meta.url), 'utf8'));
  const hidden = new Set(hold.hidden.map((entry) => entry.id));
  const live = new Set(catalog.data.map((entry) => entry.id));
  for (const m of MODEL_ALIAS_ROUTES) {
    if (!live.has(m.id) || hidden.has(m.id)) {
      assert.ok(!full.includes(aliasPath(m)), m.id);
      continue;
    }
    assert.ok(full.includes(aliasPath(m)), m.id);
  }
});
test('an SI-62 model page calls its /v1/chat/<id> route, with no alias anywhere', async () => {
  const catalog = JSON.parse(await read('data/catalog-snapshot.json'));
  const pinned = catalog.data.filter(m => m.modality === 'chat' && m.route.startsWith('/v1/chat/') && m.route !== '/v1/chat/completions');
  assert.equal(pinned.length, 19);
  const models = await read('llms-models.txt');
  for (const model of pinned) {
    const html = await read(`models/${catalogSlug(model.id)}/index.html`);
    assert.ok(html.includes(`https://ask.singitai.app${model.route}`), model.id);
    assert.ok(!html.includes(`/v1/models/${model.id}/`), model.id);
    assert.ok(!models.includes(`/v1/models/${model.id}/`), model.id);
  }
});
