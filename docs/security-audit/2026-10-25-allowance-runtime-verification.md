# Base allowance runtime verification — 25 October 2026

Status: reproduced and fixed on top of `SingItAI/main` `a114538`. Not yet
deployed to production. The Solidity limiter and its creation/runtime bytecode are unchanged.
This is hardening of the existing Base allowance infrastructure, not new Solana
enforcement and not a complete security audit.

## Finding: masked immutable copies could disagree

The gateway, independent owner-side checker and standalone artifact checker
compared deployed code with the trusted runtime after zeroing all compiler
immutable-reference ranges. Separate getters checked some or all parameters.

Solidity embeds multiple copies of one immutable in the runtime. For example,
the `agent()` getter and the caller check inside `spend()` reference different
copies. A deliberately forged deployment could preserve the getter's value but
change the execution copy. Masking both copies made the old code-identity
comparison accept that mismatch.

The local reproduction showed:

1. Modifying one compiled agent reference made both old Python matchers return
   true, while leaving the other reference unchanged.
2. `RuntimeIdentityTest` installed a modified runtime in a local EVM. The
   contract still returned the original `agent()` address, but `spend()` accepted
   a different test key and transferred mock tokens to it.

This is not a mechanism for changing an existing immutable on-chain contract.
An attacker would need to deploy a different runtime and persuade an owner to
approve it, for example through a compromised setup service. The finding is
about the identity/approval boundary, not a demonstrated compromise of a live
limiter. No live deployment was used for the reproduction.

## Local remediation

- Export compiler `immutableReferences` as groups as well as flat byte ranges.
  Keep both independently packaged artifacts synchronized.
- Require identical bytes at every occurrence within a group before masking.
  Reject incorrect runtime lengths and malformed hex.
- Apply the check to gateway deployment/grant verification, the independent
  sidecar before signing, and the standalone `--onchain` code comparison.
- Make the standalone success message explicit: matching the runtime template
  does not establish that policy/keys equal the user's independent choice.
- Add regressions for every immutable occurrence, valid consistent deployment
  values, malformed/truncated/extended code, honest-getter responses alongside
  inconsistent code, and refusal before asking the hardware wallet to sign.

Artifacts now require `immutableGroups`. Ship the updated checker with its
updated artifact; an old artifact is not silently accepted by the new code.
Compiler version, source hash, creation bytecode, runtime template, ABI and
standard compiler input remain unchanged. Existing genuine deployments need
no contract upgrade for this checker fix.

## Verification

All checks below used local fixtures or mock tokens, with no real payment:

| Check | Result |
| --- | --- |
| Full gateway suite (`python -m unittest discover -s tests` in `sign402-gateway`) | 2115 passed |
| Full sidecar suite (`python -m unittest discover -s tests` in `trezor-sidecar`) | 363 passed |
| Solidity suite including the EVM reproduction (`forge test --root agent-allowance`) | 27 passed |
| `python3 agent-allowance/script/export_artifact.py --check` | Both artifacts match a fresh build |
| New regressions against the previous gateway and sidecar checkers | Fail, as expected |
| `git diff --check` | Passed |

Test suites emitted resource-cleanup warnings and deliberate mock failure logs;
the reported suites finished with no failures.

## Remaining boundaries

This patch preserves autonomous payments. It does not remove the delegated
spending key, add an on-chain merchant allowlist, or make final x402 payments
from the agent subject to the limiter. The agent can still exercise its granted
budget; a compromised key can misuse that permitted budget.

The independent checker still needs stronger binding of all parameters to the
owner's separately recorded choice. The browser trust boundary, complete live
deployment inventory, guardian isolation and final-payment enforcement remain
separate work. Neither the live VPS nor every active limiter was inspected.
Until it is deployed, the fix must not be described as protecting production.

First written against an older local revision (`5fb48fe`), then ported to
`SingItAI/main` `a114538`, where the Solidity source and both artifacts were
unchanged, and re-tested there as recorded above.
