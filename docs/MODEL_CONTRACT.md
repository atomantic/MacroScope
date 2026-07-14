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

The interactive runner uses a deterministic weighted sample representing 135.1 million U.S. households. The default run uses 4,000 agents, allocates 80% of them to the bottom 99%, then explicitly oversamples the top 1%, 0.1%, and 0.01%. Wealth-group totals are calibrated to the Federal Reserve Distributional Financial Accounts; within-group joint distributions remain stylized. Adult and child counts reconcile to the July 2025 Census resident population, while aggregate personal income and PCE reconcile independently to calendar-year 2025 BEA totals. Full targets, eligibility rules, sector crosswalk, and diagnostics are documented in [POPULATION_FLOW_CALIBRATION.md](POPULATION_FLOW_CALIBRATION.md).

Each comparison reuses the same households for cash-first, borrow-first, and sell-first strategies. Public-equity sales interact with configurable buyer depth and price impact. Falling equity values can breach collateral limits, producing iterative forced sales and loan repayment. Domestic buyers absorb asset quantities, so ownership changes and price revaluation remain distinct. Housing can fund otherwise-unpayable tax liabilities as a slower last-resort transfer, but regional housing price feedback is deferred.

Demand changes are allocated across housing, food, healthcare, transportation, energy, durable goods, discretionary spending, and services. Baseline sector totals use a BEA/BLS crosswalk whose shares sum to the calibrated PCE total; percentile-varying demand changes preserve the model's distributional shape. Sector inflation pressure, supply-constraint amplification, and monetary-policy offset are reduced-form assumptions rather than forecasts.

## Owner-renter theory test

The ten-year theory view deliberately separates an accounting result from behavioral assumptions:

1. Bank loans used to settle wealth tax create deposits while the loans remain outstanding.
2. The tax payment itself goes to Treasury; it does not purchase housing or equities.
3. A configurable share of the resulting liquidity may later be recycled into housing and equities as an inflation hedge.
4. Housing-price pressure depends on the selected housing allocation and housing-supply response.
5. Renter burden changes only when rents follow house prices faster than renter resources, including direct cash support.

The view reports an owner-renter housing-position channel, not a claim that total wealth inequality must rise. Top-one-percent real wealth, bottom-half cash purchasing power, service spending, and administration remain separate outcomes. Service spending is not assigned an invented cash-equivalent welfare value.

## Growth and investment channel

The ten-year path also carries the *real* objection to a wealth tax, alongside the monetary one: taxing wealth can reduce saving and investment, which over a decade lowers the capital stock, productivity, and wages — including for the bottom half. It is a reduced-form Solow-style block, not a general-equilibrium model.

- The capital stock is tracked as an index relative to the no-policy path, starting at 1. Each year investment deviates from the replacement rate that just offsets depreciation. A deviation of zero pins the index at 1, so the block collapses to the constant real-growth trend and reproduces prior behavior exactly.
- Two dials drive the deviation, and either can be set to zero to isolate the pure case:
  - **Savings response elasticity** turns the wealth tax's drag on the after-tax return to wealth into an investment shortfall — the supply-side, real objection. The drag is the tax *actually collected* each year (in real, price-deflated terms) as a share of aggregate net worth, so a high exemption that reaches no one, or avoidance that guts compliance, produces little collection and therefore little drag — the growth penalty never fires on a tax that isn't levied, and pure price appreciation of the base doesn't inflate it. Central estimates around 0.5–1 span the Penn-Wharton Budget Model and Tax Foundation dynamic-scoring range for the Warren/Sanders proposals; the default is 0.
  - **Demand growth offset** turns the transfer's demand impulse — the *real* (price-deflated) program budget as a share of national GDP — into added investment and output, the opposite pull of redistribution toward high-spending households. Deflating first means a purely CPI-driven rise in a nominal benefit adds no real demand. The default is 0.
- Wages track capital per worker (`capitalIndex ** capitalShare`, capital share ≈ 0.33), and the bottom-half wage base is scaled by the change in that deviation rather than a fixed formula. Real GDP per worker is reported as an index (100 = no-policy path) alongside M2 and prices, and its year-ten change feeds the summary.
- Because the wage path flows into the bottom half's real purchasing power, a savings-driven drag shows up directly in the verdict: at literature-default elasticities a large wealth tax leaves the bottom half with visibly less buying power than the transfer alone would suggest.

## Winners and losers by wealth group

Each run also reports an explicit ten-year outcome for every calibrated cohort — bottom 50% renters and owners, the middle 40%, the top 10%, top 1%, and top 0.1% — so no group's result stays hidden inside a year-one decile average. Two reduced-form measures lead the story:

- Renters (and the liquidity-constrained bottom half) read on **real purchasing power** after the modeled rent premium, reusing the owner-renter theory test's disposable-income path.
- Asset-holding groups read on **real net worth versus the no-policy path**, computed as a channel decomposition relative to baseline net worth rather than a blanket deflation: policy-driven housing- and equity-price premia on those holdings, plus the real value inflation strips from fixed-nominal debt (which benefits leveraged owners), minus the erosion of fixed-nominal deposits, minus the group's cumulative real wealth tax.

The engine's total collected tax is authoritative; it is apportioned across groups by each cohort's net worth above the effective exemption, so under a high exemption only the top groups carry a positive burden. UBI is modeled as near-universal per household. These per-group figures are transparent reduced-form summaries, not household-level forecasts, and a "household like mine" persona simply maps user-supplied net worth, size, and tenure onto the nearest of these cohorts.

Wealth taxes can target net worth above a dollar exemption or a modeled top population share. Percentile targeting derives an effective exemption from the weighted synthetic population, so the cutoff is scenario-dependent. The funded budget is allocated among administration, cash transfers, and healthcare/social-service demand before household and sector outcomes are calculated.
