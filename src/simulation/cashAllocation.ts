export interface RecipientCashAllocationAssumptions {
  /** Share of cash left after consumption targeted to existing household debt. */
  readonly debtRepaymentShare: number;
  /** Share of cash left after consumption and debt service targeted to assets. */
  readonly assetPurchaseShare: number;
  /** Share of recipient asset cash used as a housing down payment. */
  readonly housingShare: number;
  /** Share of recipient asset cash placed in bonds or retirement accounts. */
  readonly retirementAndBondShare: number;
  /** Share of recipient asset cash placed in speculative assets such as crypto. */
  readonly speculativeShare: number;
  /** Cash down payment as a share of the modeled housing purchase price. */
  readonly housingDownPaymentShare: number;
}

export interface RecipientCashAllocationBehavior {
  readonly recipientDebtRepaymentShare: number;
  readonly recipientAssetPurchaseShare: number;
  readonly recipientHousingShare: number;
  readonly recipientRetirementAndBondShare: number;
  readonly recipientSpeculativeShare: number;
  readonly recipientHousingDownPaymentShare: number;
}

export const recipientCashAllocationAssumptions = (
  behavior: RecipientCashAllocationBehavior,
): RecipientCashAllocationAssumptions => ({
  debtRepaymentShare: behavior.recipientDebtRepaymentShare,
  assetPurchaseShare: behavior.recipientAssetPurchaseShare,
  housingShare: behavior.recipientHousingShare,
  retirementAndBondShare: behavior.recipientRetirementAndBondShare,
  speculativeShare: behavior.recipientSpeculativeShare,
  housingDownPaymentShare: behavior.recipientHousingDownPaymentShare,
});

export interface RecipientCashAllocationInput {
  readonly cashDelivered: number;
  readonly marginalPropensityToConsume: number;
  readonly percentile: number;
  readonly annualIncome: number;
  readonly deposits: number;
  readonly debtCapacity: number;
  readonly assumptions: RecipientCashAllocationAssumptions;
}

/**
 * Uses of a delivered household cash transfer. `housingPurchaseDemand` is a
 * credit-capacity indicator, not another use of cash, so it is deliberately
 * excluded from `cashReconciliationResidual`.
 */
export interface RecipientCashAllocation {
  readonly cashDelivered: number;
  readonly consumption: number;
  readonly debtRepayment: number;
  readonly depositSaving: number;
  readonly housingDownPayment: number;
  readonly housingPurchaseDemand: number;
  readonly publicEquityPurchases: number;
  readonly retirementAndBondPurchases: number;
  readonly speculativeAssetPurchases: number;
  readonly assetPurchaseCash: number;
  readonly cashReconciliationResidual: number;
}

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

// Preserve the two boundary cases exactly while allowing the middle of the
// range to vary by cohort. This keeps 0% and 100% controls literal and makes
// the exposed assumptions straightforward to test.
const cohortAdjustedShare = (base: number, multiplier: number): number => {
  const bounded = clamp(base);
  if (bounded === 0 || bounded === 1) return bounded;
  return clamp(bounded * multiplier);
};

