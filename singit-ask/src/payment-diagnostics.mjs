// Diagnostics only: never serialize a payment, transaction, signature, or exception.
import { decodePaymentSignatureHeader } from '@x402/core/http';

export const safeDiagnostic = value => String(value ?? 'unknown')
  .replace(/\b(?:authorization|token|key|payment-signature|x-payment)\s*[:=][^\r\n]*/gi, '[redacted]')
  .replace(/\bbearer\s+\S+/gi, '[redacted]')
  .replace(/0x[a-fA-F0-9]+|[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
  .replace(/[^\x20-\x7e]/g, ' ').slice(0, 200);
const short = value => typeof value === 'string' && /^[A-Za-z0-9]{9,}$/.test(value)
  ? `${value.slice(0, 4)}...${value.slice(-4)}` : 'unknown';

// One limiter per process, shared by all HTTP resource servers. Factory permits clock-controlled tests.
export function malformedPaymentWarning({ now = Date.now } = {}) {
  let last = -Infinity, suppressed = 0;
  return (log, route, error) => {
    const time = now();
    if (time - last < 60_000) { suppressed++; return; }
    const count = suppressed;
    last = time; suppressed = 0;
    try { log(`singit-ask: malformed payment header on ${safeDiagnostic(route)} (${safeDiagnostic(error.name)}) suppressed=${count}`); } catch {}
  };
}
const warnMalformed = malformedPaymentWarning();
export function paymentExtractor(log, warn = warnMalformed) {
  return adapter => {
    const header = adapter.getHeader('payment-signature') || adapter.getHeader('PAYMENT-SIGNATURE');
    if (header) {
      try { return decodePaymentSignatureHeader(header); }
      catch (error) { warn(log, adapter.getPath(), error); }
    }
    // Matches x402's extractPayment fallback, including its unchanged handling of X-PAYMENT.
    return null;
  };
}

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
// Parse only static keys and top-level SPL TransferChecked instructions (legacy and v0).
// Lookup-table keys and inner/CPI transfers need chain state; leave those unknown, never guess an ATA.
export function transactionAccounts(encoded) {
  try {
    if (typeof encoded !== 'string' || encoded.length > 32_768) return {};
    const bytes = Buffer.from(encoded, 'base64'); let offset = 0;
    const take = n => { if (offset + n > bytes.length) throw new Error(); const b = bytes.subarray(offset, offset += n); return b; };
    const byte = () => take(1)[0];
    const compact = () => { let n = 0; for (let i = 0; i < 3; i++) { const b = byte(); n |= (b & 127) << (7 * i); if (!(b & 128)) return n; } throw new Error(); };
    take(compact() * 64);
    const first = byte();
    if (first & 128) { if (first !== 128) return {}; take(3); } else take(2);
    const keys = Array.from({ length: compact() }, () => base58(take(32)));
    take(32);
    const count = compact();
    for (let i = 0; i < count; i++) {
      const program = keys[byte()], accounts = take(compact()), data = take(compact());
      if (['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(program)
          && data.length === 10 && data[0] === 12 && accounts.length >= 4) {
        return { ata: keys[accounts[0]], payer: keys[accounts[3]] };
      }
    }
  } catch { /* Malformed diagnostic data never affects verification or settlement. */ }
  return {};
}

export function paymentFailureLine(route, phase, ctx) {
  const { network, scheme, amount } = ctx.requirements ?? {};
  const error = ctx.error ?? ctx.result ?? {};
  const reason = [error.errorReason ?? error.invalidReason, error.message ?? error.errorMessage ?? error.invalidMessage]
    .filter(Boolean).join(': ') || 'unknown';
  let accounts = '';
  if (typeof network === 'string' && network.startsWith('solana:')) {
    let payment = ctx.paymentPayload;
    if (!payment) {
      try {
        const adapter = ctx.transportContext?.request?.adapter;
        payment = decodePaymentSignatureHeader(adapter?.getHeader('payment-signature') ?? adapter?.getHeader('x-payment'));
      } catch {}
    }
    const payload = payment?.payload ?? {};
    const tx = transactionAccounts(payload.transaction ?? payload.deposit?.transaction);
    accounts = ` payer=${short(error.payer || ctx.result?.payer || payload.payer || payload.channelConfig?.payer || tx.payer)} ata=${short(payload.sourceTokenAccount || payload.sourceTokenAccountAddress || payload.source || tx.ata)}`;
  }
  // Requirements are server-selected; retain the complete CAIP network identifier.
  const networkLabel = typeof network === 'string'
    && /^(?:solana:[1-9A-HJ-NP-Za-km-z]{1,44}|eip155:[0-9]{1,20})$/.test(network) ? network : safeDiagnostic(network);
  return `singit-ask: ${safeDiagnostic(route)} ${phase} network=${networkLabel} scheme=${safeDiagnostic(scheme)} amount=${safeDiagnostic(amount)}${accounts} reason=${safeDiagnostic(reason)}`;
}
