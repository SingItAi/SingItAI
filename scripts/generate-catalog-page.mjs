import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { catalogResponse } from '../singit-ask/src/catalog-shape.mjs';
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
export function renderCatalog(s) {
  const actual = catalogResponse(s.data);
  if (JSON.stringify(actual.counts) !== JSON.stringify(s.counts)) throw new Error('Snapshot counts disagree');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SingIt catalog</title><meta name="description" content="Snapshot catalog of SingIt models and services, with modality counts, payment access and prices."><link rel="canonical" href="https://singitai.app/models/"><link rel="stylesheet" href="/style.css"></head><body><main>
<h1>Models and services</h1><p>${e(breakdown(s))}</p>
<p>Snapshot: ${e(s.fetchedAt)}. ${e(s.coverage ?? 'All sold modalities')}. Zero counts mean no entries captured in this snapshot. Live availability and quotes: <a href="https://ask.singitai.app/v1/catalog">/v1/catalog</a>.</p>
<dl>${Object.entries(s.counts).map(([m,n]) => `<dt>${m}</dt><dd data-modality="${m}">${n}</dd>`).join('')}</dl>
<p>Chat includes routers and free aliases. Transcription requires an API key at the gateway. x402 entries accept USDC on Base and Solana. Prices follow the reference request or stated unit; the live quote is authoritative.</p>
<table><thead><tr><th>Name / ID</th><th>Modality</th><th>Kind</th><th>Payment</th><th>Route</th><th>Networks</th><th>Price summary</th></tr></thead><tbody>
${s.data.map(m => `<tr><td>${e(m.name)}<br>${e(m.id)}</td><td>${e(m.modality)}</td><td>${e(m.kind)}</td><td>${e(m.payment)}</td><td>${e(m.route)}</td><td>${e(m.networks.join(', '))}</td><td>${e(priceSummary(m.price))}</td></tr>`).join('\n')}
</tbody></table><a href="/models/all/">Chat model detail pages</a></main></body></html>\n`;
}
export async function generate(check = false) {
  const s = JSON.parse(await read('data/catalog-snapshot.json'));
  const files = new Map([['models/index.html', renderCatalog(s)]]);
  for (const name of ['index.html', 'x402-llm-api/index.html', '.well-known/agent-card.json', 'llms.txt']) {
    const text = await read(name);
    files.set(name, text.replace(/(?:200\+ models|\d+ chat(?:, \d+ (?:image|image_edit|embeddings|speech|transcription|search))*)/g, breakdown(s)).replace(/<!-- catalog-counts:start -->.*?<!-- catalog-counts:end -->/g, `<!-- catalog-counts:start -->${breakdown(s)}<!-- catalog-counts:end -->`));
  }
  for (const [name, content] of files) {
    if (await read(name) === content) continue;
    if (check) throw new Error(`Generated file differs: ${name}`);
    await writeFile(new URL(name, root), content);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) generate(process.argv.includes('--check')).catch(e => { console.error(e); process.exitCode = 1; });
