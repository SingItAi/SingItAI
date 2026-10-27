// RPCs can lag a successful settlement: remembering consumed nonces locally prevents paying for another model
// answer while the buyer and facilitator still see the old chain state. This is only a short-lived safety net;
// the facilitator remains authoritative, and malformed payments must reach its existing validation unchanged.
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
    record(payload) {
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
