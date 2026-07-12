# U.S. policy-story success criteria

MacroScope's first useful release is successful when a non-specialist can see whether a modeled U.S. wealth tax and UBI helps or harms the bottom half after inflation, while the underlying engine preserves its accounting contract.

## Application and operations

- [x] PortOS detects a labeled UI/API port and a stable PM2 process name.
- [x] The process exposes `/health`, starts from a CommonJS ecosystem file, restarts safely, and shuts down gracefully.
- [x] The application is usable at desktop and mobile widths without a separate development server.
- [x] The same versioned scenario can be run from the UI or JSON API.

## Model and accounting

- [x] The default deterministic weighted population represents 135.1 million U.S. households.
- [x] Aggregate assets, liabilities, net worth, deposits, public equity, and real estate are calibrated by wealth group to the Federal Reserve DFA for 2026:Q1.
- [x] The top 1%, 0.1%, and 0.01% are explicitly oversampled.
- [x] Progressive wealth-tax assessment supports asset inclusion, valuation, liability deductibility, exemptions, and installments.
- [x] Cash-first, borrow-first, and sell-first strategies use identical households and random draws.
- [x] Tax payments, UBI, deposits, loans, Treasury balances, equity, and housing remain reconciled.
- [x] Cash-funded tax plus equal redistribution does not create deposits.
- [x] Borrow-funded tax leaves loans and deposits higher while debt remains outstanding.
- [x] Domestic asset sales transfer ownership without creating deposits.
- [x] Loan repayment destroys loans and deposits together.

## Questions the dashboard must answer

- [x] How much new credit and deposits arise when taxpayers borrow rather than sell?
- [x] How much additional consumption demand reaches each of eight sectors?
- [x] How much of estimated inflation comes from demand, supply constraints, a tax wedge, or monetary offset?
- [x] How much equity and housing are sold under each payment strategy?
- [x] When do finite buyer depth, leverage, and collateral limits produce a self-reinforcing liquidation cascade?
- [x] How do net worth, tax, UBI, debt, and consumption change across household deciles?
- [x] Does the bottom 50% retain more real purchasing power after ten years than under a no-policy path?
- [x] Does the policy itself create money, or does money growth arise from bank borrowing or monetized deficits?
- [x] How much private tax debt remains when wealthy households borrow against assets?
- [x] Does that private debt automatically become a future burden on poorer households, and what additional policy action would socialize it?
- [x] How does the answer change when taxpayers use cash, borrowing, or asset sales in different proportions?
- [x] At what UBI and deficit-monetization stress does the model move from stable to elevated, high, crisis, extreme, and strict hyperinflation regimes?

## Validation and communication

- [x] Every strategy reports accounting residuals and refuses to call a run balanced when they exceed tolerance.
- [x] The test suite covers transaction identities, bracket continuity, deterministic population generation, strategy differences, cascade activation, housing liquidation, API validation, and PM2-facing health behavior.
- [x] Results are labeled as conditional scenarios rather than forecasts.
- [x] Synthetic calibration, reduced-form market impact, inflation assumptions, and closed-economy buyer absorption are disclosed in the result payload and UI.
- [x] Official Federal Reserve, FRED, BEA, and IMF sources and vintages are linked from the dashboard.
- [x] The browser has no console errors, no horizontal overflow at desktop or mobile width, and assumption changes update the visible verdict and charts.

## Deliberately outside this acceptance bar

Within-group joint distributions remain stylized even though group totals are DFA-calibrated. A later empirical phase should fit microdata distributions, add regional housing and endogenous labor/production feedback, model a central-bank reaction function and fiscal interest expense, introduce default/bailout paths and the foreign sector, and attach uncertainty bands to the reduced-form ten-year projection.
