import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const root = new URL('../../', import.meta.url);
const read = p => readFile(new URL(p, root), 'utf8');
const binding = 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http';
const forbidden = /0x[0-9a-f]{40}|video|no admin|AI team|run by bots|cheaper per token|protected by AgentAllowance/i;
async function servedTools() {
  const mcp = await read('sign402-gateway/sign402_gateway/web_mcp.py');
  const server = await read('sign402-gateway/sign402_gateway/server.py');
  const hidden = [...mcp.match(/MCP_HIDDEN_TOOLS = frozenset\(\{([^}]*)\}\)/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
  return new Set([...mcp.matchAll(/^\s+\{"name": "(\w+)", "description"/gm), ...server.matchAll(/"mcpStyleName": "(\w+)"/g)].map(m => m[1]).filter(n => !hidden.includes(n)));
}
test('discovery card declares MCP only, with required AgentCard fields', async () => {
  const card = JSON.parse(await read('website/.well-known/agent-card.json'));
  for (const field of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(card[field]);
  for (const field of ['name', 'description', 'version']) assert.equal(typeof card[field], 'string');
  assert.deepEqual(card.supportedInterfaces, [{url:'https://app.singitai.app/mcp', protocolBinding:binding, protocolVersion:'2025-06-18'}]);
  assert.deepEqual(card.capabilities, {});
  assert.match(card.description, /not an A2A task endpoint/);
  assert.match(card.description, /MCP version/);
  assert.ok(card.provider.organization && card.provider.url && card.documentationUrl);
  for (const field of ['defaultInputModes', 'defaultOutputModes']) assert.ok(Array.isArray(card[field]) && card[field].length);
  assert.equal(new Set(card.skills.map(s => s.id)).size, card.skills.length);
  assert.deepEqual(card.skills.map(s => s.id), ['free-model-answers','paid-model-answers-x402','web-search-and-page-reading','price-lookups','key-spending-limits']);
  for (const s of card.skills) {
    for (const f of ['id','name','description']) assert.equal(typeof s[f], 'string');
    assert.match(s.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(s.tags.length && s.tags.every(t => typeof t === 'string' && t.length));
  }
  assert.doesNotMatch(JSON.stringify(card), /JSONRPC|GRPC|HTTP\+JSON/);
  // The mandated custom protocol identifier is external; service URLs stay on SingIt.
  function urls(value) {
    if (typeof value === 'string' && value.startsWith('https://') && value !== binding) {
      const u = new URL(value); assert.equal(u.protocol, 'https:');
      assert.ok(['singitai.app','ask.singitai.app','app.singitai.app'].includes(u.hostname));
    } else if (value && typeof value === 'object') for (const v of Object.values(value)) urls(v);
  }
  urls(card);
});
test('skill and key guide name real tools and preserve limits and refusal wording', async () => {
  const skill = await read('website/SKILL.md');
  const page = await read('website/docs/mcp-key/index.html');
  assert.match(skill, /^---\nname: singit\ndescription: .+\n---/);
  assert.ok(skill.split('\n').length < 150);
  assert.doesNotMatch(skill + page, forbidden);
  const tools = await servedTools();
  const toolRows = skill.split('\n').filter(l => /^\| (?:get_|list_|web_|read_|resolve_)/.test(l));
  const listed = toolRows.flatMap(l => l.split('|')[1].trim().split(', '));
  assert.deepEqual([...listed].sort(), [...tools].sort());
  const candidates = new Set((skill + page.replace(/<[^>]+>/g, '')).match(/\b(?:get|list|web|read|resolve)_[a-z_]+\b/g));
  for (const name of candidates) assert.ok(tools.has(name), name);
  for (const [, tool] of page.matchAll(/data-mcp-tool="([^"]+)"/g)) assert.ok(tools.has(tool));
  const keys = await read('sign402-gateway/sign402_gateway/web_api_keys.py');
  const parts = keys.match(/raise ApiError\(429, f"(This key's daily limit[^"\n]+)"\n\s+"([^"\n]+)"/);
  const message = (parts[1] + parts[2]).replace('{daily / 1e6:g}', '0.01');
  const refusal = page.match(/<blockquote data-refusal>([^<]+)<\/blockquote>/)[1];
  assert.ok(message.includes(refusal));
  for (const text of [skill, page]) {
    assert.match(text.replace(/\s+/g, ' '), /not limit (?:what an agent spends anywhere else|spending elsewhere)/);
    assert.match(text, /not protect other people's/);
  }
});
test('onboarding files have content types, CORS and survive the static build', async () => {
  const headers = await read('website/_headers');
  const out = await mkdtemp(join(tmpdir(), 'singit-onboarding-'));
  try {
    const argv = process.argv;
    try {
      process.argv = [process.execPath, new URL('website/build.mjs', root).pathname, out];
      await import(new URL('../build.mjs?onboarding', import.meta.url));
    } finally { process.argv = argv; }
    for (const [path, type] of [['/SKILL.md','text/markdown'], ['/.well-known/agent-card.json','application/json']]) {
      assert.ok(headers.includes(`${path}\n  Content-Type: ${type}; charset=utf-8\n  Access-Control-Allow-Origin: *`));
      assert.equal(await readFile(join(out, path), 'utf8'), await read('website' + path));
      assert.ok((await read('website/llms.txt')).includes('https://singitai.app' + path));
      assert.ok(!(await read('website/sitemap.xml')).includes(path));
    }
  } finally { await rm(out, { recursive:true, force:true }); }
});

test('Claude Code headers preserve the environment reference in onboarding docs', async () => {
  const command = "claude mcp add --transport http singit https://app.singitai.app/mcp --header 'Authorization: Bearer ${SINGIT_API_KEY}'";
  const explanation = "Single quotes keep ${SINGIT_API_KEY} as a reference so the key is not written into Claude Code's configuration.";
  for (const path of ['website/SKILL.md', 'website/llms.txt', 'website/llms-full.txt']) {
    const doc = await read(path);
    const commands = doc.split('\n').filter(line => line.includes('claude mcp add'));
    assert.ok(commands.length > 0, path);
    for (const line of commands) assert.ok(line.endsWith(command), path);
    assert.ok(doc.includes(explanation), path);
  }
});
