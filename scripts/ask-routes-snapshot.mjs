import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const source = 'https://ask.singitai.app/openapi.json';
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const amount = v => (typeof v === 'number' || typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v)) && Number.isFinite(Number(v)) && Number(v) >= 0;
export function snapshot(spec, fetchedAt) {
  if (!spec?.paths || Array.isArray(spec.paths) || typeof spec.paths !== 'object' || !/^\d{4}-.*T.*Z$/.test(fetchedAt) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid OpenAPI snapshot input');
  const routes = [];
  for (const route of Object.keys(spec.paths).sort()) {
    if (route.toLowerCase().includes('video')) continue;
    if (!route.startsWith('/') || !spec.paths[route] || typeof spec.paths[route] !== 'object') throw new Error('Invalid path');
    for (const method of Object.keys(spec.paths[route]).sort()) {
      if (!methods.has(method)) continue;
      const operation = spec.paths[route][method];
      if (typeof operation?.summary !== 'string' || !operation.summary.trim()) throw new Error(`Missing summary: ${method} ${route}`);
      const entry = { path: route, method: method.toUpperCase(), summary: operation.summary };
      if (Object.hasOwn(operation, 'x-payment-info')) {
        const p = operation['x-payment-info']?.price;
        if (!amount(p?.min) || !amount(p?.max) || Number(p.min) > Number(p.max) || !['USD', 'USDC'].includes(p.currency)) throw new Error(`Invalid payment price: ${method} ${route}`);
        entry.price = { min: p.min, max: p.max, currency: p.currency };
      } else {
        // An explicit public operation is free; do not infer this from a missing price on a paid operation.
        if (Array.isArray(operation.security) && operation.security.length === 0) entry.price = { min: 0, max: 0, currency: 'USD' };
      }
      routes.push(entry);
    }
  }
  if (!routes.length) throw new Error('No routes');
  return { fetchedAt, source, routes };
}
async function main() {
  const opts = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--out', '--fetched-at'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Usage: ask-routes-snapshot.mjs [--input file] [--fetched-at ISO] [--out file]');
    opts[args[i]] = args[i + 1];
  }
  let spec;
  if (opts['--input']) spec = JSON.parse(await readFile(opts['--input'], 'utf8'));
  else {
    const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GET ${source}: ${response.status}`);
    spec = await response.json();
  }
  const data = snapshot(spec, opts['--fetched-at'] ?? new Date().toISOString());
  const out = opts['--out'] ?? 'website/data/ask-routes.json';
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data, null, 2) + '\n');
  console.log(`Snapshot: ${data.routes.length} routes`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
