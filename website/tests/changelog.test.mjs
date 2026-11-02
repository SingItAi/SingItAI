import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { renderMarkdown, renderPage, validateReleases } from '../../scripts/generate-changelog.mjs';

const root = new URL('../../', import.meta.url);
const site = new URL('website/', root);
const read = p => readFile(new URL(p, root), 'utf8');
const releases = JSON.parse(await read('website/data/changelog/releases.json'));
const page = await read('website/changelog/index.html');
const fixture = { repo: 'SingItAi/example', version: 'v0.1.0', status: 'upcoming', date: null, notes: 'example.md', repoUrl: 'https://github.com/SingItAi/example' };

test('generated page is current and --check passes', async () => {
  const notes = Object.fromEntries(await Promise.all(releases.map(async r => [r.notes, await read(`website/data/changelog/${r.notes}`)])));
  assert.equal(page, renderPage(releases, notes));
  await exec(process.execPath, ['scripts/generate-changelog.mjs', '--check'], { cwd: root });
});

test('release metadata, notes, titles and upcoming labels', async () => {
  assert.equal(validateReleases(releases), releases);
  for (const r of releases) {
    const notes = await read(`website/data/changelog/${r.notes}`);
    const title = notes.match(/^# (.+)$/m)[1];
    assert.ok(page.includes(`>${title}</h1>`));
    assert.ok(page.includes(r.repo));
    assert.ok(page.includes(r.version));
    if (r.status === 'upcoming') {
      assert.equal(r.date, null);
      assert.ok(!Object.hasOwn(r, 'releaseUrl'));
    } else {
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(r.releaseUrl, `${r.repoUrl}/releases/tag/${r.version}`);
    }
  }
  assert.equal(page.split('Upcoming, not released yet').length - 1, releases.filter(r => r.status === 'upcoming').length);
  if (releases.some(r => r.status === 'upcoming')) assert.doesNotMatch(page, /\/releases\/tag\//);
});

test('metadata, sitemap, documentation link and neutral content', async () => {
  const title = page.match(/<title>(.*?)<\/title>/)[1];
  const description = page.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.equal(title, 'Changelog | SingIt');
  assert.ok(title.length <= 60 && description.length > 0 && description.length <= 155);
  const url = 'https://singitai.app/changelog/';
  assert.ok(page.includes(`<link rel="canonical" href="${url}">`));
  const graph = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  assert.equal(graph.find(n => n['@type'] === 'WebPage').url, url);
  assert.equal(graph.find(n => n['@type'] === 'BreadcrumbList').itemListElement.at(-1).item, url);
  const sitemap = await read('website/sitemap.xml');
  assert.match(sitemap, /<url><loc>https:\/\/singitai.app\/status\/<\/loc><\/url>\s*<url><loc>https:\/\/singitai.app\/changelog\/<\/loc><\/url>/);
  assert.equal((await read('website/docs/index.html')).split('<a href="/changelog/">Changelog</a>').length - 1, 1);
  assert.doesNotMatch(page, /0x[0-9a-f]+|hackathon|AI team/i);
});

test('internal links resolve and external links use https', async () => {
  for (const [, href] of page.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (href.startsWith('#')) {
      assert.ok(page.includes(`id="${href.slice(1)}"`)); continue;
    }
    const target = new URL(href.replaceAll('&amp;', '&'), 'https://singitai.app/changelog/');
    assert.equal(target.protocol, 'https:', href);
    if (target.origin !== 'https://singitai.app') continue;
    const file = new URL('.' + target.pathname + (target.pathname.endsWith('/') ? 'index.html' : ''), site);
    assert.ok((await stat(file)).isFile(), href);
  }
});

test('restricted Markdown renders structure and escapes text', () => {
  const html = renderMarkdown('# Title\n\n## Changes\n\nA & B **bold** `a < b` [docs](https://example.com/?a=1&b=2).\n\n- Parent\n  - Child\n- Next\n\n| A | B |\n|---|---|\n| x | y |');
  assert.match(html, /<h1 class="section-title">Title<\/h1>/);
  assert.ok(html.includes('<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>a &lt; b</code>'));
  assert.ok(html.includes('A &amp; B'));
  assert.ok(html.includes('<thead>') && html.includes('<tbody>'));
  for (const construct of ['### Too deep', '+ unsupported bullet', '> quote', '1. ordered', '```js', '---', '*italic*', '![image](https://example.com/a.png)']) {
    assert.throws(() => renderMarkdown(`# Title\n\n${construct}`), /Unsupported Markdown/);
  }
});

test('published entries require dates and URLs and sort newest first', () => {
  const published = { ...fixture, status: 'published', date: '2026-11-02', releaseUrl: `${fixture.repoUrl}/releases/tag/${fixture.version}` };
  assert.doesNotThrow(() => validateReleases([published]));
  assert.match(renderPage([published], { 'example.md': '# Title' }), /<time datetime="2026-11-02">2026-11-02<\/time>/);
  for (const change of [{date: null}, {date: '2026-02-30'}, {releaseUrl: undefined}, {repoUrl: 'http://example.com'}, {notes: '../outside.md'}, {status: 'draft'}]) {
    assert.throws(() => validateReleases([{...published, ...change}]));
  }
  assert.throws(() => validateReleases([{...fixture, releaseUrl: `${fixture.repoUrl}/releases/tag/${fixture.version}`}]), /Upcoming entry/);
  const older = { ...published, version: 'v0.0.1', date: '2026-11-01', releaseUrl: `${fixture.repoUrl}/releases/tag/v0.0.1` };
  assert.throws(() => validateReleases([older, published]), /newest first/);
  assert.throws(() => validateReleases([published, {...fixture, version: 'v0.2.0'}]), /newest first/);
});

for (const [name, release, notes, error] of [
  ['upcoming date', {...fixture, date: '2026-11-02'}, '# Title', /Upcoming entry cannot have a date/],
  ['non-https link', fixture, '# Title\n\n[unsafe](http://example.com)', /Expected https link/],
  ['raw HTML', fixture, '# Title\n\n<div>unsafe</div>', /Unsupported Markdown/],
]) {
  test(`generator rejects ${name} from temporary fixtures`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'singit-changelog-'));
    try {
      const data = path.join(dir, 'website/data/changelog');
      await mkdir(data, {recursive: true});
      await writeFile(path.join(data, 'releases.json'), JSON.stringify([release]));
      await writeFile(path.join(data, 'example.md'), notes);
      const fixtureReleases = JSON.parse(await readFile(path.join(data, 'releases.json'), 'utf8'));
      const fixtureNotes = await readFile(path.join(data, 'example.md'), 'utf8');
      assert.throws(() => renderPage(fixtureReleases, {'example.md': fixtureNotes}), error);
    } finally { await rm(dir, {recursive: true, force: true}); }
  });
}

