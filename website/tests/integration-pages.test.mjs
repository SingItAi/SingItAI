import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const site = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(path.join(site, file), 'utf8');
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[e] ?? String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2),16) : Number(e.slice(1)))));
function htmlFiles(dir) {
  return readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? htmlFiles(path.join(dir,e.name)) : e.name.endsWith('.html') ? [path.join(dir,e.name)] : []);
}
const files = htmlFiles(site);
const hub = read('integrations/index.html');
const dailyMessage = "This key's daily limit of 1 USDC is used up, counting requests still running. It starts again at 00:00 UTC, or raise it with a new key.";
for (const [slug,title] of [
  ['langchain','SingIt with LangChain (Python) | SingIt'],
  ['litellm','SingIt with LiteLLM | SingIt'],
  ['openai-agents','SingIt with the OpenAI Agents SDK | SingIt'],
]) {
  const file = path.join(site,`integrations/${slug}/index.html`);
  const page = readFileSync(file,'utf8');
  const url = `https://singitai.app/integrations/${slug}/`;
  test(`${slug}: metadata, breadcrumbs and sitemap`, () => {
    assert.equal(page.match(/<title>(.*?)<\/title>/)[1],title);
    const description = unescape(page.match(/name="description" content="([^"]*)"/)[1]);
    assert.ok(title.length > 0 && title.length <= 60);
    assert.ok(description.length > 0 && description.length <= 155);
    for (const other of files.filter(f=>f!==file)) assert.ok(!readFileSync(other,'utf8').includes(`<title>${title}</title>`),other);
    assert.ok(page.includes(`<link rel="canonical" href="${url}">`));
    for (const [property,content] of [['title',title],['description',description],['url',url]]) {
      assert.equal(unescape(page.match(new RegExp(`property="og:${property}" content="([^"]*)"`))[1]),content);
    }
    const graph = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    const web = graph.find(x=>x['@type']==='WebPage');
    const crumbs = graph.find(x=>x['@type']==='BreadcrumbList');
    assert.equal(web.url,url); assert.equal(web.name,title); assert.equal(web.description,description);
    assert.equal(web['@id'],url+'#webpage'); assert.equal(web.breadcrumb['@id'],crumbs['@id']);
    assert.equal(crumbs['@id'],url+'#breadcrumb');
    assert.deepEqual(crumbs.itemListElement.map(x=>[x.position,x.item]), [[1,'https://singitai.app/developers/'],[2,'https://singitai.app/integrations/'],[3,url]]);
    assert.ok(read('sitemap.xml').includes(`<loc>${url}</loc>`));
  });
  test(`${slug}: exact code and honest status`, () => {
    const blocks = [...page.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(m=>unescape(m[1]));
    assert.equal(blocks.length,2);
    const code = blocks[1];
    assert.deepEqual(Buffer.from(code),readFileSync(path.join(site,`data/integration-pages/key-${slug}.py`)));
    assert.match(code,/os\.environ\["SINGIT_API_KEY"\]/);
    assert.doesNotMatch(code,/sk_singit_[A-Za-z0-9_-]+/);
    const text = unescape(page.replace(/<!--[\s\S]*?-->/g, ''));
    assert.doesNotMatch(text,/agent_paused|emergency stop|pays from your wallet|0x[0-9a-fA-F]{40}|hackathon/i);
    assert.doesNotMatch(text,/\bVerified\b/);
    assert.doesNotMatch(text,/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    assert.ok(page.includes('<!-- Placeholder prose; CMO rewrites. Facts verified by Dev/Ops 2 Nov 2026, see docs/integration-pages-verification.md -->'));
    for (const required of [dailyMessage,'insufficient_quota','over_request_limit','balance_low','Not run against the live service','prepaid','checked','client-side','in memory']) assert.ok(text.toLowerCase().includes(required.toLowerCase()),required);
    assert.ok(page.includes("Checked 2 November 2026 against a local test server that returns SingIt's error responses (langchain-openai 1.7.3, litellm 1.106.6, openai-agents 0.20.0). Not run against the live service."));
    const rows = [...page.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)][0][1];
    assert.equal([...rows.matchAll(/<tr>/g)].length,6);
    for (const [status,code] of [[429,'insufficient_quota'],[400,'over_request_limit'],[429,'rate_limit_exceeded'],[401,'invalid_api_key'],[402,'balance_low'],[503,'payments_paused']]) assert.match(rows,new RegExp(`<td>${status}</td><td><span class="mono">${code}</span></td>`));
  });
  test(`${slug}: links resolve and hub navigation`, () => {
    for (const [,raw] of page.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const link = unescape(raw);
      if (link.startsWith('#')) continue;
      if (link.startsWith('/')) {
        const pathname = link.split(/[?#]/)[0];
        assert.ok(existsSync(path.join(site,pathname.endsWith('/') ? pathname+'index.html' : pathname)),link);
      } else {
        assert.ok(link.startsWith('https://'),link);
        if (/^https:\/\/github.com\/SingItAi\//i.test(link)) assert.match(link,/^https:\/\/github.com\/SingItAi\/[^/]+\/(?:tree|blob)\/main\//i);
      }
    }
    assert.ok(hub.includes(`href="/integrations/${slug}/"`));
    assert.ok(page.includes('href="/integrations/"'));
    assert.ok(page.includes('href="/docs/mcp-key/"'));
    assert.ok(page.includes(`https://github.com/SingItAi/singit-examples/tree/main/${slug}-python`));
    assert.ok(page.includes('https://github.com/SingItAi/singit-examples/tree/main/python-x402'));
  });
}
test('framework-specific behavior and hub section', () => {
  const langchain = unescape(read('integrations/langchain/index.html'));
  for (const text of ['max_retries=0','bind_tools','openai.RateLimitError']) assert.ok(langchain.includes(text));
  const litellm = unescape(read('integrations/litellm/index.html'));
  for (const text of ['RateLimitError','BadRequestError','AuthenticationError','ServiceUnavailableError','num_retries=0','same key']) assert.ok(litellm.includes(text));
  const agents = unescape(read('integrations/openai-agents/index.html'));
  for (const text of ['set_tracing_disabled(True)','Do not put the SingIt key into','OPENAI_API_KEY','openai.RateLimitError','tool that already ran stays done']) assert.ok(agents.includes(text));
  const section = hub.match(/<section[^>]*><div class="shell"><h2 class="section-title">Python with a SingIt API key<\/h2>([\s\S]*?)<\/section>/)[1];
  assert.doesNotMatch(section,/<(?:code|pre)\b/);
  assert.ok(hub.indexOf('Three ways to connect') < hub.indexOf('Python with a SingIt API key'));
  assert.ok(hub.indexOf('Python with a SingIt API key') < hub.indexOf('id="langchain"'));
});
