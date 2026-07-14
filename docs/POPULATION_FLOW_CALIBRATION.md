# Population and flow calibration

MacroScope uses one coherent denominator for national benefit costs and demand pressure. The synthetic sample still represents 135,134,121 Census households, but its weighted people and annual flows are rescaled to the following national targets:

| Metric | Target | Vintage and source |
| --- | ---: | --- |
| Resident population | 341,784,857 | [Census 2025 population estimates](https://www.census.gov/data/datasets/time-series/demo/popest/2020s-national-detail.html), July 1, 2025 |
| Adults age 18+ | 269,763,509 | Census 2025 national age-detail table |
| Children under 18 | 72,021,348 | Resident population less adults |
| Group-quarters residents | 8,388,561 | [ACS 2024 table B26001](https://data.census.gov/table/ACSDT1Y2024.B26001), used to document coverage rather than as an additional person count |
| Annual personal income | $26.100T | [BEA national income and product accounts](https://www.bea.gov/itable/national-gdp-and-personal-income), calendar year 2025 |
| Annual personal consumption expenditures | $20.961T | [BEA 2025 GDP/PCE release](https://www.bea.gov/news/2026/gdp-second-estimate-4th-quarter-and-year-2025) |

All residents, including people in group quarters, are eligible for the modeled adult or child benefit; nonresidents are excluded. Household weights continue to represent households. Group-quarters residents are carried by synthetic tax-household agents only so national person and transfer totals reconcile—this is an allocation convention, not a claim that they live in Census households.

Calibration independently scales adult counts, child counts, household income, and household consumption. That preserves each series' synthetic percentile ordering while preventing the old income heuristic from defining a national PCE denominator. Wealth remains on its separate DFA instrument calibration, so the flow correction does not change tax bases or collections.

## Consumption-sector crosswalk

BEA PCE fixes the national total and broad product/service mix. The [BLS 2024 Consumer Expenditure Survey](https://www.bls.gov/news.release/archives/cesan_12192025.pdf) informs the mapping to household-facing categories and the model's percentile-varying allocation. The eight model shares are normalized to one:

| Sector | Share | Sector | Share |
| --- | ---: | --- | ---: |
| Housing | 18% | Food | 13% |
| Healthcare | 17% | Transportation | 11% |
| Energy | 4% | Durable goods | 10% |
| Discretionary | 12% | Services | 15% |

Each strategy therefore reports sector baseline demand that sums exactly to $20.961T in a full-population run. Demand changes still use percentile-varying household shares, so distributional behavior is retained while inflation pressure uses the calibrated national PCE denominator.

## Deterministic scenario regression

These 4,000-agent runs compare the prior demographic/income heuristic with the calibrated population and flow baseline. Dollar figures are first-year cash-first outcomes. Tax collections and revenue-constrained allocations stay unchanged because wealth calibration and the random wealth sample are unchanged.

| Scenario | Scheduled benefit, before → after | Tax / cash / services after | Demand inflation, before → after | Peak inflation, before → after |
| --- | ---: | ---: | ---: | ---: |
| Warren 2020 | $3.024T → $3.669T | $758.7B / $719.3B / $0 | 1.98% → 0.81% | 5.50% → 3.78% |
| Sanders 2020 | $3.024T → $3.669T | $890.4B / $844.2B / $0 | 2.38% → 0.97% | 6.02% → 4.00% |
| Fixed benefit | $3.024T → $3.669T | $771.5B / $3.479T / $0 | 13.48% → 6.82% | 14.84% → 8.67% |
| Service-heavy (20% cash, 10% administration) | $3.024T → $3.669T | $771.5B / $138.6B / $554.4B | 3.63% → 1.48% | 6.89% → 4.35% |

The scheduled national benefit rises because the modeled resident count rises from 283.7 million to 341.8 million. Demand pressure falls because its denominator rises from the heuristic $8.54T consumption total to the BEA $20.961T PCE total. The fixed-benefit case delivers more cash because it honors the larger national schedule with program borrowing; the revenue-constrained cases continue to allocate the same collected tax.

The API and model-details panel expose per-run targets, modeled values, residuals, and relative errors for households, resident people, adults, children, personal income, and PCE.
