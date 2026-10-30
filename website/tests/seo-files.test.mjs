// The landing publish root must include robots.txt and sitemap.xml as files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = [
  "https://singitai.app/status/",
  "https://singitai.app/",
  "https://singitai.app/developers/",
  "https://singitai.app/models/",
  "https://singitai.app/x402-gift-cards-esims/",
  "https://singitai.app/agent-spending-limits/",
  "https://singitai.app/x402-llm-api/",
];

function headerTypes(headers) {
  const types = new Map();
  let current = null;
  for (const line of headers.split(/\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = line.trim();
      continue;
    }
    const match = line.match(/^\s*Content-Type:\s*(.+)$/i);
    if (current && match) types.set(current, match[1].trim());
  }
  return types;
}

function contentType(filePath, headers) {
  const rules = headerTypes(headers);
  const urlPath = filePath === "index.html" ? "/" : `/${filePath}`;
  if (rules.has(urlPath)) return rules.get(urlPath);
  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (filePath.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

test("the pages output contains robots.txt and the landing sitemap", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "singit-pages-"));
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

    const robots = await readFile(path.join(out, "robots.txt"), "utf8");
    const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
    const headers = await readFile(path.join(out, "_headers"), "utf8");
    const redirects = await readFile(path.join(out, "_redirects"), "utf8");
    assert.match(robots, /^User-agent:\s*\*/m);
    assert.match(robots, /^Allow:\s*\//m);
    assert.match(robots, /^Sitemap:\s*https:\/\/singitai\.app\/sitemap\.xml$/m);
    assert.doesNotMatch(robots, /<!DOCTYPE|<html/i);
    for (const page of PAGES) assert.match(sitemap, new RegExp(`<loc>${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>`));
    assert.ok(!sitemap.includes("https://singitai.app/ai-agent-spending-limit/"));
    assert.doesNotMatch(sitemap, /app\.singitai\.app/);
    assert.doesNotMatch(sitemap, /<!DOCTYPE|<html/i);
    assert.equal(headerTypes(headers).get("/robots.txt"), "text/plain; charset=utf-8");
    assert.equal(headerTypes(headers).get("/sitemap.xml"), "application/xml; charset=utf-8");
    const rules = redirects.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    assert.deepEqual(rules, [
      "/app https://app.singitai.app/app/ 302",
      "/app/* https://app.singitai.app/app/:splat 302",
      "/numbers.json https://ask.singitai.app/numbers.json 302",
      "/ai-agent-spending-limit /agent-spending-limits/ 301",
      "/ai-agent-spending-limit/ /agent-spending-limits/ 301",
      "/models/deepseek-v4.1-flash-uncensored /models/all/ 302",
      "/models/deepseek-v4.1-flash-uncensored/ /models/all/ 302",
    ]);

    const server = createServer(async (request, response) => {
      const name = request.url === "/" ? "index.html" : request.url.slice(1);
      try {
        const body = await readFile(path.join(out, name));
        response.writeHead(200, { "Content-Type": contentType(name, headers) });
        response.end(body);
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("missing");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      for (const [file, type] of [["robots.txt", "text/plain; charset=utf-8"], ["sitemap.xml", "application/xml; charset=utf-8"]]) {
        const response = await fetch(`http://127.0.0.1:${port}/${file}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), type);
        const body = await response.text();
        assert.equal(body.includes("<!DOCTYPE"), false);
        assert.equal(body.includes("<html"), false);
      }
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
