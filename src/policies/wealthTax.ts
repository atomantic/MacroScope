import type {
  AssetClass,
  AssetTaxRule,
  LiabilityClass,
  TaxBracket,
  WealthTaxPolicyV1,
} from "./schema.js";

export interface HouseholdTaxPosition {
  readonly assets: Readonly<
    Record<Exclude<AssetClass, "otherAssets">, number> &
      Partial<Record<"otherAssets", number>>
  >;
  readonly liabilities: Readonly<Record<LiabilityClass, number>>;
}

// Old schema-v1 positions and policies did not have a residual asset class.
// Treat an omitted rule as excluded, exactly matching that older contract;
// newly built policies opt in explicitly with their intended inclusion rule.
const LEGACY_OTHER_ASSET_RULE: AssetTaxRule = {
  inclusionRate: 0,
  valuationFactor: 1,
};

export interface WealthTaxAssessment {
  readonly includedAssets: number;
  readonly deductibleLiabilities: number;
  readonly exemption: number;
  readonly taxableBase: number;
  readonly annualTax: number;
  readonly installmentAmount: number;
  readonly marginalRate: number;
  readonly effectiveRate: number;
  readonly bracketBreakdown: readonly TaxBracketAssessment[];
}

export interface TaxBracketAssessment {
  readonly threshold: number;
  readonly upperThreshold: number | null;
  readonly rate: number;
  readonly taxableAmount: number;
  readonly tax: number;
}

export interface ResponseAdjustedWealthTaxAssessment {
  readonly complianceFactor: number;
  readonly avoidedTax: number;
  readonly taxAssessed: number;
}

export const calculateProgressiveTax = (
  taxableBase: number,
  brackets: readonly TaxBracket[],
): number => assessProgressiveTax(taxableBase, brackets).annualTax;

export const assessProgressiveTax = (
  taxableBase: number,
  brackets: readonly TaxBracket[],
): Pick<WealthTaxAssessment, "annualTax" | "marginalRate" | "effectiveRate" | "bracketBreakdown"> => {
  if (!Number.isFinite(taxableBase) || taxableBase < 0) {
    throw new Error("Taxable base must be finite and nonnegative.");
  }
  const bracketBreakdown = brackets.map((bracket, index) => {
    const upperThreshold = brackets[index + 1]?.threshold;
    const taxableAmount = Math.max(
      0,
      Math.min(taxableBase, upperThreshold ?? Infinity) - bracket.threshold,
    );
    return {
      threshold: bracket.threshold,
      upperThreshold: upperThreshold ?? null,
      rate: bracket.rate,
      taxableAmount,
      tax: taxableAmount * bracket.rate,
    };
  });
  const annualTax = bracketBreakdown.reduce((total, bracket) => total + bracket.tax, 0);
  const marginalRate =
    [...bracketBreakdown]
      .reverse()
      .find((bracket) => bracket.taxableAmount > 0)?.rate ?? 0;
  return {
    annualTax,
    marginalRate,
    effectiveRate: taxableBase > 0 ? annualTax / taxableBase : 0,
    bracketBreakdown,
  };
};

export const assessWealthTax = (
  position: HouseholdTaxPosition,
  policy: WealthTaxPolicyV1,
): WealthTaxAssessment => {
  const assetRules: Readonly<Record<AssetClass, AssetTaxRule>> = {
    otherAssets: LEGACY_OTHER_ASSET_RULE,
    ...policy.assets,
  };
  const includedAssets = sumRules(position.assets, assetRules, (value, rule) =>
    value * rule.inclusionRate * rule.valuationFactor,
  );
  const deductibleLiabilities = sumRules(
    position.liabilities,
    policy.liabilities,
    (value, rule) => value * rule.deductibleRate,
  );
  const taxableBase = Math.max(
    0,
    includedAssets - deductibleLiabilities - policy.exemption,
  );
  const progressiveAssessment = assessProgressiveTax(taxableBase, policy.brackets);
  return {
    includedAssets,
    deductibleLiabilities,
    exemption: policy.exemption,
    taxableBase,
    annualTax: progressiveAssessment.annualTax,
    installmentAmount: progressiveAssessment.annualTax / policy.installments,
    marginalRate: progressiveAssessment.marginalRate,
    effectiveRate: progressiveAssessment.effectiveRate,
    bracketBreakdown: progressiveAssessment.bracketBreakdown,
  };
};

// Avoidance elasticity is the fraction of a household's taxable base that is
// removed per percentage point of the household's marginal statutory rate.
// Applying it to the assessed liability preserves the prior flat-tax identity,
// while allowing progressive schedules to respond at the bracket actually faced.
export const applyWealthTaxpayerResponse = (
  assessment: WealthTaxAssessment,
  avoidanceElasticity: number,
): ResponseAdjustedWealthTaxAssessment => {
  const complianceFactor = Math.max(
    0,
    1 - avoidanceElasticity * assessment.marginalRate * 100,
  );
  const taxAssessed = assessment.annualTax * complianceFactor;
  return {
    complianceFactor,
    avoidedTax: assessment.annualTax - taxAssessed,
    taxAssessed,
  };
};

const sumRules = <Key extends string, Rule>(
  values: Readonly<Partial<Record<Key, number>>>,
  rules: Readonly<Record<Key, Rule>>,
  apply: (value: number, rule: Rule) => number,
): number =>
  (Object.keys(values) as Key[]).reduce((total, key) => {
    const value = values[key];
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      throw new Error(`Tax position value for ${key} must be finite and nonnegative.`);
    }
    return total + apply(value, rules[key]);
  }, 0);
