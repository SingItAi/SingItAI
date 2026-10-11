# SingIt authentication and wallet review — 2026-10-11

Reviewed revision: `e47cb33ba3f63e1ff8ceb564d238cb688867f574` (`main`).

## Verdict

**The reviewed version has reproducible defects and should not be described as fully verified or free of vulnerabilities.** Wallet generation and signature authentication passed the checks below. Completing social authentication, receiving both embedded-wallet addresses, and recovering them after a new browser login still require real provider accounts.

The initial review added documentation and an offline reproduction script. The subsequent local fixes are recorded below; the original findings and baseline evidence are retained. Nothing was pushed or deployed.

## Local remediation — findings A1–A4

Implemented on 2026-10-11 in the working tree, following the owner's request to fix the first four findings. Commit/PR: not yet created; based on the reviewed revision above.

- **A1:** regular payments and metered holds validate current caps/expiry and reserve budget in one SQLite write transaction. The queued-limit-reduction and two-independent-payer reproductions are now refused before the payment callback. Already reserved/in-flight payments remain counted and are not retroactively canceled.
- **A2:** each tab pins its account and CSRF token. All authenticated HTTP reads and writes check the exact session token and expected account (legacy `/session` bootstrap requires CSRF). Storage changes reload the tab; old replies are discarded. Expired credentials are removed before reload, avoiding a reload loop. A stale tab cannot erase a newer tab's saved session or log it out using the old binding.
- **A3:** a new connection no longer automatically signs in on Base. The user selects Base/Solana and explicitly signs in. Switching and signing cannot run concurrently; wallet identity is rechecked across the sign-in steps. Network switching requests thrown SDK failures and validates the active chain/account, also addressing A8's swallowed-error behavior. Verified the pinned SDK's actual exported network definitions: Base is a viem chain without `chainNamespace`; the check explicitly uses `eip155` rather than assuming that field exists.
- **A4:** SOL funding is validated without sending, then its public signature and blockhash are checkpointed before submission. Proven pre-send failures terminate cleanly; unknown results remain reserved and are reconciled read-only. Concurrent prepared transfers cannot both claim one account, and stale validation/expiry checks cannot release a checkpointed transfer. Database changes are additive and preserve existing keys/operation records.

Verification after implementation:

| Check | Result |
| --- | --- |
| Full gateway suite in the current working tree | 1,784 passed |
| Solana client suite | 79 passed |
| Website regression suite | 24 passed |
| Chrome smoke: actual page + local HTTP API + generated signers, wallet connection mocked | Connect without auto-login → select Solana → sign → authenticated UI passed; switching identity in a second tab reloaded the first with the correct account. |
| Offline audit companion | Both A1 scenarios and A4 no longer reproduced. A6/A7 still reproduce, as they are outside this remediation request. Its overall nonzero exit reflects those remaining findings. |
| `git diff --check` | Passed |

The full gateway count includes other concurrent working-tree changes; it is a test-run result, not a count of tests added by this remediation. Frontend and web API must be released together, since stale pages lacking the account header fail closed. The Python gateway and Solana bridge must likewise ship together for the new inspect/reconcile operations. No production deployment or real payment was performed. Full real social OAuth completion remains pending. Legacy uncertain transfers with no saved signature cannot safely be cleared based only on age and still require operator investigation.

## Follow-up remediation — A6, A7 and A9

At the owner's request on October 11, A6, A7 and A9 are now fixed locally and in
the staged server release. A5 is explicitly deferred. A6 enforces private SQLite
state permissions; A7 binds Base ciphertext to the owner/chain/address and migrates
verified legacy keys without changing them; A9 rejects invalid framing before
reading and bounds request-body reads. All five offline reproductions now report
`NOT REPRODUCED` and the companion exits 0.

