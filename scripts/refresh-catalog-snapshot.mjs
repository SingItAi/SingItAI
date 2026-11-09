// Fetches the public unpaid catalog endpoints and regenerates the committed website snapshot.
// scripts/catalog-snapshot.mjs stays offline; this file is the only place that performs the GET.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshot as catalogSnapshot, EXCLUDED_MODALITIES } from './catalog-snapshot.mjs';
import { snapshot as modelsSnapshot } from './models-snapshot.mjs';

export const ENDPOINTS = Object.freeze({
  catalog: 'https://ask.singitai.app/v1/catalog',
  models: 'https://ask.singitai.app/v1/models',
  pricing: 'https://ask.singitai.app/pricing.json',
});

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogOut = path.join(root, 'website/data/catalog-snapshot.json');
const modelsOut = path.join(root, 'website/data/models-snapshot.json');

export function countDroppedSharply(previousCount, nextCount) {
  if (!Number.isSafeInteger(previousCount) || previousCount < 0) throw new Error('Invalid previous model count');
  if (!Number.isSafeInteger(nextCount) || nextCount < 0) throw new Error('Invalid next model count');
  if (previousCount === 0) return false;
  const lost = previousCount - nextCount;
  // More than 20% (1/5). A drop of exactly 20% is allowed.
  return lost > 0 && BigInt(lost) * 5n > BigInt(previousCount);
}

export function canonicalSnapshot(value) {
  return JSON.stringify(normalize(value));
}

// A later run that still matches the open refresh branch keeps that capture time,
// so unchanged pages are not rewritten merely to bump the clock.
export function reusedFetchedAt(next, branch) {
  if (!branch || typeof branch.fetchedAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(branch.fetchedAt))) return null;
  if (canonicalSnapshot(next) !== canonicalSnapshot(branch)) return null;
  return branch.fetchedAt;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'fetchedAt') continue;
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
}

export function diffIds(previousIds, nextIds, label) {
  const previous = requireIds(previousIds, label);
  const next = requireIds(nextIds, label);
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    previous: previous.length,
    next: next.length,
    added: next.filter(id => !previousSet.has(id)).sort(),
    removed: previous.filter(id => !nextSet.has(id)).sort(),
  };
}

function requireIds(ids, label) {
  if (!Array.isArray(ids)) throw new Error(`Invalid ${label} snapshot`);
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) throw new Error(`Invalid ${label} id`);
    seen.add(id);
  }
  return ids;
}

export function assessRefresh({ previousCatalog, nextCatalog, previousModels, nextModels }) {
  const catalog = diffIds(entries(previousCatalog, 'catalog').map(entry => entry.id), entries(nextCatalog, 'catalog').map(entry => entry.id), 'catalog');
  const models = diffIds(modelEntries(previousModels).map(entry => entry.id), modelEntries(nextModels).map(entry => entry.id), 'priced model');
  if (countDroppedSharply(catalog.previous, catalog.next)) {
    throw new Error(`Catalog count dropped from ${catalog.previous} to ${catalog.next}, more than 20% below the committed snapshot. Refusing to open a pull request.`);
  }
  if (countDroppedSharply(models.previous, models.next)) {
    throw new Error(`Priced model count dropped from ${models.previous} to ${models.next}, more than 20% below the committed snapshot. Refusing to open a pull request.`);
  }
  const changed = canonicalSnapshot(previousCatalog) !== canonicalSnapshot(nextCatalog)
    || canonicalSnapshot(previousModels) !== canonicalSnapshot(nextModels);
  return {
    changed,
    fetchedAt: nextCatalog.fetchedAt,
    catalog,
    models,
    catalogCounts: { previous: previousCatalog.counts ?? {}, next: nextCatalog.counts ?? {} },
  };
}

function entries(snapshot, label) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.data)) throw new Error(`Invalid ${label} snapshot`);
  return snapshot.data;
}

function modelEntries(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.models)) throw new Error('Invalid priced model snapshot');
  return snapshot.models;
}

