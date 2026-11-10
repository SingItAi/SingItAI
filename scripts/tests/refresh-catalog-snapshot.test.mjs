import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogResponse } from '../../singit-ask/src/catalog-shape.mjs';
import { EXCLUDED_MODALITIES } from '../catalog-snapshot.mjs';
import {
  ENDPOINTS,
  assessRefresh,
  buildSnapshots,
  canonicalSnapshot,
  commitMessage,
  countDroppedSharply,
  diffIds,
  fetchPublicJson,
  formatSummary,
  parseArgs,
  refreshFromPayloads,
  reusedFetchedAt,
} from '../refresh-catalog-snapshot.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function ids(count) {
  return Array.from({ length: count }, (_, index) => `id-${index}`);
}

function catalogOf(count, fetchedAt = '2026-11-01T00:00:00Z', extra = {}) {
  return { fetchedAt, data: ids(count).map(id => ({ id, ...extra })), counts: { chat: count } };
}

function modelsOf(count, fetchedAt = '2026-11-01T00:00:00Z', extra = {}) {
  return { fetchedAt, models: ids(count).map(id => ({ id, ...extra })) };
}

function tokenPayload(extra = []) {
  const data = Array.from({ length: 50 }, (_, index) => ({ id: `m-${index}`, usdPerMillionTokens: { input: 1, output: 2 } }));
  data.push(...extra);
  return {
    models: { object: 'list', data, fees: { markupPct: 30, perAnswerUsd: { base: 0.001, solana: 0.002 } } },
    pricing: {
      networks: { base: { chain: 'base', settlementFeeUsd: 0.001 }, solana: { chain: 'solana', settlementFeeUsd: 0.002 } },
      referenceRequest: { messages: 1, maxOutputTokens: 800 },
      models: data.filter(model => typeof model.usdPerMillionTokens !== 'number').map(model => ({
        id: model.id,
        upto: { base: { usd: 1 }, solana: { usd: 1 } },
        exact: { base: { usd: 1 }, solana: { usd: 1 } },
      })),
    },
  };
}

test('count drop allows exactly 20 percent and rejects a steeper drop', () => {
  assert.equal(countDroppedSharply(100, 80), false);
  assert.equal(countDroppedSharply(100, 79), true);
  assert.equal(countDroppedSharply(100, 150), false);
  assert.equal(countDroppedSharply(0, 10), false);
  assert.equal(countDroppedSharply(5, 4), false);
  assert.equal(countDroppedSharply(5, 3), true);
  assert.throws(() => countDroppedSharply(1.5, 1), /Invalid previous model count/);
  assert.throws(() => countDroppedSharply(10, -1), /Invalid next model count/);
});

test('assessRefresh ignores capture time, reports ids, and refuses a sharp drop', () => {
  const catalog = catalogOf(4);
  const models = modelsOf(4);
  const same = assessRefresh({
    previousCatalog: catalog,
    nextCatalog: { ...catalog, fetchedAt: '2026-11-09T06:00:00.000Z' },
    previousModels: models,
    nextModels: { ...models, fetchedAt: '2026-11-09T06:00:00.000Z' },
  });
  assert.equal(same.changed, false);
  assert.equal(canonicalSnapshot(catalog), canonicalSnapshot({ ...catalog, fetchedAt: '2026-12-01T00:00:00Z', data: catalog.data }));

  const priced = assessRefresh({
    previousCatalog: catalog,
    nextCatalog: catalog,
    previousModels: models,
    nextModels: modelsOf(4, '2026-11-09T06:00:00.000Z', { usd: 2 }),
  });
  assert.equal(priced.changed, true);
  assert.deepEqual(priced.models.added, []);
  assert.deepEqual(priced.models.removed, []);

  const edged = assessRefresh({
    previousCatalog: catalogOf(10),
    nextCatalog: catalogOf(8, '2026-11-09T06:00:00.000Z'),
    previousModels: models,
    nextModels: { ...models, fetchedAt: '2026-11-09T06:00:00.000Z' },
  });
  assert.deepEqual(edged.catalog.removed, ['id-8', 'id-9']);
  assert.equal(edged.changed, true);
  const summary = formatSummary(edged);
  assert.match(summary, /does not merge/);
  assert.match(summary, /Security gate/);
  assert.match(summary, /reopen this pull request/);
  assert.match(summary, /Added: none/);
  assert.match(summary, /Removed: id-8, id-9/);
  assert.match(summary, /chat 10 -> 8/);
  assert.match(commitMessage(edged), /^Refresh website catalog snapshot\n/);
  assert.doesNotMatch(commitMessage(edged), /Co-Authored-By/i);

  assert.throws(() => assessRefresh({
    previousCatalog: catalogOf(10),
    nextCatalog: catalogOf(7, '2026-11-09T06:00:00.000Z'),
    previousModels: models,
    nextModels: models,
  }), /Catalog count dropped from 10 to 7/);
  assert.throws(() => assessRefresh({
    previousCatalog: catalog,
    nextCatalog: catalog,
    previousModels: modelsOf(10),
    nextModels: modelsOf(7, '2026-11-09T06:00:00.000Z'),
  }), /Priced model count dropped from 10 to 7/);
  assert.throws(() => diffIds(['a', 'a'], ['a'], 'catalog'), /Invalid catalog id/);
});

