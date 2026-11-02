import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const template = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Changelog | SingIt</title>
<meta name="description" content="Release notes and upcoming changes for SingIt repositories.">
<link rel="canonical" href="https://singitai.app/changelog/">
<meta property="og:title" content="Changelog | SingIt">
<meta property="og:description" content="Release notes and upcoming changes for SingIt repositories.">
<meta property="og:url" content="https://singitai.app/changelog/">
<meta property="og:image" content="https://singitai.app/assets/singit-social-preview-v3.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@SingItAgent">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css?v=bb7061fc">
<link rel="stylesheet" href="/dev.css?v=1">
<link rel="stylesheet" href="/pages.css?v=1">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": "https://singitai.app/changelog/#webpage",
      "url": "https://singitai.app/changelog/",
      "name": "Changelog | SingIt",
      "description": "Release notes and upcoming changes for SingIt repositories.",
      "inLanguage": "en",
      "breadcrumb": {
        "@id": "https://singitai.app/changelog/#breadcrumb"
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://singitai.app/changelog/#breadcrumb",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Developers",
          "item": "https://singitai.app/developers/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Changelog",
          "item": "https://singitai.app/changelog/"
        }
      ]
    }
  ]
}
</script>
<!-- Umami, self-hosted and cookieless (docs/analytics.md) -->
<script defer src="https://stats.singitai.app/s.js" data-website-id="6eab5805-b9b8-4f04-aa73-df64a8ce096e" data-domains="singitai.app,app.singitai.app"></script>
</head>
<body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="singit-mark" viewBox="0 0 240 240" fill="none">
    <path d="M192 108 V152 Q192 176 168 176 H112 Q88 176 88 152 V88 Q88 64 112 64 H168 Q192 64 192 78"
          stroke="currentColor" stroke-width="12.5" stroke-linecap="round"/>
    <path d="M116 118 L139 143 L188 86 H206" stroke="currentColor" stroke-width="11.5"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="216" cy="86" r="8" stroke="currentColor" stroke-width="8.5"/>
    <g stroke="currentColor" stroke-width="9" stroke-linecap="round">
      <line x1="58" y1="94"  x2="88" y2="94"/>
      <line x1="58" y1="121" x2="88" y2="121"/>
      <line x1="58" y1="148" x2="88" y2="148"/>
    </g>
    <g fill="currentColor">
      <circle cx="49" cy="94"  r="9"/>
      <circle cx="49" cy="121" r="9"/>
      <circle cx="49" cy="148" r="9"/>
    </g>
  </symbol>
  <symbol id="ic-copy" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.4"/></symbol>
  <symbol id="ic-check" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>

<header class="nav-wrap">
  <div class="nav-bar">
    <a class="brand" href="/developers/" aria-label="SingIt home">
      <svg class="mark" aria-hidden="true"><use href="#singit-mark"/></svg>
      <span>SingIt</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
      <a href="/developers/">Developers</a>
      <a href="/models/">Models &amp; prices</a>
      <a href="/pricing/">Pricing</a>
      <a href="/developers/#quickstart">Quickstart</a>
      <a href="https://github.com/SingItAi/SingItAI/blob/main/README.md">Repository README</a>
    </nav>
    <a class="btn btn-primary btn-sm" href="/developers/">Developer guide</a>
  </div>
</header>

{{CONTENT}}
<footer class="footer"><div class="shell footer-inner"><a class="brand brand-footer" href="/developers/"><svg class="mark" aria-hidden="true"><use href="#singit-mark"/></svg><span>SingIt</span></a><nav class="footer-links" aria-label="Footer"><a href="/developers/">Developers</a><a href="/models/">Models</a><a href="/pricing/">Pricing</a><a href="/agent-spending-limits/">Spending limits</a></nav><p class="footer-fine">&copy; 2026 SingIt</p></div></footer></body></html>
`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#x27;'}[c]));
const fail = message => { throw new Error(message); };
function https(value) {
  let url;
  try { url = new URL(value); } catch { fail(`Invalid https link: ${value}`); }
  if (url.protocol !== 'https:' || !value.startsWith('https://') || url.username || url.password) fail(`Expected https link: ${value}`);
  return value;
}

export function validateReleases(releases) {
  if (!Array.isArray(releases)) fail('releases.json must be an array');
  let previous = '9999-99-99';
  let published = false;
  const seen = new Set();
  for (const r of releases) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail('Invalid release entry');
    if (Object.keys(r).some(k => !['repo', 'version', 'status', 'date', 'notes', 'repoUrl', 'releaseUrl'].includes(k))) fail('Unknown release field');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo) || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(r.version)) fail('Invalid repo or version');
    if (r.repoUrl !== `https://github.com/${r.repo}`) fail('repoUrl must match repo');
    if (typeof r.notes !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(r.notes)) fail('Invalid notes filename');
    const key = `${r.repo}@${r.version}`;
    if (seen.has(key)) fail(`Duplicate release: ${key}`);
    seen.add(key);
    if (r.status === 'upcoming') {
      if (r.date != null || Object.hasOwn(r, 'releaseUrl')) fail('Upcoming entry cannot have a date or releaseUrl');
      if (published) fail('Releases must be newest first: upcoming before published');
    } else if (r.status === 'published') {
      published = true;
      if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date)) || new Date(r.date).toISOString().slice(0,10) !== r.date) fail('Published entry requires a valid date');
      if (r.releaseUrl !== `https://github.com/${r.repo}/releases/tag/${r.version}`) fail('Published entry requires its releaseUrl');
      if (r.date > previous) fail('Published releases must be newest first');
      previous = r.date;
    } else fail('Invalid release status');
  }
  return releases;
}

