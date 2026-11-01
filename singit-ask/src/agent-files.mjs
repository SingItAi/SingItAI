import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Only these literal paths can select a file. Request text is never a filesystem path.
export function addAgentFiles(app, { log = console.error,
  websiteDir = fileURLToPath(new URL("../../website/", import.meta.url)) } = {}) {
  const files = new Map([
    ["/SKILL.md", { file: resolve(websiteDir, "SKILL.md"), type: "text/markdown; charset=utf-8" }],
    ["/.well-known/agent-card.json", { file: resolve(websiteDir, ".well-known/agent-card.json"), type: "application/json; charset=utf-8" }],
    ["/llms-models.txt", { file: resolve(websiteDir, "llms-models.txt"), type: "text/plain; charset=utf-8" }],
    ["/llms-full.txt", { file: resolve(websiteDir, "llms-full.txt"), type: "text/plain; charset=utf-8" }],
  ]);
  app.use(async (req, res, next) => {
    const entry = files.get(req.path);
    if (!entry || !["GET", "HEAD"].includes(req.method)) return next();
    let bytes;
    try { bytes = await readFile(entry.file); }
    catch {
      log(`singit-ask: warning: agent file unavailable (${req.path})`);
      return next();
    }
    res.set({ "Content-Type": entry.type, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${createHash("sha256").update(bytes).digest("hex")}"` });
    // Express handles conditional requests and suppresses the body for HEAD.
    res.send(bytes);
  });
}