test('buildSnapshots keeps exclusions and skips embedding rates', () => {
  assert.deepEqual(EXCLUDED_MODALITIES, ['video', 'music', 'sound_effects', 'transcription']);
  const catalog = catalogResponse([
    { id: 'chat-a', modality: 'chat' },
    { id: 'clip', modality: 'video' },
    { id: 'song', modality: 'music' },
    { id: 'sfx', modality: 'sound_effects' },
    { id: 'voice', modality: 'transcription' },
  ]);
  const payload = tokenPayload([{ id: 'venice-embed-1', usdPerMillionTokens: 0.1625 }]);
  payload.pricing.models.push({ id: 'venice-embed-1' });
  const built = buildSnapshots({
    catalog,
    models: payload.models,
    pricing: payload.pricing,
    fetchedAt: '2026-11-09T06:00:00.000Z',
  });
  assert.deepEqual(built.catalog.data.map(entry => entry.id), ['chat-a']);
  assert.equal(built.catalog.counts.transcription, 0);
  assert.equal(Object.hasOwn(built.catalog.counts, 'video'), false);
  assert.equal(built.models.models.some(model => model.id === 'venice-embed-1'), false);
  assert.throws(() => buildSnapshots({ catalog: { data: [] }, models: {}, pricing: {}, fetchedAt: '2026-11-09T06:00:00.000Z' }), /Malformed catalog response/);
});

