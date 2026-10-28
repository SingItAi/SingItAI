# Architecture

How a payment moves through SingIt, from a request to a settled USDC transfer. This page
covers the components and the x402 flows; the [root README](../README.md) has the product view
and [`sign402-gateway/SECURITY.md`](../sign402-gateway/SECURITY.md) the trust boundaries.

## Components

```mermaid
flowchart TB
    User["User wallet<br/>(USDC stays here)"]
    Web["Web app<br/>website/app"] --> API["Web API<br/>sign-in, chat, limits"]
    API --> GW["Payment gateway<br/>sign402-gateway (Python)"]

    GW -->|"Base"| Lim["Allowance contract<br/>agent-allowance<br/>per-purchase + daily caps, expiry"]
    GW -->|"Base: x402 payments, swaps"| CDPSvc["cdp-x402-service"]
    GW -->|"Solana: delegated USDC, x402"| SolSvc["solana-x402-service"]

    Lim -->|"transferFrom within caps"| User
    GW -->|"x402 requests"| Ask["SingIt Ask<br/>singit-ask<br/>x402 model endpoint"]
    GW -->|"x402 requests"| Sellers["Other sellers<br/>Bitrefill, data, Venice, email, calls"]

    Ask -->|"verify / settle"| Fac["Facilitator<br/>Coinbase CDP"]
    Ask -->|"model call"| Up["Upstream model marketplace<br/>(Surplus Intelligence)"]
    Agents["Any x402 agent"] -->|"pays per answer"| Ask
```

| Component | Directory | Role |
| --- | --- | --- |
| Web app and Web API | `website/app/`, `sign402-gateway/` | Sign-in, chat, limits; calls the gateway. |
| Payment gateway | `sign402-gateway/` | Checks prices, limits, seller bindings and spending policy before any money moves. |
| Allowance contract | `agent-allowance/` | `AgentAllowance` on Base: the agent can only call `spend`, inside a per-purchase cap, a daily cap and an expiry. No admin or upgrade path. |
| Base x402 helper | `cdp-x402-service/` | Does the CDP wallet and x402 work after the gateway has approved a payment. |
| Solana x402 helper | `solana-x402-service/` | Delegated USDC approvals and x402 payments on Solana. |
| SingIt Ask | `singit-ask/` | x402 endpoint that sells model answers and bills by actual cost. |
| Facilitator | external (Coinbase CDP) | Verifies a signed payment and settles it on chain. |

## x402 flow: any agent calls SingIt Ask

An agent with its own wallet needs no account or API key. On Base it signs a bounded
`upto` authorization; SingIt Ask settles only what the answer actually cost.

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Agent (own wallet)
    participant Ask as singit-ask
    participant Fac as Facilitator (Coinbase CDP)
    participant Up as Upstream model
    participant Chain as Base / Solana

    Agent->>Ask: POST /v1/chat/completions
    Ask-->>Agent: 402 Payment Required + offers (upto / exact, USDC)
    Agent->>Agent: sign the offer (spending ceiling, not the final price)
    Agent->>Ask: same request + PAYMENT-SIGNATURE header
    Ask->>Fac: verify the signed payment
    Fac-->>Ask: valid
    Ask->>Up: run the model
    Up-->>Ask: answer + actual token cost
    Note over Ask: price = actual cost + 30% markup + settlement fee
    alt answer returned
        Ask->>Fac: settle the actual amount
        Fac->>Chain: USDC transfer
        Chain-->>Fac: confirmed
        Fac-->>Ask: settled
        Ask-->>Agent: 200 answer + PAYMENT-RESPONSE
    else model failed or timed out
        Ask-->>Agent: error status, nothing is settled
    end
```

## x402 flow: the SingIt agent pays from a spending limit (Base)

The user's USDC stays in their wallet. The user approves a USDC allowance to their own
limiter contract once; the agent can then move only what a purchase needs, inside the caps
fixed in that contract.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant GW as Payment gateway
    participant Lim as Allowance contract
    participant Agent as User's agent key
    participant Ask as Seller (e.g. singit-ask)
    participant Fac as Facilitator (Coinbase CDP)

    User->>Lim: one-time: set the caps and expiry, approve a USDC allowance to the contract
    User->>GW: ask for something
    GW->>GW: check price, remaining daily limit, seller binding, spending policy
    GW->>Lim: agent calls spend(...): per-purchase cap, daily cap, expiry, unique ref
    Lim-->>Agent: USDC moved from the user's wallet (transferFrom)
    Agent->>Ask: request, answered with 402
    Agent->>Ask: retry with a signed payment (seller address, asset and ceiling pinned)
    Ask->>Fac: verify, then settle after the answer
    Fac-->>Ask: settled
    Ask-->>Agent: answer
    GW-->>User: receipt - spend counted against the limits
    User-->>Lim: revoke any time: one signature, or pause the limiter
```

A spend that breaks a cap, arrives after expiry, reuses a reference, or comes after a pause
reverts on chain, whatever the gateway or the agent asks for.

## Solana

Solana has no limiter contract. The user approves the agent as an SPL delegate on their own
USDC account for a total they choose; the chain caps that total. The gateway enforces the
daily and per-purchase limits before each payment, and the agent pays the seller over x402
straight from the user's account. For SingIt Ask on Solana the gateway first prepares a
measured invoice, then pays it with one x402 `exact` payment; the answer is released after
settlement.

## Invariants

- The language model never authorizes a payment; amounts are validated in code.
- A payment counts as made when the transfer shows on chain, not on the seller's word.
- A payment whose answer was lost is never repeated automatically; it stays counted against the limits.
- An operator kill switch stops every paying action at once.
