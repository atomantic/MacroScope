import { describe, expect, it } from "vitest";
import {
  SCENARIO_SCHEMA_VERSION,
  validateScenario,
  type AssetClass,
  type LiabilityClass,
  type ScenarioV1,
} from "../src/index.js";

const assets = Object.fromEntries(
  [
    "deposits",
    "governmentBonds",
    "publicEquity",
    "housing",
    "privateBusiness",
    "retirementAssets",
  ].map((key) => [key, { inclusionRate: 1, valuationFactor: 1 }]),
) as ScenarioV1["policies"]["wealthTax"]["assets"] & Record<AssetClass, unknown>;

const liabilities = Object.fromEntries(
  ["mortgage", "collateralizedLoan", "consumerDebt"].map((key) => [
    key,
    { deductibleRate: 1 },
  ]),
) as ScenarioV1["policies"]["wealthTax"]["liabilities"] &
  Record<LiabilityClass, unknown>;

const scenario = (): ScenarioV1 => ({
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  id: "baseline",
  name: "Baseline wealth-tax and UBI scenario",
  seed: 42,
  ticks: 120,
  tickUnit: "month",
  policies: {
    wealthTax: {
      unit: "tax-household",
      exemption: 50_000_000,
      brackets: [
        { threshold: 0, rate: 0.01 },
        { threshold: 1_000_000_000, rate: 0.02 },
      ],
      assets,
      liabilities,
      installments: 4,
      allowDeferral: true,
    },
    ubi: {
      adultMonthlyBenefit: 1_000,
      childMonthlyBenefit: 500,
      fundingRule: "smoothed",
      taxable: false,
      administrativeCostRate: 0.01,
      leakageRate: 0.001,
    },
  },
});

describe("scenario schema", () => {
  it("accepts a valid versioned scenario", () => {
    expect(validateScenario(scenario())).toEqual([]);
  });

  it("rejects decreasing progressive rates", () => {
    const invalid = scenario();
    const withInvalidBrackets: ScenarioV1 = {
      ...invalid,
      policies: {
        ...invalid.policies,
        wealthTax: {
          ...invalid.policies.wealthTax,
          brackets: [
            { threshold: 0, rate: 0.02 },
            { threshold: 1_000_000, rate: 0.01 },
          ],
        },
      },
    };
    expect(validateScenario(withInvalidBrackets)).toContain(
      "Progressive bracket rates must be nondecreasing.",
    );
  });
});