function inline(source) {
  let out = '';
  while (source) {
    let m;
    if ((m = source.match(/^`([^`]+)`/))) out += `<code>${escape(m[1])}</code>`;
    else if ((m = source.match(/^\*\*([^*]+)\*\*/))) out += `<strong>${inline(m[1])}</strong>`;
    else if ((m = source.match(/^\[([^\]]+)\]\(([^\s)]+)\)/))) out += `<a href="${escape(https(m[2]))}">${inline(m[1])}</a>`;
    else {
      if (/^[`*\[\]<>~\\]/.test(source) || /^!\[/.test(source) || /^_[^_]+_/.test(source)) fail(`Unsupported Markdown construct: ${source.slice(0,60)}`);
      out += escape(source[0]); source = source.slice(1); continue;
    }
    source = source.slice(m[0].length);
  }
  return out;
}

export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').trim().split('\n');
  if (!/^# .+/.test(lines[0])) fail('Notes must start with an h1 title');
  let i = 0, titles = 0;
  const output = [];
  const bullet = line => line?.match(/^( *)(?:- )(.+)$/);
  function list(indent) {
    let html = '<ul>';
    while (i < lines.length) {
      const m = bullet(lines[i]);
      if (!m || m[1].length < indent) break;
      if (m[1].length !== indent) fail('Unsupported Markdown list indentation');
      html += `<li>${inline(m[2])}`; i++;
      const next = bullet(lines[i]);
      if (next && next[1].length > indent) {
        if (next[1].length !== indent + 2) fail('Unsupported Markdown list indentation');
        html += list(indent + 2);
      }
      html += '</li>';
    }
    return html + '</ul>';
  }
  const cells = line => line.slice(1,-1).split('|').map(c => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,2}) (.+)$/);
    if (heading) {
      if (heading[1] === '#' && ++titles > 1) fail('Only one h1 title is supported');
      const level = heading[1].length;
      output.push(`<h${level}${level === 1 ? ' class="section-title"' : ''}>${inline(heading[2])}</h${level}>`); i++; continue;
    }
    if (bullet(line)) { if (bullet(line)[1].length) fail('Unexpected list indentation'); output.push(list(0)); continue; }
    if (line.startsWith('|')) {
      const headers = cells(line);
      if (!/^\|(?: *:?-{3,}:? *\|)+$/.test(lines[i+1] || '')) fail('Unsupported Markdown table');
      i += 2;
      let html = '<table><thead><tr>' + headers.map(c => `<th scope="col">${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (lines[i]?.startsWith('|')) {
        if (!lines[i].endsWith('|') || cells(lines[i]).length !== headers.length) fail('Invalid table row');
        html += '<tr>' + cells(lines[i++]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
      }
      output.push(html + '</tbody></table>'); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\|| *- )/.test(lines[i])) {
      if (/^(?: {2,}|\t|>|\+ |\d+[.)] |[-*_]{3,}\s*$|[=]{3,}\s*$)/.test(lines[i])) fail(`Unsupported Markdown construct: ${lines[i]}`);
      paragraph.push(lines[i++]);
    }
    if (!paragraph.length) fail(`Unsupported Markdown construct: ${line}`);
    output.push(`<p class="lp-text">${inline(paragraph.join(' '))}</p>`);
  }
  return output.join('\n');
}

// notes maps each notes filename to its unchanged Markdown source.
export function renderPage(releases, notes) {
  validateReleases(releases);
  const hasUpcoming = releases.some(r => r.status === 'upcoming');
  const entries = releases.map(r => {
    if (typeof notes[r.notes] !== 'string') fail(`Missing notes: ${r.notes}`);
    const html = renderMarkdown(notes[r.notes]);
    if (hasUpcoming && /href="[^" ]*\/releases\/tag\//.test(html)) fail('Release tag links are not allowed while entries are upcoming');
    const status = r.status === 'upcoming' ? 'Upcoming, not released yet' : `Published · <time datetime="${r.date}">${r.date}</time>`;
    const releaseLink = r.status === 'published' && !hasUpcoming ? ` · <a href="${escape(r.releaseUrl)}">Release notes on GitHub</a>` : '';
    return `<section class="lp-section"><div class="shell"><article><p class="eyebrow"><a href="${escape(r.repoUrl)}">${escape(r.repo)}</a> · ${escape(r.version)}</p><p class="tab-note"><strong>${status}</strong>${releaseLink}</p>\n${html}\n</article></div></section>`;
  }).join('\n');
  return template.replace('{{CONTENT}}', () => `<main id="top"><section class="hero dev-hero"><div class="shell"><p class="eyebrow"><a href="/docs/">Documentation</a></p><h1>Changelog</h1><p class="hero-sub">Release notes and upcoming changes for SingIt repositories.</p></div></section>\n${entries}\n</main>`);
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--check')) fail('Usage: node scripts/generate-changelog.mjs [--check]');
  const root = new URL('../', import.meta.url);
  const data = new URL('website/data/changelog/', root);
  const releases = validateReleases(JSON.parse(await readFile(new URL('releases.json', data), 'utf8')));
  const notes = Object.fromEntries(await Promise.all(releases.map(async r => [r.notes, await readFile(new URL(r.notes, data), 'utf8')])));
  const output = renderPage(releases, notes);
  const destination = new URL('website/changelog/index.html', root);
  if (process.argv.includes('--check')) {
    const current = await readFile(destination, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (current !== output) fail(`Generated file differs: ${fileURLToPath(destination)}`);
  } else {
    await mkdir(path.dirname(fileURLToPath(destination)), { recursive: true });
    await writeFile(destination, output);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Changelog: ${error.message}`); process.exitCode = 1; });
}
