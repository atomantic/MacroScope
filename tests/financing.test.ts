import { describe, expect, it } from "vitest";
import {
  annualDebtServiceCashCapacity,
  chooseHouseholdFinancingWeights,
  DEFAULT_COMPARISON_REQUEST,
  preferredHouseholdFinancingPath,
  parseComparisonRequest,
  runComparison,
  scheduledPrincipalForLoanStructure,
} from "../src/index.js";

const base = {
  annualIncome: 500_000,
  taxDue: 200_000,
  deposits: 100_000,
  publicEquity: 3_000_000,
  housing: 7_000_000,
  privateBusiness: 0,
  totalAssets: 10_000_000,
  securedLiabilities: 0,
  maximumCollateralLtv: 0.5,
  expectedAssetReturn: 0.06,
  loanInterestRate: 0.045,
  borrowShifter: 0.45,
  sellShifter: 0.25,
} as const;

describe("heterogeneous tax financing", () => {
  it("chooses different paths for equal net worth with different balance sheets", () => {
    const liquid = preferredHouseholdFinancingPath({
      ...base,
      deposits: 3_000_000,
      publicEquity: 2_000_000,
      housing: 5_000_000,
    });
    const equityHeavy = preferredHouseholdFinancingPath({
      ...base,
      deposits: 100_000,
      publicEquity: 6_000_000,
      housing: 4_000_000,
      securedLiabilities: 1_500_000,
    });
    const unlevered = preferredHouseholdFinancingPath(base);
    expect(liquid).toBe("cash");
    expect(equityHeavy).toBe("sell");
    expect(unlevered).toBe("borrow");
  });

  it("makes intermediate borrowing preferences less cash-first, not more", () => {
    // Five times the tax bill is enough liquidity to prefer cash at a low
    // borrowing preference, but not enough to keep draining deposits after the
    // household has expressed a strong preference to borrow against ample
    // collateral. This guards against a threshold that accidentally reverses
    // the dial's direction and leaves the walkthrough unchanged until 100%.
    const borderlineLiquid = { ...base, deposits: 1_000_000, sellShifter: 0 };
    expect(
      preferredHouseholdFinancingPath({ ...borderlineLiquid, borrowShifter: 0.25 }),
    ).toBe("cash");
    expect(
      preferredHouseholdFinancingPath({ ...borderlineLiquid, borrowShifter: 0.75 }),
    ).toBe("borrow");
  });

  it("returns normalized propensity weights before selecting a preferred path", () => {
    const weights = chooseHouseholdFinancingWeights(base);
    expect(weights.cash + weights.borrow + weights.sell).toBeCloseTo(1, 12);
  });

  it("separates interest-only, amortizing, and rollover principal schedules", () => {
    expect(scheduledPrincipalForLoanStructure(1_000, "interest-only", 0.1)).toBe(0);
    expect(scheduledPrincipalForLoanStructure(1_000, "demand-rollover", 0.1)).toBe(0);
    expect(scheduledPrincipalForLoanStructure(1_000, "amortizing", 0.1)).toBe(100);
  });

  it("uses income and dividends as existing-flow service capacity", () => {
    expect(annualDebtServiceCashCapacity(1_000_000, 2_000_000)).toBe(150_000);
  });

  it("keeps interest-only and rollover principal distinct from amortization", () => {
    const run = (taxLoanStructure: "interest-only" | "amortizing" | "demand-rollover") =>
      runComparison({
        ...DEFAULT_COMPARISON_REQUEST,
        sampleSize: 800,
        behavior: {
          ...DEFAULT_COMPARISON_REQUEST.behavior,
          borrowShare: 1,
          sellShare: 0,
          taxLoanStructure,
        },
      });
    const repayments = (structure: Parameters<typeof run>[0]) =>
      run(structure).projection.years.reduce(
        (sum, year) => sum + year.privateTaxLoanRepayments,
        0,
      );
    expect(repayments("interest-only")).toBe(0);
    expect(repayments("demand-rollover")).toBe(0);
    expect(repayments("amortizing")).toBeGreaterThan(0);
  });

  it("falls through a 100% borrowing preference when collateral binds", () => {
    const request = DEFAULT_COMPARISON_REQUEST;
    const result = runComparison({
      ...request,
      sampleSize: 800,
      wealthTax: { ...request.wealthTax, exemption: 0, rate: 0.2 },
      market: { ...request.market, maximumCollateralLtv: 0.1 },
      behavior: { ...request.behavior, borrowShare: 1, sellShare: 0 },
    });
    expect(result.projection.behaviorMix.borrowShare).toBeLessThan(1);
    expect(result.projection.behaviorMix.cashShare).toBeGreaterThan(0);
    expect(result.projection.behaviorMix.sellShare).toBeGreaterThan(0);
  });

  it("normalizes an omitted loan structure and rejects unknown products", () => {
    const request = DEFAULT_COMPARISON_REQUEST;
    const omitted = parseComparisonRequest({
      ...request,
      behavior: { ...request.behavior, taxLoanStructure: undefined },
    });
    expect(omitted.value?.behavior.taxLoanStructure).toBe("interest-only");
    const invalid = parseComparisonRequest({
      ...request,
      behavior: { ...request.behavior, taxLoanStructure: "balloon" },
    });
    expect(invalid.errors).toContain(
      "taxLoanStructure must be interest-only, amortizing, or demand-rollover.",
    );
  });
});
