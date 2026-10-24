import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { SingItPaymentError } from "./guards.js";

// An EVM signer plus a read-only client, the same shape buyer-cli.mjs builds by hand:
// { address, signTypedData, readContract }. `readContract` backfills EIP-2612 gas-sponsoring
// extension capability in @x402/evm's client schemes; it is optional but cheap to provide.
export function buildEvmSigner({ evmPrivateKey, evmAccount, viemChain, rpcUrl }) {
  if (!evmAccount && !evmPrivateKey) {
    throw new SingItPaymentError("Pass evmPrivateKey or evmAccount to pay on an EVM network.");
  }
  const account = evmAccount ?? privateKeyToAccount(evmPrivateKey);
  const chain = chains[viemChain];
  if (!chain) throw new SingItPaymentError(`Unknown viem chain "${viemChain}".`);
  const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  return {
    address: account.address,
    signTypedData: account.signTypedData.bind(account),
    readContract: client.readContract.bind(client),
  };
}