export const allocateRecipientCash = (
  input: RecipientCashAllocationInput,
): RecipientCashAllocation => {
  const cashDelivered = Math.max(0, input.cashDelivered);
  const consumption = cashDelivered * clamp(input.marginalPropensityToConsume);
  const afterConsumption = cashDelivered - consumption;
  const income = Math.max(1, input.annualIncome);
  const deposits = Math.max(0, input.deposits);
  const debtCapacity = Math.max(0, input.debtCapacity);

  // A half-year of income in deposits is treated as fully liquid for this
  // reduced-form transition. Lower liquidity and a larger debt burden tilt the
  // same base assumption toward debt service; they never override the user's
  // literal 0% or 100% boundary choice.
  const liquidityRatio = clamp(deposits / (income * 0.5));
  const liquidityConstraint = 1 - liquidityRatio;
  const debtBurden = clamp(debtCapacity / income);
  const effectiveDebtShare = cohortAdjustedShare(
    input.assumptions.debtRepaymentShare,
    0.65 + liquidityConstraint * 0.55 + debtBurden * 0.35,
  );
  const debtRepayment = Math.min(
    debtCapacity,
    afterConsumption * effectiveDebtShare,
  );
  const afterDebt = afterConsumption - debtRepayment;

  // Existing liquidity and wealth-market access rise with percentile. The
  // adjustment affects only interior settings: 100% asset allocation still
  // means every eligible dollar seeks an asset, while 0% means none does.
  const marketAccess = clamp(0.25 + input.percentile * 0.75);
  const effectiveAssetShare = cohortAdjustedShare(
    input.assumptions.assetPurchaseShare,
    (0.55 + liquidityRatio * 0.45) * (0.55 + marketAccess * 0.65),
  );
  const assetPurchaseCash = afterDebt * effectiveAssetShare;
  const depositSaving = afterDebt - assetPurchaseCash;

  const housingShare = clamp(input.assumptions.housingShare);
  const retirementAndBondShare = clamp(input.assumptions.retirementAndBondShare);
  const speculativeShare = clamp(input.assumptions.speculativeShare);
  const namedShareTotal =
    housingShare + retirementAndBondShare + speculativeShare;
  const namedShareScale = namedShareTotal > 1 ? 1 / namedShareTotal : 1;
  const normalizedHousingShare = housingShare * namedShareScale;
  const normalizedRetirementAndBondShare =
    retirementAndBondShare * namedShareScale;
  const normalizedSpeculativeShare = speculativeShare * namedShareScale;
  const publicEquityShare = Math.max(
    0,
    1 -
      normalizedHousingShare -
      normalizedRetirementAndBondShare -
      normalizedSpeculativeShare,
  );
  const housingDownPayment = assetPurchaseCash * normalizedHousingShare;
  const publicEquityPurchases = assetPurchaseCash * publicEquityShare;
  const retirementAndBondPurchases =
    assetPurchaseCash * normalizedRetirementAndBondShare;
  const speculativeAssetPurchases =
    assetPurchaseCash * normalizedSpeculativeShare;
  const housingPurchaseDemand =
    housingDownPayment /
    Math.max(0.03, clamp(input.assumptions.housingDownPaymentShare));
  const cashUses =
    consumption +
    debtRepayment +
    depositSaving +
    housingDownPayment +
    publicEquityPurchases +
    retirementAndBondPurchases +
    speculativeAssetPurchases;

  return {
    cashDelivered,
    consumption,
    debtRepayment,
    depositSaving,
    housingDownPayment,
    housingPurchaseDemand,
    publicEquityPurchases,
    retirementAndBondPurchases,
    speculativeAssetPurchases,
    assetPurchaseCash,
    cashReconciliationResidual: cashDelivered - cashUses,
  };
};

export const emptyRecipientCashAllocation = (): RecipientCashAllocation => ({
  cashDelivered: 0,
  consumption: 0,
  debtRepayment: 0,
  depositSaving: 0,
  housingDownPayment: 0,
  housingPurchaseDemand: 0,
  publicEquityPurchases: 0,
  retirementAndBondPurchases: 0,
  speculativeAssetPurchases: 0,
  assetPurchaseCash: 0,
  cashReconciliationResidual: 0,
});

export const addRecipientCashAllocation = (
  total: RecipientCashAllocation,
  allocation: RecipientCashAllocation,
  weight = 1,
): RecipientCashAllocation => ({
  cashDelivered: total.cashDelivered + allocation.cashDelivered * weight,
  consumption: total.consumption + allocation.consumption * weight,
  debtRepayment: total.debtRepayment + allocation.debtRepayment * weight,
  depositSaving: total.depositSaving + allocation.depositSaving * weight,
  housingDownPayment:
    total.housingDownPayment + allocation.housingDownPayment * weight,
  housingPurchaseDemand:
    total.housingPurchaseDemand + allocation.housingPurchaseDemand * weight,
  publicEquityPurchases:
    total.publicEquityPurchases + allocation.publicEquityPurchases * weight,
  retirementAndBondPurchases:
    total.retirementAndBondPurchases +
    allocation.retirementAndBondPurchases * weight,
  speculativeAssetPurchases:
    total.speculativeAssetPurchases +
    allocation.speculativeAssetPurchases * weight,
  assetPurchaseCash:
    total.assetPurchaseCash + allocation.assetPurchaseCash * weight,
  cashReconciliationResidual:
    total.cashReconciliationResidual +
    allocation.cashReconciliationResidual * weight,
});
