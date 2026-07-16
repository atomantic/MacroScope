# Wealth-tax policy packages and fiscal closures

MacroScope treats three decisions separately:

1. **Tax design** — who owes the wealth tax and at what rate.
2. **Scheduled benefit** — whether the policy promises a recurring household benefit.
3. **Revenue disposition** — what happens when revenue remains after scheduled program costs and program-debt service.

This distinction makes a wealth tax without UBI a first-class scenario rather
than treating every dollar of revenue as an implicit transfer.

## One-click packages

| Package | Scheduled cash | Surplus use | Classification |
| --- | ---: | --- | --- |
| No cash — reduce debt | $0 | Program debt, then existing public debt | No cash transfer |
| No cash — public services | $0 | Additional public services | No cash transfer |
| No cash — hold at Treasury | $0 | Treasury balance | No cash transfer |
| Cash — household rebate | $0 scheduled; surplus rebated | Household cash rebate | Household cash transfer |
| Cash — scheduled UBI | $1,000/adult and $500/child monthly equivalent | Debt reduction after scheduled outlay | Household cash transfer |

A rebate is redistribution even though the scheduled benefit is zero. Warren
and Sanders remain tax-schedule-only presets: selecting either sets scheduled
benefits to zero and does not silently choose a spending package.

## Sources, uses, and monetary treatment

Each fiscal year reconciles:

`tax revenue + debt issued + opening Treasury balance`

to:

`program outlay + interest + debt retired + ending Treasury balance`.

The projection reports tax revenue, scheduled outlay, services, rebates,
administration, debt issued and retired, interest savings, Treasury balance, and
the resulting M2 recycling or drain. Debt retirement and spending recycle the
collected deposits to asset sellers or providers. A growing Treasury balance
can drain deposits subject to the model's M2 floor. A household rebate is cash
delivered to households.

## Closure-isolated A/B comparison

Choose one no-cash package, select **Pin this closure as Scenario A**, and then
choose another package. The comparison confirms when the tax schedule,
taxpayer behavior, financing assumptions, population, and every other setting
are identical and only `surplusUse` changed. Its table includes fiscal sources
and uses, debt, Treasury balance, M2, interest savings, and cohort outcomes.

Scenario URLs encode the tax preset and fiscal package independently, for
example `?preset=warren-2020&pkg=services`. Explicit field overrides still win.
The API remains schema v1 compatible: the wire fields continue to live under
`ubi`, while the UI and documentation present their separate policy roles.

## Verdict scope

Public-service spending always creates provider demand, but its household value
is not cash. A services-only package defaults to the `unscored` service-value
assumption and therefore carries a **cash-only** verdict. The verdict copy says
that it is not an overall welfare claim. Users can explicitly select a service
value case to obtain a cash-plus-service estimate.