An isolated baseline-plus-fixes release passed 1,786 gateway, 79 Solana and 24
website tests; four additional migration/installer tests passed afterwards. The
production database migration dry run validated all 97 Base and three Solana
managed wallets on a temporary backup without modifying live records. Server
checkout remains at the baseline until the sudo installation step is completed.
The staged server release passed the gateway suite (1,790 discovered, one initial
Node/PATH skip subsequently covered by a passing 14-test module), plus all 79
Solana and 24 website tests using the server's installed dependencies.
Full real-provider OAuth and fresh-login wallet recovery are still pending.
See [release, installation and recovery notes](2026-10-11-release.md).

## Scope and evidence

- Read the web connection/session flow, SIWE/SIWS verification, managed-wallet generation and encryption, allowance services, Solana transaction validation, Base contract, relevant tests and deployment instructions.
- Used Python 3.12.15, Node 24.12.0 and Foundry locally.
- Checked the public application in fresh Chrome contexts. Its `wallet.js`, `main.js`, `api.js` and `config.js` matched the reviewed checkout after removing the server's asset-version query strings. This does **not** establish the deployed backend revision.
- Exercised the public authentication API with two newly generated, unfunded test identities, one per chain. Only nonce, signature verification, session, allowance status and logout endpoints were called. Two test account records were created; their sessions were logged out. No transaction was signed or submitted and no wallet was funded.
- Reproduced defects locally with isolated databases, generated unfunded keys and mocked payment callbacks. No merchant order or payment was created.
- Did not inspect production secrets, databases, server processes or Reown dashboard settings. No external load/fuzz testing was performed.

### Existing tests

| Suite | Passed |
| --- | ---: |
| `sign402-gateway`: `python -m unittest discover -s tests` | 1,756 |
| `hermes-plugins/sign402-wallet`: same command | 430 |
| `cdp-x402-service`: `npm test` | 46 |
| `solana-x402-service`: `npm test` | 77 |
| `singit-ask`: `npm test` | 42 |
| `website`: `node --test website/tests/*.test.mjs` | 16 |
| `agent-allowance`: `forge test` | 26 |
| **Total** | **2,393** |

The contract suite includes fuzz/invariant checks. These results do not cover full social-login journeys: the website tests replace the wallet/provider with test doubles, and several test only extracted functions.

Dependency checks found zero known advisories for the installed lockfiles of `cdp-x402-service`, `solana-x402-service` and `singit-ask`. `pip-audit --skip-editable` found no known advisories in the audited Python packages; it skipped the editable gateway and the Git-sourced `spending-memory` package. Python dependencies were freshly resolved, not read from production. The other Node components and the CDN-loaded frontend dependency graph were not independently audited in this run.

A limited scan of the 461 tracked paths found no matches for private PEM keys, GitHub tokens, AWS access-key IDs or Google API keys. It is not a complete secret-history scan.

## Authentication and wallet results

| Check | Result |
| --- | --- |
| Google | The real popup reached `accounts.google.com/v3/signin/identifier`, displaying “continue to walletconnect.org”. No credentials were entered; OAuth callback and embedded-wallet creation were not completed. |
| Apple | Reached Apple's sign-in form for “Sign in with Apple for AppKit”. No credentials were entered. |
| Discord | Reached Discord's login form through its OAuth authorization route. No credentials were entered. |
| X / Twitter | The authorization request reached `x.com/i/oauth2/authorize` and returned HTTP 403 in the audit browser. This is a blocker in that environment, not proof of a bad SingIt OAuth configuration: provider anti-bot/IP restrictions remain a possible cause. |
| Base public API sign-in | Nonce 200 → verify 200 → session 200; replayed signature 401; allowance status 200; logout 200 → session 401. Returned address and chain matched the test signer. |
| Solana public API sign-in | Same successful sequence. Allowance status returned `configured: false, chain: solana`, without `supported: false`. |
| Session cookies | `HttpOnly`, `Secure`, `SameSite=Strict` present in both successful live sign-ins. |
| Managed Base and Solana wallets | For each chain, 16 concurrent creation calls produced exactly one new wallet and the same address. Reopening the store preserved it, the private key derived the recorded address, another user received a different wallet, and the plaintext key was absent from the database. |

