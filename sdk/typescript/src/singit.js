import { NETWORKS, DEFAULT_BASE_URL, DEFAULT_APP_BASE_URL, ROUTE, perModelRoute } from "./pins.js";
import { SingItPaymentError, selectOffer, decodeHeader, DailyLimiter, usdToAtomic, isAtomicAmount } from "./guards.js";
import { buildEvmSigner } from "./signers.js";

function requiredModel(model) {
  if (!model || typeof model !== "string") throw new SingItPaymentError('model is required when route is "per-model".');
  return model;
}

// Preserves the merchant's own extension declaration (description/version/schema, ...) while
// adding the signed fields, the same merge @x402's full client applies and metered-buyer.mjs
// reimplements: dropping the declared fields trips the facilitator's extension_echo_mismatch.
function mergeExtensions(signedExtensions, declaredExtensions) {
  if (!signedExtensions) return undefined;
  return Object.fromEntries(Object.entries(signedExtensions).map(([key, value]) => {
    const declared = declaredExtensions?.[key] ?? {};
    return [key, { ...declared, ...value, info: { ...declared.info, ...value.info } }];
  }));
}

function samePayer(family, a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readJsonOrThrow(response) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SingItPaymentError(`Request failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

/**
 * x402 payment and client-side allowance for SingIt Ask, in a few lines:
 *
 *   const singit = new SingIt({ evmPrivateKey, network: "base", maxPerCallUsd: 0.01, maxPerDayUsd: 1 });
 *   const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
 *
 * Every payment is checked against a pinned network/asset/payTo and a per-call and per-day USDC
 * ceiling before anything is signed; see guards.js. Nothing here ever raises a configured ceiling.
 */
export class SingIt {
  constructor(options = {}) {
    const {
      network, baseUrl = DEFAULT_BASE_URL, appBaseUrl = DEFAULT_APP_BASE_URL, payTo, rpcUrl,
      evmPrivateKey, evmAccount, solanaSigner, maxPerCallUsd, maxPerDayUsd, fetchImpl = fetch,
    } = options;
    const pin = NETWORKS[network];
    if (!pin) throw new SingItPaymentError(`Unknown network "${network}". Use "base", "base-sepolia" or "solana".`);
    if (pin.payTo == null && !payTo) {
      throw new SingItPaymentError(`SingIt has no deployment on ${network}; pass payTo explicitly (see README).`);
    }
    if (maxPerCallUsd == null || maxPerDayUsd == null) {
      throw new SingItPaymentError("maxPerCallUsd and maxPerDayUsd are required: this SDK never pays without a ceiling.");
    }
    this.network = network;
    this.pin = pin;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.appBaseUrl = appBaseUrl.replace(/\/$/, "");
    this.payTo = payTo ?? pin.payTo;
    this.rpcUrl = rpcUrl ?? pin.defaultRpcUrl;
    this.maxPerCallAtomic = usdToAtomic(maxPerCallUsd);
    this.limiter = new DailyLimiter(usdToAtomic(maxPerDayUsd));
    this.fetchImpl = fetchImpl;
    this._evm = { evmPrivateKey, evmAccount };
    this._solanaSigner = solanaSigner;
  }

  async _sign(scheme, offer, extensions) {
    if (this.pin.family === "evm") {
      const signer = buildEvmSigner({ ...this._evm, viemChain: this.pin.viemChain, rpcUrl: this.rpcUrl });
      const { [scheme === "upto" ? "UptoEvmScheme" : "ExactEvmScheme"]: Scheme } =
        await import(scheme === "upto" ? "@x402/evm/upto/client" : "@x402/evm/exact/client");
      const signed = await new Scheme(signer).createPaymentPayload(2, offer, { extensions });
      const mergedExtensions = mergeExtensions(signed.extensions, extensions);
      return { x402Version: 2, accepted: offer, payload: signed.payload, ...(mergedExtensions ? { extensions: mergedExtensions } : {}) };
    }
    if (!this._solanaSigner) throw new SingItPaymentError("Pass solanaSigner to pay on Solana.");
    const { [scheme === "upto" ? "UptoSvmScheme" : "ExactSvmScheme"]: Scheme } =
      await import(scheme === "upto" ? "@x402/svm/upto/client" : "@x402/svm/exact/client");
    const signed = await new Scheme(this._solanaSigner, { rpcUrl: this.rpcUrl }).createPaymentPayload(2, offer);
    return { x402Version: 2, accepted: offer, payload: signed.payload };
  }

  /**
   * One OpenAI-shaped chat completion, paid over x402.
   *
   * `route: "per-model"` calls POST /v1/chat/{model} (SI-62), which is live;
   * the default calls POST /v1/chat/completions, which is live today.
   */
  async chat({ model, messages, max_tokens, scheme = "upto", route = "completions" } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new SingItPaymentError("messages must be a non-empty array.");
    }
    if (scheme !== "upto" && scheme !== "exact") throw new SingItPaymentError('scheme must be "upto" or "exact".');
    if (route !== "completions" && route !== "per-model") throw new SingItPaymentError('route must be "completions" or "per-model".');
    const path = route === "per-model" ? perModelRoute(requiredModel(model)) : ROUTE;
    const url = `${this.baseUrl}${path}`;
    const body = {
      messages,
      ...(max_tokens != null ? { max_tokens } : {}),
      ...(model && route === "completions" ? { model } : {}),
      stream: false,
    };
    const encodedBody = JSON.stringify(body);
    const send = headers => this.fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
      headers: { "Content-Type": "application/json", ...headers }, body: encodedBody,
    });

    const first = await send({});
    if (first.status !== 402) return { ...(await readJsonOrThrow(first)), payment: null };

    const { receipt, text } = await this._payOffer({ first, scheme, url, send });
    const result = JSON.parse(text);

    return {
      ...result,
      payment: { scheme, network: this.network, amountAtomic: result.billing.totalAtomic, ...(receipt?.transaction ? { txHash: receipt.transaction } : {}) },
    };
  }

  /**
   * Everything between "the merchant answered 402" and "the paid answer arrived": pin the offer, reserve the
   * worst case against today's cap, sign, send once, and settle upto reservations down to the billed amount. Shared by
   * chat() and paidFetch() so both enforce the same guards before anything is signed. Returns the paid
   * response, its text (already validated as an invoice no larger than the offered ceiling), and validated receipt.
   */
  async _payOffer({ first, scheme, url, send }) {
    const header = first.headers.get("payment-required");
    if (!header) throw new SingItPaymentError("Got HTTP 402 with no PAYMENT-REQUIRED header.");
    const challenge = decodeHeader(header);
    const offer = selectOffer(challenge, {
      scheme, networkId: this.pin.caip, family: this.pin.family,
      asset: this.pin.asset, payTo: this.payTo, maxCapAtomic: this.maxPerCallAtomic, resourceUrl: url,
    });

    const release = this.limiter.reserve(offer.amount);
    let payload;
    try {
      payload = await this._sign(scheme, offer, challenge.extensions);
    } catch (error) {
      release();
      throw error;
    }

    // Once a signed payment has left, only a 402 (payment refused) proves nothing settled. A dropped connection,
    // another status or an unreadable invoice may still have settled, so the worst-case reservation stays counted
    // against today's cap (Codex review).
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
    const text = await response.text().catch(() => "");
    let result = null;
    try { result = JSON.parse(text); } catch { /* treated as an unreadable invoice below */ }
    const totalAtomic = result?.billing?.totalAtomic;
    if (!isAtomicAmount(totalAtomic) || BigInt(totalAtomic) > BigInt(offer.amount)
      || (scheme === "exact" && BigInt(totalAtomic) !== BigInt(offer.amount))) {
      throw new SingItPaymentError("The invoice does not match the offered ceiling; treating the payment as unresolved "
        + "(its ceiling stays counted against the daily cap).");
    }
    const receipt = this._checkReceipt(response, payload);
    if (scheme === "upto") this.limiter.settle(release, totalAtomic, offer.amount);
    return { response, offer, payload, text, receipt };
  }

  _checkReceipt(response, payload) {
    const receiptHeader = response.headers.get("payment-response");
    const receipt = receiptHeader ? decodeHeader(receiptHeader) : null;
    const payer = payload.payload?.permit2Authorization?.from ?? payload.payload?.authorization?.from ?? payload.payload?.from;
    if (receipt && (receipt.network !== this.pin.caip || (payer && receipt.payer && !samePayer(this.pin.family, receipt.payer, payer)))) {
      throw new SingItPaymentError("The settlement receipt does not match this request; treating the payment as unresolved.");
    }
    return receipt;
  }

  /**
   * A fetch-compatible function for frameworks that take a custom `fetch` (LangChain's ChatOpenAI
   * `configuration.fetch`, the AI SDK's `createOpenAICompatible({ fetch })`, the OpenAI SDK's `fetch`).
   * A request to SingIt Ask that gets HTTP 402 is paid exactly like chat(): same pins, same per-call and
   * per-day ceilings (shared with chat() on this instance), signed once, never repeated. Requests to any other
   * origin pass through untouched and unpaid. Non-streaming JSON answers only: the billed amount is read from
   * the answer's `billing.totalAtomic`, so a paid answer without it counts as unresolved and the framework must
   * not retry (set maxRetries to 0).
   */
  paidFetch({ scheme = "upto" } = {}) {
    if (scheme !== "upto" && scheme !== "exact") throw new SingItPaymentError('scheme must be "upto" or "exact".');
    const origin = new URL(this.baseUrl).origin;
    return async (input, init) => {
      let request = new Request(input, init);
      if (new URL(request.url).origin !== origin) return this.fetchImpl(request);
      request = new Request(request, { redirect: "error" });
      const first = await this.fetchImpl(request.clone());
      if (first.status !== 402) return first;
      // redirect: "error" so a redirect can never carry PAYMENT-SIGNATURE elsewhere or resend the paid POST.
      const send = headers => {
        const paid = new Request(request.clone(), { redirect: "error" });
        for (const [name, value] of Object.entries(headers)) paid.headers.set(name, value);
        return this.fetchImpl(paid);
      };
      const { response, text } = await this._payOffer({ first, scheme, url: request.url, send });
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }

  /** GET /v1/wallet/{address}/reconciliation on app.singitai.app (SI-67). The report is private: pass
   *  apiKey, a SingIt API key (sk_singit_...) of the account that signs in with `address`. */
  async walletReport(address, { days, apiKey } = {}) {
    const qs = days != null ? `?days=${encodeURIComponent(days)}` : "";
    const response = await this.fetchImpl(`${this.appBaseUrl}/v1/wallet/${encodeURIComponent(address)}/reconciliation${qs}`,
      apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
    if (response.status === 401 || response.status === 403) {
      throw new SingItPaymentError(
        `The wallet report is private (HTTP ${response.status}): pass apiKey, a SingIt API key of the account that signs in with this wallet.`
      );
    }
    if (!response.ok) {
      throw new SingItPaymentError(
        `Wallet reconciliation is not available (HTTP ${response.status}).`
      );
    }
    return response.json();
  }

  /** GET /pricing.json on the SingIt Ask base URL (SI-68; live). */
  async pricing() {
    const response = await this.fetchImpl(`${this.baseUrl}/pricing.json`);
    if (!response.ok) {
      throw new SingItPaymentError(
        `pricing.json is not available (HTTP ${response.status}).`
      );
    }
    return response.json();
  }

  /** The on-chain spending limit set in the SingIt app for `address`, with today's spent/remaining. */
  async allowance(address, options) {
    const report = await this.walletReport(address, options);
    return report?.allowance;
  }
}
