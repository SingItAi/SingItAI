// No dependencies on purpose: the website build imports free.mjs without installing the service's packages.
export const safeDiagnostic = value => String(value ?? 'unknown')
  .replace(/\b(?:authorization|token|key|payment-signature|x-payment)\s*[:=][^\r\n]*/gi, '[redacted]')
  .replace(/\bbearer\s+\S+/gi, '[redacted]')
  .replace(/0x[a-fA-F0-9]+|[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
  .replace(/[^\x20-\x7e]/g, ' ').slice(0, 200);
