import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderCatalog, accessMethod, availability, breakdown } from '../../scripts/generate-catalog-page.mjs';
import { catalogResponse } from '../../singit-ask/src/catalog-shape.mjs';
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
  assert.ok(body.includes(breakdown(snapshot)));
  for (const [modality, count] of Object.entries(snapshot.counts)) {
    assert.ok(body.includes(`<dd data-modality="${modality}">${count}</dd>`));
  }
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
  const page = renderCatalog({ fetchedAt: 'offline', ...catalogResponse([m]) });
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
  for (const modality of ['video', 'music', 'sound_effects', 'transcription']) {
    const gated = structuredClone(snapshot);
    gated.data.push({ ...gated.data[0], modality });
    gated.counts = catalogResponse(gated.data).counts;
    assert.throws(() => renderCatalog(gated), /Gated modality/);
    assert.ok(!snapshot.data.some(m => m.modality === modality));
  }
  const duplicate = structuredClone(snapshot);
  duplicate.data.push({ ...duplicate.data[0], modality: 'image' });
  duplicate.counts = Object.fromEntries(Object.keys(snapshot.counts).map(modality => [modality, duplicate.data.filter(m => m.modality === modality).length]));
  assert.throws(() => renderCatalog(duplicate), /Duplicate catalog anchor/);
});

test('catalog content follows a changed snapshot without pinned totals or model names', () => {
  const changed = structuredClone(snapshot);
  changed.data = changed.data.slice().reverse().filter((_, i) => i % 2 === 0);
  changed.data[0].id = 'fixture/catalog-entry';
  changed.data[0].name = 'Snapshot fixture';
  changed.counts = catalogResponse(changed.data).counts;
  const page = renderCatalog(changed);
  assert.ok(page.includes(breakdown(changed)));
  const structured = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(structured.numberOfItems, changed.data.length);
  assert.deepEqual(structured.itemListElement.map(m => m.name), changed.data.map(m => m.name ?? m.id));
  assert.deepEqual([...page.matchAll(/<tr id="([^"]+)"/g)].map(m => m[1]), changed.data.map(m => encodeURIComponent(m.id)));
});

 test('published catalog includes captured image, editing, embeddings and speech entries', () => {
  assert.equal(snapshot.fetchedAt, '2026-11-05T17:25:00Z');
  for (const modality of ['image', 'image_edit', 'embeddings', 'speech']) {
    const entries = snapshot.data.filter(e => e.modality === modality);
    assert.ok(entries.length > 0, modality);
    assert.equal(snapshot.counts[modality], entries.length);
    assert.ok(html.includes(`<td>${modality}</td>`));
  }
});
