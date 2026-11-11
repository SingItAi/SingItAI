#!/usr/bin/env node
import { startProxy, VERSION } from "./server.js";

try {
  const { config } = await startProxy();
  // Never print keys or wallet addresses. Point the user at GET /wallet for the funding address.
  console.error(`singit-proxy/${VERSION} listening on http://${config.host}:${config.port}/v1/`);
  console.error(`Upstream: ${config.askUrl}/v1/chat/completions  network=${config.network}  client=${config.client}`);
  console.error(`Caps: $${config.maxPerCallUsd}/call, $${config.maxPerDayUsd}/day (UTC). Wallet: GET http://${config.host}:${config.port}/wallet`);
} catch (error) {
  console.error(`singit-proxy: ${error.message}`);
  process.exit(1);
}