test('refresh writes only a safe change and never writes a sharp drop or a bad payload', async () => {
  const payload = tokenPayload();
  const catalog = catalogResponse([{ id: 'chat-a', modality: 'chat' }]);
  const fetchedAt = '2026-11-09T06:00:00.000Z';
  const next = buildSnapshots({ catalog, models: payload.models, pricing: payload.pricing, fetchedAt });
  let writes = 0;
  const write = () => { writes += 1; };
  const previousModels = { ...next.models, fetchedAt: '2026-11-01T00:00:00Z' };
  await assert.rejects(() => refreshFromPayloads({
    catalog,
    models: payload.models,
    pricing: payload.pricing,
    fetchedAt,
    previousCatalog: catalogOf(10),
    previousModels,
    write,
  }), /Refusing to open a pull request/);
  assert.equal(writes, 0);

  const unchanged = await refreshFromPayloads({
    catalog,
    models: payload.models,
    pricing: payload.pricing,
    fetchedAt,
    previousCatalog: { ...next.catalog, fetchedAt: '2026-11-01T00:00:00Z' },
    previousModels,
    write,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(writes, 0);
  assert.match(formatSummary(unchanged), /No pull request was opened/);

  const added = catalogResponse([{ id: 'chat-a', modality: 'chat' }, { id: 'chat-b', modality: 'chat' }]);
  const changed = await refreshFromPayloads({
    catalog: added,
    models: payload.models,
    pricing: payload.pricing,
    fetchedAt,
    previousCatalog: { ...next.catalog, fetchedAt: '2026-11-01T00:00:00Z' },
    previousModels,
    write,
  });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.catalog.added, ['chat-b']);
  assert.equal(writes, 1);

  await assert.rejects(() => refreshFromPayloads({
    catalog: { data: [{ id: 'nope' }] },
    models: payload.models,
    pricing: payload.pricing,
    fetchedAt,
    previousCatalog: next.catalog,
    previousModels,
    write,
  }), /Malformed catalog response/);
  assert.equal(writes, 1);
});

test('an open refresh branch keeps its capture time when the content is unchanged', async () => {
  const payload = tokenPayload();
  const catalog = catalogResponse([{ id: 'chat-a', modality: 'chat' }]);
  const fetchedAt = '2026-11-09T06:00:00.000Z';
  const built = buildSnapshots({ catalog, models: payload.models, pricing: payload.pricing, fetchedAt });
  const branchCatalog = { ...built.catalog, fetchedAt: '2026-11-08T06:00:00.000Z' };
  const branchModels = { ...built.models, fetchedAt: '2026-11-08T06:00:00.000Z' };
  assert.equal(reusedFetchedAt(built.catalog, branchCatalog), '2026-11-08T06:00:00.000Z');
  assert.equal(reusedFetchedAt(built.catalog, { ...branchCatalog, fetchedAt: 'not-a-date' }), null);
  assert.equal(reusedFetchedAt({ ...built.catalog, data: [] }, branchCatalog), null);
  let written;
  const plan = await refreshFromPayloads({
    catalog,
    models: payload.models,
    pricing: payload.pricing,
    fetchedAt,
    previousCatalog: catalogOf(1),
    previousModels: { ...built.models, fetchedAt: '2026-11-01T00:00:00Z' },
    branchCatalog,
    branchModels,
    write: payloadWrite => { written = payloadWrite; },
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.fetchedAt, '2026-11-08T06:00:00.000Z');
  assert.equal(written.catalogFetchedAt, '2026-11-08T06:00:00.000Z');
  assert.equal(written.modelsFetchedAt, '2026-11-08T06:00:00.000Z');
});

test('public fetch is a credential-free GET and hides error bodies', async () => {
  let seen;
  const body = await fetchPublicJson(ENDPOINTS.catalog, async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, text: async () => '{"counts":{}}' };
  });
  assert.deepEqual(body, { counts: {} });
  assert.equal(seen.url, ENDPOINTS.catalog);
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.redirect, 'manual');
  assert.deepEqual(seen.options.headers, { accept: 'application/json' });
  assert.equal(JSON.stringify(seen.options).includes('authorization'), false);
  await assert.rejects(() => fetchPublicJson('https://example.com/secret', async () => ({ ok: true, status: 200, text: async () => '{}' })), /unexpected URL/);
  await assert.rejects(() => fetchPublicJson(ENDPOINTS.models, async () => ({ ok: false, status: 402, text: async () => 'payment-secret' })), err => {
    assert.match(err.message, /HTTP 402/);
    assert.equal(err.message.includes('payment-secret'), false);
    return true;
  });
  await assert.rejects(() => fetchPublicJson(ENDPOINTS.pricing, async () => ({ ok: true, status: 200, text: async () => 'not-json-secret' })), err => {
    assert.match(err.message, /not JSON/);
    assert.equal(err.message.includes('not-json-secret'), false);
    return true;
  });
  await assert.rejects(() => fetchPublicJson(ENDPOINTS.catalog, async () => { throw new Error('proxy secret'); }), /network error/);
  assert.throws(() => parseArgs(['--nope']), /Usage/);
});

test('workflow refreshes on a daily schedule and does not publish or merge', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/catalog-snapshot.yml', import.meta.url), 'utf8');
  const opener = await readFile(new URL('../open-catalog-snapshot-pr.sh', import.meta.url), 'utf8');
  const header = workflow.split(/^jobs:/m)[0];
  assert.match(header, /workflow_dispatch:/);
  assert.match(header, /cron: "17 6 \* \* \*"/);
  assert.doesNotMatch(header, /pull_request|push:/);
  assert.match(header, /contents: write/);
  assert.match(header, /pull-requests: write/);
  assert.match(header, /actions: write/);
  assert.match(header, /bot\/catalog-snapshot/);
  assert.match(opener, /branch="bot\/catalog-snapshot"/);
  assert.match(workflow, /refresh-catalog-snapshot\.mjs/);
  assert.match(workflow, /github\.token/);
  assert.doesNotMatch(workflow, /secrets\.|gh pr merge|workflow_dispatch:[\s\S]*push:/);
  assert.doesNotMatch(`${workflow}\n${opener}`, /--force|pull_request_target|x402\/invoice|PAYMENT-SIGNATURE/);
  assert.match(opener, /git push origin "HEAD:\$\{branch\}"/);
  assert.match(opener, /gh workflow run security-gate\.yml --ref "\$branch"/);
  assert.match(opener, /No snapshot changes/);
});

test('pull request script fast-forwards one branch and skips a clean tree', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'catalog-pr-'));
  const bare = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  const bin = path.join(dir, 'bin');
  const ghLog = path.join(dir, 'gh.log');
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr list") printf '%s\\n' "\${FAKE_PR_NUMBER:-}" ;;
  "pr close"|"pr create"|"pr edit"|"workflow run") ;;
  *) echo "unexpected gh: $*" >&2; exit 2 ;;
