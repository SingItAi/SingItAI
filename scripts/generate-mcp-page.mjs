import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderTools(data) {
  const free = new Set(['get_price', 'list_price_symbols', 'list_models']);
  const account = new Set(['get_balance', 'get_limits', 'get_receipts']);
  const search = new Set(['web_search', 'read_page']);
  const rows = data.result.tools.map(tool => {
    // Protect the abbreviation used in the live descriptions before splitting.
    const protectedText = tool.description.replaceAll('e.g.', 'e&#46;g&#46;');
    const first = (protectedText.match(/^.*?\.(?=\s|$)/)?.[0] ?? protectedText).replaceAll('e&#46;g&#46;', 'e.g.');
    const params = Object.entries(tool.inputSchema.properties ?? {}).map(([name, schema]) => `<code>${e(name)}</code>: ${e(schema.type ?? 'unspecified')}, ${(tool.inputSchema.required ?? []).includes(name) ? 'required' : 'optional'}`).join('<br>') || 'None';
    const access = free.has(tool.name) ? ['No', 'Free; none'] : account.has(tool.name) ? ['Yes; free, read-only', 'Account read; no paid-tool scope'] : ['Yes; paid', search.has(tool.name) ? 'search' : 'tools'];
    const network = free.has(tool.name) ? 'No payment' : account.has(tool.name) ? 'Account data' : search.has(tool.name) ? 'USDC on Base or Solana' : 'USDC on Base only for now';
    const annotations = `readOnlyHint: ${tool.annotations.readOnlyHint}; idempotentHint: ${tool.annotations.idempotentHint}`;
    return `<tr><th scope="row"><code>${e(tool.name)}</code></th><td>${e(first)}</td><td>${params}</td><td>${e(access[0])}</td><td>${e(access[1])}</td><td>${e(network)}</td><td>${e(annotations)}</td></tr>`;
  });
  return `<div class="table-wrap"><table class="mtable">\n<caption>16 tools from the keyless tools/list snapshot. Paid tools are paid per call within the key's caps; get_limits shows spent and remaining today.</caption>\n<thead><tr><th>Tool</th><th>What it does</th><th>Parameters</th><th>Needs a key?</th><th>Scope</th><th>Network</th><th>Annotation hints</th></tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody></table></div>`;
}
export async function generate(check = false) {
  const file = path.join(root, 'website/docs/mcp/index.html');
  const html = await readFile(file, 'utf8');
  const data = JSON.parse(await readFile(path.join(root, 'website/data/mcp-tools.json'), 'utf8'));
  const pattern = /<!-- generated:mcp-tools:start -->[\s\S]*?<!-- generated:mcp-tools:end -->/;
  if (!pattern.test(html)) throw new Error('Missing MCP generation markers');
  const expected = html.replace(pattern, `<!-- generated:mcp-tools:start -->\n${renderTools(data)}\n<!-- generated:mcp-tools:end -->`);
  if (check && expected !== html) throw new Error('MCP table is stale: run node scripts/generate-mcp-page.mjs');
  if (!check && expected !== html) await writeFile(file, expected);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate(process.argv.includes('--check'));
}
