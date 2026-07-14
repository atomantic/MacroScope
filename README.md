# MacroScope

MacroScope is a deterministic economic-policy simulator focused first on whether U.S. wealth-tax-funded redistribution—direct cash, welfare, healthcare, or social services—improves real purchasing power after inflation, administration, and financing effects. A TypeScript engine powers the JSON API and a verdict-led interactive story.

The current implementation covers the model contract and a usable first policy vertical slice:

- Double-entry journal events with transaction, revaluation, and other-volume layers.
- Sector and instrument metadata for households, banks, government, the central bank, and firms.
- Versioned wealth-tax and UBI scenario schemas.
- Dollar-exemption and modeled top-percentile wealth-tax targeting, with presets for top-1%, billionaire, $10 million, and universal scenarios.
- Progressive wealth-tax assessment.
- Cash-funded, borrow-funded, and asset-sale-funded tax settlement.
- Treasury-to-household UBI settlement and collateralized-loan repayment.
- A per-strategy accounting audit that replays each scenario's aggregate sector-level flows (loan origination, tax settlement, UBI, public-services and administration spending, forced repayments) through the double-entry ledger kernel with causal event tags, reporting trial-balance and instrument-mirror residuals plus an independent per-household deposit cross-check in the API's `accounting` block. Intra-household asset trades net out at the sector level; per-household balance sheets are tracked outside the ledger.
- A deterministic weighted population representing 135.1 million U.S. households with explicit top-tail oversampling.
- Balance-sheet totals calibrated to the Federal Reserve Distributional Financial Accounts for 2026:Q1.
- Parallel cash-first, borrow-first, and sell-first scenarios using common households.
- Reduced-form equity depth, price impact, collateral calls, and iterative forced liquidation.
- Public-equity and last-resort housing sale channels with asset-quantity reconciliation.
- Fiscal, money-and-credit, distributional-decile, and eight-sector demand outcomes.
- A transparent ten-year projection of M2, inflation, private tax debt, public debt, bottom-half purchasing power, and top-one-percent real wealth.
- A five-link owner-renter theory test that keeps bank-credit creation separate from the optional portfolio shift into housing and equities, then exposes housing supply and rent pass-through assumptions.
- Configurable allocation of the funded budget among direct cash, public services, and administration/implementation costs.
- Taxpayer-response dials for avoidance/evasion elasticity, decade-cumulative expatriation, and the private-business inclusion (valuation-discount) rate, with full-compliance, Scandinavian, and French ISF presets grounded in the literature.
- A 25-cell stress test that separates elevated inflation, crisis inflation, and the Cagan 50%-per-month hyperinflation threshold.
- An explicit 512- or 1,000-draw joint-assumption ensemble with seeded Latin-hypercube sampling, p10/p50/p90 bands, verdict frequencies, global influence, pairwise interactions, progress, cancellation, and an optional synthetic-population uncertainty layer.
- A responsive verdict-led dashboard with editable policy, taxpayer behavior, market, and monetization assumptions.

## Development

```sh
npm install
npm run verify
```

The current build intentionally has no Three.js dependency. See [docs/MODEL_CONTRACT.md](docs/MODEL_CONTRACT.md) for the accounting conventions and [docs/SUCCESS_CRITERIA.md](docs/SUCCESS_CRITERIA.md) for the vertical-slice acceptance bar.

## PortOS and PM2

MacroScope is a single-process PortOS-compatible application. Its web UI, JSON API, and health check share port `6020`, defined only in `ecosystem.config.cjs`.

```sh
npm install
npm run pm2:start
```

Useful commands:

```sh
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

PortOS can import this directory directly. It will detect:

- UI and API on port `6020`.
- PM2 process `macroscope-server`.
- Build command `npm run build`.
- Start command `npm start`.
- Health endpoint `/health`.

The PM2 process serves the compiled engine and static shell from one Node process. Ports belong in `ecosystem.config.cjs`, not `.env`.

## Scenario API

The UI uses the same versioned JSON API available to headless clients:

```sh
# Fetch a complete baseline request
curl http://127.0.0.1:6020/api/scenarios/default

# Run all three payment strategies
curl -X POST http://127.0.0.1:6020/api/scenarios/compare \
  -H 'Content-Type: application/json' \
  --data @scenario.json

# Run joint uncertainty (request + ensemble options envelope)
curl -X POST http://127.0.0.1:6020/api/scenarios/uncertainty \
  -H 'Content-Type: application/json' \
  --data '{"request":{},"options":{"draws":512,"seed":20260713,"populationMode":"fixed","populationReplicates":8}}'
```

The comparison response contains the immutable assumptions, population aggregates, all three strategy outcomes, the ten-year projection and verdict, the inflation stress test, accounting residuals, decile results, sector demand, and caveats. The uncertainty response adds declared assumption metadata, rank-factor dependency checks, p10/p50/p90 outcome and trajectory bands, verdict frequencies, influences, and interactions. Population seeds are treated as categorical effects and built one at a time, bounding combined-run memory independently of the number of replicates. Send `Accept: application/x-ndjson` to the uncertainty endpoint for progress records before the final result. Replaying the same request and ensemble seed produces the same response.
