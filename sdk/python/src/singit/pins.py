"""Pinned, per-network expectations an x402 offer must match before the SDK signs anything.

Base and Solana values are the live SingIt Ask addresses (singit-ask/src/pricing.mjs).
Base Sepolia has no SingIt deployment: its USDC address is the well-known testnet asset, and
`pay_to` is never pinned here -- the caller must pass one explicitly (SingIt(pay_to=...)).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class NetworkPin:
    caip: str
    family: str  # "evm" | "svm"
    asset: str
    pay_to: str | None
    asset_name: str = "USDC"
    asset_version: str = "2"
    default_rpc_url: str | None = None


NETWORKS: dict[str, NetworkPin] = {
    "base": NetworkPin(
        caip="eip155:8453",
        family="evm",
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        pay_to="0xC23d1Dc0f5fCe1abfFB051e06cB93f0329968B4e",
        asset_name="USD Coin",
        asset_version="2",
        default_rpc_url="https://mainnet.base.org",
    ),
    "base-sepolia": NetworkPin(
        caip="eip155:84532",
        family="evm",
        asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        pay_to=None,
        asset_name="USDC",
        asset_version="2",
        default_rpc_url="https://sepolia.base.org",
    ),
    "solana": NetworkPin(
        caip="solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        family="svm",
        asset="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        pay_to="4an2sqamWWhny9mjLsMtGXCDXakeNtg6vSLq4QvhdmQu",
        default_rpc_url="https://api.mainnet-beta.solana.com",
    ),
}

DEFAULT_BASE_URL = "https://ask.singitai.app"
DEFAULT_APP_BASE_URL = "https://app.singitai.app"
ROUTE = "/v1/chat/completions"


def per_model_route(model: str) -> str:
    return f"/v1/chat/{model}"
