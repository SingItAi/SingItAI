import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
const site = new URL('../', import.meta.url);
const html = readFileSync(new URL('docs/claude-code/index.html', site), 'utf8');
const text = html.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
test('Claude Code guide has canonical metadata and exact verified setup commands', () => {
  assert.ok(html.includes('<title>Claude Code + SingIt MCP in 60 seconds</title>'));
  assert.ok(html.includes('<link rel="canonical" href="https://singitai.app/docs/claude-code/">'));
  for (const command of [
    'claude mcp add --transport http --scope user singit https://app.singitai.app/mcp',
    'claude mcp list',
    'singit: https://app.singitai.app/mcp (HTTP) - ✔ Connected',
    'export SINGIT_API_KEY=sk_singit_...',
    'claude mcp remove singit --scope user',
    "claude mcp add --transport http --scope user singit https://app.singitai.app/mcp --header 'Authorization: Bearer ${SINGIT_API_KEY}'",
    'codex mcp add singit --url https://app.singitai.app/mcp',
  ]) assert.ok(text.includes(command), command);
  assert.doesNotMatch(html, /Telegram|0x[0-9a-f]+|(?:owner|founder|contact person):\s+[A-Z][a-z]+/i);
  for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"#]+)"/g)) {
    const path = href.split(/[?#]/)[0];
    assert.ok(existsSync(new URL('.' + path + (path.endsWith('/') ? 'index.html' : ''), site)), path);
  }
});
test('free and paid claims agree with the repository and stay within SingIt', () => {
  const mcp = readFileSync(new URL('../../sign402-gateway/sign402_gateway/web_mcp.py', import.meta.url), 'utf8');
  for (const name of ['chat_free', 'chat', 'list_models', 'get_limits', 'get_receipts']) {
    assert.ok(mcp.includes(`"name": "${name}"`));
    assert.ok(text.includes(name));
  }
  for (const claim of ['400 tokens', 'billing.remainingToday', 'billing.resetsAt', 'shared daily budget', 'midnight UTC', '60 requests a minute per key', 'per address without a key', 'Missing environment variables: SINGIT_API_KEY', 'before anything is charged', 'do not protect an agent’s own wallet']) assert.ok(text.includes(claim), claim);
  assert.doesNotMatch(html, /\$\d|\d%|0\.1\.[345]/);
});
