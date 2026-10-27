// RPCs can lag a successful settlement: remembering consumed nonces locally prevents paying for another model
// answer while the buyer and facilitator still see the old chain state. This is only a short-lived safety net;
// the facilitator remains authoritative, and malformed payments must reach its existing validation unchanged.
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

export function createPermitGuard({ maxEntries = 10000, ttlMs = 600000, now = Date.now } = {}) {
  const settled = new Map();
  const permit = payload => {
    const info = payload?.extensions?.eip2612GasSponsoring?.info;
    if (typeof info?.from !== "string" || typeof info.asset !== "string") return null;
    if (!(typeof info.nonce === "string" && /^\d+$/.test(info.nonce))
        && !(Number.isSafeInteger(info.nonce) && info.nonce >= 0)) return null;
    return { key: `${info.from.toLowerCase()}:${info.asset.toLowerCase()}`, nonce: BigInt(info.nonce) };
  };
  const entry = key => {
    const value = settled.get(key);
    if (value && now() - value.at >= ttlMs) { settled.delete(key); return undefined; }
    return value;
  };
  return {
    // Only a permit the settlement provably consumed: on `upto` over EVM (Permit2), a payment that carries the
    // eip2612GasSponsoring extension is verified with that permit bound to the payer and the token
    // (@x402/evm 2.28 upto/facilitator `validateEip2612PermitForPayment`) and settled through
    // `settleUptoWithEIP2612`, which spends its nonce in the same transaction. `exact` (EIP-3009) settles
    // without it, so an extension riding along there is never trusted: anyone could name another wallet in it.
    record(payload, requirements, result) {
      if (requirements?.scheme !== "upto" || !String(requirements?.network ?? "").startsWith("eip155:")) return;
      if (!payload?.payload?.permit2Authorization) return;
      const info = payload?.extensions?.eip2612GasSponsoring?.info;
      if (typeof result?.payer !== "string" || typeof info?.from !== "string"
          || info.from.toLowerCase() !== result.payer.toLowerCase()) return;
      if (typeof requirements.asset !== "string" || typeof info.asset !== "string"
          || info.asset.toLowerCase() !== requirements.asset.toLowerCase()) return;
      if (typeof info.spender !== "string" || info.spender.toLowerCase() !== PERMIT2) return;
      const p = permit(payload);
      if (!p) return;
      const previous = entry(p.key);
      settled.delete(p.key);
      settled.set(p.key, { nonce: previous && previous.nonce > p.nonce ? previous.nonce : p.nonce, at: now() });
      while (settled.size > maxEntries) settled.delete(settled.keys().next().value);
    },
    middleware(req, res, next) {
      let p;
      try {
        const header = req.get("payment-signature") ?? req.get("x-payment");
        p = permit(JSON.parse(Buffer.from(header, "base64").toString()));
      } catch { return next(); }
      if (!p || !(p.nonce <= entry(p.key)?.nonce)) return next();
      return res.status(409).json({ error: { type: "invalid_request_error", code: "stale_payment_permit",
        message: "This payment's USDC permit reuses a nonce your previous payment already spent: your RPC had not seen that settlement yet. Wait for the previous payment's transaction, sign again and retry. You were not charged." } });
    },
  };
}

export const permitGuard = createPermitGuard();
