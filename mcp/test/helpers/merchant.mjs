// A local stand-in for SingIt Ask: GET /v1/models is free; POST /v1/chat/completions answers 402 with a real
// x402 v2 `upto` challenge and, on the paid retry, verifies the Permit2-witness signature with viem (the same
// check as sdk/typescript/test/helpers/merchant.mjs). `funded: false` refuses every payment with a second 402,
// like an empty wallet. No facilitator, no chain, no network access.
import http from "node:http";
import { getAddress, verifyTypedData } from "viem";

const UPTO_PROXY = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};

const decode = value => JSON.parse(Buffer.from(value, "base64").toString("utf8"));
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");

async function verifyUpto(payment) {
  const offer = payment.accepted;
  const auth = payment.payload?.permit2Authorization;
  const signature = payment.payload?.signature;
  if (!auth || !signature) return { ok: false };
  if (getAddress(auth.spender) !== getAddress(UPTO_PROXY) || getAddress(auth.witness.to) !== getAddress(offer.payTo)
    || auth.permitted.amount !== offer.amount) return { ok: false };
  const ok = await verifyTypedData({
    address: auth.from,
    domain: { name: "Permit2", chainId: Number(offer.network.split(":")[1]), verifyingContract: PERMIT2 },
    types: TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
      spender: getAddress(auth.spender), nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline),
      witness: { to: getAddress(auth.witness.to), facilitator: getAddress(auth.witness.facilitator),
        validAfter: BigInt(auth.witness.validAfter) },
    },
    signature,
  });
  return { ok, payer: auth.from };
}

export function startMerchant({ offer, funded = true, acceptBearer } = {}) {
  const requests = [];
  let resourceUrl;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const entry = { method: req.method, path: req.url, headers: req.headers, body, status: null, payer: null };
    requests.push(entry);
    const reply = (status, payload, headers = {}) => {
      entry.status = status;
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const completion = extra => ({
      id: "singit-ask-mock-1", object: "chat.completion", created: 0, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "Hello back." }, finish_reason: "stop" }],
      ...extra,
    });
    if (req.method === "GET" && req.url === "/v1/models") {
      return reply(200, { object: "list", data: [{ id: "deepseek-v4.1-flash", object: "model" }] });
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return reply(404, { error: "Not found." });
    if (acceptBearer && req.headers.authorization === `Bearer ${acceptBearer}`) return reply(200, completion({}));
    const paymentHeader = req.headers["payment-signature"];
    if (!paymentHeader) {
      return reply(402, { error: "Payment required." },
        { "PAYMENT-REQUIRED": encode({ x402Version: 2, resource: { url: resourceUrl }, accepts: [offer] }) });
    }
    const payment = decode(paymentHeader);
    const { ok, payer } = await verifyUpto(payment);
    entry.payer = payer ?? null;
    if (!ok || !funded) return reply(402, { error: "Payment refused." });
    const billed = (BigInt(payment.accepted.amount) / 2n).toString();
    return reply(200, completion({ billing: { totalAtomic: billed } }), {
      "payment-response": encode({ success: true, network: payment.accepted.network, payer, transaction: `0x${"ab".repeat(32)}` }),
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resourceUrl = `${url}/v1/chat/completions`;
      resolve({ url, requests, close: () => new Promise(r => server.close(r)) });
    });
  });
}