esac
`);
    await chmod(path.join(bin, 'gh'), 0o755);
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GH_LOG: ghLog,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const git = (args, cwd) => {
      const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    git(['init', '--bare', '-b', 'main', bare]);
    git(['init', '-b', 'main', work]);
    git(['config', 'user.name', 'Test'], work);
    git(['config', 'user.email', 'test@example.com'], work);
    const paths = [
      'website/data/catalog-snapshot.json', 'website/data/models-snapshot.json', 'website/models/keep/index.html',
      'website/models/old/index.html', 'website/sitemap.xml', 'website/llms.txt', 'website/llms-models.txt',
      'website/llms-full.txt', 'website/_redirects', 'website/index.html', 'website/x402-llm-api/index.html',
      'website/.well-known/agent-card.json', 'website/agent-spending-limits/index.html',
      'website/limit-ai-agent-spending/index.html', 'website/x402-budget-for-agents/index.html',
    ];
    for (const file of paths) {
      await mkdir(path.join(work, path.dirname(file)), { recursive: true });
      await writeFile(path.join(work, file), 'one\n');
    }
    git(['add', '.'], work);
    git(['commit', '-m', 'base'], work);
    git(['remote', 'add', 'origin', bare], work);
    git(['push', '-u', 'origin', 'main'], work);

    await writeFile(path.join(work, 'website/data/catalog-snapshot.json'), 'two\n');
    await writeFile(path.join(work, 'website/models/keep/index.html'), 'kept\n');
    await rm(path.join(work, 'website/models/old/index.html'));
    const summary = path.join(dir, 'summary.md');
    const commitFile = path.join(dir, 'commit.txt');
    await writeFile(summary, 'summary body\n');
    await writeFile(commitFile, 'Refresh website catalog snapshot\n\nCatalog changed.\n');
    const scriptEnv = {
      ...gitEnv,
      BASE_BRANCH: 'main',
      GITHUB_REPOSITORY: 'example/repo',
      SUMMARY_FILE: summary,
      COMMIT_FILE: commitFile,
      GH_TOKEN: 'not-a-real-token',
      FAKE_PR_NUMBER: '',
    };
    const first = spawnSync('sh', [path.join(repoRoot, 'scripts/open-catalog-snapshot-pr.sh')], { cwd: work, env: scriptEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const refreshed = git(['ls-tree', '-r', '--name-only', 'origin/bot/catalog-snapshot'], work);
    assert.equal(refreshed.includes('website/models/old/index.html'), false);
    assert.equal(git(['show', 'origin/bot/catalog-snapshot:website/data/catalog-snapshot.json'], work), 'two');
    assert.equal(git(['show', 'origin/bot/catalog-snapshot:website/models/keep/index.html'], work), 'kept');
    const message = git(['log', '-1', '--format=%B', 'origin/bot/catalog-snapshot'], work);
    assert.match(message, /Refresh website catalog snapshot/);
    assert.doesNotMatch(message, /Co-Authored-By/i);
    const created = await readFile(ghLog, 'utf8');
    assert.match(created, /pr create/);
    assert.doesNotMatch(created, /pr merge|--force/);
    const firstTip = git(['rev-parse', 'origin/bot/catalog-snapshot'], work);

    git(['checkout', 'main'], work);
    await writeFile(ghLog, '');
    const clean = spawnSync('sh', [path.join(repoRoot, 'scripts/open-catalog-snapshot-pr.sh')], {
      cwd: work,
      env: { ...scriptEnv, FAKE_PR_NUMBER: '7' },
      encoding: 'utf8',
    });
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
    assert.equal(git(['rev-parse', 'origin/bot/catalog-snapshot'], work), firstTip);
    const closed = await readFile(ghLog, 'utf8');
    assert.match(closed, /pr close 7/);
    assert.doesNotMatch(closed, /pr create/);

    git(['checkout', 'main'], work);
    await writeFile(path.join(work, 'website/data/catalog-snapshot.json'), 'three\n');
    await writeFile(ghLog, '');
    const second = spawnSync('sh', [path.join(repoRoot, 'scripts/open-catalog-snapshot-pr.sh')], {
      cwd: work,
      env: scriptEnv,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const secondTip = git(['rev-parse', 'origin/bot/catalog-snapshot'], work);
    assert.notEqual(secondTip, firstTip);
    git(['merge-base', '--is-ancestor', firstTip, secondTip], work);
    assert.equal(git(['show', 'origin/bot/catalog-snapshot:website/data/catalog-snapshot.json'], work), 'three');
    const updated = await readFile(ghLog, 'utf8');
    assert.match(updated, /pr create/);
    assert.doesNotMatch(updated, /--force/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
