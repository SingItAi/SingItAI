# Security policy

SingIt handles payments in USDC, so we take security reports seriously and appreciate responsible
disclosure.

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.**

Email **contact@singitai.app** with:

- what the problem is and which component it affects (for example the gateway, the allowance
  contract, SingIt Ask, the web app or an integration),
- steps to reproduce it, or a proof of concept,
- what an attacker could do with it.

Do not include real private keys, seed phrases or other people's data in the report. If you need to
send something sensitive, say so in a first message and we will agree on a way to share it.

We will confirm that we received your report and keep you updated until it is resolved. Please give us
a reasonable time to fix the problem before you disclose it publicly.

## In scope

- The code in this repository: `sign402-gateway`, `agent-allowance`, `cdp-x402-service`,
  `solana-x402-service`, `singit-ask`, `integrations/` and `sdk/`.
- The running services at `singitai.app`, `app.singitai.app` and `ask.singitai.app`.
- Ways to make the agent spend more than the user's limits, pay an address or price the user did not
  agree to, repeat a payment, or read another user's data.

## Out of scope

- Findings in third-party services we depend on (Coinbase CDP, Bitrefill, wallet providers, upstream
  model sellers). Please report those to the vendor.
- Denial of service through large volumes of traffic, spam, or social engineering of our users.
- Reports that need a compromised device or wallet of the victim.

Please test only against your own accounts and funds, and do not access, change or destroy other
people's data.

## Supported versions

Only the current `main` branch is supported. `main` is deployed by hand, so the running service is
whatever was last deployed.

## Security model

The trust boundaries of the payment gateway are described in
[`sign402-gateway/SECURITY.md`](sign402-gateway/SECURITY.md).
