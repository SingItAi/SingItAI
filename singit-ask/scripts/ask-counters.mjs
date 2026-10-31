// Read-only private counter report. Never writes or exposes payer identifiers.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { HealthStats, privateStatsBody } from "../src/health-stats.mjs";
import { parseOwnPayers } from "../src/own-payers.mjs";
export function main({ env = process.env, args = process.argv.slice(2), print = console.log } = {}) {
  let ownPayers = [];
  try {
    if (env.SINGIT_ASK_OWN_PAYERS_FILE) ownPayers = parseOwnPayers(readFileSync(env.SINGIT_ASK_OWN_PAYERS_FILE, "utf8"));
  } catch {
    console.error("singit-ask: SINGIT_ASK_OWN_PAYERS_FILE could not be read");
    throw new Error("singit-ask: SINGIT_ASK_OWN_PAYERS_FILE could not be read");
  }
  const body = privateStatsBody(new HealthStats({ readOnly: true, ownPayers,
    file: env.SINGIT_ASK_STATS_FILE || `${homedir()}/.config/singit-ask/health-stats.json` }));
  if (args.includes("--text")) {
    print([`Since: ${body.since}`, `Generated: ${body.generated_at}`,
      `Own payers configured: ${body.own_payers_configured}`, `Own payments excluded: ${body.own_payments_excluded}`,
      `External unique (total/24h/7d): ${Object.values(body.external_payers.unique).join(" / ")}`,
      `Paid calls (total/24h/7d): ${Object.values(body.external_payers.paid_calls).join(" / ")}`,
      `USDC (total/24h/7d): ${Object.values(body.external_payers.usdc).join(" / ")}`,
      `402 lifetime (post/probe/refused): ${body.issued_402.total.post} / ${body.issued_402.total.probe} / ${body.issued_402.total.refused}`,
      body.note].join("\n"));
  } else print(JSON.stringify(body, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch { process.exitCode = 1; }
}