There are distinct wallet systems: Reown creates the user's social-login wallet; the Telegram managed-wallet service creates custodial wallets; the allowance services create agent signing keys. Passing the managed-wallet tests does not verify Reown account recovery. Base and Solana addresses are separate SingIt accounts (`wallet:<address>` and `solana:<address>`), with separate limits/history; there is no unified social identity record joining them in this code.

## Findings

Severity describes impact under the stated preconditions, not evidence of an attack in production. All findings below remain open in the reviewed revision.

### A1 — High: Solana can spend against superseded limits

**Code:** `sign402-gateway/sign402_gateway/solana_allowance.py:283-298,387-415`.

`spend()` reads the limits before acquiring `_spend_lock`. `setup()` changes the limits without that lock and, in the documented deployment, runs in the web API process while purchases run in the gateway. A request waiting to pay retains the old daily and per-purchase values after a successful limit reduction.

**Reproduction:** queue a 4 USDC purchase under the original limits; while it waits for `_spend_lock`, change both caps to 1 USDC; release the lock. The payment callback runs and 4 USDC is recorded with both saved caps now 1 USDC. This is reproducible within one service instance, so it does not require a multi-worker deployment.

There is a related **conditional multi-process risk**: each service instance has its own `threading.Lock`, and the budget read and spend insertion are separate database transactions. Two paying instances sharing one database both accepted 4 USDC against a 5 USDC daily cap, recording 8 USDC. The documented single paying gateway reduces this second exposure; production worker topology was not inspected. The web and gateway processes alone are not proof that there are two paying workers.

**Remediation:** check the current limits and reserve the budget atomically in a database transaction, coordinated with limit changes and all other holds. Keep uncertain outcomes reserved. A process-local lock alone is insufficient for the shared database. The on-chain delegated total still bounds total debit; it does not enforce these daily/per-purchase caps.

### A2 — High: cross-tab session changes can silently select a different payer

**Code:** `website/app/api.js:16-35`; `website/app/main.js:17-20,133-150,340-349,1585-1652,2105-2109`.

The displayed session is per-tab memory, but the session cookie and CSRF token in `localStorage` are shared by all tabs. Each request reads the latest CSRF token. If tab B logs in as a different wallet/network, tab A can continue showing wallet A while its requests carry wallet B's cookie and CSRF token. There is no storage/session-change listener or expected-account binding on requests. New chat messages and direct shop requests can use B; some existing chat IDs/quote IDs are account-scoped and will instead be rejected.

**Reproduction:** execute the real `api.js` with A displayed, then replace the shared cookie identity and `singit.csrf` with B as another tab would. `api.say('', ...)` sends the valid B CSRF token and is accepted under B, with no change to A's displayed state. This does not bypass authentication into an unrelated victim: both accounts must already have been authenticated in that browser. It can nevertheless charge the wrong available allowance or expose the wrong account's response to a stale tab.

**Remediation:** invalidate/reload account-bound state on cross-tab changes; bind each request to the session/account the tab expects and have the server reject a mismatch. Capture the CSRF token per authenticated tab/session rather than silently reading a replacement. Do not automatically replay payment requests after changing sessions.

### A3 — Medium: normal first-time social login bypasses the network choice

**Code:** `website/app/wallet.js:223-227`; `website/app/main.js:131-160,176-185,375-405,1330-1345`.

AppKit starts on Base. Pressing Continue sets `signInAfterConnect`, and the first account event immediately signs in. The Base/Solana chooser exists only in the signed-out hero and only after a wallet is connected. After successful sign-in, the settings offer sign-out but no network switch. The ordinary successful first-time social-login path therefore selects Base before the user gets a practical chance to choose Solana.

