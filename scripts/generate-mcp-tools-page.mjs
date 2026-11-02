import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { e, classifyTool } from './generate-mcp-page.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const groups = [
  'Free lookups',
  'Chat, paid per call, no extra scope, USDC on Base or Solana',
  'Your account, free and read-only, needs a key',
  'Web, paid per call, search scope, USDC on Base or Solana',
  'Market and data, paid per call, tools scope, Base accounts for now',
];
export function toolGroup(name) {
  const { access } = classifyTool(name);
  return access[0] === 'No' ? 0 : name === 'chat' ? 1 : access[0] === 'Yes; free, read-only' ? 2 : access[1] === 'search' ? 3 : 4;
}
export function renderGroupOverview(data) {
  return `<div class="table-wrap"><table class="mtable">\n<caption>Tool groups</caption>\n<thead><tr><th>Group</th><th>Tools</th><th>Key</th><th>Scope</th><th>Network</th></tr></thead>\n<tbody>\n${groups.map((group, i) => {
    const tools = data.result.tools.filter(t => toolGroup(t.name) === i);
    const { access, network } = classifyTool(tools[0].name);
    return `<tr><th scope="row">${e(group)}</th><td>${tools.map(t => `<a href="#${e(t.name)}"><code>${e(t.name)}</code></a>`).join(', ')}</td><td>${e(access[0])}</td><td>${e(access[1])}</td><td>${e(network)}</td></tr>`;
  }).join('\n')}\n</tbody></table></div>`;
}
export function renderToolsReference(data) {
  let previous = -1;
  return data.result.tools.map(tool => {
    const group = toolGroup(tool.name);
    const heading = group !== previous ? `<h2 class="section-title">${e(groups[group])}</h2>\n` : '';
    previous = group;
    const rows = Object.entries(tool.inputSchema.properties ?? {}).map(([name, schema]) => {
      const bounds = ['minimum', 'maximum'].filter(k => schema[k] !== undefined).map(k => `${k}: ${schema[k]}`).join('; ');
      return `<tr><th scope="row"><code>${e(name)}</code></th><td>${e(schema.type ?? 'unspecified')}</td><td>${e((tool.inputSchema.required ?? []).includes(name) ? 'required' : 'optional')}</td><td>${schema.enum?.map(v => `<code>${e(v)}</code>`).join(', ') || 'None'}</td><td>${e(schema.description ?? '')}${bounds ? ` ${e(bounds)}` : ''}</td></tr>`;
    });
    const params = rows.length ? `<div class="table-wrap"><table class="mtable">\n<caption>${e(tool.name)} parameters</caption>\n<thead><tr><th>Name</th><th>Type</th><th>Required/optional</th><th>Allowed values</th><th>Description and bounds</th></tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody></table></div>` : '<p class="lp-text">Parameters: None</p>';
    const { access, network } = classifyTool(tool.name);
    return `${heading}<h3 id="${e(tool.name)}">${e(tool.name)}</h3>\n<p class="lp-text">${e(tool.description)}</p>\n${params}\n<p class="lp-text">Key needed? ${e(access[0])}; scope: ${e(access[1])}; network: ${e(network)}; readOnlyHint: ${e(tool.annotations.readOnlyHint)}; idempotentHint: ${e(tool.annotations.idempotentHint)}.</p>`;
  }).join('\n');
}
export async function generate(check = false) {
  const file = path.join(root, 'website/docs/mcp-tools/index.html');
  const html = await readFile(file, 'utf8');
  const data = JSON.parse(await readFile(path.join(root, 'website/data/mcp-tools.json'), 'utf8'));
  let expected = html;
  for (const [name, content] of [['mcp-tools-overview', renderGroupOverview(data)], ['mcp-tools-reference', renderToolsReference(data)]]) {
    const pattern = new RegExp(`<!-- generated:${name}:start -->[\\s\\S]*?<!-- generated:${name}:end -->`);
    if (!pattern.test(expected)) throw new Error(`Missing ${name} generation markers`);
    expected = expected.replace(pattern, () => `<!-- generated:${name}:start -->\n${content}\n<!-- generated:${name}:end -->`);
  }
  if (check && expected !== html) throw new Error('MCP tools reference is stale: run node scripts/generate-mcp-tools-page.mjs');
  if (!check && expected !== html) await writeFile(file, expected);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate(process.argv.includes('--check'));
}
