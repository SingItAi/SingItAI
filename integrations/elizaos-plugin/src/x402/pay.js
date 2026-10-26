// Vendored and trimmed from sdk/typescript/src/{signers.js,singit.js} (Base only). Pays a single
// x402 `upto`/`exact` offer with a viem EVM signer, after guards.js has pinned and capped it.
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { SingItPaymentError, BASE_PIN, DEFAULT_ASK_BASE_URL, decodeHeader, selectOffer, isAtomicAmount } from "./guards.js";

// { address, signTypedData, readContract } — the shape @x402/evm's client schemes expect.
export function buildEvmSigner({ evmPrivateKey, rpcUrl = BASE_PIN.defaultRpcUrl }) {
  if (!evmPrivateKey) throw new SingItPaymentError("Pass an EVM private key to pay on Base.");
  const account = privateKeyToAccount(evmPrivateKey);
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  return {
    address: account.address,
    signTypedData: account.signTypedData.bind(account),
    readContract: client.readContract.bind(client),
  };
}

async function signOffer(scheme, offer, extensions, signer) {
  const { [scheme === "upto" ? "UptoEvmScheme" : "ExactEvmScheme"]: Scheme } =
    await import(scheme === "upto" ? "@x402/evm/upto/client" : "@x402/evm/exact/client");
  const signed = await new Scheme(signer).createPaymentPayload(2, offer, { extensions });
  return { x402Version: 2, accepted: offer, payload: signed.payload, ...(signed.extensions ? { extensions: signed.extensions } : {}) };
}

/**
 * Pays one OpenAI-shaped chat completion on SingIt Ask's Base offer, guarded by a per-call and
 * per-day USDC ceiling (see guards.js). `limiter` is a shared DailyLimiter so repeated calls from
 * one action/runtime enforce one rolling-day cap; pass a fresh one per process otherwise.
 */
export async function payAskRequest({
  body, path = "/v1/chat/completions", baseUrl = DEFAULT_ASK_BASE_URL, payTo = BASE_PIN.payTo,
  rpcUrl, scheme = "upto", evmPrivateKey, limiter, maxPerCallAtomic, fetchImpl = fetch,
}) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const signer = buildEvmSigner({ evmPrivateKey, rpcUrl });
  const encodedBody = JSON.stringify(body);
  const send = headers => fetchImpl(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
    headers: { "Content-Type": "application/json", ...headers }, body: encodedBody,
  });

  const first = await send({});
  if (first.status !== 402) return { response: await first.json(), payment: null };

  const header = first.headers.get("payment-required");
  if (!header) throw new SingItPaymentError("Got HTTP 402 with no PAYMENT-REQUIRED header.");
  const challenge = decodeHeader(header);
  const offer = selectOffer(challenge, { scheme, payTo, maxCapAtomic: maxPerCallAtomic, resourceUrl: url });

  const release = limiter.reserve(offer.amount);
  let payload;
  try {
    payload = await signOffer(scheme, offer, challenge.extensions, signer);
  } catch (error) {
    release();
    throw error;
  }

  let response;
  try {
    response = await send({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  } catch (error) {
    throw new SingItPaymentError(`The paid request failed after the payment was sent (${error.message}); `
      + "it was not repeated and its ceiling stays counted against the daily cap.");
  }
  if (response.status === 402) {
    release();
    throw new SingItPaymentError("The merchant refused the payment (HTTP 402); nothing was paid and it was not repeated.");
  }
  if (response.status !== 200) {
    throw new SingItPaymentError(`Paid request returned HTTP ${response.status}; it was not repeated, and its ceiling `
      + "stays counted against the daily cap in case it settled.");
  }
  const result = await response.json().catch(() => null);
  const totalAtomic = result?.billing?.totalAtomic;
  if (!isAtomicAmount(totalAtomic) || BigInt(totalAtomic) > BigInt(offer.amount)) {
    throw new SingItPaymentError("The invoice does not match the offered ceiling; treating the payment as unresolved "
      + "(its ceiling stays counted against the daily cap).");
  }
  limiter.settle(release, totalAtomic, offer.amount);

  // Trimmed vs. @singit/sdk's SingIt.chat(): this skips the receipt's payer-address cross-check
  // (network is still checked). See sdk/typescript/src/singit.js for the full check.
  const receiptHeader = response.headers.get("payment-response");
  const receipt = receiptHeader ? decodeHeader(receiptHeader) : null;
  if (receipt && receipt.network !== "base") {
    throw new SingItPaymentError("The settlement receipt does not match this request; treating the payment as unresolved.");
  }

  return {
    response: result,
    payment: { scheme, network: "base", amountAtomic: totalAtomic, ...(receipt?.transaction ? { txHash: receipt.transaction } : {}) },
  };
}
