import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addAgentFiles } from '../../singit-ask/src/agent-files.mjs';

test('Ask document allowlist exists in website and matches Pages content types', async () => {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  const handler = [];
  addAgentFiles({ use(fn) { handler.push(fn); } });
  for (const [path, type] of [
    ['/SKILL.md', 'text/markdown; charset=utf-8'],
    ['/.well-known/agent-card.json', 'application/json; charset=utf-8'],
    ['/llms-models.txt', 'text/plain; charset=utf-8'],
    ['/llms-full.txt', 'text/plain; charset=utf-8'],
  ]) {
    const bytes = await readFile(new URL('..' + path, import.meta.url));
    assert.ok(bytes.length);
    assert.ok(headers.includes(`${path}\n  Content-Type: ${type}\n`));
    let served = false;
    await handler[0]({ path, method: 'GET' }, {
      set(values) { assert.equal(values['Content-Type'], type); },
      send(body) { assert.deepEqual(body, bytes); served = true; },
    }, () => assert.fail(`${path} missing from Ask allowlist`));
    assert.ok(served);
  }
});
