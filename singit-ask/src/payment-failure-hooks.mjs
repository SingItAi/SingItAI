import { AsyncLocalStorage } from "node:async_hooks";
import { originalVerificationFailure } from "./facilitator-hints.mjs";
import { PAYMENT_ERROR_CODES, ACTIONS, messageFor, classifyPaymentFailure } from "./payment-codes.mjs";

export const paymentFailureContext = new AsyncLocalStorage();
export function attachPaymentFailureCodes(server) {
  const record = phase => ctx => {
    try {
      const store = paymentFailureContext.getStore();
      const failure = ctx?.error ?? ctx?.result;
      if (!store || !failure || typeof failure !== "object") return;
      const original = failure[originalVerificationFailure];
      const text = [failure, original].filter(Boolean).flatMap(f =>
        [f.invalidReason, f.errorReason, f.invalidMessage, f.errorMessage, f.message])
        .filter(v => typeof v === "string").join(" ");
      const network = ctx.requirements?.network;
      if (phase === "settle") {
        // Only a refusal the facilitator reported with a reason counts. A settlement that may have reached
        // the chain (transaction hash, pending, timeout, transport error) keeps the legacy answer instead of
        // claiming nothing was charged.
        const reason = typeof failure.errorReason === "string" ? failure.errorReason : "";
        if (!reason || failure.transaction || /pending|time(?:d)? ?out|unavailable|unexpected|settlement failed|unknown reason/i.test(text + " " + reason)) return;
      }
      store.failure = { code: classifyPaymentFailure({ message: text }), phase, network };
    } catch {}
  };
  server.onVerifyFailure(record("verify"));
  const verify = record("verify");
  server.onAfterVerify(ctx => {
    try {
      if (ctx?.result?.isValid === false) return verify(ctx);
      // When this payment's verification succeeded: Solana `exact` gives the model a window from here
      // (solana-exact-window.mjs).
      const store = paymentFailureContext.getStore();
      if (store && ctx?.result?.isValid === true)
        store.verified = { at: (store.clock ?? Date).now(), network: ctx.requirements?.network, scheme: ctx.requirements?.scheme };
    } catch {}
  });
  server.onSettleFailure(record("settle"));
  return server;
}
export function paymentCodesMiddleware({ stats, log, clock } = {}) {
  return (_req, res, next) => {
    const store = { clock }, json = res.json.bind(res);
    let recorded = false;
    res.json = body => {
      if (res.statusCode === 402 && store.failure && body
          && [Object.prototype, null].includes(Object.getPrototypeOf(body))) {
        const { code, network, phase } = store.failure;
        body = { ...body, code, action: ACTIONS[code], message: messageFor(code, network) };
        if (!recorded) {
          recorded = true;
          try { stats?.recordPaymentFailure({ code, network, phase }); } catch {}
        }
      }
      // errorCodesMiddleware supplies a legacy 409 default inside this wrapper.
      const code = body?.code ?? body?.error?.code ?? (typeof body?.error === "string"
        && /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : res.statusCode === 409 ? "payment_duplicate" : undefined);
      if (res.statusCode >= 400 && [...PAYMENT_ERROR_CODES, "payment_duplicate", "stale_payment_permit", "permit2_allowance_required"].includes(code)) res.set("X-SingIt-Error", code);
      return json(body);
    };
    paymentFailureContext.run(store, next);
  };
}