export async function fetchPublicJson(url, fetchImpl = fetch) {
  if (!Object.values(ENDPOINTS).includes(url)) throw new Error(`Refusing unexpected URL: ${url}`);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new Error(`GET ${url} failed: ${reason}`);
  }
  if (!response?.ok) throw new Error(`GET ${url}: HTTP ${response?.status ?? 'error'}`);
  let text;
  try {
    text = await response.text();
  } catch {
    throw new Error(`GET ${url} failed: unreadable body`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${url}: response is not JSON`);
  }
}

export function buildSnapshots({ catalog, models, pricing, fetchedAt }) {
  let nextCatalog;
  let nextModels;
  try {
    nextCatalog = catalogSnapshot(catalog, fetchedAt);
  } catch (err) {
    throw new Error(`Malformed catalog response: ${err.message}`);
  }
  try {
    nextModels = modelsSnapshot(models, pricing, fetchedAt);
  } catch (err) {
    throw new Error(`Malformed models response: ${err.message}`);
  }
  if (!Array.isArray(nextCatalog.excluded) || nextCatalog.excluded.join('\0') !== EXCLUDED_MODALITIES.join('\0')) {
    throw new Error('Malformed catalog response: exclusions changed');
  }
  if (nextCatalog.data.some(entry => EXCLUDED_MODALITIES.includes(entry.modality))) {
    throw new Error('Malformed catalog response: excluded modality remained');
  }
  return { catalog: nextCatalog, models: nextModels };
}

export async function refreshFromPayloads({ catalog, models, pricing, fetchedAt, previousCatalog, previousModels, branchCatalog = null, branchModels = null, write }) {
  const built = buildSnapshots({ catalog, models, pricing, fetchedAt });
  const catalogFetchedAt = reusedFetchedAt(built.catalog, branchCatalog) ?? fetchedAt;
  const modelsFetchedAt = reusedFetchedAt(built.models, branchModels) ?? fetchedAt;
  const next = {
    catalog: { ...built.catalog, fetchedAt: catalogFetchedAt },
    models: { ...built.models, fetchedAt: modelsFetchedAt },
  };
  const plan = assessRefresh({
    previousCatalog,
    nextCatalog: next.catalog,
    previousModels,
    nextModels: next.models,
  });
  if (plan.changed) {
    if (typeof write !== 'function') throw new Error('Refusing to refresh without a writer');
    await write({ catalog, models, pricing, catalogFetchedAt, modelsFetchedAt, next });
  }
  return plan;
}

export function formatSummary(plan) {
  const excluded = EXCLUDED_MODALITIES.join(', ');
  if (!plan.changed) {
    return [
      '## Catalog snapshot',
      '',
      'No content changes. The public unpaid endpoints match the committed snapshot, aside from the capture time. No pull request was opened.',
      '',
      `Excluded modalities stay ${excluded}.`,
      '',
    ].join('\n');
  }
  return [
    '## Catalog snapshot',
    '',
    'Automated refresh of the committed website catalog from the public unpaid endpoints. This pull request does not merge.',
    '',
    'After the push, this workflow dispatches the Security gate on `bot/catalog-snapshot`. A pull request opened by GITHUB_TOKEN does not start that workflow by itself. If the checks do not appear, reopen this pull request from a user account.',
    '',
    `- GET ${ENDPOINTS.catalog}`,
    `- GET ${ENDPOINTS.models}`,
    `- GET ${ENDPOINTS.pricing}`,
    '',
    `Captured at ${plan.fetchedAt}.`,
    `Excluded modalities stay ${excluded}.`,
    '',
    '### Catalog',
    '',
    `Count: ${plan.catalog.previous} -> ${plan.catalog.next}.`,
    `Added: ${formatIds(plan.catalog.added)}.`,
    `Removed: ${formatIds(plan.catalog.removed)}.`,
    `Modality counts: ${formatCounts(plan.catalogCounts.previous, plan.catalogCounts.next)}.`,
    '',
    '### Priced model pages',
    '',
    `Count: ${plan.models.previous} -> ${plan.models.next}.`,
    `Added: ${formatIds(plan.models.added)}.`,
    `Removed: ${formatIds(plan.models.removed)}.`,
    '',
  ].join('\n');
}

export function commitMessage(plan) {
  return `Refresh website catalog snapshot\n\n${formatSummary(plan)}`;
}

function formatIds(ids) {
  return ids.length ? ids.join(', ') : 'none';
}

function formatCounts(previous, next) {
  const keys = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])].sort();
  if (!keys.length) return 'none';
  return keys.map(key => `${key} ${previous?.[key] ?? 0} -> ${next?.[key] ?? 0}`).join(', ');
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => reject(new Error(`Could not run ${args[0]}`)));
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${args[0]} failed`))));
  });
}

