export const MAX_PAYMENT_REQUIRED_HEADER_BYTES = 8192;

// Keep discovery info and signed offers intact; detailed validation schemas travel in the body.
export function slimPaymentRequired(challenge) {
  const slim = structuredClone(challenge);
  for (const extension of Object.values(slim.extensions ?? {})) {
    if (extension && typeof extension === "object" && !Array.isArray(extension)
      && Object.hasOwn(extension, "schema")) {
      extension.schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };
    }
  }
  return slim;
}

export function paymentRequiredHeaderMiddleware({ log = () => {} } = {}) {
  const skipped = () => { try { log("singit-ask: payment-required header slimming skipped"); } catch { /* logging must not break the response */ } };
  return (req, res, next) => {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (String(name).toLowerCase() === "payment-required") {
        try {
          const full = JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
          if (!full || typeof full !== "object" || Array.isArray(full)) throw new Error("Invalid challenge");
          const encoded = Buffer.from(JSON.stringify(slimPaymentRequired(full))).toString("base64");
          res.locals.singitPaymentRequiredFull = full;
          value = encoded;
        } catch { skipped(); }
      }
      return setHeader(name, value);
    };
    const json = res.json.bind(res);
    res.json = (body) => {
      try {
        const full = res.locals.singitPaymentRequiredFull;
        if (res.statusCode === 402 && full?.extensions && body && typeof body === "object" && !Array.isArray(body)) {
          body = { ...body, extensions: full.extensions };
        }
      } catch { skipped(); }
      return json(body);
    };
    next();
  };
}
