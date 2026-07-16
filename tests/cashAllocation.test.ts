import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  allocateRecipientCash,
  runComparison,
  type RecipientCashAllocationAssumptions,
} from "../src/index.js";

const assumptions = (
  overrides: Partial<RecipientCashAllocationAssumptions> = {},
): RecipientCashAllocationAssumptions => ({
  debtRepaymentShare: 0.35,
  assetPurchaseShare: 0.25,
  housingShare: 0.3,
  retirementAndBondShare: 0.2,
  speculativeShare: 0.1,
  housingDownPaymentShare: 0.2,
  ...overrides,
});

const allocation = (
  overrides: Partial<Parameters<typeof allocateRecipientCash>[0]> = {},
) =>
  allocateRecipientCash({
    cashDelivered: 100,
    marginalPropensityToConsume: 0,
    percentile: 0.5,
    annualIncome: 100,
    deposits: 50,
    debtCapacity: 100,
    assumptions: assumptions(),
    ...overrides,
  });

const expectReconciled = (result: ReturnType<typeof allocation>) => {
  expect(
    result.consumption +
      result.debtRepayment +
      result.depositSaving +
      result.housingDownPayment +
      result.publicEquityPurchases +
      result.retirementAndBondPurchases +
      result.speculativeAssetPurchases,
  ).toBeCloseTo(result.cashDelivered, 10);
  expect(result.cashReconciliationResidual).toBeCloseTo(0, 10);
};

