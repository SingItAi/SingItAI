// Runs SingIt Ask on loopback, for the Cloudflare tunnel in front of it. Coinbase CDP settles every payment.
//
//   SINGIT_ASK_PAY_TO_SOLANA   where Solana payments go (its USDC account must exist)
//   SINGIT_ASK_PAY_TO_BASE     where Base payments go
//   SURPLUS_API_KEY            the inf_… buyer key the model is bought with
//   CDP_API_KEY_ID, CDP_API_KEY_SECRET   the CDP facilitator's credentials
//   SINGIT_ASK_DIRECT_SOLANA   1 turns on the web agent's private Solana route, with
//   SINGIT_ASK_QUOTE_TOKEN     its shared secret (32+ characters) and
//   SINGIT_ASK_QUOTE_DB        its private SQLite file
//   SINGIT_ASK_MODEL           upstream model, default deepseek-v4.1-flash
//   SINGIT_ASK_PORT            default 8140
//   SINGIT_ASK_BLOCKED_PROVIDERS  provider ids the Surplus key blocks (comma-separated), so models only they sell
//                              are not offered
//   SINGIT_ASK_OBSERVED_PRICES where what answers cost per model is kept (no prompts), default
//                              ~/.config/singit-ask/observed-prices.json
//   SINGIT_ASK_FREE_MODELS     models answered free as "free/<id>" (comma-separated); unset means the default model,
//                              empty turns free answers off
//   SINGIT_ASK_FREE_PER_VISITOR, SINGIT_ASK_FREE_PER_DAY  free answers a day per visitor and for everyone together
//                              (defaults in src/free.mjs)
//   SINGIT_ASK_SETTLEMENT_KEY  the settlement wallet's private key (Base): turns on /v1/exa/search and /contents,
//                              which pay Exa from it. SingIt's own small float, topped up by hand (src/search.mjs)
//   SINGIT_ASK_BASE_RPC        Base RPC for the settlement wallet's balance (https://mainnet.base.org)

import { createRequire } from "node:module";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createApp } from "./app.mjs";
import { settlementWallet } from "./search.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    console.error(`singit-ask: ${name} is required`);
    process.exit(1);
  }
  return value;
}

const config = {
  directSolana: process.env.SINGIT_ASK_DIRECT_SOLANA === "1",
  quoteToken: process.env.SINGIT_ASK_QUOTE_TOKEN,
  quoteDb: process.env.SINGIT_ASK_QUOTE_DB,
  payToSolana: required("SINGIT_ASK_PAY_TO_SOLANA"),
  payToBase: required("SINGIT_ASK_PAY_TO_BASE"),
  surplusKey: required("SURPLUS_API_KEY"),
  surplusUrl: (process.env.SURPLUS_API_URL || "https://api.surplusintelligence.ai").replace(/\/$/, ""),
  model: process.env.SINGIT_ASK_MODEL || "deepseek-v4.1-flash",
  blockedProviders: String(process.env.SINGIT_ASK_BLOCKED_PROVIDERS || "").split(",").map((p) => p.trim()).filter(Boolean),
  observedFile: process.env.SINGIT_ASK_OBSERVED_PRICES
    || `${process.env.HOME}/.config/singit-ask/observed-prices.json`,
};
const model = config.model;
config.freeModels = process.env.SINGIT_ASK_FREE_MODELS === undefined ? [model]
  : process.env.SINGIT_ASK_FREE_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
const positive = (name) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : undefined; };
config.freeLimits = Object.fromEntries(Object.entries({
  perVisitorPerDay: positive("SINGIT_ASK_FREE_PER_VISITOR"), perDay: positive("SINGIT_ASK_FREE_PER_DAY"),
}).filter(([, v]) => v !== undefined));
const port = Number(process.env.SINGIT_ASK_PORT || 8140);

required("CDP_API_KEY_ID"); required("CDP_API_KEY_SECRET");
// The CDP component's installed, authenticated SDK signs each facilitator call.
const requireCdp = createRequire(new URL("../../cdp-x402-service/package.json", import.meta.url));
const facilitatorClient = new HTTPFacilitatorClient(requireCdp("@coinbase/x402").facilitator);

const settlementKey = String(process.env.SINGIT_ASK_SETTLEMENT_KEY || "").trim();
const wallet = settlementKey ? settlementWallet({ account: privateKeyToAccount(settlementKey),
  publicClient: createPublicClient({ chain: base, transport: http(process.env.SINGIT_ASK_BASE_RPC || "https://mainnet.base.org",
    { retryCount: 1, timeout: 10000 }) }) }) : null;
delete process.env.SINGIT_ASK_SETTLEMENT_KEY;  // nothing later in this process reads it from the environment
if (wallet) console.error(`singit-ask: search on, settlement wallet ${wallet.address}`);

const app = createApp(config, { facilitatorClient, settlementWallet: wallet });
// The model list and its live prices are read now and kept fresh, so no visitor waits for Surplus.
app.locals.catalogue?.warm().catch(() => { /* the first read retries */ });
app.listen(port, "127.0.0.1", () => {
  console.error(`singit-ask: ${config.model}, actual usage over Coinbase CDP on Solana and Base, on http://127.0.0.1:${port}`);
});