**Reproduction:** run the actual `connectWallet()` and `setWallet()` with a fresh state, then emit an AppKit Base connection. `signIn()` is invoked immediately. A canceled signature/restored connection can expose the chooser, but that is an accidental workaround, not a reliable onboarding flow.

**Remediation:** let the user choose Base/Solana before connection/signature, or implement an explicit authenticated network/account switch with fresh signature and full clearing of account-scoped UI state. Test the entire connection → selection → signature → session journey.

### A4 — Medium: Solana transaction errors can permanently block SOL funding

**Code:** `sign402-gateway/sign402_gateway/solana_allowance.py:165-172,310-312,342-380`; `solana-x402-service/src/allowance.mjs:200-218,254-273`.

For `FUND_GAS`, the operation is marked `SUBMITTING` before the bridge validates/sends it. An exception such as `TRANSACTION_MISMATCH` or `SIGNATURE_REQUIRED` leaves it `SUBMITTING`, even though no transaction was sent. Future funding preparation rejects the account because `pending_gas()` sees that row. `operation()` only returns stored state; it performs no reconciliation.

**Reproduction:** prepare an unfunded mock funding operation and make the bridge raise `TRANSACTION_MISMATCH`. The first request reports “Nothing was sent”; the stored state remains `SUBMITTING`; every new funding attempt reports that the previous transfer needs confirmation. The same missing reconciliation affects an operation returned as `UNCERTAIN`: polling cannot turn it into `DONE` even if it later confirms on chain.

**Remediation:** transition proven pre-send validation failures to a retryable terminal state; preserve and reconcile ambiguous outcomes using the signature and blockhash lifetime. Never blindly retry an unknown payment. This finding concerns the funding endpoint; it does not mean normal direct Ask payments require an agent SOL top-up.

### A5 — Medium: fresh Solana setup displays false Base security guarantees

**Code:** `website/app/main.js:207-217,430-447,493-505`.

An unconfigured Solana account falls through to the Base setup view. It says it will create a contract on Base and that the limits hold even if the server is compromised. The setup progress/success messages also refer to a Base limiter. In reality the Solana lane stores daily/per-purchase caps and expiry on the server; only the total delegated allowance is enforced on chain.

**Reproduction:** render `renderAllowance()` with `{configured:false, chain:'solana'}`. The output contains both “A small contract on Base” and “even if our server or the agent is compromised”. The live API returned exactly this state shape for a fresh Solana account.

**Remediation:** provide chain-specific setup text and progress states, with the same accurate trust model already used in the configured Solana view and root README.

### A6 — Medium, local access required: Solana allowance database lacks private modes

**Code:** `sign402-gateway/sign402_gateway/solana_allowance.py:92-111`; `scripts/enable-web-page.sh:65-80`.

Unlike the managed-wallet store and Base allowance database, `SolanaAllowanceStore` does not enforce `0700`/`0600`. With umask `022`, a new parent is `0755` and the database is `0644`, including encrypted agent keys, account associations, limits and spend records. The generated web API systemd unit does not set `UMask=0077`; the deploy script's own umask is not a runtime service guarantee.

**Reproduction:** instantiate this store in a new directory under umask `022`; observe `0755/0644`. Keys remain encrypted. An already-private ancestor can prevent access, so actual production exposure depends on its directory permissions, which were not inspected.

**Remediation:** use the existing private-state helpers for directory/database creation and verify SQLite sidecar modes, plus a restrictive service umask.

### A7 — Medium, database modification required: managed Base keys are not bound to their owner

**Code:** `sign402-gateway/sign402_gateway/user_wallets.py:310-317,481-493`; compare `solana_wallets.py:38-42,99-106`. Signing consumers include `server.py:3516-3526,3553-3576`.

