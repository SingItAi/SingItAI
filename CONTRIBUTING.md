# Contributing to SingIt

Thanks for taking a look. Bug reports, fixes, documentation and integrations are welcome.

SingIt moves real money, so changes to payment code are reviewed more strictly than the rest.
Please keep that in mind when you open a pull request.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue first if you are not sure.
- **New features or larger changes:** open an issue and describe the problem and your idea first, so
  nobody builds something that cannot be merged.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

Use **Python 3.12** and **Node.js 22** to match CI (`solana-x402-service` needs Node.js 24). Clone the
whole repository: the gateway imports shared code from sibling directories.

```bash
git clone https://github.com/bubon-ik/SingItAI.git
cd SingItAI
python3.12 -m venv sign402-gateway/.venv
sign402-gateway/.venv/bin/python -m pip install -e ./sign402-gateway
```

## Run the tests

Run the suites for the parts you changed. They use test doubles for chains, sellers and wallets, so
no funded wallet, API key or network access is needed.

```bash
(cd sign402-gateway && .venv/bin/python -m unittest discover -s tests)
(cd cdp-x402-service && npm ci --ignore-scripts && npm test)
(cd solana-x402-service && npm ci --ignore-scripts && npm test)
(cd singit-ask && npm ci --ignore-scripts && npm test)
(cd integrations/elizaos-plugin && npm ci --ignore-scripts && npm test)
node --test website/tests/*.test.mjs
```

The contract in `agent-allowance/` uses Foundry (`forge test`). The full list of CI jobs is in
[`.github/workflows/security-gate.yml`](.github/workflows/security-gate.yml).

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Add or update tests for behaviour you change. Tests must never send a real payment.
- Update the docs next to the code, and write documentation in English.
- Describe what changed, why, and how you checked it. Say what you did **not** check.
- Make sure CI is green. `main` is deployed by hand, so a merge does not change the running service by itself.
- Do not rewrite history on a branch that someone has already reviewed.

## Rules for payment code

Changes under `sign402-gateway/`, `agent-allowance/`, `cdp-x402-service/`, `solana-x402-service/` and
`singit-ask/` follow a few rules:

- The language model never authorizes a payment. Amounts, limits and recipients are validated in code.
- Check the price, the limits and the seller binding before any money moves, never after.
- A payment whose outcome is unknown is never retried automatically.
- Never commit secrets, private keys, API keys, wallet addresses of real users, payment links or
  redemption codes. Do not paste them into issues or pull requests either.

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
