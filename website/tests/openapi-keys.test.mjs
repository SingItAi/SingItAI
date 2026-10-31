import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const raw = read('../openapi-keys.json');
const spec = JSON.parse(raw);
const keys = read('../../sign402-gateway/sign402_gateway/web_api_keys.py');
const proxy = read('../../sign402-gateway/sign402_gateway/web_api_proxy.py');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

test('key spec has OpenAPI 3.1 structure, local references and secured unique operations', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, 'https://app.singitai.app/v1');
  assert.ok(spec.info.title && spec.info.version && spec.info.description);
  assert.equal(spec.components.securitySchemes.BearerKey.scheme, 'bearer');
  assert.equal(spec.components.securitySchemes.HeaderKey.name, 'x-api-key');
  const ids = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    assert.ok(path.startsWith('/') && !path.startsWith('/v1/'));
    for (const [method, op] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      assert.ok(op.operationId && !ids.has(op.operationId), `${path}: unique operationId`);
      ids.add(op.operationId);
      assert.match(op.summary, /^(Create|Count|Generate|Transcribe|Search|Retrieve|Answer|List|Read) /);
      assert.ok(op.responses?.['200']);
      assert.ok(op.security?.length);
      for (const requirement of op.security) for (const scheme of Object.keys(requirement)) {
        assert.ok(spec.components.securitySchemes[scheme]);
      }
      for (const status of ['401', '403', '404']) assert.ok(op.responses[status]);
    }
  }
  assert.equal(ids.size, 13);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'));
      let target = spec;
      for (const part of value.$ref.slice(2).split('/')) target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      assert.ok(target, `resolve ${value.$ref}`);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(spec);
});

test('each documented method/path exists in parsed gateway dispatch or route tables', () => {
  const routes = proxy.match(/^ROUTES = \{([\s\S]*?)^\}/m)?.[1];
  const searches = keys.match(/^SEARCH_PATHS = \(([^\n]*)\)/m)?.[1];
  assert.ok(routes && searches);
  const posts = new Set([...routes.matchAll(/^\s*"([^"]+)":/gm), ...searches.matchAll(/"([^"]+)"/g)].map(m => m[1]));
  for (const match of keys.matchAll(/method == "(GET|POST)" and path == "([^"]+)"/g)) {
    if (match[1] === 'POST') posts.add(match[2]);
  }
  // Only public dispatch, not session-management paths above it.
  const publicCode = keys.slice(keys.indexOf('    def _public('), keys.indexOf('    def _search('));
  const gets = new Set([...publicCode.matchAll(/method == "GET" and path == "([^"]+)"/g)].map(m => m[1]));
  const expected = ['/chat/completions', '/responses', '/messages', '/messages/count_tokens', '/images/generations', '/audio/speech', '/audio/transcriptions', '/exa/search', '/exa/contents', '/exa/answer', '/models', '/balance', '/usage'];
  assert.deepEqual(Object.keys(spec.paths).sort(), expected.sort());
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) assert.ok((method === 'post' ? posts : gets).has(path), `${method} ${path}`);
  }
});

test('key spec excludes forbidden content and preserves sourced examples and limits', () => {
  assert.doesNotMatch(raw, /video|no admin|0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/i);
  assert.match(spec.info.description, /60 requests\/minute/);
  assert.match(keys, /REQUESTS_PER_MINUTE = 60/);
  assert.match(spec.info.description, /https:\/\/ask\.singitai\.app\/openapi\.json/);
  const example = spec.paths['/chat/completions'].post.responses['200'].content['application/json'].example;
  const tests = read('../../sign402-gateway/tests/test_api_keys.py');
  assert.equal(example.choices[0].message.content, 'Hello!');
  assert.deepEqual(example.usage, { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
  assert.ok(tests.includes('"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12'));
  assert.equal(example.billing.chargedAtomic, 7100);
  assert.ok(spec.paths['/audio/transcriptions'].post.requestBody.content['multipart/form-data']);
  assert.ok(spec.paths['/messages'].post.requestBody.content['application/json'].example.max_tokens);
});

test('discovery redirects preserve existing routes and JSON response headers', () => {
  const rules = read('../_redirects').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/));
  assert.ok(rules.every(r => r.length === 3 && /^30[12]$/.test(r[2])));
  assert.equal(new Set(rules.map(r => r[0])).size, rules.length);
  for (const [source, target, status] of [
    ['/.well-known/x402', 'https://ask.singitai.app/.well-known/x402', '302'],
    ['/openapi.json', 'https://ask.singitai.app/openapi.json', '302'],
    ['/numbers.json', 'https://ask.singitai.app/numbers.json', '302'],
    ['/app', 'https://app.singitai.app/app/', '302'],
    ['/app/*', 'https://app.singitai.app/app/:splat', '302'],
    ['/ai-agent-spending-limit', '/agent-spending-limits/', '301'],
    ['/ai-agent-spending-limit/', '/agent-spending-limits/', '301'],
  ]) assert.deepEqual(rules.find(r => r[0] === source), [source, target, status]);
  assert.ok(!rules.some(r => r[0] === '/*'));
  const block = read('../_headers').match(/^\/openapi-keys\.json\n((?:[ \t]+[^\n]+\n?)+)/m)?.[1];
  assert.match(block, /Content-Type: application\/json; charset=utf-8/i);
  assert.match(block, /Access-Control-Allow-Origin: \*/i);
});
