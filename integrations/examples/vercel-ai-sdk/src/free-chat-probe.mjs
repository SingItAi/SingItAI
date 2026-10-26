// Free mode, part 2: an unpaid POST to SingIt Ask's chat route, printing the x402 402 challenge
// (network, asset, amount, payTo) without paying it. Any x402-shaped HTTP route answers this way.
import { decodeHeader } from "./x402/guards.js";

export const DEFAULT_ASK_BASE_URL = "https://ask.singitai.app";

export async function runFreeChatProbe({ baseUrl = DEFAULT_ASK_BASE_URL } = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }], max_tokens: 16 }),
  });
  if (response.status !== 402) return { status: response.status, offers: [] };
  const header = response.headers.get("payment-required");
  const challenge = header ? decodeHeader(header) : null;
  const offers = (challenge?.accepts ?? []).map(offer => ({
    scheme: offer.scheme, network: offer.network, asset: offer.asset, amount: offer.amount, payTo: offer.payTo,
  }));
  return { status: response.status, offers };
}
