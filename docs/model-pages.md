# Model pages and spending limits

Refresh from the live read-only endpoints, then regenerate the committed HTML:

```sh
node scripts/models-snapshot.mjs && node scripts/generate-model-pages.mjs
node scripts/generate-model-pages.mjs --check
cd website && node --test tests/*.test.mjs
```

For an offline refresh, supply both `--models-input` and `--pricing-input` JSON files and `--fetched-at` with a UTC ISO timestamp to the snapshot script. `--out` changes its output path. The generator always reads `website/data/models-snapshot.json`. Cloudflare publishes `website/` directly; commit the snapshot and generated output together after review.

`/v1/models` supplies list prices, expected SingIt token prices including markup, basis, fees and model facts. `/pricing.json` supplies reference-request `upto` ceilings and `exact` flat prices on Base and Solana. The snapshot retains only the basis of the upstream expected-price object, not its raw cost estimates. It also preserves the free offer's model and daily limit to source the separate free-try copy. Missing fields stay missing. Models without a SingIt token price show only request prices, with no zero-dollar token offer.

Formatting treats digits beyond the 12th significant digit as binary floating-point noise (for example, the server's decimal product `0.052 * 1.3` becomes `0.06760000000000001`) and normalizes with `x = Number(n.toPrecision(12))`. On that number's decimal string, it keeps up to nine decimal places; if more remain, it rounds UP at the ninth decimal using string arithmetic, then trims trailing zeros. Snapshot numbers remain unchanged in JSON. Live values and the actual request's 402 are authoritative. Titles fall back to a shorter form; descriptions drop the optional price sentence before shortening a name.

The shell is copied from the published spending-limit page into `scripts/templates/model-shell.html`. Limits copy is in `scripts/templates/spending-limits.mjs`. Both are generator inputs. Sitemap and llms.txt edits replace only the marked generated blocks. The live models table has a plain directory link; its JavaScript is unchanged.

## Claim sources

Line numbers refer to this checkout. The limits templates use only the claims below; model-page formula and integration sources are included for review.

| Claim on the limits pages | Source file/line in this repo |
| --- | --- |
| Sign in with wallet; sign-in is separate from approval | `docs/allowance-web-v1.md:43`, `docs/allowance-web-v1.md:67` |
| Choose daily, per-purchase and lifetime; deploy limiter; SingIt pays deployment gas | `docs/allowance-web-v1.md:79`, `docs/allowance-web-v1.md:85` |
| Approve USDC once from owner's wallet; approval is a separate total | `agent-allowance/src/AgentAllowance.sol:13`, `agent-allowance/src/AgentAllowance.sol:132`, `docs/allowance-web-v1.md:93` |
| Limiter holds no tokens; spend uses transferFrom from owner to payee | `agent-allowance/src/AgentAllowance.sol:18`, `agent-allowance/src/AgentAllowance.sol:109` |
| Agent-only caller; reject over caps, at expiry or while paused | `agent-allowance/src/AgentAllowance.sol:88`, `agent-allowance/src/AgentAllowance.sol:103` |
| UTC calendar days, midnight reset; adjacent days have separate caps | `agent-allowance/src/AgentAllowance.sol:98` |
| Immutable limits; no admin/proxy/setter; changes need new limiter and approval | `agent-allowance/src/AgentAllowance.sol:21`, `agent-allowance/src/AgentAllowance.sol:30` |
| Owner or guardian can pause; guardian can do nothing else; Base pause permanent | `agent-allowance/src/AgentAllowance.sol:113`, `docs/allowance-web-v1.md:139` |
| Pause in app or wallet; revoke by approve zero, also via revoke.cash without SingIt | `docs/allowance-web-v1.md:26`, `docs/allowance-web-v1.md:134`, `docs/allowance-web-v1.md:139` |
| App shows purchases and receipts | `docs/allowance-web-v1.md:394`, `docs/allowance-web-v1.md:523` |
| Solana has no limiter contract; SPL delegate total enforced by chain; Revoke ends approval | `sign402-gateway/sign402_gateway/solana_allowance.py:3` |
| Solana daily/per-purchase/expiry checked on server before payment | `sign402-gateway/sign402_gateway/solana_allowance.py:9` |
| Solana pause refuses new purchases, retains delegate approval, lifted only by new owner-signed approval; reserved purchase may settle | `sign402-gateway/sign402_gateway/solana_allowance.py:16`, `docs/allowance-web-v1.md:142` |
| x402 402 header, offers upto then exact, Base then Solana; retry with signature | `singit-ask/README.md:32`, `docs/first-paid-call.md:40`, `docs/first-paid-call.md:177` |
| upto signs ceiling, settles actual cost plus markup and fee, refuses excess | `singit-ask/src/pricing.mjs:61`, `singit-ask/src/pricing.mjs:68` |
| exact flat price, no refund | `docs/first-paid-call.md:65`, `singit-ask/src/pricing.mjs:58` |
| X-SingIt-Limiter and X-SingIt-Spend-Limit; Base only, Solana offers unchecked; cached 15 seconds, balance not read | `singit-ask/README.md:169` |
| Settled answers carry X-SingIt-Receipt with charged amount, ceiling and optional prior limit figures | `singit-ask/README.md:180` |
| AgentAllowance covers SingIt app's own agent; independent signing wallets are outside it | `sdk/README.md:49`, `integrations/elizaos-plugin/README.md:116` |
| SDK caps are in-memory per client, reset at restart, only as strong as client | `sdk/README.md:43` |
| Plugin paid chat uses Base; caps in process memory, reset at restart, not on-chain or server-enforced | `integrations/elizaos-plugin/README.md:110` |
| Provider charge + markup + per-request network fee | `singit-ask/src/pricing.mjs:7`, `singit-ask/src/pricing.mjs:13`, `singit-ask/src/pricing.mjs:61` |
| MCP free tools without key | `integrations/elizaos-plugin/README.md:77` |

The dry technical pages describe enforcement boundaries, not guarantees about a wallet or client. No unverified signing implementation is supplied. No payments are made by refresh, generation or tests.