describe("recipient cash allocation", () => {
  it("preserves the literal 100% consumption boundary", () => {
    const result = allocation({ marginalPropensityToConsume: 1 });
    expect(result.consumption).toBe(100);
    expect(result.debtRepayment).toBe(0);
    expect(result.assetPurchaseCash).toBe(0);
    expect(result.depositSaving).toBe(0);
    expectReconciled(result);
  });

  it("preserves the literal 100% deposit boundary", () => {
    const result = allocation({
      debtCapacity: 0,
      assumptions: assumptions({
        debtRepaymentShare: 0,
        assetPurchaseShare: 0,
      }),
    });
    expect(result.depositSaving).toBe(100);
    expectReconciled(result);
  });

  it("preserves the literal 100% debt-repayment boundary when debt exists", () => {
    const result = allocation({
      assumptions: assumptions({ debtRepaymentShare: 1 }),
    });
    expect(result.debtRepayment).toBe(100);
    expect(result.depositSaving).toBe(0);
    expect(result.assetPurchaseCash).toBe(0);
    expectReconciled(result);
  });

  it("keeps housing leverage, public equity, retirement, and speculation distinct", () => {
    const result = allocation({
      debtCapacity: 0,
      assumptions: assumptions({
        debtRepaymentShare: 0,
        assetPurchaseShare: 1,
        housingShare: 0.3,
        retirementAndBondShare: 0.2,
        speculativeShare: 0.1,
        housingDownPaymentShare: 0.2,
      }),
    });
    expect(result.housingDownPayment).toBe(30);
    expect(result.housingPurchaseDemand).toBe(150);
    expect(result.publicEquityPurchases).toBeCloseTo(40, 10);
    expect(result.retirementAndBondPurchases).toBe(20);
    expect(result.speculativeAssetPurchases).toBe(10);
    expectReconciled(result);
  });

  it("gives lower-liquidity cohorts a larger consumption and debt-service response", () => {
    const lowLiquidity = allocation({
      marginalPropensityToConsume: 0.8,
      percentile: 0.2,
      deposits: 1,
      debtCapacity: 100,
    });
    const highLiquidity = allocation({
      marginalPropensityToConsume: 0.3,
      percentile: 0.95,
      deposits: 100,
      debtCapacity: 100,
    });
    expect(
      lowLiquidity.consumption + lowLiquidity.debtRepayment,
    ).toBeGreaterThan(
      highLiquidity.consumption + highLiquidity.debtRepayment,
    );
    expectReconciled(lowLiquidity);
    expectReconciled(highLiquidity);
  });

  it("produces zero recipient portfolio flow when no cash transfer exists", () => {
    const result = runComparison({
      ...DEFAULT_COMPARISON_REQUEST,
      sampleSize: 200,
      representedHouseholds: 1_000,
      wealthTax: { ...DEFAULT_COMPARISON_REQUEST.wealthTax, rate: 0 },
      ubi: {
        ...DEFAULT_COMPARISON_REQUEST.ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
      },
    });
    expect(
      result.projection.theoryTest.years.every(
        (year) => year.recipientCashAllocation.assetPurchaseCash === 0,
      ),
    ).toBe(true);
    expect(
      result.projection.theoryTest.summary.annualRecipientAssetPurchaseCash,
    ).toBe(0);
  });

  it("allows money-neutral cash redistribution to change asset demand", () => {
    const result = runComparison({
      ...DEFAULT_COMPARISON_REQUEST,
      sampleSize: 400,
      representedHouseholds: 10_000,
      ubi: {
        ...DEFAULT_COMPARISON_REQUEST.ubi,
        adultMonthlyBenefit: 100,
        childMonthlyBenefit: 50,
        fundingRule: "revenue-constrained",
        surplusUse: "rebate",
      },
      market: {
        ...DEFAULT_COMPARISON_REQUEST.market,
        maximumCollateralLtv: 0,
      },
      behavior: {
        ...DEFAULT_COMPARISON_REQUEST.behavior,
        borrowShare: 0,
        sellShare: 0,
        deficitMonetizationShare: 0,
        assetHedgeShare: 0,
        recipientDebtRepaymentShare: 0,
      },
    });
    expect(Math.abs(result.projection.summary.cumulativeM2Change)).toBeLessThan(
      1e-9,
    );
    expect(
      result.projection.theoryTest.summary.annualLiquiditySeekingAssets,
    ).toBe(0);
    expect(
      result.projection.theoryTest.summary.annualRecipientAssetPurchaseCash,
    ).toBeGreaterThan(0);
    expect(
      result.projection.theoryTest.summary.annualRecipientHousingPurchaseDemand,
    ).toBeGreaterThan(0);
    expect(
      result.projection.theoryTest.summary.recipientCashReconciliationResidual,
    ).toBeLessThan(0.01);
  });

  it("destroys deposits when recipients use transfer cash to repay bank debt", () => {
    const base = {
      ...DEFAULT_COMPARISON_REQUEST,
      sampleSize: 300,
      representedHouseholds: 5_000,
      ubi: {
        ...DEFAULT_COMPARISON_REQUEST.ubi,
        fundingRule: "revenue-constrained" as const,
        surplusUse: "rebate" as const,
      },
      market: {
        ...DEFAULT_COMPARISON_REQUEST.market,
        maximumCollateralLtv: 0,
      },
      behavior: {
        ...DEFAULT_COMPARISON_REQUEST.behavior,
        borrowShare: 0,
        sellShare: 0,
        deficitMonetizationShare: 0,
        recipientDebtRepaymentShare: 0,
      },
    };
    const neutral = runComparison(base);
    const debtRepayment = runComparison({
      ...base,
      behavior: {
        ...base.behavior,
        recipientDebtRepaymentShare: 1,
      },
    });
    expect(neutral.projection.summary.cumulativeM2Change).toBeCloseTo(0, 9);
    expect(
      debtRepayment.projection.theoryTest.summary
        .cumulativeRecipientDebtRepayment,
    ).toBeGreaterThan(0);
    expect(debtRepayment.projection.summary.cumulativeM2Change).toBeLessThan(
      neutral.projection.summary.cumulativeM2Change - 1e-7,
    );
  });

  it("reports recipient demand separately from new-money recycling in a stress case", () => {
    const result = runComparison({
      ...DEFAULT_COMPARISON_REQUEST,
      sampleSize: 200,
      representedHouseholds: 1_000,
      ubi: {
        ...DEFAULT_COMPARISON_REQUEST.ubi,
        adultMonthlyBenefit: 5_000,
        childMonthlyBenefit: 2_500,
        fundingRule: "fixed",
      },
      behavior: {
        ...DEFAULT_COMPARISON_REQUEST.behavior,
        borrowShare: 1,
        sellShare: 0,
        deficitMonetizationShare: 1,
        assetHedgeShare: 1,
      },
    });
    const summary = result.projection.theoryTest.summary;
    expect(summary.annualRecipientAssetPurchaseCash).toBeGreaterThan(0);
    expect(summary.annualLiquiditySeekingAssets).toBeGreaterThan(0);
    expect(summary.annualRecipientPublicEquityPurchases).toBeGreaterThan(0);
    expect(summary.annualRecipientSpeculativeAssetPurchases).toBeGreaterThan(0);
  });
});
