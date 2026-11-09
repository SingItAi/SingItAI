# feat(discovery): limits-first WK documentation and MCP blurbs (L1)

SI-287: agents discovering SingIt can find owner-set limits, allowance checks,
receipts and owner stop controls before spending. Adds WK documentation links,
MCP descriptions and a bounded capability-first CDP boilerplate. Route descriptions,
price fields, bazaar fields and payment behavior remain unchanged.

## Acceptance mapping

1. WK instructions and documentation name owner-set server-side limits,
   get_allowance/get_limits/get_receipts, receipts, charged-only-when-answered
   and Base Emergency stop / Revoke. llms.txt repeats the controls and explains
   that direct wallet calls are outside these agent limits. No competitor claims.
2. list_models and chat name owner-set limits and get_allowance before spending;
   get_allowance names pause/Revoke, Base on-chain enforcement and Solana
   server-checked daily/per-purchase limits. Website snapshot/reference match.
3. bazaarLimitsBoilerplate() exports ≤160-character capability-first copy with
   owner-set USDC limits and length/banned-word guards. Ready for propagation;
   Growth listings remain a separate later step.
4. #255 resourceDetails.price and bazaar fields are preserved; WK additions only.
   Existing route/alias copy stays stable, including long pinned model names.
5. Draft only here; merge/rollout is gated after R1/R2 reliability work.
6. Merge/deploy only after Kostya's own OK in Dev/Ops chat. No merge/deploy,
   paid settles, external posts, Notion changes or listing refresh in this work.

## Verification

- Node discovery/app/free/listing-price/listing-copy and website MCP page tests:
  126 passed. Regenerated website page recheck: 3 passed.
- Gateway: `cd sign402-gateway && /workspace/singit/venv-gw312/bin/python -m pytest tests/test_web_mcp.py -q`
  — 105 passed, 65 subtests passed (offline mocks).
- `git diff --check` clean.

CDP refresh still requires paid settles after deploy by Kostya. Boilerplate is
exported for later propagation; existing route descriptions do not append it.
Payment math, routing/fallback and speech billing are outside this change.