function readBranchSnapshot(file) {
  const result = spawnSync('git', ['show', `origin/bot/catalog-snapshot:${file}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function writeSnapshots({ catalog, models, pricing, catalogFetchedAt, modelsFetchedAt, next, previousCatalog, previousModels }) {
  const catalogChanged = canonicalSnapshot(previousCatalog) !== canonicalSnapshot(next.catalog);
  const modelsChanged = canonicalSnapshot(previousModels) !== canonicalSnapshot(next.models);
  const dir = await mkdtemp(path.join(tmpdir(), 'catalog-refresh-'));
  try {
    if (catalogChanged) {
      const file = path.join(dir, 'catalog.json');
      await writeFile(file, JSON.stringify(catalog));
      await runNode(['scripts/catalog-snapshot.mjs', file, catalogFetchedAt]);
      const written = JSON.parse(await readFile(catalogOut, 'utf8'));
      if (written.fetchedAt !== catalogFetchedAt || canonicalSnapshot(written) !== canonicalSnapshot(next.catalog)) {
        throw new Error('Catalog snapshot script wrote unexpected content');
      }
    }
    if (modelsChanged) {
      const modelsFile = path.join(dir, 'models.json');
      const pricingFile = path.join(dir, 'pricing.json');
      await writeFile(modelsFile, JSON.stringify(models));
      await writeFile(pricingFile, JSON.stringify(pricing));
      await runNode(['scripts/models-snapshot.mjs', '--models-input', modelsFile, '--pricing-input', pricingFile, '--fetched-at', modelsFetchedAt]);
      const written = JSON.parse(await readFile(modelsOut, 'utf8'));
      if (written.fetchedAt !== modelsFetchedAt || canonicalSnapshot(written) !== canonicalSnapshot(next.models)) {
        throw new Error('Models snapshot script wrote unexpected content');
      }
    }
    await runNode(['scripts/generate-catalog-page.mjs']);
    await runNode(['scripts/generate-model-pages.mjs']);
    await runNode(['scripts/generate-catalog-page.mjs', '--check']);
    await runNode(['scripts/generate-model-pages.mjs', '--check']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const options = { summaryOut: '', commitMessageOut: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--summary-out' && flag !== '--commit-message-out') || !value || value.startsWith('--')) {
      throw new Error('Usage: refresh-catalog-snapshot.mjs [--summary-out file] [--commit-message-out file]');
    }
    i += 1;
    if (flag === '--summary-out') options.summaryOut = value;
    else options.commitMessageOut = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fetchedAt = new Date().toISOString();
  const [catalog, models, pricing] = await Promise.all([
    fetchPublicJson(ENDPOINTS.catalog),
    fetchPublicJson(ENDPOINTS.models),
    fetchPublicJson(ENDPOINTS.pricing),
  ]);
  let previousCatalog;
  let previousModels;
  try {
    previousCatalog = JSON.parse(await readFile(catalogOut, 'utf8'));
    previousModels = JSON.parse(await readFile(modelsOut, 'utf8'));
  } catch {
    throw new Error('Committed snapshot is unreadable');
  }
  const plan = await refreshFromPayloads({
    catalog,
    models,
    pricing,
    fetchedAt,
    previousCatalog,
    previousModels,
    branchCatalog: readBranchSnapshot('website/data/catalog-snapshot.json'),
    branchModels: readBranchSnapshot('website/data/models-snapshot.json'),
    write: payload => writeSnapshots({ ...payload, previousCatalog, previousModels }),
  });
  const summary = formatSummary(plan);
  if (options.summaryOut) await writeFile(options.summaryOut, summary);
  if (options.commitMessageOut) await writeFile(options.commitMessageOut, commitMessage(plan));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  const line = plan.changed
    ? `Snapshot changed. Catalog ${plan.catalog.previous} -> ${plan.catalog.next}. Priced models ${plan.models.previous} -> ${plan.models.next}.`
    : 'No snapshot changes.';
  console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    const message = err instanceof Error ? err.message : 'Catalog refresh failed';
    console.error(message);
    process.exitCode = 1;
  });
}
