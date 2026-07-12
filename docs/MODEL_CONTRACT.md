# MacroScope model contract

## Scope of the first slice

This slice establishes the accounting kernel and policy schema before adding production, endogenous prices, market impact, synthetic-population calibration, or Three.js. It implements the smallest closed economy that can distinguish the central policy mechanisms:

1. A household pays wealth tax from existing deposits.
2. A household originates a collateralized loan and pays the tax from the new deposit.
3. A household sells an asset to another household for existing deposits and pays the tax.
4. Treasury redistributes the receipts as UBI.
5. A household repays a loan, destroying a loan and a deposit together.

## Accounting layers

Every event is assigned exactly one layer:

- **Transaction**: loan origination, asset purchase, tax payment, UBI, consumption, wages.
- **Revaluation**: a change in the market value of an existing position without cash flow.
- **Other volume**: default, write-off, migration, destruction, or reclassification.

Journal events must balance debits and credits before they can mutate state. Every account has a normal balance based on its class: asset and expense accounts are debit-normal; liability, equity, and income accounts are credit-normal.

## Instrument taxonomy

| Instrument | Holder-side treatment | Issuer-side treatment | First-slice issuer |
| --- | --- | --- | --- |
| Bank deposit | Asset | Liability | Commercial bank |
| Collateralized loan | Liability | Asset | Commercial bank |
| Central-bank reserve | Asset | Liability | Central bank |
| Treasury account | Asset | Liability | Central bank |
| Public equity | Asset | Equity claim | Aggregate firm sector |
| Productive capital | Real asset | Opening/issued equity | Aggregate firm sector |

Account metadata also identifies owner, counterparty, instrument, and whether the account is the holder or issuer side of a financial claim. This lets invariant checks compare every financial asset with its matching liability or equity claim.

## Sector balance sheets

- **Household**: deposits and public equity; collateralized-loan liabilities; opening net worth; tax expense and UBI income.
- **Commercial bank**: loans and reserves; deposit liabilities; opening bank equity.
- **Government**: Treasury-account asset; tax income; UBI expense.
- **Central bank**: government-securities asset; reserve and Treasury-account liabilities.
- **Firm sector**: productive-capital asset; public-equity claims issued.

The kernel checks both the economy-wide trial balance and each entity's accounting identity after every committed event.

## Monthly event order

The target engine order is:

1. Policy announcements and exogenous shocks.
2. Production, wages, hiring, and prices.
3. Income, interest, dividends, rent, and benefits.
4. Tax assessment.
5. Household funding choice: cash, borrowing, sale, or deferral.
6. Bank credit decision.
7. Tax and UBI settlement through Treasury.
8. Consumption and portfolio rebalancing.
9. Asset-market clearing.
10. Collateral revaluation.
11. Margin-call and forced-sale inner loop.
12. Bank losses and lending-limit changes.
13. Central-bank response.
14. Government debt and funding balance.
15. Metrics and accounting invariants.

Steps 4–7, domestic asset transfers, a reduced-form securities-market clearing loop, collateral calls, and the loan-repayment primitive are implemented in this slice. Production and central-bank behavior are reduced-form outcome decompositions rather than agent modules. Unimplemented phases remain explicit so later work does not reorder causal events accidentally.

## Required invariants

- Journal debits equal journal credits.
- Every tracked financial asset equals its matching liability or issued claim.
- Each entity and the full economy have a zero trial-balance residual.
- Accounts cannot become negative unless their definition explicitly allows it.
- Tax expense equals government tax income.
- UBI expense equals household UBI income.
- A cash-funded tax followed by equal UBI does not create deposits.
- A borrow-funded tax followed by equal UBI leaves loans and deposits higher while the loan is outstanding.
- Repayment reduces loans and deposits by the same amount.
- An asset sale using existing deposits changes ownership but not aggregate deposits.
- Revaluations are never tagged as cash transactions.

Floating-point comparisons use an explicit tolerance. Production-scale simulations should move monetary values to integer minor units or a fixed-point representation before calibration.

## Vertical-slice population and markets

The interactive runner uses a deterministic weighted sample representing 50,000 households. It allocates 80% of simulated agents to the bottom 99%, then explicitly oversamples the top 1%, 0.1%, and 0.01%. The current distribution is stylized and intentionally labeled as uncalibrated.

Each comparison reuses the same households for cash-first, borrow-first, and sell-first strategies. Public-equity sales interact with configurable buyer depth and price impact. Falling equity values can breach collateral limits, producing iterative forced sales and loan repayment. Domestic buyers absorb asset quantities, so ownership changes and price revaluation remain distinct. Housing can fund otherwise-unpayable tax liabilities as a slower last-resort transfer, but regional housing price feedback is deferred.

Demand changes are allocated across housing, food, healthcare, transportation, energy, durable goods, discretionary spending, and services. Sector inflation pressure, supply-constraint amplification, and monetary-policy offset are reduced-form assumptions rather than forecasts.
