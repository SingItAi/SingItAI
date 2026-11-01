import { VerifyError } from '@x402/core/types';

// Non-enumerable diagnostic provenance: never part of a response body.
export const originalVerificationFailure = Symbol('originalVerificationFailure');
const hint = "The payer's USDC token account is missing or not initialised. Fund the wallet with USDC on Solana mainnet so the associated token account exists, and send the payment from the wallet that owns that account.";

function hinted(failure, requirements) {
  if (!requirements?.network?.startsWith('solana:')
      || ![failure.invalidReason, failure.invalidMessage].some(value =>
        typeof value === 'string' && /invalid_?account_?data/i.test(value))) return failure;
  // Keep only the machine code, never simulation text or account addresses.
  const code = failure.invalidReason?.match(/^[A-Za-z][A-Za-z0-9_]*(?=$|[\s:])/)?.[0];
  if (!code) return failure;
  const reason = `${code}: ${hint}`;
  const descriptors = Object.getOwnPropertyDescriptors(failure);
  descriptors.invalidReason = { value: reason, writable: true, enumerable: true, configurable: true };
  if (failure instanceof VerifyError) descriptors.message = { value: reason, writable: true, configurable: true };
  descriptors[originalVerificationFailure] = { value: failure };
  return Object.create(Object.getPrototypeOf(failure), descriptors);
}

export function withFacilitatorHints(client) {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'verify') return async (payload, requirements) => {
        let result;
        try { result = await target.verify(payload, requirements); }
        catch (error) {
          throw error instanceof VerifyError ? hinted(error, requirements) : error;
        }
        return result?.isValid === false ? hinted(result, requirements) : result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
