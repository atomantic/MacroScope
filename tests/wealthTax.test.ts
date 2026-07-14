import { describe, expect, it } from "vitest";
import {
  applyWealthTaxpayerResponse,
  assessWealthTax,
  assessProgressiveTax,
  calculateProgressiveTax,
  type AssetClass,
  type LiabilityClass,
  type WealthTaxPolicyV1,
} from "../src/index.js";

const assets = Object.fromEntries(
  [
    "deposits",
    "governmentBonds",
    "publicEquity",
    "housing",
    "privateBusiness",
    "retirementAssets",
    "otherAssets",
  ].map((assetClass) => [assetClass, { inclusionRate: 1, valuationFactor: 1 }]),
) as Record<AssetClass, { inclusionRate: number; valuationFactor: number }>;

const liabilities = Object.fromEntries(
  ["mortgage", "collateralizedLoan", "consumerDebt"].map((liabilityClass) => [
    liabilityClass,
    { deductibleRate: 1 },
  ]),
) as Record<LiabilityClass, { deductibleRate: number }>;

const policy: WealthTaxPolicyV1 = {
  unit: "tax-household",
  exemption: 1_000_000,
  brackets: [
    { threshold: 0, rate: 0 },
    { threshold: 1_000_000, rate: 0.01 },
    { threshold: 5_000_000, rate: 0.02 },
  ],
  assets,
  liabilities,
  installments: 4,
  allowDeferral: true,
};

describe("wealth-tax policy", () => {
  it("calculates progressive marginal brackets continuously", () => {
    expect(calculateProgressiveTax(999_999, policy.brackets)).toBe(0);
    expect(calculateProgressiveTax(1_000_000, policy.brackets)).toBe(0);
    expect(calculateProgressiveTax(1_000_001, policy.brackets)).toBeCloseTo(0.01);
    expect(calculateProgressiveTax(6_000_000, policy.brackets)).toBe(60_000);
  });

  it("reports bracket-level liabilities and applies avoidance at the marginal rate", () => {
    const progressive = assessProgressiveTax(6_000_000, policy.brackets);

    expect(progressive.marginalRate).toBe(0.02);
    expect(progressive.effectiveRate).toBe(0.01);
    expect(progressive.bracketBreakdown).toEqual([
      {
        threshold: 0,
        upperThreshold: 1_000_000,
        rate: 0,
        taxableAmount: 1_000_000,
        tax: 0,
      },
      {
        threshold: 1_000_000,
        upperThreshold: 5_000_000,
        rate: 0.01,
        taxableAmount: 4_000_000,
        tax: 40_000,
      },
      {
        threshold: 5_000_000,
        upperThreshold: null,
        rate: 0.02,
        taxableAmount: 1_000_000,
        tax: 20_000,
      },
    ]);
    expect(
      applyWealthTaxpayerResponse(
        assessWealthTax(
          {
            assets: {
              deposits: 0,
              governmentBonds: 0,
              publicEquity: 7_000_000,
              housing: 0,
              privateBusiness: 0,
              retirementAssets: 0,
              otherAssets: 0,
            },
            liabilities: { mortgage: 0, collateralizedLoan: 0, consumerDebt: 0 },
          },
          policy,
        ),
        0.1,
      ),
    ).toMatchObject({ complianceFactor: 0.8, taxAssessed: 48_000 });
  });

  it("applies inclusion, valuation, debt, exemption, and installment rules", () => {
    const assessment = assessWealthTax(
      {
        assets: {
          deposits: 500_000,
          governmentBonds: 0,
          publicEquity: 6_000_000,
          housing: 1_000_000,
          privateBusiness: 0,
          retirementAssets: 0,
          otherAssets: 0,
        },
        liabilities: {
          mortgage: 500_000,
          collateralizedLoan: 0,
          consumerDebt: 0,
        },
      },
      policy,
    );

    expect(assessment.includedAssets).toBe(7_500_000);
    expect(assessment.deductibleLiabilities).toBe(500_000);
    expect(assessment.taxableBase).toBe(6_000_000);
    expect(assessment.annualTax).toBe(60_000);
    expect(assessment.installmentAmount).toBe(15_000);
  });

  it("keeps schema-v1 policies without otherAssets backward compatible", () => {
    const { otherAssets: _otherAssets, ...legacyAssets } = policy.assets;
    const legacyPolicy: WealthTaxPolicyV1 = { ...policy, assets: legacyAssets };
    const assessment = assessWealthTax(
      {
        assets: {
          deposits: 2_000_000,
          governmentBonds: 0,
          publicEquity: 0,
          housing: 0,
          privateBusiness: 0,
          retirementAssets: 0,
          otherAssets: 5_000_000,
        },
        liabilities: {
          mortgage: 0,
          collateralizedLoan: 0,
          consumerDebt: 0,
        },
      },
      legacyPolicy,
    );

    expect(assessment.includedAssets).toBe(2_000_000);
    expect(assessment.annualTax).toBe(0);
  });
});