Base encrypts only the raw private key and decrypts it without checking the derived address or authenticated user identity. Copying Alice's encrypted key into Bob's row makes Bob's signer use Alice's wallet. Fernet authenticates ciphertext bytes, but not the row they belong to. The managed Solana implementation already binds the chain, user and address in its encrypted envelope.

**Reproduction:** create two unfunded Base wallets, substitute only `encrypted_private_key` in Bob's row, and decrypt for Bob. The derived signer is Alice, with no error. This is not a public API exploit: it requires database write access or an incorrect restore/migration. It means DB integrity is currently part of the Base signing trust boundary even without access to the encryption master key.

**Remediation:** immediately verify derived address on decrypt; use versioned, authenticated `{chain,user,address,key}` envelopes for new records, with a reviewed compatibility/migration approach for existing wallets. Do not regenerate existing users' keys.

### A8 — Medium: AppKit network-switch errors are swallowed by the real SDK

**Code:** `website/app/wallet.js:116,156-157,297-300`; `website/tests/network-switch.test.mjs:48-52`.

The pinned AppKit 1.8.24 implementation has `switchNetwork(network, {throwOnFailure = false} = {})`; its chain controller catches adapter failures unless `throwOnFailure` is true. SingIt calls it without the option, so the UI catch block does not reliably receive a refused switch. The existing test replaces `switchAppKitNetwork` with a directly throwing stub and misses this SDK behavior.

**Evidence:** inspected the actual jsDelivr bundle imported by the site (`appkit-DSMu6gPS.js`, `switchNetwork` and `switchActiveNetwork`).

**Remediation:** request thrown failures and verify the selected namespace/network/account before accepting a switch or preparing signatures. Exercise an unsupported/refused switch against the pinned SDK API, not just a throwing substitute.

### A9 — Low/conditional availability risk: invalid body lengths can block the origin handler

**Code:** `sign402-gateway/sign402_gateway/web_api.py:583-590,616-619`.

`Content-Length` is checked only against the upper bound. A negative value reaches `rfile.read(-1)` and reads until EOF; incomplete positive-length bodies likewise lack an application read timeout. The threaded origin creates a handler per connection.

**Reproduction:** one loopback request with `Content-Length: -1` received no response until the client half-closed its socket, after which the body was accepted. No such requests were sent to production. Cloudflare/reverse-proxy parsing and timeouts may block this at the public boundary; that exposure was not tested.

**Remediation:** reject negative/invalid/ambiguous lengths, require supported transfer framing, and apply bounded request-read timeouts. Keep the origin loopback-only.

## What to do first

1. Fix A1 (atomic current-limit reservation) and A2 (tab/session payer binding).
2. Fix the social-login network selection and real SDK error handling (A3/A8), then verify actual social callbacks and both embedded wallets.
3. Correct Solana setup guarantees and transaction recovery (A5/A4).
4. Harden state permissions, Base key binding and HTTP parsing (A6/A7/A9).

The offline companion script reproduces A1, A4, A6 and A7 against this revision:

```bash
sign402-gateway/.venv/bin/python docs/security-audit/reproduce-2026-10-11.py
```

It creates only temporary test state, performs no network calls, prints no keys/tokens and intentionally returns a failing status while the defects reproduce.

## Remaining social-login acceptance

For each of Google, X, Apple, Discord and email, use an authorized test account to complete the callback, confirm that the resulting Base address can sign SIWE and the Solana address can sign SIWS, log out, restart in a fresh browser context, and verify the same addresses are recovered. Test provider cancellation, a blocked popup, page reload during authentication, account changes in another tab, and Base ↔ Solana switching. Passwords, OTPs and seed/private keys should be entered only in the provider/wallet UI, never added to this repository or the audit record.

Solana approval/revoke needs owner SOL in the current implementation; a newly created address has neither SOL nor a USDC token account. Wallet-address creation is not proof that a funded approval or purchase works. Any real funding, approval or payment acceptance test needs separately agreed exact terms; none was performed in this review.
