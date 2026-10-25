// Pinned, per-network expectations an x402 offer must match before the SDK signs anything.
// Base and Solana values are the live SingIt Ask addresses (singit-ask/src/pricing.mjs).
// Base Sepolia has no SingIt deployment: its USDC address is the well-known testnet asset,
// and `payTo` is never pinned here — the caller must pass one explicitly (SingIt.payTo).
export const NETWORKS = {
  base: {
    caip: "eip155:8453",
    family: "evm",
    chainId: 8453,
    viemChain: "base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e",
    assetName: "USD Coin",
    assetVersion: "2",
    defaultRpcUrl: "https://mainnet.base.org",
  },
  "base-sepolia": {
    caip: "eip155:84532",
    family: "evm",
    chainId: 84532,
    viemChain: "baseSepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: null,
    assetName: "USDC",
    assetVersion: "2",
    defaultRpcUrl: "https://sepolia.base.org",
  },
  solana: {
    caip: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    family: "svm",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu",
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
  },
};

export const DEFAULT_BASE_URL = "https://ask.singitai.app";
export const DEFAULT_APP_BASE_URL = "https://app.singitai.app";
export const ROUTE = "/v1/chat/completions";
export const perModelRoute = model => `/v1/chat/${model}`;
