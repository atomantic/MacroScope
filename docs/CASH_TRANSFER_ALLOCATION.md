# Cash-transfer allocation

MacroScope treats a delivered UBI or rebate dollar as existing cash that must
be assigned once. It is not automatically consumption, and it is not the same
thing as a new bank deposit created by lending or deficit monetization.

For each synthetic household, delivered cash is allocated in this order:

1. consumption, using the household's existing marginal propensity to consume;
2. repayment of existing mortgage, consumer, or collateralized debt;
3. asset-purchase cash; and
4. deposits as the residual.

Asset-purchase cash is then split among a housing down payment, public equity,
bonds or retirement saving, and speculative assets. Those named uses plus
consumption, debt repayment, and deposits reconcile exactly to delivered cash.
Gross housing demand is reported separately as `down payment / down-payment
share`; it is credit capacity, not a second use of the same cash.

## Default assumptions

| Assumption | Default | Uncertainty range | Meaning |
| --- | ---: | ---: | --- |
| Post-consumption cash targeted to debt | 35% | 15%–60% | Lower-liquidity and higher-debt cohorts tilt above the base. |
| Post-debt cash targeted to assets | 25% | 5%–50% | Higher-liquidity and higher-participation cohorts tilt above the base. |
| Asset cash used for housing down payment | 30% | UI scenario control | Public equity receives the portfolio remainder after the named shares. |
| Asset cash used for retirement/bonds | 20% | UI scenario control | Kept separate from the public-equity price channel. |
| Asset cash used for speculative assets | 10% | UI scenario control | Reported separately; it does not silently raise the equity index. |
| Housing down-payment share | 20% | 5%–35% | Converts cash down payments into gross purchase demand. |

The cohort tilt is deliberately bounded. A 0% or 100% control remains literal;
only interior assumptions vary by liquidity, debt burden, percentile, and
existing market access. The existing synthetic-population MPC runs from high
for lower-percentile households to low for higher-percentile households, so
lower-liquidity recipients consume more before the saving transition begins.

The ranges are scenario distributions, not statistical confidence intervals.
They are informed by evidence that transfer recipients combine consumption,
debt repayment, deposit accumulation, and a smaller but nonzero flow into
traded assets:

- [How Did U.S. Consumers Use Their Stimulus Payments?](https://www.nber.org/papers/w27097)
- [Direct Payments to Americans During the COVID-19 Pandemic](https://www.nber.org/papers/w29827)
- [Wealth Inequality and COVID-19: Evidence from the Distributional Financial Accounts](https://www.federalreserve.gov/econres/notes/feds-notes/wealth-inequality-and-covid-19-evidence-from-the-distributional-financial-accounts-20210830.html)

## Money and asset-price channels

A cash-funded tax and rebate can leave aggregate M2 unchanged while changing
who wants to hold housing, equity, or speculative assets. MacroScope reports
that recipient portfolio demand separately from `new-money liquidity
recycling`, the existing channel in which some newly created deposits later
seek inflation hedges. Only debt repayment destroys deposits in the cash
allocation transition. Asset purchases transfer deposits to counterparties;
they do not create money or new asset quantities.

The owner-renter theory uses the cash down payment's gross housing purchase
capacity and recipient public-equity cash as additional demand. Retirement,
bond, and speculative allocations remain visible but do not silently enter a
tracked price index.
