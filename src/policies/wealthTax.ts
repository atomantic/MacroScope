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
}

export const calculateProgressiveTax = (
  taxableBase: number,
  brackets: readonly TaxBracket[],
): number => {
  if (!Number.isFinite(taxableBase) || taxableBase < 0) {
    throw new Error("Taxable base must be finite and nonnegative.");
  }
  let tax = 0;
  for (let index = 0; index < brackets.length; index += 1) {
    const bracket = brackets[index];
    if (!bracket) continue;
    const next = brackets[index + 1];
    const upperBound = next?.threshold ?? Infinity;
    const amountInBracket = Math.max(
      0,
      Math.min(taxableBase, upperBound) - bracket.threshold,
    );
    tax += amountInBracket * bracket.rate;
  }
  return tax;
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
  const annualTax = calculateProgressiveTax(taxableBase, policy.brackets);
  return {
    includedAssets,
    deductibleLiabilities,
    exemption: policy.exemption,
    taxableBase,
    annualTax,
    installmentAmount: annualTax / policy.installments,
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
