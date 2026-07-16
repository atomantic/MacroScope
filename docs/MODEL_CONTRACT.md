# MacroScope model contract

Cash transfers follow the cohort allocation and reconciliation contract in
[CASH_TRANSFER_ALLOCATION.md](./CASH_TRANSFER_ALLOCATION.md). Recipient asset
demand is distinct from new-money liquidity recycling: a money-neutral
tax/rebate can change portfolios without changing aggregate M2.
Housing and public equity follow the bidirectional annual loop documented in
[ASSET_MARKET_CLEARING.md](./ASSET_MARKET_CLEARING.md).

## Scope of the first slice

This slice establishes the accounting kernel and policy schema before adding a full multi-country model. It implements the smallest domestic economy that can distinguish the central policy mechanisms, plus an optional aggregate rest-of-world closure:

1. A household pays wealth tax from existing deposits.
2. A household originates a collateralized loan and pays the tax from the new deposit.
3. A household sells an asset to another household for existing deposits and pays the tax.
4. Treasury redistributes the receipts as UBI.
5. A household repays a loan, destroying a loan and a deposit together.
6. A household pays tax-loan interest retained by the bank, reducing household
   and bank deposits while increasing bank income.

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
| Foreign claim | Asset held by a U.S. resident | Liability issued by rest of world | Aggregate rest-of-world sector |

Account metadata also identifies owner, counterparty, instrument, and whether the account is the holder or issuer side of a financial claim. This lets invariant checks compare every financial asset with its matching liability or equity claim.

## Sector balance sheets

- **Household**: deposits and public equity; collateralized-loan liabilities; opening net worth; tax and interest expense; and UBI income.
- **Commercial bank**: loans and reserves; deposit liabilities; opening bank equity and retained loan-interest income.
- **Government**: Treasury-account asset; tax income; UBI expense.
- **Central bank**: government-securities asset; reserve and Treasury-account liabilities.
- **Firm sector**: productive-capital asset; public-equity claims issued.
- **Rest of world (optional aggregate closure)**: foreign deposits, domestic securities/property claims, Treasury securities, and foreign claims held by U.S. residents.

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

Steps 4–7, including annual household tax-loan servicing and re-underwriting against current collateral, domestic asset transfers, a reduced-form securities-market clearing loop, collateral calls, and the loan-repayment primitive are implemented in this slice. An exhausted funding capacity leaves tax explicitly deferred; the model does not silently originate an unlimited new loan. Bank losses, default resolution, and bailout allocation remain unimplemented. Production and central-bank behavior are reduced-form outcome decompositions rather than agent modules.

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
- Retained loan interest reduces household and bank deposits by the same amount
  and raises bank income; it does not create money. Any later bank wage,
  dividend, or operating payment must be a separate named flow that restores a
  recipient deposit. The current projection does not assume that re-entry.
- An asset sale using existing deposits changes ownership but not aggregate deposits.
- Revaluations are never tagged as cash transactions.

Floating-point comparisons use an explicit tolerance. Production-scale simulations should move monetary values to integer minor units or a fixed-point representation before calibration.

## Vertical-slice population and markets

The interactive runner uses a deterministic weighted sample representing 135.1 million U.S. households. The default run uses 4,000 agents, allocates 80% of them to the bottom 99%, then explicitly oversamples the top 1%, 0.1%, and 0.01%. Wealth-group totals are calibrated to the Federal Reserve Distributional Financial Accounts; within-group joint distributions remain stylized. Adult and child counts reconcile to the July 2025 Census resident population, while aggregate personal income and PCE reconcile independently to calendar-year 2025 BEA totals. Full targets, eligibility rules, sector crosswalk, and diagnostics are documented in [POPULATION_FLOW_CALIBRATION.md](POPULATION_FLOW_CALIBRATION.md).

Each comparison reuses the same households for cash-first, borrow-first, and sell-first strategies. The ten-year path carries each household's initial funding mix forward, services its outstanding tax loan from deposits, and re-underwrites every new loan against current equity and housing collateral after mortgages and prior tax loans. A funding shortfall falls through from cash to borrowing to asset sales, then remains visible as deferred tax rather than compounding into unconstrained credit. Public-equity and housing sales clear against recipient purchases, recycled liquidity, foreign buyers, and new supply. Falling prices can breach collateral limits, producing iterative forced sales and loan repayment before the next annual assessment. In closed mode, domestic buyers absorb asset quantities. In partially-open and stress modes, a configurable rest-of-world share absorbs asset sales and newly issued Treasury debt, while resident capital outflow becomes an explicit foreign claim rather than disappearing deposits. Housing remains a national aggregate rather than a regional forecast.

The main projection subtracts tax-loan interest actually paid from M2 while
retaining it as bank income and capital. The reduced-form stress grid applies
the same sign but assumes all scheduled interest is paid; unlike the main
household path, it does not model cash constraints, defaults, or partial payment
inside each stress cell.

### Default-scenario correction impact

With the cohort cash-allocation model held fixed, correcting retained interest
from a positive to a negative M2 flow changes the default ten-year run as
follows:

| Output | Interest added to M2 | Interest removed from M2 |
| --- | ---: | ---: |
| Cumulative M2 change | +20.51% | +12.61% |
| Annual new-money asset demand | $165.48B | $101.78B |
| Housing-price change | +6.07% | +4.80% |
| Equity-price change | +2.43% | +1.74% |
| Peak annual inflation | 3.80% | 3.80% |

The owner-renter theory verdict remains `partial` and the overall policy
verdict remains `beneficial`; the correction reduces the asset-price channel
without crossing either verdict threshold. Peak inflation is unchanged because
the default run's peak occurs before the cumulative interest-sign difference
becomes the binding inflation input.

## Aggregate rest-of-world closure

The optional foreign sector is one auditable aggregate, not a country-by-country DSGE or exchange-rate forecast. It separates four stock-flow paths that were previously conflated:

1. Foreign buyers acquire domestic securities and property claims; this raises foreign ownership without creating or destroying U.S. deposits.
2. Foreign holders buy new Treasury debt; that funding is reported separately from domestic M2.
3. Residents acquire foreign claims as a capital outflow; the net foreign asset position rises by that claim rather than treating wealth as deleted.
4. Repatriation returns part of a foreign claim to domestic deposits; the remaining net flow supplies a directional FX-pressure indicator.

Expatriation is likewise split into a reported residence change, a U.S. tax-jurisdiction change (the only channel that reduces the taxable base), and an optional capital-flow response. Every nonzero aggregate cross-border leg is replayed through the ledger with domestic and rest-of-world entries; trial-balance and instrument-mirror residuals must remain within tolerance. The default is closed with all foreign-flow dials at zero, preserving the earlier domestic-only path.

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
