# Starter credit

$1 of SingIt API calls for up to 20 vetted users, paid from a budget with a hard cap of $20. **OFF by default.**

Code: `sign402-gateway/sign402_gateway/starter_credit.py` (store, GitHub OAuth, routes, CLI), wired into
`web_api.py` (routes) and `web_api_proxy.py` (spending). Tests: `sign402-gateway/tests/test_starter_credit.py`.

## Rules (all enforced server-side)

| Rule | How |
|---|---|
| Base only, own allowance | `check_allowance`: `allowance.lane_for(account)` returns an active limiter, its `owner_address` is the signed-in wallet, and the limiter's on-chain `owner()` is that wallet too. Checked at `start`, at the callback, and again at approval. Solana accounts are refused (`solana_not_supported`): Solana has no on-chain limiter. |
| One credit per GitHub account | `starter_claims.github_id` is `UNIQUE`, whatever state the claim is in (rejected and expired count too). |
| GitHub older than 182 days, with a real repo | Read server-side from `GET /user` (`created_at`) and `GET /user/repos?type=owner&per_page=100` (at least one repo with `fork=false`, `private=false`) using the token we exchanged ourselves. Nothing the client sends about GitHub is used. The token lives only in memory. |
| One credit per wallet | `starter_claims.account_id` is `UNIQUE`. |
| Not withdrawable | Credit lives in its own tables, never in `balances`, so refunds and top-ups never see it. `StarterCredit.withdraw()` / `refund()` always raise `StarterCreditNotWithdrawable` and are audited; `POST /starter-credit/refund` and `/withdraw` answer 403. |
| Drips | At most $0.25 per grant per UTC day, holds in flight included (`starter_daily`). Only requests whose ceiling is at most $0.05 use it. A grant expires 7 days after approval; unspent credit stays unspent (not returned to the budget). A hold taken before expiry may still settle. |
| Manual approval | Claims land `pending`. There is no auto-grant path: only `approve` in the CLI grants. |
| Budget | `HARD_CAP_ATOMIC = 20_000_000`, `MAX_GRANTS = 20`, `GRANT_ATOMIC = 1_000_000`. The budget starts at `funded = 0`. Approval reserves with one conditional `UPDATE starter_budget ... WHERE committed + grant <= MIN(funded, cap) AND grants < 20` in the same `BEGIN IMMEDIATE` transaction that flips the claim from `pending`. `fund` can never take `funded` past the cap. |
| Idempotent | The same (account, GitHub id) claim returns the existing claim; approving an approved claim reserves nothing; a bill for an unknown or settled hold bills nothing. |
| Audit | `starter_audit` has every claim, approve, reject, fund, refusal (with its reason code), hold, bill, release and expiry. No tokens, codes or OAuth states are stored or logged. The state is stored only as its sha256. |

## Flow

