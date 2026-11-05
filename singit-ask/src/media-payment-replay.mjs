import crypto from 'node:crypto';

// Process-wide, shared by edits and embeddings. images/generations should adopt this store later.
export const reservations = new Map();
export function paymentDigest(payment) {
  const network = String(payment.accepted?.network ?? '').trim();
  const evm = /^eip155:/i.test(network);
  const authorization = payment.payload?.authorization;
  const identity = evm ? {
    network: `eip155:${BigInt(network.split(':')[1])}`,
    asset: String(payment.accepted?.asset ?? '').toLowerCase(),
    signer: String(authorization?.from ?? '').toLowerCase(),
    nonce: String(authorization?.nonce ?? payment.payload?.signature ?? '').toLowerCase(),
  } : { network, transaction: payment.payload?.transaction ?? payment.payload?.signature };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
