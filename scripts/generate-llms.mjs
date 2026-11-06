import { MODEL_ALIAS_ROUTES, aliasPath } from "../singit-ask/src/model-alias-routes.mjs";
import { readFileSync } from 'node:fs';
import { breakdown } from './generate-catalog-page.mjs';
const catalog = JSON.parse(readFileSync(new URL('../website/data/catalog-snapshot.json', import.meta.url), 'utf8'));
// Dependency-free: website CI runs on a clean Node checkout without npm install.
import { limits } from './templates/spending-limits.mjs';
import { DEFAULT_FREE_MODELS, FREE_DEFAULTS } from '../singit-ask/src/free.mjs';

const hasTokenPrice = (m) => ["input", "output"].every((key) => {
  const v = m.singitUsdPerMillionTokens?.[key];
  return Number.isFinite(v) && v >= 0 && (v > 0 || m.usdPerMillionTokens?.[key] === 0);
}) && ["input", "output"].some((key) => m.singitUsdPerMillionTokens?.[key] > 0);

export const tasks = [
  ['Chat completion (OpenAI format)', 'POST', ['/v1/chat/completions']],
  ['Anthropic Messages', 'POST', ['/v1/messages']],
  ['OpenAI Responses', 'POST', ['/v1/responses']],
  ['Per-model chat routes', 'POST', ['/v1/chat/{model}']],
  ['Image edits (JSON data URIs)', 'POST', ['/v1/images/edits', '/v1/images/image2image']],
  ['Embeddings (exact input estimate)', 'POST', ['/v1/embeddings']],
  ['Image generation', 'POST', ['/v1/images/generations']],
  ['Speech', 'POST', ['/v1/audio/speech']],
  ['Exa web search', 'POST', ['/v1/exa/search']],
  ['Exa page contents', 'POST', ['/v1/exa/contents']],
  ['Exa cited answer', 'POST', ['/v1/exa/answer']],
  ['Free models (free/ prefix)', 'POST', ['/v1/chat/completions'], true],
  ['Crypto / metal / FX prices (free)', 'GET', ['/v1/prices', '/v1/prices/crypto/{symbol}', '/v1/prices/metal/{symbol}', '/v1/prices/fx/{base}/{quote}']],
  ['Models / pricing lookups (free)', 'GET', ['/v1/models', '/pricing.json']],
  ['Health', 'GET', ['/health']],
];
const label = s => String(s).replace(/[\[\]\\|]/g, '\\$&').replace(/[\r\n]/g, ' ');
export function replaceBlock(text, name, content) {
  const start = `<!-- generated:${name}:start -->`, end = `<!-- generated:${name}:end -->`;
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b < a || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) throw new Error(`Malformed ${name} markers`);
  return text.slice(0, a) + `${start}\n${content}\n${end}` + text.slice(b + end.length);
}
export function taskRows(routes, format) {
  return tasks.map(([task, method, paths, free]) => {
    const entries = paths.flatMap(p => p === '/v1/chat/{model}'
      ? routes.filter(r => r.method === method && r.path.startsWith('/v1/chat/') && r.path !== '/v1/chat/completions')
      : [routes.find(r => r.method === method && r.path === p)]);
    if (!entries.length || entries.some(r => !r?.price)) throw new Error(`Missing priced route: ${task}`);
    const min = Math.min(...entries.map(r => Number(r.price.min)));
    const max = Math.max(...entries.map(r => Number(r.price.max)));
    if (![min, max].every(v => Number.isFinite(v) && v >= 0) || min > max || entries.some(r => !['USD', 'USDC'].includes(r.price.currency))) throw new Error(`Invalid route price: ${task}`);
    return [task, paths.map(p => `${method} https://ask.singitai.app${p}`).join('; '), free ? 'Free (limited daily allowance)' : max === 0 ? 'Free' : `${format(min)}..${format(max)} USDC per call`];
  });
}
export function renderLlms(text, s, routes, format) {
  const rows = taskRows(routes.routes, format);
  const table = '## I need to... -> Call -> Price\n\n| Task | Call | Price |\n| --- | --- | --- |\n' + rows.map(r => `| ${r.join(' | ')} |`).join('\n');
  const money = renderMoney(s, format);
  text = replaceBlock(text, 'ask-guide', table + '\n\nAliases: POST /v1/models/<id>/chat or /images; ids at https://ask.singitai.app/llms-models.txt.' + '\n\n' + money);
  text = replaceBlock(text, 'model-pages', renderModelLinks());
  if (Buffer.byteLength(text) > 14000) throw new Error('llms.txt exceeds 14000 bytes');
  const models = renderModelList(s, format) + '\n## D4 aliases\n\n' + MODEL_ALIAS_ROUTES.map(m => `- POST https://ask.singitai.app${aliasPath(m)}`).join('\n') + '\n';
  const body = text.replace(/^<!-- generated:[^\n]+ -->\n/gm, '');

  const audioDraft = 'Draft Ask audio: POST /v1/audio/sound-effects and /v1/audio/generations return audio bytes after bounded server-side generation; Base-only exact USDC (Solana refused; disabled until credit, route and pricing readiness are confirmed), model capabilities and flat prices at GET /v1/audio/generation-models. Not yet published.';
  return new Map([['llms.txt', text], ['llms-models.txt', models], ['llms-full.txt', body.trimEnd() + '\n\n' + models.replace(/^# SingIt model pages/, '## Model pages with prices').trimEnd() + '\n\n' + audioDraft + '\n']]);
}

export function renderModelList(s, format) {
  return '# SingIt model pages\n\nsingit/auto: POST /v1/chat/completions picks eco/standard/premium by simple rules for text prompts. Optional min_tier sets a minimum. X-SingIt-Model and X-SingIt-Tier report the choice. If the chosen model\'s seller refuses before payment, the router picks the next model of the tier or the next tier up, never below min_tier; after payment it retries once with another model of the same tier only if it costs no more than the price quoted, otherwise the request fails with 503 and no charge; X-SingIt-Model and X-SingIt-Tier show what actually answered. Prices depend on the chosen model; use the live 402 quote.\n\n> Generated from models-snapshot.json; USD per 1M tokens includes markup. Settlement fees are additional. Reference request prices are USDC per call; live 402 offers are authoritative.\n\n' +
    '| Model page | Input / 1M | Output / 1M | Base upto | Base exact | Solana upto | Solana exact |\n| --- | --- | --- | --- | --- | --- | --- |\n' +
    s.models.map(m => `| [${label(m.name ?? m.id)}](https://singitai.app/models/${m.id}/) | ${hasTokenPrice(m) ? '$' + format(m.singitUsdPerMillionTokens.input) : 'Not listed'} | ${hasTokenPrice(m) ? '$' + format(m.singitUsdPerMillionTokens.output) : 'Not listed'} | ${['base', 'solana'].flatMap(n => ['upto', 'exact'].map(scheme => format(m[scheme][n].usd))).join(' | ')} |`).join('\n') + '\n';
}

export function renderModelLinks() {
  const links = [
    ['Privacy policy', 'https://singitai.app/privacy/'],
    ['Terms of service', 'https://singitai.app/terms/'],
    ['Data deletion', 'https://singitai.app/data-deletion/'],
    ['Model pages with prices', 'https://ask.singitai.app/llms-models.txt'],
    ['All model pages', 'https://singitai.app/models/all/'],
    ['Live catalog (all modalities)', 'https://ask.singitai.app/v1/catalog'],
    ['Live reference prices', 'https://ask.singitai.app/pricing.json'],
    ...limits.map(p => [p.title.replace(' | SingIt', ''), `https://singitai.app/${p.slug}/`]),
  ];
  // Compact: snapshot counts here; full route DESCRIPTION lives on Ask discovery (D2).
  return '## Models\n\nSnapshot: ' + breakdown(catalog)
    + (catalog.coverage ? ' (partial offline snapshot).' : '.') + '\n\n'
    + links.map(([name, url]) => `- [${label(name)}](${url})`).join('\n');}

export function renderMoney(s, format) {
  const fees = ['base', 'solana'].map(n => format(s.fees.perAnswerUsd[s.networks[n].chain]));
  return `## Money rules for agents

Unpaid calls: HTTP 402 includes PAYMENT-REQUIRED (base64 JSON, x402Version 2). Decode it, sign one offer, retry the same request with PAYMENT-SIGNATURE. Success: HTTP 200 with PAYMENT-RESPONSE.

\`upto\` is listed first: pay the actual cost up to the signed ceiling. \`exact\` is priced for a typical answer (~30% of max_tokens), settled at that flat price whatever length the answer turns out to be. Never sign above budget.

LLM/image/speech: model cost plus ${format(s.fees.markupPct)}% markup, plus a settlement fee of $${fees[0]} on Base or $${fees[1]} on Solana. Base and Solana share API URLs. Exa: own price, no markup, plus settlement fee of $0.001 on both Base and Solana. Route ranges are USDC; the request's 402 offer is authoritative.

Only billable answers charge; upstream 503s never charge. For 400/413/422, fix the request; do not switch models. 409: payment signature already used. For 503, wait Retry-After if supplied; for free-tier 429, wait Retry-After.

Free tier: ${DEFAULT_FREE_MODELS.length} free models, ${FREE_DEFAULTS.perVisitorPerDay} answers/day/network, shared daily cost cap $${FREE_DEFAULTS.budgetUsdPerDay}. The shared cap may run out (free_budget_exhausted); resets at midnight UTC. No wallet or key required. Each free answer reports \`billing.remainingToday\`; when used up, drop the \`free/\` prefix to pay.

Paid /v1/chat/completions: 200 messages, 100000 estimated characters (tools included; 8000 per image), 64 tools/calls, four images, max_tokens 8192 (default 800), 128 kB JSON body. Model capabilities constrain tools/images. Messages/Responses support tools and 32000 output tokens.

Chat/Messages/Responses stream:true returns buffered SSE after settlement with billing and PAYMENT-RESPONSE. Chat ends with [DONE]; Responses with response.completed. Chat stream_options accepts only {include_usage:boolean} with stream:true. Free/per-model streams retain text-only limits; free refuses tools/images.

/numbers.json: aggregate traffic only.

Reference chat request: ${s.referenceRequest.messages} message(s), ${s.referenceRequest.chars} characters, ${s.referenceRequest.inputTokens} input tokens, max_tokens ${s.referenceRequest.maxOutputTokens}. Per-model reference prices are in the full models list, with upto before exact.`;
}

// Regenerate only the LLM references from committed snapshots; no network access.
async function runCli() {
  if (!process.argv[1]) return;
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: generate-llms.mjs [--check]');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { price, visibleSnapshot } = await import('./generate-model-pages.mjs');
    const website = new URL('../website/', import.meta.url);
    const read = name => readFile(new URL(name, website), 'utf8');
    const snapshot = JSON.parse(await read('data/models-snapshot.json'));
    const hidden = JSON.parse(await readFile(new URL('./hidden-models.json', import.meta.url), 'utf8'));
    const routes = JSON.parse(await read('data/ask-routes.json'));
    const stale = [];
    for (const [name, content] of renderLlms(await read('llms.txt'), visibleSnapshot(snapshot, hidden), routes, price)) {
      if (await read(name) === content) continue;
      stale.push(name);
      if (!process.argv.includes('--check')) await writeFile(new URL(name, website), content);
    }
    if (process.argv.includes('--check') && stale.length) throw new Error(`Generated files differ: ${stale.join(', ')}`);
  }
}

runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
