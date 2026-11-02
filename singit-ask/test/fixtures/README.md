# Listing price fixtures

`listing-prices.json` contains only model ids, numeric list USD per million input/output tokens from the local audit `raw/models.json`, and `cheapest_trusted_share` from `raw/books.json` (2026-11-02). These snapshots need not match shares at earlier audit quotes. Production `priceGuard` adds its usual one percentage point and rounds up.

`listing-baseline.json` pins all four real example offers for the 17 chat/format routes. It was compared byte for byte with quotes from an isolated extraction of main 2be6464, using the same fake catalogue. `listing-probes.json` records the 22-route comparison using those model prices/shares, the current route examples, and fixed media list prices (image 0.05 USDC and speech 0.0035 per 1000 characters). All amounts are integer micro-USDC. The listing-price tests recompute and check these fixtures.

`listing-harness.mjs` dispatches requests directly through Express in memory. It uses synthetic payment configuration and a fake facilitator and throws on upstream calls. It never opens a socket or makes payments. No audit bearer data or recipient data is copied.