1. The page calls `POST /web/v1/starter-credit/github/start` (session + CSRF). It gets back `{"url": ...}`, a GitHub
   authorize URL (`scope=read:user`, `allow_signup=false`, a single-use `state` that lasts 10 minutes and is bound to
   the account). The response also sets `singit_starter_oauth=<random nonce>; Path=/web/v1/starter-credit/github/callback;
   Max-Age=600; HttpOnly; Secure; SameSite=Lax` (Lax because GitHub's redirect back is a top-level cross-site GET).
   Only the nonce's sha256 is stored, next to the state's. This binds the link to the browser that started it: a
   `state` alone names an account but doesn't prove the authorizing browser began the flow, so without the nonce an
   attacker could start a link and send the URL to a victim, binding the victim's GitHub to the attacker's wallet.
2. GitHub redirects to `GET /web/v1/starter-credit/github/callback?code=&state=`. This route runs without the session
   cookie, which is SameSite=Strict and so isn't sent on GitHub's redirect. The state identifies the account; the
   `singit_starter_oauth` cookie must also match the hash stored for that state (`hmac.compare_digest`). That check
   comes first, before the state is consumed and before GitHub is asked anything. A missing or wrong cookie (or a
   state started before this column existed) is refused with `reason=browser_mismatch` and audited; the state is not
   burned, so the real user can still finish. The nonce is never logged. The response always clears the cookie
   (`Max-Age=0`). The server then exchanges the code, reads `/user` and `/user/repos`, re-checks the allowance and creates a `pending` claim.
   It then answers `302` to `SIGN402_STARTER_CREDIT_REDIRECT?starter=pending`, or
   `?starter=refused&reason=<code>`. The callback is rate-limited per IP.
3. `GET /web/v1/starter-credit` (session) returns the account's own claim: its state, what is spendable today, what
   is left and when it expires.
4. The operator approves by hand (below). From then on, small API-key requests are paid from the grant before the
   balance. `billing.paidFrom` says `"your SingIt starter credit"`, and nothing reaches `balance_ledger`.

Refusal reason codes: `bad_state`, `browser_mismatch`, `no_code`, `github_unavailable`, `github_unreadable`, `github_too_young`,
`no_public_repo`, `no_allowance`, `foreign_owner`, `allowance_unreadable`, `solana_not_supported`,
`account_already_claimed`, `github_already_used`, `rate_limited`.

## Environment (sign402-web-api)

| Variable | Meaning |
|---|---|
| `SIGN402_STARTER_CREDIT=1` | Turns the feature on. Anything else means OFF: routes answer 404 `starter_credit_off`, the proxy never touches starter credit, and CLI `approve` and `fund` refuse. |
| `SIGN402_GITHUB_CLIENT_ID`, `SIGN402_GITHUB_CLIENT_SECRET` | The GitHub OAuth app. Its callback URL must be `${SIGN402_WEB_URI}/web/v1/starter-credit/github/callback`. |
| `SIGN402_STARTER_CREDIT_REDIRECT` | The app page the callback sends the user back to, e.g. `https://app.singitai.app/app/`. |
| `SIGN402_STARTER_CREDIT_CAP_ATOMIC` | Optional. It can only **lower** the $20 cap; a higher value is ignored. |

If the flag is on but the three OAuth variables are not all set, the routes answer 503. Spending also needs the paid
`/v1` proxy (`SIGN402_WEB_SURPLUS_API_KEY` and `SIGN402_WEB_INTERNAL_TOKEN`).

## Admin runbook

The CLI runs on the VPS as `hermes`, against the same `web.db` as web-api (`SIGN402_WEB_DB`). For `approve`, load the
same environment as sign402-web-api so the allowance re-check uses the same lane (`SIGN402_ALLOWANCE_*`, master key).

```sh
python -m sign402_gateway.starter_credit queue                       # pending: claim id, GitHub login, age, wallet:0x1234…abcd
python -m sign402_gateway.starter_credit fund 20000000 --by kostya --ref "sent 20 USDC, tx 0x…"
python -m sign402_gateway.starter_credit approve sc_… --by kostya    # re-checks the allowance, reserves $1
python -m sign402_gateway.starter_credit reject sc_… --by kostya --reason "looks like a farm"
python -m sign402_gateway.starter_credit budget                      # funded, committed, grants, spent, held
python -m sign402_gateway.starter_credit audit --limit 50
```

* Nothing can be approved until `fund` has run. `fund` records money that Kostya actually put aside; the funded total
  can never exceed the cap.
* `approve` refuses when the flag is off, the claim isn't pending, the allowance re-check fails, 20 grants already
  exist, or the funded budget is fully committed. Running it again on an approved claim does nothing.
* `queue`, `budget` and `audit` are read-only and also work while the flag is off. Output never shows full addresses.
* To stop all starter spending at once, unset `SIGN402_STARTER_CREDIT` and restart sign402-web-api.

## Restarts

* **sign402-web-api**: needed for the routes and for spending, and after any change to the variables above.
* The **gateway** (sign402-gateway service) is not involved and doesn't need a restart.
* The CLI is not a service; each run reads `web.db` fresh.
