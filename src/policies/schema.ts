export const SCENARIO_SCHEMA_VERSION = 1 as const;

export type AssetClass =
  | "deposits"
  | "governmentBonds"
  | "publicEquity"
  | "housing"
  | "privateBusiness"
  | "retirementAssets";

export type LiabilityClass = "mortgage" | "collateralizedLoan" | "consumerDebt";

export interface TaxBracket {
  readonly threshold: number;
  readonly rate: number;
}

export interface AssetTaxRule {
  readonly inclusionRate: number;
  readonly valuationFactor: number;
}

export interface DebtTaxRule {
  readonly deductibleRate: number;
}

export interface WealthTaxPolicyV1 {
  readonly unit: "individual" | "tax-household";
  readonly exemption: number;
  readonly brackets: readonly TaxBracket[];
  readonly assets: Readonly<Record<AssetClass, AssetTaxRule>>;
  readonly liabilities: Readonly<Record<LiabilityClass, DebtTaxRule>>;
  readonly installments: 1 | 2 | 4 | 12;
  readonly allowDeferral: boolean;
}

export type UbiFundingRule = "fixed" | "revenue-constrained" | "smoothed";
export type SurplusUse =
  | "debt-reduction"
  | "additional-services"
  | "rebate"
  | "treasury-balance";

export interface UbiPolicyV1 {
  readonly adultMonthlyBenefit: number;
  readonly childMonthlyBenefit: number;
  readonly fundingRule: UbiFundingRule;
  readonly surplusUse?: SurplusUse;
  readonly taxable: boolean;
  readonly administrativeCostRate: number;
  readonly leakageRate: number;
}

export interface ScenarioV1 {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly seed: number;
  readonly ticks: number;
  readonly tickUnit: "month";
  readonly policies: {
    readonly wealthTax: WealthTaxPolicyV1;
    readonly ubi: UbiPolicyV1;
  };
}

export const validateScenario = (scenario: ScenarioV1): readonly string[] => {
  const errors: string[] = [];
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    errors.push(`Unsupported schema version: ${String(scenario.schemaVersion)}`);
  }
  if (!scenario.id.trim()) errors.push("Scenario id is required.");
  if (!scenario.name.trim()) errors.push("Scenario name is required.");
  if (!Number.isSafeInteger(scenario.seed)) errors.push("Seed must be a safe integer.");
  if (!Number.isInteger(scenario.ticks) || scenario.ticks <= 0) {
    errors.push("Ticks must be a positive integer.");
  }

  const wealthTax = scenario.policies.wealthTax;
  if (!Number.isFinite(wealthTax.exemption) || wealthTax.exemption < 0) {
    errors.push("Wealth-tax exemption must be finite and nonnegative.");
  }
  let previousThreshold = -Infinity;
  let previousRate = -Infinity;
  for (const bracket of wealthTax.brackets) {
    if (!Number.isFinite(bracket.threshold) || bracket.threshold < 0) {
      errors.push("Bracket thresholds must be finite and nonnegative.");
    }
    if (bracket.threshold <= previousThreshold) {
      errors.push("Bracket thresholds must be strictly increasing.");
    }
    if (!Number.isFinite(bracket.rate) || bracket.rate < 0 || bracket.rate > 1) {
      errors.push("Bracket rates must be between 0 and 1.");
    }
    if (bracket.rate < previousRate) {
      errors.push("Progressive bracket rates must be nondecreasing.");
    }
    previousThreshold = bracket.threshold;
    previousRate = bracket.rate;
  }

  for (const [assetClass, rule] of Object.entries(wealthTax.assets)) {
    validateUnitRate(rule.inclusionRate, `${assetClass} inclusion rate`, errors);
    if (!Number.isFinite(rule.valuationFactor) || rule.valuationFactor < 0) {
      errors.push(`${assetClass} valuation factor must be finite and nonnegative.`);
    }
  }
  for (const [liabilityClass, rule] of Object.entries(wealthTax.liabilities)) {
    validateUnitRate(rule.deductibleRate, `${liabilityClass} deductible rate`, errors);
  }

  const ubi = scenario.policies.ubi;
  if (!Number.isFinite(ubi.adultMonthlyBenefit) || ubi.adultMonthlyBenefit < 0) {
    errors.push("Adult UBI benefit must be finite and nonnegative.");
  }
  if (!Number.isFinite(ubi.childMonthlyBenefit) || ubi.childMonthlyBenefit < 0) {
    errors.push("Child UBI benefit must be finite and nonnegative.");
  }
  validateUnitRate(ubi.administrativeCostRate, "UBI administrative cost rate", errors);
  validateUnitRate(ubi.leakageRate, "UBI leakage rate", errors);
  if (
    ubi.surplusUse !== undefined &&
    ubi.surplusUse !== "debt-reduction" &&
    ubi.surplusUse !== "additional-services" &&
    ubi.surplusUse !== "rebate" &&
    ubi.surplusUse !== "treasury-balance"
  ) {
    errors.push(
      "UBI surplus use must be debt-reduction, additional-services, rebate, or treasury-balance.",
    );
  }
  return errors;
};

const validateUnitRate = (rate: number, label: string, errors: string[]): void => {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    errors.push(`${label} must be between 0 and 1.`);
  }
};
