// Vendored and trimmed from sdk/typescript/src/{signers.js,singit.js} (Base only), reshaped as a
// fetch-wrapper so it drops straight into @langchain/openai's `configuration.fetch`. Every request
// through the returned fetch is guarded exactly like @singit/sdk: the merchant's offer must be on
// Base, pay the pinned SingIt Ask address in the pinned USDC contract, and stay within both the
// per-call and per-day ceilings. See ../../../../elizaos-plugin/src/x402/pay.js for the same
// pattern as a plain async call instead of a fetch wrapper.
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { SingItPaymentError, BASE_PIN, DailyLimiter, usdToAtomic, decodeHeader, selectOffer, isAtomicAmount } from "./guards.js";

function buildEvmSigner({ evmPrivateKey, rpcUrl = BASE_PIN.defaultRpcUrl }) {
  const account = privateKeyToAccount(evmPrivateKey);
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  return {
    address: account.address,
    signTypedData: account.signTypedData.bind(account),
    readContract: client.readContract.bind(client),
  };
}

// Same as sdk/typescript mergeExtensions: keep the merchant's declared extension fields next to the
// signed ones, or the facilitator rejects the payment with extension_echo_mismatch.
export function mergeExtensions(signedExtensions, declaredExtensions) {
  if (!signedExtensions) return undefined;
  return Object.fromEntries(Object.entries(signedExtensions).map(([key, value]) => {
    const declared = declaredExtensions?.[key] ?? {};
    return [key, { ...declared, ...value, info: { ...declared.info, ...value.info } }];
  }));
}

async function signOffer(scheme, offer, extensions, signer) {
  const { [scheme === "upto" ? "UptoEvmScheme" : "ExactEvmScheme"]: Scheme } =
    await import(scheme === "upto" ? "@x402/evm/upto/client" : "@x402/evm/exact/client");
  const signed = await new Scheme(signer).createPaymentPayload(2, offer, { extensions });
  const merged = mergeExtensions(signed.extensions, extensions);
  return { x402Version: 2, accepted: offer, payload: signed.payload, ...(merged ? { extensions: merged } : {}) };
}

/**
 * Returns a fetch-compatible function that pays SingIt Ask's Base x402 offer whenever the wrapped
 * request gets a 402, guarded by a per-call and per-day USDC ceiling. Requests to origins other
 * than `baseUrl` are passed through unpaid — this wrapper is deliberately not a drop-in general
 * x402 client, it only pays the merchant it was pinned to. Pass one long-lived `limiter` (a
 * DailyLimiter) to share the daily cap across several fetches; by default each fetch has its own.
 */
export function createSingitPaidFetch({
  evmPrivateKey, maxPerCallUsd, maxPerDayUsd, payTo = BASE_PIN.payTo,
  baseUrl = "https://ask.singitai.app", rpcUrl, scheme = "upto", fetchImpl = fetch, limiter,
}) {
  if (!evmPrivateKey) throw new SingItPaymentError("createSingitPaidFetch needs evmPrivateKey to pay on Base.");
  if (maxPerCallUsd == null || maxPerDayUsd == null) {
    throw new SingItPaymentError("createSingitPaidFetch needs maxPerCallUsd and maxPerDayUsd: it never pays without a ceiling.");
  }
  const signer = buildEvmSigner({ evmPrivateKey, rpcUrl });
  const maxPerCallAtomic = usdToAtomic(maxPerCallUsd);
  const dailyLimiter = limiter ?? new DailyLimiter(usdToAtomic(maxPerDayUsd));
  const allowedOrigin = new URL(baseUrl).origin;

  return async function singitPaidFetch(input, init) {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== allowedOrigin) return fetchImpl(request);

    const first = await fetchImpl(request.clone());
    if (first.status !== 402) return first;

    const header = first.headers.get("payment-required");
    if (!header) throw new SingItPaymentError("Got HTTP 402 with no PAYMENT-REQUIRED header.");
    const challenge = decodeHeader(header);
    const offer = selectOffer(challenge, { scheme, payTo, maxCapAtomic: maxPerCallAtomic, resourceUrl: request.url });

    const release = dailyLimiter.reserve(offer.amount);
    let payload;
    try {
      payload = await signOffer(scheme, offer, challenge.extensions, signer);
    } catch (error) {
      release();
      throw error;
    }

    // redirect: "error" so a redirect can never carry PAYMENT-SIGNATURE elsewhere or resend the paid POST.
    const paidRequest = new Request(request.clone(), { redirect: "error" });
    paidRequest.headers.set("PAYMENT-SIGNATURE", Buffer.from(JSON.stringify(payload)).toString("base64"));
    let response;
    try {
      response = await fetchImpl(paidRequest);
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

    const bodyText = await response.text();
    const result = bodyText ? JSON.parse(bodyText) : null;
    const totalAtomic = result?.billing?.totalAtomic;
    if (!isAtomicAmount(totalAtomic) || BigInt(totalAtomic) > BigInt(offer.amount)) {
      throw new SingItPaymentError("The invoice does not match the offered ceiling; treating the payment as unresolved "
        + "(its ceiling stays counted against the daily cap).");
    }
    dailyLimiter.settle(release, totalAtomic, offer.amount);

    // Rebuild the Response: body was already consumed above to read the billed amount.
    return new Response(bodyText, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
