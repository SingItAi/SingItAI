import { encodeFunctionData, erc20Abi } from "viem";

import { appendDataSuffix } from "./token-return.mjs";


const USDC_ADDRESS_BY_NETWORK = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};


// account.transfer() has no way to carry an ERC-8021 attribution suffix, so
// when one is set we build the ERC-20 transfer ourselves via sendTransaction.
// Unset or unknown network falls back to account.transfer unchanged.
export async function transferUsdc({ account, to, amount, network, dataSuffix }) {
  const usdcAddress = USDC_ADDRESS_BY_NETWORK[network];
  if (dataSuffix && usdcAddress) {
    const result = await account.sendTransaction({
      network,
      transaction: {
        to: usdcAddress,
        data: appendDataSuffix(
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [to, amount],
          }),
          dataSuffix,
        ),
      },
    });
    const transactionHash = result?.transactionHash || result?.hash;
    return {
      ok: true,
      transactionHash,
      to,
      amount: amount.toString(),
      token: "usdc",
      network,
    };
  }

  const result = await account.transfer({
    to,
    amount,
    token: "usdc",
    network,
  });
  const transactionHash = result?.transactionHash || result?.hash;
  return {
    ok: true,
    transactionHash,
    to,
    amount: amount.toString(),
    token: "usdc",
    network,
  };
}
