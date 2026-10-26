#!/usr/bin/env node
// Usage: node src/run.mjs [free|paid] ["question for paid mode"]
import { runFreeMcpTools } from "./free-mcp-tools.mjs";
import { runFreeChatProbe } from "./free-chat-probe.mjs";
import { runPaidChat, paidChatModeFromEnv } from "./paid-chat.mjs";

async function main() {
  const mode = process.argv[2] ?? "free";

  if (mode === "free") {
    const tools = await runFreeMcpTools();
    console.log("MCP tools:", tools.toolNames);
    console.log("get_price(BTC):", tools.price);

    const probe = await runFreeChatProbe();
    console.log(`Unpaid chat probe: HTTP ${probe.status}`);
    for (const offer of probe.offers) {
      console.log(`  offer: ${offer.scheme} on ${offer.network}, ${offer.amount} atomic of ${offer.asset} to ${offer.payTo}`);
    }
    return;
  }

  if (mode === "paid") {
    const caps = paidChatModeFromEnv();
    const prompt = process.argv[3] ?? "What is x402?";
    const result = await runPaidChat({ prompt, caps });
    console.log(result.text);
    return;
  }

  console.error(`Unknown mode "${mode}". Use "free" or "paid".`);
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
