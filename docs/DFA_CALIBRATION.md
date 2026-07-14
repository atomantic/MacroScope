# DFA instrument calibration

MacroScope calibrates every modeled balance-sheet instrument for each of its five wealth groups to the Federal Reserve Distributional Financial Accounts (DFA), vintage 2026:Q1. Targets come from `dfa-networth-levels-detail.csv`, released June 18, 2026. The API publishes the vintage, mapping, tolerance, and residual rule under `US_BASELINE.calibration`.

## Instrument mapping

- Deposits, debt securities, corporate equities and mutual funds, real estate, home mortgages, and consumer credit map directly to their model classes.
- Retirement assets aggregate annuities, defined-contribution pensions, and defined-benefit pensions.
- Private business maps to DFA miscellaneous other equity, labeled “Unincorporated businesses” in the visualization.
- Collateralized/other loans aggregate depository-institution loans not elsewhere classified, other loan advances, and unpaid insurance premiums. This is the closest published DFA proxy for the model's non-mortgage, non-consumer loan class.
- `otherAssets` explicitly preserves consumer durables, money-market funds, household loan assets, life-insurance reserves, and miscellaneous assets. These instruments are not silently relabeled as government bonds.

Calibration scales each group/instrument cell independently while preserving household weights, nonnegative positions, and within-cell relative holdings. Since every DFA component is represented, the instrument targets also reconcile to each group's published total assets and liabilities. The synthetic joint distribution inside each cell remains stylized.

## Scenario regression, issue #35

The following deterministic 4,000-agent runs compare the prior group-total scalar with instrument-level calibration. Dollar figures are first-year values. These are expected model changes, not coefficients tuned to retain earlier outputs.

| Scenario | Revenue | Borrow-first loans | Sell-first equity / housing | Peak inflation | Owner–renter housing-position gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default, before → after | $656.5B → $770.7B | $656.5B → $770.7B | $656.5B / $0 → $770.7B / $0 | 5.11% → 5.55% | 0.67pp → 0.80pp |
| Warren 2020, before → after | $604.6B → $759.6B | $604.6B → $759.6B | $604.6B / $0 → $759.6B / $0 | 4.91% → 5.50% | 1.00pp → 1.28pp |
| Sanders 2020, before → after | $701.9B → $891.7B | $701.9B → $891.7B | $701.9B / $0 → $891.7B / $0 | 5.28% → 6.03% | 1.14pp → 1.52pp |
| Extreme 20% zero-exemption stress, before → after | $28.77T → $27.97T | $2.02T → $2.78T | $28.52T / $0.25T → $26.40T / $1.58T | 1.92% → 1.85% | −36.06pp → −36.67pp |

The larger Warren/Sanders tax bases mainly come from correcting the top groups' portfolio composition: private-business and other taxable holdings rise while excess modeled housing and missing liability detail are removed. The extreme case also demonstrates why instrument calibration matters even when aggregate wealth is unchanged: lower equity and different loan collateral force substantially more housing liquidation.

The stress row uses a 20% tax from the first dollar, shallow buyer depth, maximum price impact, 10% maximum LTV, constrained housing supply, 100% borrow behavior, full deficit monetization, and full asset/housing hedge and rent pass-through. Its revenue-constrained transfer rule can produce lower inflation than the ordinary scenarios; it is a boundary test for portfolio and financing channels, not a policy forecast.
