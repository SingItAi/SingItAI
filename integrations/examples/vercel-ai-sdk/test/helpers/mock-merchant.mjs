// A local mock merchant for SingIt Ask's Base offer: issues a real x402 v2 402 challenge and, on
// the paid retry, verifies the client's signature for real (the same EIP-712 domain/types
// @x402/evm's client schemes sign with: Permit2 witness for upto, EIP-3009 for exact) using
// viem's verifyTypedData. No facilitator, no chain, no network access. Adapted from
// sdk/typescript/test/helpers/merchant.mjs, trimmed to Base (eip155:8453) only.
import http from "node:http";
import { getAddress, verifyTypedData } from "viem";

export const X402_UPTO_PERMIT2_PROXY_ADDRESS = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CHAIN_ID = 8453;

const UPTO_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export const decode = value => JSON.parse(Buffer.from(value, "base64").toString("utf8"));
export const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");

export async function verifyUptoPayload(paymentPayload) {
  const offer = paymentPayload.accepted;
  const auth = paymentPayload.payload?.permit2Authorization;
  const signature = paymentPayload.payload?.signature;
  if (!auth || !signature) return { ok: false, payer: undefined };
  const payer = auth.from;
  if (getAddress(auth.spender) !== getAddress(X402_UPTO_PERMIT2_PROXY_ADDRESS)) return { ok: false, payer };
  if (getAddress(auth.witness.to) !== getAddress(offer.payTo)) return { ok: false, payer };
  if (getAddress(auth.witness.facilitator) !== getAddress(offer.extra.facilitatorAddress)) return { ok: false, payer };
  if (auth.permitted.amount !== offer.amount) return { ok: false, payer };
  const ok = await verifyTypedData({
    address: payer,
    domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS },
    types: UPTO_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
      spender: getAddress(auth.spender),
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: {
        to: getAddress(auth.witness.to),
        facilitator: getAddress(auth.witness.facilitator),
        validAfter: BigInt(auth.witness.validAfter),
      },
    },
    signature,
  });
  return { ok, payer };
}

export async function verifyExactPayload(paymentPayload) {
  const offer = paymentPayload.accepted;
  const auth = paymentPayload.payload?.authorization;
  const signature = paymentPayload.payload?.signature;
  if (!auth || !signature) return { ok: false, payer: undefined };
  const payer = auth.from;
  if (getAddress(auth.to) !== getAddress(offer.payTo)) return { ok: false, payer };
  if (auth.value !== offer.amount) return { ok: false, payer };
  const ok = await verifyTypedData({
    address: payer,
    domain: { name: offer.extra.name, version: offer.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(offer.asset) },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(auth.from), to: getAddress(auth.to), value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
    },
    signature,
  });
  return { ok, payer };
}

export function uptoOffer({ asset, payTo, amount, maxTimeoutSeconds = 120, facilitatorAddress, assetName = "USD Coin", assetVersion = "2" }) {
  return {
    scheme: "upto", network: "eip155:8453", asset, payTo, amount, maxTimeoutSeconds,
    extra: { facilitatorAddress, assetTransferMethod: "permit2", name: assetName, version: assetVersion,
      billing: { mode: "actual_usage", maxChargeAtomic: amount } },
  };
}

export function exactOffer({ asset, payTo, amount, maxTimeoutSeconds = 120, assetName = "USD Coin", assetVersion = "2" }) {
  return {
    scheme: "exact", network: "eip155:8453", asset, payTo, amount, maxTimeoutSeconds,
    extra: { name: assetName, version: assetVersion, billing: { mode: "exact_ceiling", maxChargeAtomic: amount } },
  };
}

// Starts a one-shot local HTTP merchant. `accepts(body)` builds the offer list for a given request
// body; `bill(offer)` decides the atomic amount actually billed (defaults to the full ceiling for
// `exact`, half of it for `upto`, simulating metered usage).
export function startMockMerchant({ accepts, bill, verifyOverride } = {}) {
  let resourceUrl;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const paymentHeader = req.headers["payment-signature"];
    if (!paymentHeader) {
      const offers = accepts(body);
      res.setHeader("PAYMENT-REQUIRED", encode({ x402Version: 2, resource: { url: resourceUrl }, accepts: offers }));
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payment required." }));
      return;
    }
    const paymentPayload = decode(paymentHeader);
    const offer = paymentPayload.accepted;
    const verify = verifyOverride ?? (offer?.scheme === "upto" ? verifyUptoPayload : verifyExactPayload);
    const { ok, payer } = await verify(paymentPayload);
    if (!ok) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid payment signature." }));
      return;
    }
    const billedAtomic = (bill ?? (o => (o.scheme === "exact" ? o.amount : (BigInt(o.amount) / 2n).toString())))(offer);
    res.setHeader("payment-response", encode({ success: true, network: "base", payer, transaction: `0x${"ab".repeat(32)}` }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "singit-ask-mock-1", object: "chat.completion", created: 0, model: "singit-ask-mock",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello back." }, finish_reason: "stop" }],
      usage: { buyer_cost_micro: 100 }, billing: { totalAtomic: billedAtomic },
    }));
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resourceUrl = `${url}/v1/chat/completions`;
      resolve({ url, resourceUrl, close: () => new Promise(r => server.close(r)) });
    });
  });
}
