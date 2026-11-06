import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { catalogResponse } from '../singit-ask/src/catalog-shape.mjs';
import { EXCLUDED_MODALITIES } from './catalog-snapshot.mjs';
const root = new URL('../website/', import.meta.url);
const read = p => readFile(new URL(p, root), 'utf8');
const e = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const breakdown = s => Object.entries(s.counts).filter(([, n]) => n > 0).map(([m,n]) => `${n} ${m}`).join(', ');
export function priceSummary(p) {
  if (p.usd === 0) return 'Free, subject to daily limits';
  if (p.mode === 'selected_model') return 'Depends on the selected model; see live quote';
  if (p.unit) return `$${p.withMarkup} per ${p.unit}${p.settlementFeeAdditional ? ', plus settlement fee' : ''}`;
  if (p.min !== undefined && p.max !== undefined) return `$${p.min}–$${p.max} per call`;
  const prices = ['upto', 'exact'].flatMap(scheme => ['base', 'solana'].flatMap(network => {
    const usd = p[scheme]?.[network]?.usd;
    return usd === undefined ? [] : [`${network} ${scheme}: $${usd}`];
  }));
  return prices.length ? prices.join('; ') : 'See live quote';
}
export const anchor = m => encodeURIComponent(m.id);
export const accessMethod = m => [m.router || m.kind === 'router' ? 'router' : '', m.access ?? (m.payment === 'api_key_only' ? 'api_key' : m.payment)].filter(Boolean).join(' / ');
export const availability = m => m.available === true ? 'Available at capture' : m.available === false ? 'Unavailable at capture' : 'Unknown (not captured)';
export function renderCatalog(s) {
  const actual = catalogResponse(s.data);
  if (JSON.stringify(actual.counts) !== JSON.stringify(s.counts)) throw new Error('Snapshot counts disagree');
  if (s.data.some(m => EXCLUDED_MODALITIES.includes(m.modality))) throw new Error('Gated modality in snapshot');
  if (new Set(s.data.map(anchor)).size !== s.data.length) throw new Error('Duplicate catalog anchor');
  const structured = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    url: 'https://singitai.app/models/', numberOfItems: s.data.length,
    itemListElement: s.data.map((m, i) => ({
      '@type': 'ListItem', position: i + 1, name: m.name ?? m.id,
      url: `https://singitai.app/models#${anchor(m)}`,
      item: { '@type': 'Thing', name: m.name ?? m.id,
        url: `https://singitai.app/models#${anchor(m)}`,
        additionalProperty: { '@type': 'PropertyValue', name: 'modality', value: m.modality } }
    }))
  };
  const jsonLd = JSON.stringify(structured).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SingIt catalog</title><meta name="description" content="Snapshot catalog of SingIt models and services, with modality counts, payment access and prices."><link rel="canonical" href="https://singitai.app/models/"><link rel="stylesheet" href="/style.css"><script type="application/ld+json">${jsonLd}</script></head><body><main>
<h1>Models and services</h1><p>${e(breakdown(s))}</p>
<p>Snapshot: ${e(s.fetchedAt)}. ${e(s.coverage ?? 'All sold modalities')}. Zero counts mean no entries captured in this snapshot. Live availability and quotes: <a href="https://ask.singitai.app/v1/catalog">/v1/catalog</a>.</p>
<dl>${Object.entries(s.counts).map(([m,n]) => `<dt>${e(m)}</dt><dd data-modality="${e(m)}">${e(n)}</dd>`).join('')}</dl>
<p>Access methods, networks and prices below reflect the captured entries. Prices follow the reference request or stated unit; the live quote is authoritative.</p>
<table><thead><tr><th>Name / ID</th><th>Modality</th><th>Kind</th><th>Access method</th><th>Availability</th><th>Route</th><th>Networks</th><th>Price summary</th></tr></thead><tbody>
${s.data.map(m => `<tr id="${e(anchor(m))}"><td><a href="/models#${e(anchor(m))}">${e(m.name ?? m.id)}</a><br>${e(m.id)}</td><td>${e(m.modality)}</td><td>${e(m.kind)}</td><td>${e(accessMethod(m))}</td><td>${e(availability(m))}</td><td>${e(m.route)}</td><td>${e(m.networks.join(', '))}</td><td>${e(priceSummary(m.price))}</td></tr>`).join('\n')}</tbody></table><a href="/models/all/">Chat model detail pages</a></main></body></html>\n`;
}
export async function generate(check = false) {
  const s = JSON.parse(await read('data/catalog-snapshot.json'));
  const demoModel = s.data.find(m => m.modality === 'chat' && (m.payment === 'x402' || m.access === 'x402') && !m.router && !m.free)?.id
    ?? s.data.find(m => m.modality === 'chat')?.id;
  if (!demoModel) throw new Error('Snapshot has no chat model for demos');
  const files = new Map([['models/index.html', renderCatalog(s)]]);
  const sitemap = await read('sitemap.xml');
  const catalogUrl = '<loc>https://singitai.app/models/</loc>';
  files.set('sitemap.xml', sitemap.includes(catalogUrl) ? sitemap : sitemap.replace('</urlset>', `  <url>${catalogUrl}</url>\n</urlset>`));
  const modalityPattern = Object.keys(s.counts).sort((a, b) => b.length - a.length).map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const countPattern = new RegExp(`\\d+ (?:${modalityPattern})(?:, \\d+ (?:${modalityPattern}))*`, 'g');
  for (const name of ['index.html', 'x402-llm-api/index.html', '.well-known/agent-card.json', 'llms.txt']) {
    let text = await read(name);
    text = text.replace(countPattern, breakdown(s)).replace(/<!-- catalog-counts:start -->.*?<!-- catalog-counts:end -->/g, `<!-- catalog-counts:start -->${breakdown(s)}<!-- catalog-counts:end -->`);
    if (name === 'x402-llm-api/index.html') {
      // Demo snippets must use a chat id from the D3 snapshot, never a hard-coded favorite.
      text = text
        .replace(/ask \S+ "Review this pull request"/, `ask ${demoModel} "Review this pull request"`)
        .replace(/JSON\.stringify\(\{ model: "[^"]+"/, `JSON.stringify({ model: "${demoModel}"`);
    }
    files.set(name, text);
  }
  if (Buffer.byteLength(files.get('llms.txt')) > 14000) throw new Error('llms.txt exceeds 14000 bytes');  for (const [name, content] of files) {
    if (await read(name) === content) continue;
    if (check) throw new Error(`Generated file differs: ${name}`);
    await writeFile(new URL(name, root), content);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) generate(process.argv.includes('--check')).catch(e => { console.error(e); process.exitCode = 1; });
