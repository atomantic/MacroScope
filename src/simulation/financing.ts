import type { TaxLoanStructure } from "./contracts.js";

export interface FinancingWeights {
  readonly cash: number;
  readonly borrow: number;
  readonly sell: number;
}

export interface HouseholdFinancingInput {
  readonly annualIncome: number;
  readonly taxDue: number;
  readonly deposits: number;
  readonly publicEquity: number;
  readonly housing: number;
  readonly privateBusiness: number;
  readonly totalAssets: number;
  readonly securedLiabilities: number;
  readonly maximumCollateralLtv: number;
  readonly expectedAssetReturn: number;
  readonly loanInterestRate: number;
  readonly borrowShifter: number;
  readonly sellShifter: number;
}

/** Household-specific preferences; capacity fall-through remains in settlement. */
export const chooseHouseholdFinancingWeights = (
  input: HouseholdFinancingInput,
): FinancingWeights => {
  const assets = Math.max(1, input.totalAssets);
  const collateral = Math.max(0, input.publicEquity + input.housing);
  const liquidShare = clamp(input.deposits / assets);
  const marketableShare = clamp(input.publicEquity / assets);
  const illiquidShare = clamp(input.privateBusiness / assets);
  const currentLtv = input.securedLiabilities / Math.max(1, collateral);
  const ltvHeadroom = clamp(
    (input.maximumCollateralLtv - currentLtv) /
      Math.max(0.05, input.maximumCollateralLtv),
  );
  const returnSpread = input.expectedAssetReturn - input.loanInterestRate;
  const incomeCoverage = clamp(
    input.annualIncome / Math.max(1, input.taxDue * 5),
  );
  const cashScore =
    Math.max(0, 1 - input.borrowShifter - input.sellShifter) *
    (0.25 + liquidShare * 1.5 + incomeCoverage * 0.35);
  const borrowScore =
    clamp(input.borrowShifter) *
    (0.15 + marketableShare + incomeCoverage * 0.5) *
    ltvHeadroom *
    (returnSpread > 0 ? 1.25 : 0.65);
  const sellScore =
    clamp(input.sellShifter) *
    (0.2 + marketableShare * 0.9 + (1 - ltvHeadroom) * 0.6) *
    (returnSpread > 0 ? 0.75 : 1.25) *
    (1 - illiquidShare * 0.5);
  const fallbackCash = 0.05 + liquidShare * 0.2;
  const total = cashScore + borrowScore + sellScore + fallbackCash;
  return {
    cash: (cashScore + fallbackCash) / total,
    borrow: borrowScore / total,
    sell: sellScore / total,
  };
};

export const preferredHouseholdFinancingPath = (
  input: HouseholdFinancingInput,
): keyof FinancingWeights => {
  const weights = chooseHouseholdFinancingWeights(input);
  const collateral = Math.max(1, input.publicEquity + input.housing);
  const currentLtv = input.securedLiabilities / collateral;
  const liquidTaxCoverage = input.deposits / Math.max(1, input.taxDue);
  const marketableTaxCoverage = input.publicEquity / Math.max(1, input.taxDue);
  if (
    input.borrowShifter < 0.9 &&
    liquidTaxCoverage >= 6 - input.borrowShifter * 2
  ) {
    return "cash";
  }
  if (
    input.sellShifter > 0 &&
    (currentLtv >= input.maximumCollateralLtv * 0.4 ||
      (input.publicEquity / Math.max(1, input.totalAssets) > 0.45 &&
        liquidTaxCoverage < 3) ||
      (input.privateBusiness / Math.max(1, input.totalAssets) > 0.15 &&
        liquidTaxCoverage < 5.5))
  ) {
    return "sell";
  }
  if (
    currentLtv < input.maximumCollateralLtv * 0.75 &&
    input.expectedAssetReturn > input.loanInterestRate &&
    weights.borrow >= 0.25
  ) {
    return "borrow";
  }
  return marketableTaxCoverage >= 1 || weights.sell >= weights.cash
    ? "sell"
    : "cash";
};

const clamp = (value: number): number =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export const scheduledPrincipalForLoanStructure = (
  balance: number,
  structure: TaxLoanStructure,
  amortizationRate: number,
): number =>
  structure === "amortizing"
    ? Math.max(0, balance) * clamp(amortizationRate)
    : 0;

export const annualDebtServiceCashCapacity = (
  annualIncome: number,
  publicEquity: number,
): number => Math.max(0, annualIncome) * 0.12 + Math.max(0, publicEquity) * 0.015;
