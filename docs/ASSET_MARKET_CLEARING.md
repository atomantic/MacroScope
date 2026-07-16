# Annual asset-market clearing

The ten-year projection clears housing and public equity once per year, with an
inner collateral loop when a price decline breaches loan-to-value limits. This
keeps the causal chain in one place:

`tax sales + recipient demand + recycled liquidity + foreign buyers + supply -> prices -> collateral calls -> forced sales -> next tax base`

## Order flow and prices

For each market and clearing pass:

1. Gross purchases are recipient purchases, recycled new-money demand, and the
   configured foreign-buyer share of assets offered for sale.
2. Gross sales are voluntary tax-funding sales plus forced collateral sales.
3. Positive excess demand creates new housing or equity claims according to
   `new supply = excess demand * elasticity / (1 + elasticity)`.
4. The residual clears against finite depth:
   `price change = impact coefficient * net order flow / market depth`, capped
   at 25% in either direction per pass.

Housing uses the exposed construction/supply elasticity. Public equity uses a
documented 0.35 issuance elasticity. Market depth is the current market value
times the exposed buyer-depth ratio. Foreign buyers participate in the same
order book; they are not an after-the-fact subtraction.

Trades transfer claims and deposits between buyers and sellers. They do not
change M2. A forced sale followed by loan repayment destroys equal deposits and
loans. New construction/issuance is the only market-clearing leg that increases
the quantity of outstanding assets. Each annual API result reports purchases,
foreign purchases, voluntary and forced sales, new supply, net order flow,
price change, collateral calls, forced repayments, reconciliation residual,
iteration count, and whether the loop converged before its 12-pass cap.

## Collateral and annual assessment

After every price pass, the engine revalues each household's housing and public
equity. If its modeled tax-payment loan exceeds current collateral capacity,
the household sells public equity and then housing, repays principal, and sends
that forced order flow through the next pass. The loop stops below $1 million of
new forced flow or reports that the iteration cap was reached.

Domestic buyers receive claims sold by taxpayers; non-resident purchases leave
the domestic household sector explicitly. Recipient housing demand adds the
associated mortgage balance after the configured down payment. The next annual
wealth-tax assessment therefore reads the post-trade, post-revaluation holdings
and liabilities rather than an aggregate multiplier.

Asset classes no longer receive one blanket return. Deposits stay nominal;
government bonds receive a capped fixed-income proxy; public equity, housing,
private business, retirement assets, and other assets receive distinct
reduced-form baseline returns. Only public equity and housing receive the
policy-driven market-clearing revaluation.

## Default-scenario impact

The comparison below holds the issue #62 interest correction and issue #61
recipient allocation model fixed. “Before” is the positive-demand-only price
path; “After” includes sales, supply, ownership transfer, and collateral/base
feedback.

| Ten-year output | Before | After |
| --- | ---: | ---: |
| Housing-price change | +4.80% | +3.10% |
| Public-equity price change | +1.74% | -14.10% |
| Year-one tax collected | $771.51B | $771.51B |
| Year-ten tax collected | $1.504T | $1.167T |
| Ending private tax debt | $3.177T | $1.611T |
| Cumulative tax-loan defaults | $2.318T | $3.667T |
| Renter housing-burden change | -4.16% | -3.16% |
| Middle-homeowner wealth change | +2.11% | +1.36% |
| Bottom-half purchasing-power change | +5.82% | +4.21% |
| Peak annual inflation | 3.80% | 3.80% |

The overall verdict remains `beneficial` and the owner-renter theory verdict
remains `partial`. The new loop materially weakens the asset-price and future
tax-base assumptions without crossing the configured verdict thresholds. The
default path does not trigger a collateral call; the dedicated stress test does
and reports whether its iteration cap binds.
