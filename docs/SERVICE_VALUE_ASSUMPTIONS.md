# Public-service resource-value assumptions

MacroScope records public-service spending as provider demand in every scenario.
That accounting effect is not a household cash transfer. This note documents the
separate, opt-in resource-equivalent display used when a scenario includes
healthcare or social-service delivery.

## What is scored

The engine currently routes 60% of public-service spending to healthcare and
40% to the mixed services sector. It reports three cases, before any claim about
an overall welfare ranking:

| Case | Healthcare | Mixed services | Meaning |
| --- | ---: | ---: | --- |
| Zero | 0% | 0% | Reproduces the cash-only boundary. |
| Base | 60% | 35% | A conservative avoided-cost/access resource proxy. |
| High | 85% | 65% | A capacity-and-delivery case with more complete access. |

The percentages are sensitivity assumptions, not estimates of a universal
exchange rate between public services and cash. The displayed value is therefore
called *resource-equivalent* and is kept separate from cash buying power.

## Evidence boundary

CMS National Health Expenditure Accounts measure spending by service, payer, and
sponsor, including household out-of-pocket payments. They support treating health
delivery as a real household resource channel, but do **not** identify a single
welfare value for a dollar of new public provision. The BLS Consumer Expenditure
research on the expanded Child Tax Credit likewise shows that household responses
are composition-specific rather than one-for-one cash equivalents. MacroScope
uses these sources to justify an explicit range, not to calibrate a false-precise
single number.

- [CMS National Health Expenditure Accounts](https://www.cms.gov/data-research/statistics-trends-and-reports/national-health-expenditure-data)
- [CMS NHEA definitions, sources, and methods](https://www.cms.gov/files/document/definitions-sources-and-methods.pdf)
- [BLS Consumer Expenditure research on child-related spending](https://www.bls.gov/osmr/research-papers/2024/ec240070.htm)

## How to read results

- **Unscored** is the default. The verdict is labelled `cash-only`; the model
  does not call a service-heavy package beneficial or harmful overall.
- **Zero**, **base**, and **high** show the same three resource cases. Selecting
  one surfaces it alongside the cash flow, but it remains neither spendable cash
  nor a cardinal welfare function.
- Capacity, quality, eligibility, and cohort-specific delivery are not yet
  structural state variables. The range is a transparent interim boundary, not
  a substitute for those extensions.
