import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = readFileSync(fileURLToPath(new URL('../../llms-install.md', import.meta.url)), 'utf8');

test('llms-install.md has a Cline block that selects Streamable HTTP', () => {
  const section = text.split('\n## Cline\n')[1];
  assert.ok(section, 'a "## Cline" section exists');
  const config = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]).mcpServers.singit;
  // Cline falls back to legacy SSE without `type`, and this endpoint answers GET with 405.
  assert.equal(config.type, 'streamableHttp');
  assert.equal(config.url, 'https://app.singitai.app/mcp');
  assert.equal(config.headers.Authorization, 'Bearer ${env:SINGIT_API_KEY}');
  assert.deepEqual(config.autoApprove, []);
});

test('the generic block stays first and unchanged in shape', () => {
  const generic = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]).mcpServers.singit;
  assert.equal(generic.url, 'https://app.singitai.app/mcp');
  assert.ok(!('type' in generic));
});
