# Tax-payment financing calibration

The projection chooses a preferred financing path for each taxed household each
year. The borrowing and sale controls are scenario shifters, not identical
weights imposed on every household.

## Household choice

The preferred path responds to cash above a precautionary buffer, tax relative
to liquid deposits and income, public-equity and private-business concentration,
existing secured leverage, lender LTV, and the expected asset-return spread over
the loan rate. Settlement then falls through to cash, collateralized borrowing,
public-equity sales, housing sales, and statutory deferral as capacity binds.

The API reports two different realized concepts:

- shares of collected tax dollars paid from cash, new loans, and asset sales;
- shares of affected households using each source (a household can use a
  fallback source after its preferred source reaches capacity).

## Product structures and cure order

The central case is an interest-only demand loan. The scenario selector also
supports an amortizing loan and a demand loan with interest rollover. Annual
income equal to 12% of modeled income plus a 1.5% dividend proxy on public
equity can service the debt; this reallocates existing firm/household deposits
and does not create money. Amortizing loans additionally pay the exposed annual
principal rate. Rollover may capitalize unpaid interest only inside current LTV
headroom.

Before default, the borrower sells public equity and then housing to cure missed
service or an LTV breach. The sale and matching interest/principal payment are
reported separately as `taxLoanSaleToCure`; only an uncured residual reaches the
declared bank-loss, guarantee, or central-bank resolution path.

## Evidence and calibration status

The Federal Reserve estimates $138B of securities-based loans outstanding in
2024:Q1 and about $180B of margin loans, or roughly $318B combined. It describes
securities-backed lines as flexible-repayment demand loans that can be recalled,
are sensitive to collateral and rates, and commonly permit re-borrowing. This is
an observed stock, not a hard cap on policy-year originations. See [Estimating
Securities-Based Loans Outstanding](https://www.federalreserve.gov/econres/notes/feds-notes/estimating-securities-based-loans-outstanding-20240802.html).

The default 2%-over-$10M scenario now produces $163.9B of first-year loans,
about 52% of that observed combined stock. Cohort-specific take-up and policy
origination flows are not directly observed, so the household choice coefficients
remain explicit scenario assumptions rather than empirical estimates.

## Default before/after

| Year-one output | Imposed global blend | Heterogeneous central calibration |
| --- | ---: | ---: |
| Cash share of tax dollars | 15.0% | 23.3% |
| Borrowed share of tax dollars | 65.0% | 21.2% |
| Asset-sale share of tax dollars | 20.0% | 55.5% |
| New tax-payment loans | $501.5B | $163.9B |
| Affected households using cash | ambiguous | 85.0% |
| Affected households borrowing | ambiguous | 9.6% |
| Affected households selling | ambiguous | 5.4% |

The central, borrow-dominant, and near-total-borrowing stress presets are UI
labels, not probability claims. In particular, a 100% borrowing preference still
falls through to cash, sales, or deferral when lender and collateral limits bind.
