import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderCatalog, accessMethod, availability } from '../../scripts/generate-catalog-page.mjs';
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const snapshot = JSON.parse(await read('data/catalog-snapshot.json'));
const html = await read('models/index.html');

test('static catalog renders every snapshot entry with unique encoded anchors and access', () => {
  assert.equal(html, renderCatalog(snapshot));
  const body = html.split('<body>')[1];
  assert.doesNotMatch(body, /<script\b|Loading live prices/i);
  const anchors = [...body.matchAll(/<tr id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(anchors).size, snapshot.data.length);
  assert.deepEqual(anchors, snapshot.data.map(m => encodeURIComponent(m.id)));
  for (const m of snapshot.data) {
    assert.ok(body.includes(`href="/models#${encodeURIComponent(m.id)}"`));
    assert.ok(body.includes(`<td>${m.modality}</td>`));
    assert.ok(body.includes(`<td>${accessMethod(m)}</td>`));
    assert.ok(body.includes(`<td>${availability(m)}</td>`));
  }
  assert.ok(body.includes(snapshot.coverage));
  assert.match(body, /image.*speech.*transcription.*fresh catalog capture/);
});

test('JSON-LD matches the complete HTML list without fabricated offers or ratings', () => {
  const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data['@type'], 'ItemList');
  assert.equal(data.url, 'https://singitai.app/models/');
  assert.equal(data.numberOfItems, snapshot.data.length);
  assert.equal(data.itemListElement.length, snapshot.data.length);
  data.itemListElement.forEach((entry, i) => {
    const model = snapshot.data[i];
    assert.equal(entry['@type'], 'ListItem');
    assert.equal(entry.position, i + 1);
    assert.equal(entry.name, model.name ?? model.id);
    assert.equal(entry.url, `https://singitai.app/models#${encodeURIComponent(model.id)}`);
    assert.equal(entry.item.url, entry.url);
    assert.equal(entry.item.additionalProperty.name, 'modality');
    assert.equal(entry.item.additionalProperty.value, model.modality);
  });
  assert.doesNotMatch(JSON.stringify(data), /aggregateRating|offers|reviewRating/);
});

test('sitemap includes the canonical catalog once and excludes fragments and gated modality', async () => {
  const sitemap = await read('sitemap.xml');
  assert.equal(sitemap.split('<loc>https://singitai.app/models/</loc>').length - 1, 1);
  assert.doesNotMatch(sitemap, /<loc>[^<]*#/);
  for (const content of [html, sitemap]) assert.doesNotMatch(content, /video/i);
  assert.ok(Buffer.byteLength(await read('llms.txt')) <= 14000);
});

test('encoding, availability and access support fresh D3 entries safely', () => {
  const m = { id: "free/a b?#é", name: '</script><b>', modality: 'chat', access: 'api_key', available: false, router: true, kind: 'router', networks: [], price: {} };
  const page = renderCatalog({ fetchedAt: 'offline', counts: { chat: 1, image: 0, image_edit: 0, embeddings: 0, speech: 0, transcription: 0, search: 0 }, data: [m] });
  assert.ok(page.includes(`id="${encodeURIComponent(m.id)}"`));
  assert.ok(page.includes('router / api_key'));
  assert.ok(page.includes('Unavailable at capture'));
  assert.equal(availability({ available: true }), 'Available at capture');
  assert.equal(accessMethod({ payment: 'api_key_only' }), 'api_key');
  const data = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.itemListElement[0].name, m.name);
  assert.throws(() => renderCatalog({ counts: {}, data: [] }), /counts/i);
});

test('generator refuses gated entries and ambiguous anchors', () => {
  const gated = structuredClone(snapshot);
  gated.data.push({ ...gated.data[0], modality: 'video' });
  gated.counts.video = 1;
  assert.throws(() => renderCatalog(gated), /Gated modality/);
  const duplicate = structuredClone(snapshot);
  duplicate.data.push({ ...duplicate.data[0], modality: 'image' });
  duplicate.counts.image++;
  assert.throws(() => renderCatalog(duplicate), /Duplicate catalog anchor/);
});
