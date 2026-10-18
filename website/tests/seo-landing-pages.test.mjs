// The SEO landing pages (/x402-gift-cards-esims, /ai-agent-spending-limit,
// /x402-llm-api) must ship exactly what their briefs say: title, meta
// description, self-referencing canonical, a FAQPage JSON-LD that matches the
// visible FAQ word for word, UTM-tagged CTAs, and sitemap entries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGES = [
  {
    dir: "x402-gift-cards-esims",
    canonical: "https://singitai.app/x402-gift-cards-esims/",
    title: "x402 Gift Cards & eSIMs for AI Agents | SingIt",
    description: "Your AI agent buys gift cards, eSIMs and mobile top-ups from Bitrefill in USDC on Base or Solana, inside the daily and per-purchase limits you set.",
    jsonLdTypes: ["WebPage", "Service", "FAQPage", "BreadcrumbList"],
    ctas: [
      "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=giftcards-esims&utm_content=hero",
      "/ai-agent-spending-limit/?utm_source=singitai&utm_medium=landing&utm_campaign=giftcards-esims&utm_content=hero-secondary",
      "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=giftcards-esims&utm_content=footer",
    ],
  },
  {
    dir: "ai-agent-spending-limit",
    canonical: "https://singitai.app/ai-agent-spending-limit/",
    title: "AI Agent Spending Limit in USDC on Base & Solana | SingIt",
    description: "Give your AI agent a USDC budget, not your wallet: a daily and a per-purchase limit enforced on chain on Base. Approve once, revoke with one signature.",
    jsonLdTypes: ["WebPage", "SoftwareApplication", "FAQPage", "BreadcrumbList"],
    ctas: [
      "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=spending-limit&utm_content=hero",
      "https://github.com/bubon-ik/SingItAI/blob/main/agent-allowance/src/AgentAllowance.sol",
      "/x402-gift-cards-esims/?utm_source=singitai&utm_medium=landing&utm_campaign=spending-limit&utm_content=body",
      "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=spending-limit&utm_content=footer",
    ],
  },
  {
    dir: "x402-llm-api",
    canonical: "https://singitai.app/x402-llm-api/",
    title: "Pay-per-Answer LLM API over x402 | SingIt",
    description: "150+ models, Claude, GPT, Gemini and DeepSeek among them, paid per answer in USDC over x402. No key, no account: you pay only what each answer used.",
    jsonLdTypes: ["WebPage", "WebAPI", "FAQPage", "BreadcrumbList"],
    ctas: [
      "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=hero",
      "/models/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=hero",
      "/developers/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=keys",
      "/ai-agent-spending-limit/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=body",
      "/models/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=faq",
      "https://app.singitai.app/app/?utm_source=singitai&utm_medium=landing&utm_campaign=x402-llm-api&utm_content=footer-key",
    ],
  },
];

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", middot: "·", rarr: "→", larr: "←", "#8599": "↗", "#10003": "✓", "#10005": "✕", copy: "©" };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, name) => NAMED[name] ?? all);
}

function visibleText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function jsonLdNodes(html) {
  const nodes = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    nodes.push(...(parsed["@graph"] ?? [parsed]));
  }
  return nodes;
}

function visibleFaq(html) {
  const questions = [...html.matchAll(/<dt><h3>([\s\S]*?)<\/h3><\/dt>/g)].map((m) => visibleText(m[1]));
  const answers = [...html.matchAll(/<dd class="faq-answer">([\s\S]*?)<\/dd>/g)].map((m) => visibleText(m[1]));
  assert.equal(questions.length, answers.length);
  return questions.map((question, i) => ({ question, answer: answers[i] }));
}

for (const page of PAGES) {
  test(`/${page.dir}/ has the brief's head tags`, async () => {
    const html = await readFile(path.join(website, page.dir, "index.html"), "utf8");
    const escapedTitle = page.title.replaceAll("&", "&amp;");
    assert.ok(html.includes(`<title>${escapedTitle}</title>`), "exact <title>");
    assert.ok(html.includes(`<meta name="description" content="${page.description}">`), "exact meta description");
    assert.ok(html.includes(`<link rel="canonical" href="${page.canonical}">`), "self-referencing canonical");
    assert.ok(html.includes(`<meta property="og:url" content="${page.canonical}">`), "og:url matches canonical");
    assert.ok(html.includes(`<meta property="og:title" content="${escapedTitle}">`), "og:title matches title");
    assert.ok(html.includes('<meta property="og:image" content="https://singitai.app/assets/singit-social-preview-v3.png">'), "og:image");
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), "twitter card");
  });

  test(`/${page.dir}/ JSON-LD parses and carries the brief's types`, async () => {
    const html = await readFile(path.join(website, page.dir, "index.html"), "utf8");
    const nodes = jsonLdNodes(html);
    const types = new Set(nodes.map((n) => n["@type"]));
    for (const type of page.jsonLdTypes) assert.ok(types.has(type), `missing @type ${type}`);
    const webPage = nodes.find((n) => n["@type"] === "WebPage");
    assert.equal(webPage.url, page.canonical);
    assert.equal(webPage.name, page.title);
    assert.equal(webPage.description, page.description);
    const breadcrumb = nodes.find((n) => n["@type"] === "BreadcrumbList");
    assert.equal(breadcrumb.itemListElement.at(-1).item, page.canonical);
  });

  test(`/${page.dir}/ FAQPage JSON-LD matches the visible FAQ`, async () => {
    const html = await readFile(path.join(website, page.dir, "index.html"), "utf8");
    const faqPage = jsonLdNodes(html).find((n) => n["@type"] === "FAQPage");
    assert.ok(faqPage, "FAQPage JSON-LD exists");
    const visible = visibleFaq(html);
    assert.equal(faqPage.mainEntity.length, visible.length, "JSON-LD and visible FAQ counts differ");
    visible.forEach(({ question, answer }, i) => {
      const entity = faqPage.mainEntity[i];
      assert.equal(entity["@type"], "Question");
      assert.equal(entity.name, question, `question ${i + 1} differs from the visible text`);
      assert.equal(entity.acceptedAnswer.text, answer, `answer ${i + 1} differs from the visible text`);
    });
  });

  test(`/${page.dir}/ CTAs carry the brief's UTM parameters`, async () => {
    const html = await readFile(path.join(website, page.dir, "index.html"), "utf8");
    for (const cta of page.ctas) {
      assert.ok(html.includes(`href="${cta.replaceAll("&", "&amp;")}"`), `missing CTA ${cta}`);
    }
  });
}

test("build output contains the three pages and the sitemap lists them", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "singit-landing-"));
  try {
    const built = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(website, "build.mjs"), out], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)));
    });
    assert.equal(built, out);

    for (const page of PAGES) {
      const file = path.join(out, page.dir, "index.html");
      assert.ok((await stat(file)).isFile(), `${page.dir}/index.html missing from the build output`);
      const html = await readFile(file, "utf8");
      assert.ok(html.includes(`<link rel="canonical" href="${page.canonical}">`));
    }

    const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
    for (const page of PAGES) {
      assert.ok(sitemap.includes(`<loc>${page.canonical}</loc>`), `sitemap missing ${page.canonical}`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
