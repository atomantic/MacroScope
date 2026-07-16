import type {
  AssetClass,
  LiabilityClass,
  WealthTaxPolicyV1,
} from "../policies/schema.js";
import {
  applyWealthTaxpayerResponse,
  assessWealthTax,
} from "../policies/wealthTax.js";
import type {
  ComparisonRequestV1,
  ConsumptionSector,
  FiscalProjectionYear,
  InflationRegime,
  OpenEconomyProjectionYear,
  PaymentStrategy,
  PolicyProjection,
  ServiceEffectiveness,
  ServiceValueRange,
  StrategyOutcome,
  StressCell,
  AnnualAssetMarketDiagnostics,
  WealthGroupOutcome,
} from "./contracts.js";
import { US_BASELINE, type UsWealthGroupBaseline } from "./usBaseline.js";
import { MODEL_CONSTANTS } from "./modelConstants.js";
import { auditOpenEconomyFlows } from "./openEconomy.js";
import {
  createFiscalState,
  initialFiscalStateForRequest,
  normalizedSurplusUse,
  resolveFiscalYear,
  type FiscalState,
} from "./fiscal.js";
import {
  addRecipientCashAllocation,
  allocateRecipientCash,
  emptyRecipientCashAllocation,
  recipientCashAllocationAssumptions,
  type RecipientCashAllocation,
} from "./cashAllocation.js";
import {
  annualAssetClassReturns,
  clearAssetMarket,
} from "./assetMarket.js";
import {
  annualDebtServiceCashCapacity,
  preferredHouseholdFinancingPath,
  scheduledPrincipalForLoanStructure,
} from "./financing.js";

// Load-bearing model assumptions are documented in ./modelConstants.ts; these
// aliases keep the projection math readable. Rationale and sources live there.
const YEARS = MODEL_CONSTANTS.projectionYears;
const REAL_GROWTH = MODEL_CONSTANTS.realWageGrowth;
const MAX_ANNUAL_INFLATION = MODEL_CONSTANTS.maxAnnualInflation;
// Treasury surplus drains cannot destroy the whole money stock, so M2 (and
// everything derived from it) is floored at a share of its baseline.
const M2_FLOOR = US_BASELINE.m2 * MODEL_CONSTANTS.m2FloorShare;
const STRICT_HYPER_MONTHLY_RATE = MODEL_CONSTANTS.strictHyperMonthlyRate;
const STRICT_HYPER_ANNUAL_RATE =
  (1 + STRICT_HYPER_MONTHLY_RATE) ** 12 - 1;
const BASELINE_RENTER_HOUSING_COST_SHARE =
  MODEL_CONSTANTS.baselineRenterHousingCostShare;
const BOTTOM_HALF_RENTER_SHARE = MODEL_CONSTANTS.bottomHalfRenterShare;
// These are resource-equivalent cases, not cash-equivalent welfare claims. The
// higher avoided-cost/value factor for healthcare reflects insurance and care
// access; the services factor covers the mixed childcare, education, housing,
// and social-service delivery bundle currently represented in the model.
const SERVICE_VALUE_FACTORS = {
  zero: { healthcare: 0, services: 0 },
  base: { healthcare: 0.6, services: 0.35 },
  high: { healthcare: 0.85, services: 0.65 },
} as const;

const serviceValueRange = (
  publicServicesSpending: number,
  mode: ServiceEffectiveness,
): ServiceValueRange => {
  const valueFor = (effectiveness: keyof typeof SERVICE_VALUE_FACTORS) => {
    const factors = SERVICE_VALUE_FACTORS[effectiveness];
    return publicServicesSpending * (
      MODEL_CONSTANTS.publicServicesHealthcareShare * factors.healthcare +
      MODEL_CONSTANTS.publicServicesServicesShare * factors.services
    );
  };
  const base = valueFor("base");
  const high = valueFor("high");
  return {
    mode,
    zero: 0,
    base,
    high,
    selected: mode === "unscored" ? null : mode === "zero" ? 0 : mode === "base" ? base : high,
  };
};
// A cohort ends "better off"/"worse off" once its leading real measure clears
// this band around the no-policy path; inside it the result reads as mixed.
const GROUP_OUTCOME_BAND = MODEL_CONSTANTS.groupOutcomeBand;

// Reduced-form growth/investment channel (issue #13). The capital stock is
// tracked as an index relative to the no-policy path. Each year the actual
// investment rate deviates from the replacement rate that just offsets
// depreciation; a deviation of zero pins the index at 1, so REAL_GROWTH stays
// the constant trend and the whole block reduces to prior behavior. Wages and
// output per worker move with capital per worker via the capital share.
const CAPITAL_DEPRECIATION = 0.06; // BEA private fixed-capital depreciation ≈ 5–6%/yr
const CAPITAL_SHARE = 0.33; // capital's share of income; wage/output ∝ (K/L)^share
// Keep wages and the GDP index finite even under an extreme, sustained savings
// drag that would otherwise drive the capital index toward zero.
const CAPITAL_INDEX_FLOOR = 0.05;

type Strategies = Readonly<Record<PaymentStrategy, StrategyOutcome>>;

const allocateProgramOutlay = (
  fiscal: FiscalProjectionYear,
  request: ComparisonRequestV1,
): {
  readonly ubiReceived: number;
  readonly publicServicesSpending: number;
  readonly administrativeCost: number;
} => {
  const administrativeCost =
    fiscal.scheduledProgramOutlay * request.ubi.administrativeShare;
  const postAdministration =
    fiscal.scheduledProgramOutlay - administrativeCost;
  const delivered =
    postAdministration * (1 - MODEL_CONSTANTS.programLeakageRate);
  return {
    ubiReceived: delivered * request.ubi.directCashShare + fiscal.rebate,
    publicServicesSpending:
      delivered * (1 - request.ubi.directCashShare) + fiscal.additionalServices,
    administrativeCost,
  };
};

const aggregateRecipientCashAllocation = (
  assessments: readonly HouseholdProjectionTaxAssessment[],
  request: ComparisonRequestV1,
  scheduledCash: number,
  rebate: number,
  remainingDebtByHousehold: number[],
): RecipientCashAllocation => {
  if (scheduledCash <= 0 && rebate <= 0) return emptyRecipientCashAllocation();
  const requestedBenefit = assessments.reduce(
    (total, household) =>
      total + household.annualRequestedBenefit * household.weight,
    0,
  );
  const representedHouseholds = assessments.reduce(
    (total, household) => total + household.weight,
    0,
  );
  const scheduledCashRatio = scheduledCash / Math.max(1, requestedBenefit);
  const rebatePerHousehold = rebate / Math.max(1, representedHouseholds);
  const assumptions = recipientCashAllocationAssumptions(request.behavior);

  return assessments.reduce((total, household, index) => {
    const debtCapacity = Math.max(
      0,
      remainingDebtByHousehold[index] ??
        household.liabilities.mortgage +
          household.liabilities.collateralizedLoan +
          household.liabilities.consumerDebt,
    );
    const allocation = allocateRecipientCash({
      cashDelivered:
        household.annualRequestedBenefit * scheduledCashRatio +
        rebatePerHousehold,
      marginalPropensityToConsume: household.marginalPropensityToConsume,
      percentile: household.percentile,
      annualIncome: household.annualIncome,
      deposits: household.assets.deposits,
      debtCapacity,
      assumptions,
    });
    remainingDebtByHousehold[index] = Math.max(
      0,
      debtCapacity - allocation.debtRepayment,
    );
    return addRecipientCashAllocation(total, allocation, household.weight);
  }, emptyRecipientCashAllocation());
};

// Household-level tax records are the attribution backbone for the projection.
// They carry the same assessed and actually collected amounts used by the
// strategy engine, so cohort burdens and the top-tier revenue split cannot
// drift away from the authoritative year-one collection total.
export interface HouseholdProjectionTaxAssessment {
  readonly percentile: number;
  readonly weight: number;
  readonly annualIncome: number;
  readonly annualRequestedBenefit: number;
  readonly marginalPropensityToConsume: number;
  readonly taxAssessed: number;
  readonly assets: Readonly<Record<AssetClass, number>>;
  readonly liabilities: Readonly<Record<LiabilityClass, number>>;
  readonly funding: Readonly<Record<PaymentStrategy, HouseholdProjectionFunding>>;
}

export interface HouseholdProjectionFunding {
  readonly cash: number;
  readonly borrowed: number;
  readonly equitySold: number;
  readonly housingSold: number;
  readonly deferred: number;
}

export interface PolicyProjectionTaxInputs {
  readonly effectiveTaxRate: number;
  readonly policy: WealthTaxPolicyV1;
  readonly householdAssessments: readonly HouseholdProjectionTaxAssessment[];
  readonly demandProfiles: Readonly<Record<PaymentStrategy, ProjectionDemandProfile>>;
}

export interface ProjectionDemandProfile {
  readonly baselineAnnualConsumption: number;
  readonly taxCashDemandBySector: Readonly<Record<ConsumptionSector, number>>;
  readonly scheduledCashDemandPerDollar: Readonly<
    Record<ConsumptionSector, number>
  >;
  readonly rebateDemandPerDollar: Readonly<Record<ConsumptionSector, number>>;
}

const CONSUMPTION_SECTORS: readonly ConsumptionSector[] = [
  "housing",
  "food",
  "healthcare",
  "transportation",
  "energy",
  "durable-goods",
  "discretionary",
  "services",
];

const demandInflationForAllocation = (
  profiles: PolicyProjectionTaxInputs["demandProfiles"],
  weights: ReturnType<typeof strategyWeights>,
  input: {
    readonly taxBaseMultiplier: number;
    readonly scheduledCash: number;
    readonly rebate: number;
    readonly publicServices: number;
    readonly monetaryPolicyOffsetShare: number;
  },
): number => {
  const forStrategy = (strategy: PaymentStrategy): number => {
    const profile = profiles[strategy];
    const denominator = Math.max(1, profile.baselineAnnualConsumption);
    let demandPressure = 0;
    let supplyConstraintPressure = 0;
    for (const sector of CONSUMPTION_SECTORS) {
      const publicServiceDemand =
        sector === "healthcare"
          ? input.publicServices * MODEL_CONSTANTS.publicServicesHealthcareShare
          : sector === "services"
            ? input.publicServices * MODEL_CONSTANTS.publicServicesServicesShare
            : 0;
      const demandChange =
        profile.taxCashDemandBySector[sector] * input.taxBaseMultiplier +
        profile.scheduledCashDemandPerDollar[sector] * input.scheduledCash +
        profile.rebateDemandPerDollar[sector] * input.rebate +
        publicServiceDemand;
      const pressure =
        (demandChange * MODEL_CONSTANTS.supplySensitivity[sector]) / denominator;
      demandPressure += pressure;
      supplyConstraintPressure +=
        Math.max(0, pressure) * MODEL_CONSTANTS.supplyConstraintShare;
    }
    return (
      (demandPressure + supplyConstraintPressure) *
      (1 - input.monetaryPolicyOffsetShare)
    );
  };

  return (
    forStrategy("cash-first") * weights.cash +
    forStrategy("borrow-first") * weights.borrow +
    forStrategy("sell-first") * weights.sell
  );
};

export const applyTreasuryMoneyFlow = (input: {
  readonly m2: number;
  readonly nonTreasuryMoneyChange: number;
  readonly treasuryBalanceChange: number;
  readonly drainedTreasuryBalance: number;
}): { readonly moneyChange: number; readonly drainedTreasuryBalance: number } => {
  // Fiscal Treasury balances and monetary drains are different stocks once the
  // M2 floor binds. Remember only the cash that actually left M2, so a later
  // fiscal draw cannot recreate deposits that the floor previously preserved.
  let drainedTreasuryBalance = input.drainedTreasuryBalance;
  let effectiveTreasuryChange = 0;
  if (input.treasuryBalanceChange >= 0) {
    const desiredMoneyChange =
      input.nonTreasuryMoneyChange - input.treasuryBalanceChange;
    const moneyChange = Math.max(desiredMoneyChange, M2_FLOOR - input.m2);
    const appliedDrain = Math.min(
      input.treasuryBalanceChange,
      Math.max(0, input.nonTreasuryMoneyChange - moneyChange),
    );
    drainedTreasuryBalance += appliedDrain;
    effectiveTreasuryChange = appliedDrain;
  } else {
    const released = Math.min(
      -input.treasuryBalanceChange,
      drainedTreasuryBalance,
    );
    drainedTreasuryBalance -= released;
    effectiveTreasuryChange = -released;
  }
  return {
    moneyChange: Math.max(
      input.nonTreasuryMoneyChange - effectiveTreasuryChange,
      M2_FLOOR - input.m2,
    ),
    drainedTreasuryBalance,
  };
};

// Wealth groups whose collected revenue counts as "top tier" for the
// expatriation dial (issue #6/#17): the top 1% and above.
const TOP_TIER_GROUP_IDS = new Set<string>(
  US_BASELINE.wealthGroups
    .filter((group) => group.percentileMinimum >= MODEL_CONSTANTS.topOnePercentPercentile)
    .map((group) => group.id),
);

// The taxed base is tracked as two sub-bases relative to year one (each starts
// at 1): the top-tier portion, which expatriation can drain, and the retained
// non-top-tier remainder, which it cannot. See evolveTaxBase.
type TaxBaseState = { readonly top: number; readonly rest: number };

type AnnualHouseholdTaxState = {
  readonly source: HouseholdProjectionTaxAssessment;
  assets: Record<AssetClass, number>;
  liabilities: Record<LiabilityClass, number>;
  taxLoanBalance: number;
  deferredTax: number;
};

type AnnualHouseholdTaxResult = {
  readonly taxCollected: number;
  readonly taxpayerHouseholds: number;
  readonly effectiveTaxRate: number;
  readonly groupTaxCollected: ReadonlyMap<string, number>;
  readonly groupTaxShare: ReadonlyMap<string, number>;
  readonly topTierShare: number;
  readonly newPrivateLoans: number;
  readonly principalRepayments: number;
  readonly interestPaid: number;
  readonly defaults: number;
  readonly collateralSeized: number;
  readonly privateBankLosses: number;
  readonly governmentGuarantees: number;
  readonly centralBankFacilities: number;
  readonly privateTaxDebt: number;
  readonly deferredTax: number;
  readonly equitySold: number;
  readonly housingSold: number;
  readonly cashPaid: number;
  readonly householdsPayingCash: number;
  readonly householdsBorrowing: number;
  readonly householdsSelling: number;
  readonly saleToCure: number;
};

const createAnnualHouseholdTaxStates = (
  assessments: readonly HouseholdProjectionTaxAssessment[],
): AnnualHouseholdTaxState[] =>
  assessments.map((source) => ({
    source,
    assets: { ...source.assets },
    liabilities: { ...source.liabilities },
    taxLoanBalance: 0,
    deferredTax: 0,
  }));

const applyRecipientNonMarketAllocation = (
  states: readonly AnnualHouseholdTaxState[],
  allocation: RecipientCashAllocation,
  debtBefore: readonly number[],
  debtAfter: readonly number[],
): void => {
  const scoreTotal = states.reduce(
    (sum, state) =>
      sum + state.source.annualRequestedBenefit * state.source.weight,
    0,
  );
  const representedWeight = states.reduce(
    (sum, state) => sum + state.source.weight,
    0,
  );
  for (const [index, state] of states.entries()) {
    const share =
      scoreTotal > 0
        ? state.source.annualRequestedBenefit / scoreTotal
        : 1 / Math.max(1, representedWeight);
    state.assets.deposits += allocation.depositSaving * share;
    state.assets.retirementAssets +=
      allocation.retirementAndBondPurchases * share;
    state.assets.otherAssets += allocation.speculativeAssetPurchases * share;
    let debtRepaid = Math.max(
      0,
      (debtBefore[index] ?? 0) - (debtAfter[index] ?? 0),
    );
    for (const liability of [
      "consumerDebt",
      "collateralizedLoan",
      "mortgage",
    ] as const) {
      const reduction = Math.min(debtRepaid, state.liabilities[liability]);
      state.liabilities[liability] -= reduction;
      debtRepaid -= reduction;
    }
  }
};

const weightedFunding = (
  funding: Readonly<Record<PaymentStrategy, HouseholdProjectionFunding>>,
  weights: ReturnType<typeof strategyWeights>,
): HouseholdProjectionFunding => ({
  cash: funding["cash-first"].cash * weights.cash +
    funding["borrow-first"].cash * weights.borrow +
    funding["sell-first"].cash * weights.sell,
  borrowed: funding["cash-first"].borrowed * weights.cash +
    funding["borrow-first"].borrowed * weights.borrow +
    funding["sell-first"].borrowed * weights.sell,
  equitySold: funding["cash-first"].equitySold * weights.cash +
    funding["borrow-first"].equitySold * weights.borrow +
    funding["sell-first"].equitySold * weights.sell,
  housingSold: funding["cash-first"].housingSold * weights.cash +
    funding["borrow-first"].housingSold * weights.borrow +
    funding["sell-first"].housingSold * weights.sell,
  deferred: funding["cash-first"].deferred * weights.cash +
    funding["borrow-first"].deferred * weights.borrow +
    funding["sell-first"].deferred * weights.sell,
});

const cashBuffer = (state: AnnualHouseholdTaxState): number =>
  Math.max(
    MODEL_CONSTANTS.householdCashBufferFloor,
    state.source.annualIncome * MODEL_CONSTANTS.householdCashBufferIncomeShare,
  );

const householdFinancingWeights = (
  state: AnnualHouseholdTaxState,
  taxDue: number,
  request: ComparisonRequestV1,
): ReturnType<typeof strategyWeights> => {
  const preferred = preferredHouseholdFinancingPath({
    annualIncome: state.source.annualIncome,
    taxDue,
    deposits: state.assets.deposits,
    publicEquity: state.assets.publicEquity,
    housing: state.assets.housing,
    privateBusiness: state.assets.privateBusiness,
    totalAssets: Object.values(state.assets).reduce((sum, value) => sum + value, 0),
    securedLiabilities:
      state.liabilities.mortgage +
      state.liabilities.collateralizedLoan +
      state.taxLoanBalance,
    maximumCollateralLtv: request.market.maximumCollateralLtv,
    expectedAssetReturn: request.behavior.annualAssetReturn,
    loanInterestRate: request.behavior.loanInterestRate,
    borrowShifter: request.behavior.borrowShare,
    sellShifter: request.behavior.sellShare,
  });
  return {
    cash: preferred === "cash" ? 1 : 0,
    borrow: preferred === "borrow" ? 1 : 0,
    sell: preferred === "sell" ? 1 : 0,
  };
};

const availableCash = (state: AnnualHouseholdTaxState): number =>
  Math.max(0, state.assets.deposits - cashBuffer(state));

const debitCash = (state: AnnualHouseholdTaxState, amount: number): number => {
  const paid = Math.min(Math.max(0, amount), availableCash(state));
  state.assets.deposits -= paid;
  return paid;
};

const borrowCapacity = (
  state: AnnualHouseholdTaxState,
  maximumCollateralLtv: number,
): number =>
  Math.max(
    0,
    maximumCollateralLtv * (state.assets.publicEquity + state.assets.housing) -
      state.liabilities.mortgage -
      state.liabilities.collateralizedLoan -
      state.taxLoanBalance,
  );

const sellAssets = (
  state: AnnualHouseholdTaxState,
  amount: number,
): Pick<HouseholdProjectionFunding, "equitySold" | "housingSold"> => {
  const equitySold = Math.min(Math.max(0, amount), state.assets.publicEquity);
  state.assets.publicEquity -= equitySold;
  const housingSold = Math.min(
    Math.max(0, amount - equitySold),
    state.assets.housing,
  );
  state.assets.housing -= housingSold;
  return { equitySold, housingSold };
};

const settleAnnualTax = (
  state: AnnualHouseholdTaxState,
  taxDue: number,
  request: ComparisonRequestV1,
  weights: ReturnType<typeof strategyWeights>,
  maximumNewBorrowing: number,
): HouseholdProjectionFunding => {
  let remaining = Math.max(0, taxDue);
  let cash = 0;
  let borrowed = 0;
  let equitySold = 0;
  let housingSold = 0;
  const payCash = (target: number): void => {
    const paid = debitCash(state, Math.min(remaining, target));
    cash += paid;
    remaining -= paid;
  };
  const borrow = (target: number): void => {
    if (weights.borrow <= 0) return;
    const amount = Math.min(
      remaining,
      target,
      maximumNewBorrowing - borrowed,
      borrowCapacity(state, request.market.maximumCollateralLtv),
    );
    state.taxLoanBalance += amount;
    borrowed += amount;
    remaining -= amount;
  };
  const sell = (target: number): void => {
    const proceeds = sellAssets(state, Math.min(remaining, target));
    equitySold += proceeds.equitySold;
    housingSold += proceeds.housingSold;
    remaining -= proceeds.equitySold + proceeds.housingSold;
  };

  // The behavior dials allocate the preferred first attempt, but each source is
  // re-underwritten against the balance sheet that remains after earlier choices.
  // Any unmet amount falls through to the remaining legal funding sources rather
  // than creating an unconstrained proportional loan every year.
  payCash(taxDue * weights.cash);
  borrow(taxDue * weights.borrow);
  sell(taxDue * weights.sell);
  payCash(remaining);
  borrow(remaining);
  sell(remaining);
  return { cash, borrowed, equitySold, housingSold, deferred: remaining };
};

const seizeTaxLoanCollateral = (
  state: AnnualHouseholdTaxState,
  amount: number,
): number => {
  // Mortgages are senior to the modeled tax-payment lien. The remainder is
  // collateral the bank can take in kind; this reclassifies a real asset, not
  // a deposit, so it does not manufacture M2.
  let remaining = Math.min(
    Math.max(0, amount),
    Math.max(0, state.assets.publicEquity + state.assets.housing - state.liabilities.mortgage),
  );
  const equity = Math.min(remaining, state.assets.publicEquity);
  state.assets.publicEquity -= equity;
  remaining -= equity;
  const housing = Math.min(remaining, state.assets.housing);
  state.assets.housing -= housing;
  return equity + housing;
};

type TaxLoanServiceResult = {
  readonly principalRepaid: number;
  readonly interestPaid: number;
  readonly defaults: number;
  readonly collateralSeized: number;
  readonly privateBankLosses: number;
  readonly governmentGuarantees: number;
  readonly centralBankFacilities: number;
  readonly cureEquitySold: number;
  readonly cureHousingSold: number;
};

const serviceTaxLoan = (
  state: AnnualHouseholdTaxState,
  request: ComparisonRequestV1,
): TaxLoanServiceResult => {
  if (state.taxLoanBalance <= 0) {
    return {
      principalRepaid: 0,
      interestPaid: 0,
      defaults: 0,
      collateralSeized: 0,
      privateBankLosses: 0,
      governmentGuarantees: 0,
      centralBankFacilities: 0,
      cureEquitySold: 0,
      cureHousingSold: 0,
    };
  }
  let annualCashFlowCapacity = annualDebtServiceCashCapacity(
    state.source.annualIncome,
    state.assets.publicEquity,
  );
  const payDebtService = (amount: number): number => {
    const fromDeposits = debitCash(state, amount);
    const fromCurrentIncome = Math.min(
      Math.max(0, amount - fromDeposits),
      annualCashFlowCapacity,
    );
    annualCashFlowCapacity -= fromCurrentIncome;
    return fromDeposits + fromCurrentIncome;
  };
  const interestDue = state.taxLoanBalance * request.behavior.loanInterestRate;
  let interestPaid = payDebtService(interestDue);
  let unpaidInterest = interestDue - interestPaid;
  if (request.behavior.taxLoanStructure === "demand-rollover") {
    const rolloverCapacity = borrowCapacity(
      state,
      request.market.maximumCollateralLtv,
    );
    const rolled = Math.min(unpaidInterest, rolloverCapacity);
    state.taxLoanBalance += rolled;
    unpaidInterest -= rolled;
  }
  const scheduledPrincipal = scheduledPrincipalForLoanStructure(
    state.taxLoanBalance,
    request.behavior.taxLoanStructure,
    request.model.loanAmortizationRate,
  );
  let principalRepaid = payDebtService(scheduledPrincipal);
  state.taxLoanBalance -= principalRepaid;
  let missedPrincipal = Math.max(0, scheduledPrincipal - principalRepaid);
  const collateral = state.assets.publicEquity + state.assets.housing;
  const collateralExcess = Math.max(
    0,
    state.taxLoanBalance +
      state.liabilities.mortgage +
      state.liabilities.collateralizedLoan -
      request.market.maximumCollateralLtv * collateral,
  );
  const ltvCure =
    collateralExcess /
    Math.max(0.01, 1 - request.market.maximumCollateralLtv);
  const cureTarget = unpaidInterest + missedPrincipal + ltvCure;
  const cure = sellAssets(state, cureTarget);
  let cureCash = cure.equitySold + cure.housingSold;
  const interestCured = Math.min(unpaidInterest, cureCash);
  interestPaid += interestCured;
  unpaidInterest -= interestCured;
  cureCash -= interestCured;
  const principalCured = Math.min(
    state.taxLoanBalance,
    Math.max(missedPrincipal, ltvCure),
    cureCash,
  );
  principalRepaid += principalCured;
  state.taxLoanBalance -= principalCured;
  missedPrincipal = Math.max(0, missedPrincipal - principalCured);
  const remainsAboveLtv =
    state.taxLoanBalance +
      state.liabilities.mortgage +
      state.liabilities.collateralizedLoan >
    request.market.maximumCollateralLtv *
      (state.assets.publicEquity + state.assets.housing) +
      0.01;
  const missedDebtService =
    unpaidInterest > 0.01 || missedPrincipal > 0.01 || remainsAboveLtv;
  if (!missedDebtService) {
    return {
      principalRepaid,
      interestPaid,
      defaults: 0,
      collateralSeized: 0,
      privateBankLosses: 0,
      governmentGuarantees: 0,
      centralBankFacilities: 0,
      cureEquitySold: cure.equitySold,
      cureHousingSold: cure.housingSold,
    };
  }
  const defaulted = state.taxLoanBalance;
  const collateralSeized = seizeTaxLoanCollateral(state, defaulted);
  const residualLoss = Math.max(0, defaulted - collateralSeized);
  state.taxLoanBalance = 0;
  return {
    principalRepaid,
    interestPaid,
    defaults: defaulted,
    collateralSeized,
    privateBankLosses:
      request.behavior.taxLoanResolution === "private-bank-loss" ? residualLoss : 0,
    governmentGuarantees:
      request.behavior.taxLoanResolution === "government-guarantee" ? residualLoss : 0,
    centralBankFacilities:
      request.behavior.taxLoanResolution === "central-bank-facility" ? residualLoss : 0,
    cureEquitySold: cure.equitySold,
    cureHousingSold: cure.housingSold,
  };
};

// Year one preserves the strategy engine's observed funding. Later years
// re-underwrite each household: outstanding tax loans are serviced first, new
// borrowing is capped by current collateral, and any unpayable balance remains
// explicit deferred tax instead of becoming another unconstrained loan.
const assessAnnualHouseholdTaxes = (
  states: readonly AnnualHouseholdTaxState[],
  policy: WealthTaxPolicyV1,
  avoidanceElasticity: number,
  request: ComparisonRequestV1,
  isYearOne: boolean,
  bankLoanHeadroom: number,
): AnnualHouseholdTaxResult => {
  const groupTaxCollected = new Map<string, number>(
    US_BASELINE.wealthGroups.map((group) => [group.id, 0]),
  );
  let taxCollected = 0;
  let taxableBase = 0;
  let taxpayerHouseholds = 0;
  let newPrivateLoans = 0;
  let principalRepayments = 0;
  let interestPaid = 0;
  let defaults = 0;
  let collateralSeized = 0;
  let privateBankLosses = 0;
  let governmentGuarantees = 0;
  let centralBankFacilities = 0;
  let privateTaxDebt = 0;
  let deferredTax = 0;
  let equitySold = 0;
  let housingSold = 0;
  let cashPaid = 0;
  let householdsPayingCash = 0;
  let householdsBorrowing = 0;
  let householdsSelling = 0;
  let saleToCure = 0;

  for (const state of states) {
    const servicing = isYearOne
      ? {
          principalRepaid: 0,
          interestPaid: 0,
          defaults: 0,
          collateralSeized: 0,
          privateBankLosses: 0,
          governmentGuarantees: 0,
          centralBankFacilities: 0,
          cureEquitySold: 0,
          cureHousingSold: 0,
        }
      : serviceTaxLoan(state, request);
    const assessment = assessWealthTax(
      {
        assets: state.assets,
        liabilities: {
          ...state.liabilities,
          collateralizedLoan:
            state.liabilities.collateralizedLoan + state.taxLoanBalance,
        },
      },
      policy,
    );
    const response = applyWealthTaxpayerResponse(assessment, avoidanceElasticity);
    const householdWeights = householdFinancingWeights(
      state,
      response.taxAssessed + state.deferredTax,
      request,
    );
    const funding = isYearOne
      ? weightedFunding(state.source.funding, householdWeights)
      : settleAnnualTax(
          state,
          response.taxAssessed + state.deferredTax,
          request,
          householdWeights,
          Math.max(0, bankLoanHeadroom / Math.max(1, state.source.weight)),
        );
    if (isYearOne) {
      state.assets.deposits = Math.max(0, state.assets.deposits - funding.cash);
      state.assets.publicEquity = Math.max(0, state.assets.publicEquity - funding.equitySold);
      state.assets.housing = Math.max(0, state.assets.housing - funding.housingSold);
      state.taxLoanBalance += funding.borrowed;
    }
    state.deferredTax = funding.deferred;
    const blendedCollection =
      funding.cash + funding.borrowed + funding.equitySold + funding.housingSold;
    const weightedCollection = blendedCollection * state.source.weight;
    taxCollected += weightedCollection;
    taxableBase += assessment.taxableBase * state.source.weight;
    if (response.taxAssessed > 0) taxpayerHouseholds += state.source.weight;
    newPrivateLoans += funding.borrowed * state.source.weight;
    bankLoanHeadroom = Math.max(0, bankLoanHeadroom - funding.borrowed * state.source.weight);
    principalRepayments += servicing.principalRepaid * state.source.weight;
    interestPaid += servicing.interestPaid * state.source.weight;
    defaults += servicing.defaults * state.source.weight;
    collateralSeized += servicing.collateralSeized * state.source.weight;
    privateBankLosses += servicing.privateBankLosses * state.source.weight;
    governmentGuarantees += servicing.governmentGuarantees * state.source.weight;
    centralBankFacilities += servicing.centralBankFacilities * state.source.weight;
    privateTaxDebt += state.taxLoanBalance * state.source.weight;
    deferredTax += state.deferredTax * state.source.weight;
    equitySold +=
      (funding.equitySold + servicing.cureEquitySold) * state.source.weight;
    housingSold +=
      (funding.housingSold + servicing.cureHousingSold) * state.source.weight;
    saleToCure +=
      (servicing.cureEquitySold + servicing.cureHousingSold) *
      state.source.weight;
    cashPaid += funding.cash * state.source.weight;
    if (funding.cash > 0) householdsPayingCash += state.source.weight;
    if (funding.borrowed > 0) householdsBorrowing += state.source.weight;
    if (
      funding.equitySold +
        funding.housingSold +
        servicing.cureEquitySold +
        servicing.cureHousingSold >
      0
    ) {
      householdsSelling += state.source.weight;
    }

    const group = wealthGroupForPercentile(state.source.percentile);
    groupTaxCollected.set(
      group.id,
      (groupTaxCollected.get(group.id) ?? 0) + weightedCollection,
    );
  }

  const groupTaxShare = new Map<string, number>();
  for (const [id, collected] of groupTaxCollected) {
    groupTaxShare.set(id, taxCollected > 0 ? collected / taxCollected : 0);
  }
  const topTierTaxCollected = [...groupTaxCollected]
    .filter(([id]) => TOP_TIER_GROUP_IDS.has(id))
    .reduce((sum, [, collected]) => sum + collected, 0);

  return {
    taxCollected,
    taxpayerHouseholds,
    effectiveTaxRate: taxableBase > 0 ? taxCollected / taxableBase : 0,
    groupTaxCollected,
    groupTaxShare,
    topTierShare: taxCollected > 0 ? topTierTaxCollected / taxCollected : 1,
    newPrivateLoans,
    principalRepayments,
    interestPaid,
    defaults,
    collateralSeized,
    privateBankLosses,
    governmentGuarantees,
    centralBankFacilities,
    privateTaxDebt,
    deferredTax,
    equitySold,
    housingSold,
    cashPaid,
    householdsPayingCash,
    householdsBorrowing,
    householdsSelling,
    saleToCure,
  };
};

const emptyMarketDiagnostics = () => ({
  housing: {
    domesticPurchases: 0,
    foreignPurchases: 0,
    voluntarySales: 0,
    forcedSales: 0,
    newSupply: 0,
    netOrderFlow: 0,
    priceChange: 0,
  },
  publicEquity: {
    domesticPurchases: 0,
    foreignPurchases: 0,
    voluntarySales: 0,
    forcedSales: 0,
    newSupply: 0,
    netOrderFlow: 0,
    priceChange: 0,
  },
  collateralCalls: 0,
  forcedRepayments: 0,
  transactionResidual: 0,
  iterations: 0,
  converged: true,
});

const clearAnnualAssetMarkets = (
  states: readonly AnnualHouseholdTaxState[],
  input: {
    readonly request: ComparisonRequestV1;
    readonly domesticHousingPurchases: number;
    readonly domesticEquityPurchases: number;
    readonly recipientHousingPurchases: number;
    readonly recipientEquityPurchases: number;
    readonly voluntaryHousingSales: number;
    readonly voluntaryEquitySales: number;
    readonly housingMarketValue: number;
    readonly equityMarketValue: number;
    readonly remainingRecipientDebtByHousehold: number[];
  },
): AnnualAssetMarketDiagnostics => {
  const totals = emptyMarketDiagnostics();
  let housingForcedSales = 0;
  let equityForcedSales = 0;
  let totalHousingPriceFactor = 1;
  let totalEquityPriceFactor = 1;
  let collateralCalls = 0;
  let forcedRepayments = 0;
  let converged = false;
  let iterations = 0;

  for (
    let iteration = 0;
    iteration < MODEL_CONSTANTS.annualMarketMaximumIterations;
    iteration += 1
  ) {
    iterations = iteration + 1;
    const firstPass = iteration === 0;
    const currentHousingSales = firstPass
      ? input.voluntaryHousingSales
      : housingForcedSales;
    const currentEquitySales = firstPass
      ? input.voluntaryEquitySales
      : equityForcedSales;
    const foreignHousingPurchases =
      currentHousingSales * input.request.economy.foreignBuyerShare;
    const foreignEquityPurchases =
      currentEquitySales * input.request.economy.foreignBuyerShare;
    const housing = clearAssetMarket({
      domesticPurchases: firstPass ? input.domesticHousingPurchases : 0,
      foreignPurchases: foreignHousingPurchases,
      voluntarySales: firstPass ? currentHousingSales : 0,
      forcedSales: firstPass ? 0 : currentHousingSales,
      marketValue: input.housingMarketValue * totalHousingPriceFactor,
      buyerDepthRatio: input.request.market.buyerDepthRatio,
      priceImpactCoefficient: input.request.market.priceImpactCoefficient,
      supplyElasticity: input.request.market.housingSupplyElasticity,
      maximumAbsolutePriceMove:
        MODEL_CONSTANTS.annualMarketMaximumAbsolutePriceMove,
    });
    const equity = clearAssetMarket({
      domesticPurchases: firstPass ? input.domesticEquityPurchases : 0,
      foreignPurchases: foreignEquityPurchases,
      voluntarySales: firstPass ? currentEquitySales : 0,
      forcedSales: firstPass ? 0 : currentEquitySales,
      marketValue: input.equityMarketValue * totalEquityPriceFactor,
      buyerDepthRatio: input.request.market.buyerDepthRatio,
      priceImpactCoefficient:
        input.request.market.priceImpactCoefficient *
        MODEL_CONSTANTS.equityPriceImpactAmplifier,
      supplyElasticity: MODEL_CONSTANTS.equityIssuanceElasticity,
      maximumAbsolutePriceMove:
        MODEL_CONSTANTS.annualMarketMaximumAbsolutePriceMove,
    });

    totals.housing.domesticPurchases += firstPass
      ? input.domesticHousingPurchases
      : 0;
    totals.housing.foreignPurchases += foreignHousingPurchases;
    totals.housing.voluntarySales += firstPass ? currentHousingSales : 0;
    totals.housing.forcedSales += firstPass ? 0 : currentHousingSales;
    totals.housing.newSupply += housing.newSupply;
    totals.housing.netOrderFlow += housing.netOrderFlow;
    totals.publicEquity.domesticPurchases += firstPass
      ? input.domesticEquityPurchases
      : 0;
    totals.publicEquity.foreignPurchases += foreignEquityPurchases;
    totals.publicEquity.voluntarySales += firstPass ? currentEquitySales : 0;
    totals.publicEquity.forcedSales += firstPass ? 0 : currentEquitySales;
    totals.publicEquity.newSupply += equity.newSupply;
    totals.publicEquity.netOrderFlow += equity.netOrderFlow;

    totalHousingPriceFactor *= 1 + housing.priceChange;
    totalEquityPriceFactor *= 1 + equity.priceChange;
    for (const state of states) {
      state.assets.housing *= 1 + housing.priceChange;
      state.assets.publicEquity *= 1 + equity.priceChange;
    }

    housingForcedSales = 0;
    equityForcedSales = 0;
    for (const state of states) {
      if (state.taxLoanBalance <= 0) continue;
      const collateralCapacity = Math.max(
        0,
        input.request.market.maximumCollateralLtv *
          (state.assets.publicEquity + state.assets.housing) -
          state.liabilities.mortgage -
          state.liabilities.collateralizedLoan,
      );
      let excessLoan = Math.max(0, state.taxLoanBalance - collateralCapacity);
      if (excessLoan <= 0) continue;
      collateralCalls += state.source.weight;
      const equitySale = Math.min(excessLoan, state.assets.publicEquity);
      state.assets.publicEquity -= equitySale;
      excessLoan -= equitySale;
      const housingSale = Math.min(excessLoan, state.assets.housing);
      state.assets.housing -= housingSale;
      const repaid = equitySale + housingSale;
      state.taxLoanBalance = Math.max(0, state.taxLoanBalance - repaid);
      equityForcedSales += equitySale * state.source.weight;
      housingForcedSales += housingSale * state.source.weight;
      forcedRepayments += repaid * state.source.weight;
    }

    if (
      equityForcedSales + housingForcedSales <=
      MODEL_CONSTANTS.annualMarketConvergenceTolerance
    ) {
      converged = true;
      break;
    }
  }

  // If the declared iteration cap binds, the last collateral calls still
  // execute at the last cleared prices. Record those sales and their foreign
  // absorption even though no further price pass is attempted.
  if (!converged && housingForcedSales + equityForcedSales > 0) {
    totals.housing.forcedSales += housingForcedSales;
    totals.publicEquity.forcedSales += equityForcedSales;
    totals.housing.foreignPurchases +=
      housingForcedSales * input.request.economy.foreignBuyerShare;
    totals.publicEquity.foreignPurchases +=
      equityForcedSales * input.request.economy.foreignBuyerShare;
  }

  const totalHousingSales =
    totals.housing.voluntarySales + totals.housing.forcedSales;
  const totalEquitySales =
    totals.publicEquity.voluntarySales + totals.publicEquity.forcedSales;
  const domesticHousingTransfer = Math.max(
    0,
    totalHousingSales - totals.housing.foreignPurchases,
  );
  const domesticEquityTransfer = Math.max(
    0,
    totalEquitySales - totals.publicEquity.foreignPurchases,
  );
  const housingSupplyForDomesticBuyers =
    totals.housing.newSupply *
    (input.domesticHousingPurchases /
      Math.max(
        1,
        totals.housing.domesticPurchases + totals.housing.foreignPurchases,
      ));
  const equitySupplyForDomesticBuyers =
    totals.publicEquity.newSupply *
    (input.domesticEquityPurchases /
      Math.max(
        1,
        totals.publicEquity.domesticPurchases +
          totals.publicEquity.foreignPurchases,
      ));
  const domesticHousingAddition =
    domesticHousingTransfer + housingSupplyForDomesticBuyers;
  const domesticEquityAddition =
    domesticEquityTransfer + equitySupplyForDomesticBuyers;
  const recipientHousingAddition = Math.min(
    input.recipientHousingPurchases,
    domesticHousingAddition,
  );
  const recipientEquityAddition = Math.min(
    input.recipientEquityPurchases,
    domesticEquityAddition,
  );
  let recipientScoreTotal = 0;
  let housingScoreTotal = 0;
  let equityScoreTotal = 0;
  let representedWeight = 0;
  for (const state of states) {
    recipientScoreTotal +=
      state.source.annualRequestedBenefit * state.source.weight;
    housingScoreTotal += state.assets.housing * state.source.weight;
    equityScoreTotal += state.assets.publicEquity * state.source.weight;
    representedWeight += state.source.weight;
  }
  const recipientMortgage =
    recipientHousingAddition *
    (1 - input.request.behavior.recipientHousingDownPaymentShare);
  const remainingHousing = domesticHousingAddition - recipientHousingAddition;
  const remainingEquity = domesticEquityAddition - recipientEquityAddition;
  for (const [index, state] of states.entries()) {
    const recipientShare =
      recipientScoreTotal > 0
        ? state.source.annualRequestedBenefit / recipientScoreTotal
        : 1 / Math.max(1, representedWeight);
    const housingShare =
      housingScoreTotal > 0
        ? state.assets.housing / housingScoreTotal
        : 1 / Math.max(1, representedWeight);
    const equityShare =
      equityScoreTotal > 0
        ? state.assets.publicEquity / equityScoreTotal
        : 1 / Math.max(1, representedWeight);
    state.assets.housing +=
      recipientHousingAddition * recipientShare +
      remainingHousing * housingShare;
    state.assets.publicEquity +=
      recipientEquityAddition * recipientShare +
      remainingEquity * equityShare;
    const mortgageAddition = recipientMortgage * recipientShare;
    state.liabilities.mortgage += mortgageAddition;
    input.remainingRecipientDebtByHousehold[index] =
      (input.remainingRecipientDebtByHousehold[index] ?? 0) + mortgageAddition;
  }

  totals.housing.priceChange = totalHousingPriceFactor - 1;
  totals.publicEquity.priceChange = totalEquityPriceFactor - 1;
  return {
    ...totals,
    collateralCalls,
    forcedRepayments,
    transactionResidual:
      totals.housing.forcedSales +
      totals.publicEquity.forcedSales -
      forcedRepayments,
    iterations,
    converged,
  };
};

const evolveAnnualHouseholdTaxStates = (
  states: readonly AnnualHouseholdTaxState[],
  input: {
    readonly annualAssetReturn: number;
    readonly annualInflation: number;
    readonly baselineInflation: number;
    readonly assetPriceInflationPassThrough: number;
    readonly expatriationRetention: number;
  },
): void => {
  const returns = annualAssetClassReturns(input);
  for (const state of states) {
    const isTopTier = TOP_TIER_GROUP_IDS.has(
      wealthGroupForPercentile(state.source.percentile).id,
    );
    const retention = isTopTier ? input.expatriationRetention : 1;
    for (const asset of Object.keys(state.assets) as AssetClass[]) {
      // Housing/equity already received this year's policy-driven market
      // revaluation inside the clearing loop. These class-specific baseline
      // returns replace the former blanket return across deposits and every
      // real/financial asset.
      state.assets[asset] *= Math.max(0, 1 + returns[asset]) * retention;
    }
  }
};

const taxGroupCollectionRecord = (
  collections: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    US_BASELINE.wealthGroups.map((group) => [group.id, collections.get(group.id) ?? 0]),
  );

// Base-dynamics inputs threaded into the inflation stress grid so its cells and
// the hyperinflation threshold respond to asset returns, rate erosion, and
// expatriation — not only to UBI scale and monetization share (issue #17).
type BaseDynamics = {
  readonly annualAssetReturn: number;
  readonly baselineInflation: number;
  readonly assetPriceInflationPassThrough: number;
  readonly effectiveTaxRate: number;
  readonly expatriationRetention: number;
  readonly topTierShare: number;
};

// Reduced-form wealth-tax base dynamics shared by the main projection loop and
// the inflation stress grid (issue #17). Asset returns plus partial pass-through
// of policy-driven excess inflation grow the base; the effective rate paid out
// of it erodes it. Both act on the whole taxed base. Expatriation drains ONLY
// the top-tier sub-base; the household-derived revenue split determines how
// much remains in the non-top-tier sub-base.
const evolveTaxBase = (
  state: TaxBaseState,
  input: {
    annualAssetReturn: number;
    annualInflation: number;
    baselineInflation: number;
    assetPriceInflationPassThrough: number;
    effectiveTaxRate: number;
    expatriationRetention: number;
  },
): TaxBaseState => {
  const growth =
    1 +
    input.annualAssetReturn +
    Math.max(0, input.annualInflation - input.baselineInflation) *
      input.assetPriceInflationPassThrough;
  const erosion = 1 - input.effectiveTaxRate;
  return {
    top: Math.max(0, state.top * growth * erosion * input.expatriationRetention),
    rest: Math.max(0, state.rest * growth * erosion),
  };
};

// Effective base multiplier: the top-tier sub-base weighted by its share of
// collected revenue plus the retained non-top-tier remainder. A top-tier share
// of 1 returns the top sub-base alone.
const combinedBaseMultiplier = (state: TaxBaseState, topTierShare: number): number =>
  topTierShare * state.top + (1 - topTierShare) * state.rest;

export const buildPolicyProjection = (
  request: ComparisonRequestV1,
  strategies: Strategies,
  taxInputs: PolicyProjectionTaxInputs,
): PolicyProjection => {
  const serviceEffectiveness = request.ubi.serviceEffectiveness ?? "unscored";
  let weights = strategyWeights(request);
  const blended = <T>(select: (outcome: StrategyOutcome) => T): number => {
    const value = select(strategies["cash-first"]);
    if (typeof value !== "number") throw new Error("Projection inputs must be numeric.");
    return (
      value * weights.cash +
      Number(select(strategies["borrow-first"])) * weights.borrow +
      Number(select(strategies["sell-first"])) * weights.sell
    );
  };

  const taxCollected = blended((outcome) => outcome.fiscal.taxCollected);
  let newPrivateLoans = blended(
    (outcome) => outcome.funding.newCollateralizedLoans,
  );
  let assetSales = blended(
    (outcome) => outcome.markets.totalEquitySales + outcome.markets.housingSold,
  );
  const bottom50AnnualUbi = averageBottomHalf(
    strategies,
    weights,
    (decile) => decile.averageUbiReceived,
  );
  const requestedUbi = blended((outcome) => outcome.fiscal.requestedUbi);
  const surplusUse = normalizedSurplusUse(request);
  const initialFiscalState = initialFiscalStateForRequest(request);
  const yearOneFiscal = resolveFiscalYear(
    {
      year: 1,
      taxRevenue: taxCollected,
      requestedProgramOutlay: requestedUbi,
      fundingRule: request.ubi.fundingRule,
      surplusUse,
    },
    initialFiscalState,
  ).year;
  const yearOneAllocation = allocateProgramOutlay(yearOneFiscal, request);
  const { ubiReceived, publicServicesSpending, administrativeCost } =
    yearOneAllocation;
  const yearOneScheduledCash = yearOneAllocation.ubiReceived - yearOneFiscal.rebate;
  const yearOneRebatePerHousehold =
    yearOneFiscal.rebate / Math.max(1, request.representedHouseholds);
  const bottom50ScheduledCash = Math.max(
    0,
    bottom50AnnualUbi - yearOneRebatePerHousehold,
  );
  const governmentDeficit = yearOneFiscal.debtIssued;

  const cumulativeGroupTax = new Map<string, number>(
    US_BASELINE.wealthGroups.map((group) => [group.id, 0]),
  );
  const householdTaxStates = createAnnualHouseholdTaxStates(
    taxInputs.householdAssessments,
  );
  const remainingRecipientDebtByHousehold =
    taxInputs.householdAssessments.map(
      (household) =>
        household.liabilities.mortgage +
        household.liabilities.collateralizedLoan +
        household.liabilities.consumerDebt,
    );
  const initialAnnualTax = assessAnnualHouseholdTaxes(
    householdTaxStates,
    taxInputs.policy,
    request.behavior.avoidanceElasticity,
    request,
    true,
    Number.POSITIVE_INFINITY,
  );
  newPrivateLoans = initialAnnualTax.newPrivateLoans;
  assetSales = initialAnnualTax.equitySold + initialAnnualTax.housingSold;
  weights = {
    cash: initialAnnualTax.cashPaid / Math.max(1, initialAnnualTax.taxCollected),
    borrow:
      initialAnnualTax.newPrivateLoans /
      Math.max(1, initialAnnualTax.taxCollected),
    sell:
      assetSales / Math.max(1, initialAnnualTax.taxCollected),
  };
  const initialCollectionDifference = Math.abs(initialAnnualTax.taxCollected - taxCollected);
  const initialCollectionTolerance = Math.max(
    MODEL_CONSTANTS.absoluteToleranceFloor,
    taxCollected * MODEL_CONSTANTS.convergenceEpsilon,
  );
  if (initialCollectionDifference > initialCollectionTolerance) {
    throw new Error("Annual household tax assessment does not reconcile to year-one collection.");
  }
  const groupTaxShare = initialAnnualTax.groupTaxShare;
  const topTierShare = initialAnnualTax.topTierShare;
  // Expatriation drains a cumulative share of the TOP-TIER taxable base over the
  // decade (issue #6/#17). evolveTaxBase applies this retention to the top-tier
  // sub-base only. The household-derived share can be below 1 even with a
  // positive exemption when that cutoff reaches part of a non-top cohort.
  // Spread geometrically so each year retains an equal fraction and the
  // top-tier base has lost the tax-jurisdiction portion of expatriation by year
  // ten. A residence change and a capital flow are reported separately; neither
  // silently deletes the domestic tax base. Defaults preserve the prior path.
  const expatriationRetention =
    (1 - request.behavior.expatriationShare * request.behavior.expatriationTaxBaseShare) **
    (1 / YEARS);

  // Growth/investment channel state (issue #13). The savings dial turns the
  // wealth tax's drag on the after-tax return to wealth into an investment
  // shortfall; the demand dial pushes the other way with the transfer's fiscal
  // impulse. Both national aggregates come from the represented flows scaled
  // back to national terms with this factor. The drag itself is computed per
  // year inside the loop from that year's collection (it evolves as the base
  // erodes/grows).
  const nationalScale = populationScale(request);
  let capitalIndex = 1;
  let capitalPerWorker = 1; // capitalIndex ** CAPITAL_SHARE; wage/output deviation
  const yearOneM2Injection = Math.max(
    newPrivateLoans +
      governmentDeficit * request.behavior.deficitMonetizationShare -
      yearOneFiscal.treasuryBalance,
    M2_FLOOR - US_BASELINE.m2,
  );
  let finalYearFlows = {
    taxCollected,
    ubiReceived,
    rebate: yearOneFiscal.rebate,
    publicServicesSpending,
    serviceValue: serviceValueRange(publicServicesSpending, serviceEffectiveness),
    administrativeCost,
    newPrivateLoans,
    governmentDeficit,
    m2Injection: yearOneM2Injection,
  };

  let m2 = US_BASELINE.m2;
  let priceLevel = 1;
  let baselinePriceLevel = 1;
  let privateTaxDebt = 0;
  // This is an allocated ten-year capital buffer for the modeled tax-payment
  // loan book, not a claim about the capitalization of the entire banking
  // system. It avoids assuming that a new policy's first annual loans consume
  // every dollar of the banking sector's pre-existing lending capacity.
  let bankCapital =
    initialAnnualTax.privateTaxDebt * MODEL_CONSTANTS.taxLoanBankCapitalRatio * YEARS;
  // Retained interest raises accounting equity but is not assumed to be
  // instantly recommitted to this policy-specific loan allocation. Origination
  // capacity therefore falls with losses, not rises mechanically with rates.
  let lendingCapital = bankCapital;
  let cumulativeGovernmentGuarantees = 0;
  let drainedTreasuryBalance = 0;
  let publicDebt = 0;
  const openingPublicDebt = initialFiscalState.externalPublicDebt;
  let fiscalState: FiscalState = initialFiscalState;
  const fiscalYears: FiscalProjectionYear[] = [];
  let confidence = 1;
  let bottomWageBase =
    (US_BASELINE.annualPce * MODEL_CONSTANTS.bottomHalfConsumptionShare) /
    (US_BASELINE.households * MODEL_CONSTANTS.bottomHalfPopulationShare);
  let baselineResources = bottomWageBase;
  const initialBottomResources = bottomWageBase;
  let topWealth = topOnePercentWealth();
  let baselineTopWealth = topWealth;
  const housingWealth = totalHousingWealth();
  const publicEquityWealth = totalPublicEquityWealth();
  const middleHousingToNetWorth = middleFortyHousingToNetWorth();
  let housingPriceIndex = 1;
  let equityPriceIndex = 1;
  let rentPremiumIndex = 1;
  let residentForeignClaims = 0;
  let foreignOwnedDomesticClaims = 0;
  let foreignHeldTreasuryDebt = 0;
  let cumulativeNetCapitalOutflow = 0;
  const openEconomyFlows = {
    foreignAssetPurchases: 0,
    foreignTreasuryPurchases: 0,
    residentCapitalOutflow: 0,
    repatriatedCapital: 0,
  };
  const openEconomyYears: OpenEconomyProjectionYear[] = [
    {
      year: 0,
      foreignAssetPurchases: 0,
      foreignTreasuryPurchases: 0,
      residentCapitalOutflow: 0,
      repatriatedCapital: 0,
      netForeignAssetPosition: 0,
      foreignOwnedDomesticClaims: 0,
      exchangeRatePressure: 0,
      residentsChangingJurisdiction: 0,
      taxableBaseLeavingJurisdiction: 0,
    },
  ];
  const theoryYears: PolicyProjection["theoryTest"]["years"][number][] = [
    {
      year: 0,
      recipientCashAllocation: emptyRecipientCashAllocation(),
      liquiditySeekingAssets: 0,
      housingPriceIndex: 100,
      equityPriceIndex: 100,
      assetMarket: emptyMarketDiagnostics(),
      middleHomeownerWealthIndex: 100,
      bottomRenterHousingBurdenIndex: 100,
      bottomRenterDisposableIncomeIndex: 100,
    },
  ];
  const years: PolicyProjection["years"][number][] = [
    {
      year: 0,
      taxCollected: 0,
      taxpayerHouseholds: 0,
      effectiveTaxRate: 0,
      taxGroupCollections: taxGroupCollectionRecord(new Map()),
      annualInflation: US_BASELINE.baselineInflation,
      monthlyInflation: annualToMonthly(US_BASELINE.baselineInflation),
      priceLevel,
      m2,
      m2Index: 100,
      privateTaxDebt,
      newPrivateLoans: 0,
      privateTaxLoanRepayments: 0,
      privateTaxLoanInterestPaid: 0,
      taxLoanSaleToCure: 0,
      taxLoanDefaults: 0,
      collateralSeized: 0,
      privateBankLosses: 0,
      governmentGuarantees: 0,
      centralBankFacilities: 0,
      bankCapital,
      deferredTax: 0,
      governmentDebtAdded: publicDebt,
      bottom50PurchasingPowerIndex: 100,
      top1RealWealthIndex: 100,
      confidenceIndex: confidence * 100,
      gdpIndex: 100,
      regime: regimeForInflation(US_BASELINE.baselineInflation),
    },
  ];

  for (let year = 1; year <= YEARS; year += 1) {
    // CPI indexation applies the last observed policy price level (a one-year
    // recognition lag), so year 1 always matches the strategy outcomes.
    const indexation = request.ubi.benefitIndexation === "cpi" ? priceLevel : 1;
    const annualTax =
      year === 1
        ? initialAnnualTax
        : assessAnnualHouseholdTaxes(
            householdTaxStates,
            taxInputs.policy,
            request.behavior.avoidanceElasticity,
            request,
            false,
            Math.max(
              0,
              lendingCapital / MODEL_CONSTANTS.taxLoanBankCapitalRatio - privateTaxDebt,
            ),
          );
    const taxCollectedYear = annualTax.taxCollected;
    const taxDemandMultiplier = taxCollected > 0 ? taxCollectedYear / taxCollected : 0;
    for (const [id, collection] of annualTax.groupTaxCollected) {
      cumulativeGroupTax.set(id, (cumulativeGroupTax.get(id) ?? 0) + collection);
    }
    const newPrivateLoansYear = annualTax.newPrivateLoans;
    const requestedUbiYear = requestedUbi * indexation;
    const openingTreasuryBalance = fiscalState.treasuryBalance;
    const fiscalTransition = resolveFiscalYear(
      {
        year,
        taxRevenue: taxCollectedYear,
        requestedProgramOutlay: requestedUbiYear,
        fundingRule: request.ubi.fundingRule,
        surplusUse,
      },
      fiscalState,
    );
    const fiscalYear = fiscalTransition.year;
    fiscalState = fiscalTransition.state;
    fiscalYears.push(fiscalYear);
    const allocation = allocateProgramOutlay(fiscalYear, request);
    const programBudgetYear = fiscalYear.programOutlay;
    const governmentDeficitYear = fiscalYear.debtIssued;
    const scheduledCashYear = allocation.ubiReceived - fiscalYear.rebate;
    const recipientDebtBeforeAllocation =
      remainingRecipientDebtByHousehold.slice();
    const recipientCashAllocation = aggregateRecipientCashAllocation(
      taxInputs.householdAssessments,
      request,
      scheduledCashYear,
      fiscalYear.rebate,
      remainingRecipientDebtByHousehold,
    );
    applyRecipientNonMarketAllocation(
      householdTaxStates,
      recipientCashAllocation,
      recipientDebtBeforeAllocation,
      remainingRecipientDebtByHousehold,
    );
    const bottom50UbiYear =
      bottom50ScheduledCash *
        (yearOneScheduledCash > 0 ? scheduledCashYear / yearOneScheduledCash : 0) +
      fiscalYear.rebate / Math.max(1, request.representedHouseholds);

    const repayments = annualTax.principalRepayments;
    // Retained interest rebuilds the loan-book buffer. A private resolution
    // consumes it; the other paths make the rescue assumption explicit rather
    // than silently leaving a bank loss in the balance sheet.
    bankCapital = Math.max(
      0,
      bankCapital + annualTax.interestPaid - annualTax.privateBankLosses,
    );
    lendingCapital = Math.max(
      0,
      lendingCapital - annualTax.privateBankLosses,
    );
    cumulativeGovernmentGuarantees += annualTax.governmentGuarantees;
    publicDebt = fiscalYear.netPublicDebtChange + cumulativeGovernmentGuarantees;
    const treasuryBalanceChange =
      fiscalYear.treasuryBalance - openingTreasuryBalance;
    const nonTreasuryMoneyChangeBeforeMarket =
      newPrivateLoansYear -
      repayments -
      recipientCashAllocation.debtRepayment -
      annualTax.interestPaid +
      annualTax.centralBankFacilities +
      governmentDeficitYear * request.behavior.deficitMonetizationShare;
    const preliminaryMoneyFlow = applyTreasuryMoneyFlow({
      m2,
      // Cash-transfer recipients who repay existing bank debt extinguish
      // matching deposits. This can offset asset demand without being confused
      // with either Treasury redistribution or new-money recycling.
      nonTreasuryMoneyChange: nonTreasuryMoneyChangeBeforeMarket,
      treasuryBalanceChange,
      drainedTreasuryBalance,
    });

    // Tax-payment loans do not buy assets directly: they settle with Treasury.
    // This separate, exposed assumption asks how much of the resulting liquidity
    // is later recycled into inflation hedges by its eventual holders.
    const liquiditySeekingAssets =
      Math.max(0, preliminaryMoneyFlow.moneyChange) *
      request.behavior.assetHedgeShare;
    const newMoneyHousingDemand =
      liquiditySeekingAssets * request.behavior.housingHedgeShare;
    const newMoneyEquityDemand = liquiditySeekingAssets - newMoneyHousingDemand;
    const housingDemand =
      newMoneyHousingDemand + recipientCashAllocation.housingPurchaseDemand;
    const equityDemand =
      newMoneyEquityDemand + recipientCashAllocation.publicEquityPurchases;
    const assetMarket = clearAnnualAssetMarkets(householdTaxStates, {
      request,
      domesticHousingPurchases: housingDemand,
      domesticEquityPurchases: equityDemand,
      recipientHousingPurchases:
        recipientCashAllocation.housingPurchaseDemand,
      recipientEquityPurchases:
        recipientCashAllocation.publicEquityPurchases,
      voluntaryHousingSales: annualTax.housingSold,
      voluntaryEquitySales: annualTax.equitySold,
      housingMarketValue: housingWealth * housingPriceIndex,
      equityMarketValue: publicEquityWealth * equityPriceIndex,
      remainingRecipientDebtByHousehold,
    });
    housingPriceIndex *= 1 + assetMarket.housing.priceChange;
    equityPriceIndex *= 1 + assetMarket.publicEquity.priceChange;
    rentPremiumIndex *=
      1 + assetMarket.housing.priceChange * request.behavior.rentPassThrough;

    // Forced collateral sales end in principal repayment, so their matching
    // deposits and loans disappear in addition to scheduled servicing.
    const moneyFlow = applyTreasuryMoneyFlow({
      m2,
      nonTreasuryMoneyChange:
        nonTreasuryMoneyChangeBeforeMarket - assetMarket.forcedRepayments,
      treasuryBalanceChange,
      drainedTreasuryBalance,
    });
    const moneyInjection = moneyFlow.moneyChange;
    drainedTreasuryBalance = moneyFlow.drainedTreasuryBalance;
    const moneyGrowth = moneyInjection / Math.max(1, m2);
    m2 += moneyInjection;
    privateTaxDebt = Math.max(
      0,
      annualTax.privateTaxDebt - assetMarket.forcedRepayments,
    );

    // One aggregate rest-of-world sector remains an explicit part of the
    // market-clearing buyer pool, including purchases of forced-sale claims.
    const foreignAssetPurchases =
      assetMarket.housing.foreignPurchases +
      assetMarket.publicEquity.foreignPurchases;
    const foreignTreasuryPurchases =
      governmentDeficitYear * request.economy.foreignTreasuryDebtShare;
    const residentCapitalOutflow =
      (topWealth * request.behavior.expatriationShare *
        request.economy.capitalOutflowResponse) /
      YEARS;
    const repatriatedCapital =
      residentCapitalOutflow * request.economy.repatriationFxPassThrough;
    const netCapitalOutflow = residentCapitalOutflow - repatriatedCapital;
    residentForeignClaims += netCapitalOutflow;
    foreignOwnedDomesticClaims += foreignAssetPurchases;
    foreignHeldTreasuryDebt += foreignTreasuryPurchases;
    cumulativeNetCapitalOutflow += netCapitalOutflow;
    openEconomyFlows.foreignAssetPurchases += foreignAssetPurchases;
    openEconomyFlows.foreignTreasuryPurchases += foreignTreasuryPurchases;
    openEconomyFlows.residentCapitalOutflow += residentCapitalOutflow;
    openEconomyFlows.repatriatedCapital += repatriatedCapital;
    const netForeignAssetPosition =
      residentForeignClaims - foreignOwnedDomesticClaims - foreignHeldTreasuryDebt;
    const exchangeRatePressure =
      ((netCapitalOutflow - foreignAssetPurchases - foreignTreasuryPurchases) /
        Math.max(1, US_BASELINE.nominalGdp)) *
      request.economy.repatriationFxPassThrough;
    openEconomyYears.push({
      year,
      foreignAssetPurchases,
      foreignTreasuryPurchases,
      residentCapitalOutflow,
      repatriatedCapital,
      netForeignAssetPosition,
      foreignOwnedDomesticClaims,
      exchangeRatePressure,
      residentsChangingJurisdiction:
        (US_BASELINE.households *
          (1 - MODEL_CONSTANTS.topOnePercentPercentile) *
          request.behavior.expatriationShare *
          request.behavior.expatriationResidenceShare) /
        YEARS,
      taxableBaseLeavingJurisdiction:
        (topWealth * request.behavior.expatriationShare *
          request.behavior.expatriationTaxBaseShare) /
        YEARS,
    });

    const stress = inflationFromStress({
      baselineInflation: US_BASELINE.baselineInflation,
      // The transfer creates a level shock; domestic supply and wages partially
      // adapt rather than repeating the full first-year shock forever. The
      // shock is recomputed from this year's scheduled cash, rebate, and public-
      // service mix. This preserves the distinct household MPC and sector
      // channels when the fiscal closure changes composition over time.
      demandInflation:
        demandInflationForAllocation(taxInputs.demandProfiles, weights, {
          taxBaseMultiplier: taxDemandMultiplier,
          scheduledCash: scheduledCashYear,
          rebate: fiscalYear.rebate,
          publicServices: allocation.publicServicesSpending,
          monetaryPolicyOffsetShare: request.model.monetaryPolicyOffsetShare,
        }) *
        Math.exp(-(year - 1) / MODEL_CONSTANTS.demandShockDecayYears) *
        (1 / priceLevel),
      moneyGrowth,
      monetizedDeficitRatio:
        (governmentDeficitYear * request.behavior.deficitMonetizationShare) /
        US_BASELINE.nominalGdp,
      priorConfidence: confidence,
    });
    confidence = stress.confidence;
    const annualInflation = stress.inflation;
    priceLevel *= 1 + annualInflation;
    baselinePriceLevel *= 1 + US_BASELINE.baselineInflation;

    // Reduced-form growth/investment channel (issue #13). Investment deviates
    // from the steady-state replacement rate: the wealth tax's drag on the
    // after-tax return to wealth cuts it (savings channel), while the transfer's
    // demand impulse — the REAL program budget as a share of national GDP —
    // lifts it (demand channel). Deflate the (possibly CPI-indexed) nominal
    // budget by the price level first, so a benefit that only grows with prices
    // adds no real demand. With both dials at 0 the deviation is 0, so the
    // mean-reverting capital index stays pinned at 1 and wages/output grow along
    // the constant REAL_GROWTH trend exactly as before.
    const realProgramBudget = programBudgetYear / priceLevel;
    const demandImpulse =
      realProgramBudget / nationalScale / US_BASELINE.nominalGdp;
    // This year's drag: national tax ACTUALLY collected as a share of aggregate
    // net worth — not the statutory rate — so it goes to ~0 when a high
    // exemption reaches no one or avoidance guts compliance, and it tracks the
    // base as it erodes or grows over the decade rather than freezing at
    // year-one collections. Deflate the (nominal) collection by the price level
    // first, exactly as the demand impulse does, so nominal appreciation /
    // inflation of the base can't drive the drag toward 1 purely because prices
    // rose. (taxCollectedYear already folds in avoidance, exemption reach, and
    // the annual base multiplier.)
    const collectionDrag = Math.min(
      1,
      taxCollectedYear / priceLevel / nationalScale / US_BASELINE.householdNetWorth,
    );
    const investmentDeviation =
      -request.behavior.savingsResponseElasticity * collectionDrag +
      request.behavior.demandGrowthOffset * demandImpulse;
    capitalIndex = Math.max(
      CAPITAL_INDEX_FLOOR,
      capitalIndex - CAPITAL_DEPRECIATION * (capitalIndex - 1) + investmentDeviation,
    );
    const priorCapitalPerWorker = capitalPerWorker;
    capitalPerWorker = capitalIndex ** CAPITAL_SHARE;
    // Wages track capital per worker: scale the trend wage growth by the change
    // in the capital-per-worker deviation. Factor is 1 whenever capital is on the
    // baseline path.
    const capitalWageFactor = capitalPerWorker / priorCapitalPerWorker;

    bottomWageBase *=
      (1 + REAL_GROWTH + US_BASELINE.baselineInflation +
        Math.max(0, annualInflation - US_BASELINE.baselineInflation) *
          request.model.wagePassThrough) *
      capitalWageFactor;
    baselineResources *= 1 + REAL_GROWTH + US_BASELINE.baselineInflation;
    const policyRealResources = (bottomWageBase + bottom50UbiYear) / priceLevel;
    const baselineRealResources = baselineResources / baselinePriceLevel;

    // topTaxIncidenceShare scopes ONLY this aggregate top-1% wealth trajectory
    // (a reduced-form "how much of all collected tax lands on the top tier"
    // proxy). Per-cohort outcomes in buildGroupOutcomes attribute tax precisely
    // by each cohort's household-level collected revenue
    // (groupRealWealthChange), so they intentionally do not read this dial.
    const topTaxBurden = taxCollectedYear * request.model.topTaxIncidenceShare;
    const interestCost =
      annualTax.interestPaid * request.model.topTaxIncidenceShare;
    topWealth = Math.max(
      0,
      topWealth * (1 + request.behavior.annualAssetReturn) - topTaxBurden - interestCost -
        annualTax.collateralSeized,
    );
    baselineTopWealth *= 1 + request.behavior.annualAssetReturn;

    const middleHomeownerWealthIndex =
      (1 + (housingPriceIndex - 1) * middleHousingToNetWorth) * 100;
    const baselineRentCost =
      initialBottomResources *
      BASELINE_RENTER_HOUSING_COST_SHARE *
      baselinePriceLevel;
    const policyRentCost =
      initialBottomResources *
      BASELINE_RENTER_HOUSING_COST_SHARE *
      priceLevel *
      rentPremiumIndex;
    const policyRenterIncome = bottomWageBase + bottom50UbiYear;
    const baselineRenterIncome = baselineResources;
    const policyRentBurden = policyRentCost / Math.max(1, policyRenterIncome);
    const baselineRentBurden = baselineRentCost / Math.max(1, baselineRenterIncome);
    const policyDisposable = Math.max(1, policyRenterIncome - policyRentCost);
    const baselineDisposable = Math.max(1, baselineRenterIncome - baselineRentCost);

    theoryYears.push({
      year,
      recipientCashAllocation,
      liquiditySeekingAssets,
      housingPriceIndex: housingPriceIndex * 100,
      equityPriceIndex: equityPriceIndex * 100,
      assetMarket,
      middleHomeownerWealthIndex,
      bottomRenterHousingBurdenIndex:
        (policyRentBurden / Math.max(0.0001, baselineRentBurden)) * 100,
      bottomRenterDisposableIncomeIndex:
        ((policyDisposable / priceLevel) /
          Math.max(1, baselineDisposable / baselinePriceLevel)) *
        100,
    });

    years.push({
      year,
      taxCollected: taxCollectedYear,
      taxpayerHouseholds: annualTax.taxpayerHouseholds,
      effectiveTaxRate: annualTax.effectiveTaxRate,
      taxGroupCollections: taxGroupCollectionRecord(annualTax.groupTaxCollected),
      annualInflation,
      monthlyInflation: annualToMonthly(annualInflation),
      priceLevel,
      m2,
      m2Index: (m2 / US_BASELINE.m2) * 100,
      privateTaxDebt,
      newPrivateLoans: newPrivateLoansYear,
      privateTaxLoanRepayments: repayments + assetMarket.forcedRepayments,
      privateTaxLoanInterestPaid: annualTax.interestPaid,
      taxLoanSaleToCure: annualTax.saleToCure,
      taxLoanDefaults: annualTax.defaults,
      collateralSeized: annualTax.collateralSeized,
      privateBankLosses: annualTax.privateBankLosses,
      governmentGuarantees: annualTax.governmentGuarantees,
      centralBankFacilities: annualTax.centralBankFacilities,
      bankCapital,
      deferredTax: annualTax.deferredTax,
      governmentDebtAdded: publicDebt,
      bottom50PurchasingPowerIndex:
        (policyRealResources / Math.max(1, baselineRealResources)) * 100,
      top1RealWealthIndex:
        (topWealth / priceLevel) /
        Math.max(1, baselineTopWealth / baselinePriceLevel) *
        100,
      confidenceIndex: confidence * 100,
      gdpIndex: capitalPerWorker * 100,
      regime: regimeForInflation(annualInflation),
    });

    finalYearFlows = {
      taxCollected: taxCollectedYear,
      ubiReceived: allocation.ubiReceived,
      rebate: fiscalYear.rebate,
      publicServicesSpending: allocation.publicServicesSpending,
      serviceValue: serviceValueRange(
        allocation.publicServicesSpending,
        serviceEffectiveness,
      ),
      administrativeCost: allocation.administrativeCost,
      newPrivateLoans: newPrivateLoansYear,
      governmentDeficit: governmentDeficitYear,
      m2Injection: moneyInjection,
    };
    evolveAnnualHouseholdTaxStates(householdTaxStates, {
      annualAssetReturn: request.behavior.annualAssetReturn,
      annualInflation,
      baselineInflation: US_BASELINE.baselineInflation,
      assetPriceInflationPassThrough: request.model.assetPriceInflationPassThrough,
      expatriationRetention,
    });
  }

  const finalYear = years.at(-1);
  if (!finalYear) throw new Error("Projection did not produce a final year.");
  const peakAnnualInflation = Math.max(...years.slice(1).map((year) => year.annualInflation));
  const bottom50PurchasingPowerChange = finalYear.bottom50PurchasingPowerIndex / 100 - 1;
  const top1RealWealthChange = finalYear.top1RealWealthIndex / 100 - 1;
  const gdpChange = finalYear.gdpIndex / 100 - 1;
  const loanResolutionTotals = years.slice(1).reduce(
    (totals, year) => ({
      taxLoanDefaults: totals.taxLoanDefaults + year.taxLoanDefaults,
      collateralSeized: totals.collateralSeized + year.collateralSeized,
      privateBankLosses: totals.privateBankLosses + year.privateBankLosses,
      governmentGuarantees: totals.governmentGuarantees + year.governmentGuarantees,
      centralBankFacilities: totals.centralBankFacilities + year.centralBankFacilities,
    }),
    {
      taxLoanDefaults: 0,
      collateralSeized: 0,
      privateBankLosses: 0,
      governmentGuarantees: 0,
      centralBankFacilities: 0,
    },
  );
  const publicBurdenPerHousehold =
    Math.max(0, publicDebt) / Math.max(1, request.representedHouseholds);
  const yearOneServiceValue = serviceValueRange(
    publicServicesSpending,
    serviceEffectiveness,
  );
  const verdict = makeVerdict({
    bottom50PurchasingPowerChange,
    peakAnnualInflation,
    publicBurdenPerHousehold,
    gdpChange,
    borrowShare: weights.borrow,
    harmfulPeakInflation: request.model.verdictHarmfulInflation,
    serviceValueScored:
      publicServicesSpending > 0 && (yearOneServiceValue.selected ?? 0) > 0,
  });
  const stressTest = buildStressTest(
    strategies,
    taxInputs.demandProfiles,
    newPrivateLoans,
    taxCollected,
    request,
    request.behavior.taxLoanStructure === "amortizing"
      ? request.model.loanAmortizationRate
      : 0,
    {
      annualAssetReturn: request.behavior.annualAssetReturn,
      baselineInflation: US_BASELINE.baselineInflation,
      assetPriceInflationPassThrough: request.model.assetPriceInflationPassThrough,
      effectiveTaxRate: taxInputs.effectiveTaxRate,
      expatriationRetention,
      topTierShare,
    },
  );
  const theoryTest = buildTheoryTest(request, theoryYears, finalYear.m2Index / 100 - 1);
  const openEconomyAudit = auditOpenEconomyFlows(openEconomyFlows);

  const groupOutcomes = buildGroupOutcomes({
    request,
    ubiReceived,
    taxCollected,
    groupTaxShare,
    cumulativeGroupTax,
    policyPriceLevel: priceLevel,
    baselinePriceLevel,
    housingPremium: housingPriceIndex,
    equityPremium: equityPriceIndex,
    rentPremiumChange: rentPremiumIndex - 1,
    bottom50PurchasingPowerChange,
    renterDisposableChange: theoryTest.summary.bottomRenterDisposableIncomeChange,
  });

  return {
    verdict,
    behaviorMix: {
      cashShare: weights.cash,
      borrowShare: weights.borrow,
      sellShare: weights.sell,
      householdsPayingCashShare:
        initialAnnualTax.householdsPayingCash /
        Math.max(1, initialAnnualTax.taxpayerHouseholds),
      householdsBorrowingShare:
        initialAnnualTax.householdsBorrowing /
        Math.max(1, initialAnnualTax.taxpayerHouseholds),
      householdsSellingShare:
        initialAnnualTax.householdsSelling /
        Math.max(1, initialAnnualTax.taxpayerHouseholds),
      calibration:
        request.behavior.borrowShare >= 0.9
          ? "near-total-borrow-stress"
          : request.behavior.borrowShare >= 0.65
            ? "borrow-dominant"
            : "central",
    },
    annualFlows: {
      taxCollected,
      ubiReceived,
      rebate: yearOneFiscal.rebate,
      publicServicesSpending,
      serviceValue: yearOneServiceValue,
      administrativeCost,
      newPrivateLoans,
      assetSales,
      governmentDeficit,
      m2Injection: yearOneM2Injection,
      finalYear: finalYearFlows,
    },
    fiscal: {
      fundingRule: request.ubi.fundingRule,
      surplusUse,
      averageInterestRate: MODEL_CONSTANTS.averagePublicDebtInterestRate,
      cumulativeDebtIssued: fiscalState.cumulativeDebtIssued,
      cumulativeDebtRepaid: fiscalState.cumulativeDebtRepaid,
      netPublicDebtChange: publicDebt,
      openingPublicDebt,
      endingPublicDebt: fiscalState.externalPublicDebt + fiscalState.programDebt,
      endingProgramDebt: fiscalState.programDebt,
      endingTreasuryBalance: fiscalState.treasuryBalance,
      years: fiscalYears,
    },
    summary: {
      peakAnnualInflation,
      cumulativeM2Change: finalYear.m2Index / 100 - 1,
      bottom50PurchasingPowerChange,
      selectedAnnualResourceValue:
        yearOneServiceValue.selected === null
          ? null
          : ubiReceived + yearOneServiceValue.selected,
      top1RealWealthChange,
      gdpChange,
      privateTaxDebt,
      ...loanResolutionTotals,
      bankCapital,
      publicBurdenPerHousehold,
      firstHyperinflationYear:
        years.find((year) => year.monthlyInflation >= STRICT_HYPER_MONTHLY_RATE)?.year ??
        null,
    },
    years,
    groupOutcomes,
    stressTest,
    theoryTest,
    openEconomy: {
      closure: request.economy.closure,
      assumptions: {
        foreignBuyerShare: request.economy.foreignBuyerShare,
        foreignTreasuryDebtShare: request.economy.foreignTreasuryDebtShare,
        capitalOutflowResponse: request.economy.capitalOutflowResponse,
        repatriationFxPassThrough: request.economy.repatriationFxPassThrough,
        residenceChangeShare: request.behavior.expatriationResidenceShare,
        taxBaseJurisdictionShare: request.behavior.expatriationTaxBaseShare,
      },
      summary: {
        foreignOwnedDomesticClaims,
        foreignHeldTreasuryDebt,
        residentForeignClaims,
        netForeignAssetPosition:
          residentForeignClaims - foreignOwnedDomesticClaims - foreignHeldTreasuryDebt,
        cumulativeNetCapitalOutflow,
        peakExchangeRatePressure: Math.max(
          ...openEconomyYears.map((year) => Math.abs(year.exchangeRatePressure)),
        ),
      },
      accounting: openEconomyAudit,
      years: openEconomyYears,
    },
    interpretation: [
      "A tax-funded UBI moves existing deposits between households; it does not by itself create money.",
      `The ${request.ubi.fundingRule} rule determines scheduled outlays, while ${surplusUse} explicitly closes surpluses. Debt reduction is capped by the opening public-debt stock and any remainder stays at Treasury. Only the share of a growing Treasury balance that actually drains M2 can be released later; debt retirement, rebates, and additional services recycle the collected cash.`,
      "Bank borrowing creates deposits while the tax loans remain outstanding, so borrowing can expand M2 and add inflation pressure even when the federal budget balances.",
      "Private loans remain liabilities of the wealthy borrowers. They become a burden on other households only if losses are later socialized through bailouts, guarantees, or inflationary deficit finance; this model assumes no such bailout.",
      "Purchasing-power results compare the bottom half with a no-policy baseline after prices; they include partial wage adjustment and an annual UBI flow.",
      "The asset-price and rent channel is not implied by the accounting identities. It activates only when the selected share of new liquidity seeks housing or equities, housing supply is constrained, and rents follow asset prices.",
      "The growth channel weighs the real objection to a wealth tax: taxing wealth can lower saving and investment, shrinking the capital stock, wages, and GDP over the decade. The demand offset represents the opposite pull of transfers to high-spending households. Both are off by default; turn them up to see either steelman.",
      request.economy.closure === "closed"
        ? "Closed-economy mode keeps foreign buyer, foreign debt, and capital-flow channels at their selected zero baseline; it reproduces the domestic-only accounting path."
        : "The rest-of-world result is an aggregate stock-flow closure, not a country-by-country exchange-rate forecast: it reports who holds claims, Treasury financing, resident foreign claims, and directional FX pressure separately.",
    ],
  };
};

const buildTheoryTest = (
  request: ComparisonRequestV1,
  years: PolicyProjection["theoryTest"]["years"],
  cumulativeM2Change: number,
): PolicyProjection["theoryTest"] => {
  const finalYear = years.at(-1);
  if (!finalYear) throw new Error("Theory test did not produce a final year.");
  const housingPriceChange = finalYear.housingPriceIndex / 100 - 1;
  const equityPriceChange = finalYear.equityPriceIndex / 100 - 1;
  const middleHomeownerWealthChange =
    finalYear.middleHomeownerWealthIndex / 100 - 1;
  const bottomRenterHousingBurdenChange =
    finalYear.bottomRenterHousingBurdenIndex / 100 - 1;
  const bottomRenterDisposableIncomeChange =
    finalYear.bottomRenterDisposableIncomeIndex / 100 - 1;
  const housingPositionGapChange =
    middleHomeownerWealthChange + bottomRenterHousingBurdenChange;
  const annualLiquiditySeekingAssets =
    years.slice(1).reduce((sum, year) => sum + year.liquiditySeekingAssets, 0) /
    Math.max(1, years.length - 1);
  const annualRecipientAssetPurchaseCash =
    years
      .slice(1)
      .reduce(
        (sum, year) => sum + year.recipientCashAllocation.assetPurchaseCash,
        0,
      ) / Math.max(1, years.length - 1);
  const annualRecipientHousingPurchaseDemand =
    years
      .slice(1)
      .reduce(
        (sum, year) =>
          sum + year.recipientCashAllocation.housingPurchaseDemand,
        0,
      ) / Math.max(1, years.length - 1);
  const annualRecipientPublicEquityPurchases =
    years
      .slice(1)
      .reduce(
        (sum, year) =>
          sum + year.recipientCashAllocation.publicEquityPurchases,
        0,
      ) / Math.max(1, years.length - 1);
  const annualRecipientRetirementAndBondPurchases =
    years
      .slice(1)
      .reduce(
        (sum, year) =>
          sum + year.recipientCashAllocation.retirementAndBondPurchases,
        0,
      ) / Math.max(1, years.length - 1);
  const annualRecipientSpeculativeAssetPurchases =
    years
      .slice(1)
      .reduce(
        (sum, year) =>
          sum + year.recipientCashAllocation.speculativeAssetPurchases,
        0,
      ) / Math.max(1, years.length - 1);
  const cumulativeRecipientDebtRepayment = years
    .slice(1)
    .reduce(
      (sum, year) => sum + year.recipientCashAllocation.debtRepayment,
      0,
    );
  const cumulativeRecipientDepositSaving = years
    .slice(1)
    .reduce(
      (sum, year) => sum + year.recipientCashAllocation.depositSaving,
      0,
    );
  const recipientCashReconciliationResidual = years.reduce(
    (sum, year) =>
      sum + Math.abs(year.recipientCashAllocation.cashReconciliationResidual),
    0,
  );

  const { linkThreshold, positionGapThreshold } = MODEL_CONSTANTS.theoryTest;
  const hasMonetaryLink = cumulativeM2Change > linkThreshold;
  const hasRecipientPortfolioLink =
    (annualRecipientHousingPurchaseDemand +
      annualRecipientPublicEquityPurchases) /
      Math.max(1, totalHousingWealth() + totalPublicEquityWealth()) >
    linkThreshold;
  const hasAssetLink =
    housingPriceChange > linkThreshold || equityPriceChange > linkThreshold;
  const hasRenterHarm = bottomRenterHousingBurdenChange > linkThreshold;
  const hasWiderPositionGap = housingPositionGapChange > positionGapThreshold;
  const rating =
    (hasMonetaryLink || hasRecipientPortfolioLink) &&
    hasAssetLink &&
    hasRenterHarm &&
    hasWiderPositionGap
      ? "active"
      : (hasMonetaryLink || hasRecipientPortfolioLink) && hasAssetLink
        ? "partial"
        : "inactive";
  const verdict: PolicyProjection["theoryTest"]["verdict"] = rating === "active"
    ? {
        rating,
        headline: "The proposed owner–renter gap channel is active.",
        explanation:
          bottomRenterDisposableIncomeChange >= 0
            ? "Asset owners gain relative housing wealth and renters face a higher housing burden, although the transfer still leaves renters with more disposable buying power overall."
            : "Asset owners gain relative housing wealth while renters face both a higher housing burden and lower disposable buying power.",
      }
    : rating === "partial"
      ? {
          rating,
          headline: "Asset prices rise, but the renter-harm link is not established.",
          explanation:
            "Recipient portfolio demand and any new-money recycling lift asset prices, but income support, housing supply, or weak rent pass-through prevents a clear widening of renter housing burden.",
        }
      : {
          rating,
          headline: "The proposed feedback loop breaks under these assumptions.",
          explanation:
            "Recipient portfolio demand and new-money recycling are too small to produce a material policy-linked asset-price and rent effect in this reduced-form test.",
        };

  return {
    verdict,
    assumptions: {
      assetHedgeShare: request.behavior.assetHedgeShare,
      housingHedgeShare: request.behavior.housingHedgeShare,
      recipientDebtRepaymentShare:
        request.behavior.recipientDebtRepaymentShare,
      recipientAssetPurchaseShare:
        request.behavior.recipientAssetPurchaseShare,
      recipientHousingShare: request.behavior.recipientHousingShare,
      recipientRetirementAndBondShare:
        request.behavior.recipientRetirementAndBondShare,
      recipientSpeculativeShare: request.behavior.recipientSpeculativeShare,
      recipientHousingDownPaymentShare:
        request.behavior.recipientHousingDownPaymentShare,
      recipientUncertaintyRanges: {
        debtRepaymentShare: { low: 0.15, high: 0.6 },
        assetPurchaseShare: { low: 0.05, high: 0.5 },
        housingDownPaymentShare: { low: 0.05, high: 0.35 },
      },
      housingSupplyElasticity: request.market.housingSupplyElasticity,
      rentPassThrough: request.behavior.rentPassThrough,
      baselineRenterHousingCostShare: BASELINE_RENTER_HOUSING_COST_SHARE,
    },
    summary: {
      annualLiquiditySeekingAssets,
      annualRecipientAssetPurchaseCash,
      annualRecipientHousingPurchaseDemand,
      annualRecipientPublicEquityPurchases,
      annualRecipientRetirementAndBondPurchases,
      annualRecipientSpeculativeAssetPurchases,
      cumulativeRecipientDebtRepayment,
      cumulativeRecipientDepositSaving,
      recipientCashReconciliationResidual,
      housingPriceChange,
      equityPriceChange,
      middleHomeownerWealthChange,
      bottomRenterHousingBurdenChange,
      bottomRenterDisposableIncomeChange,
      housingPositionGapChange,
    },
    years,
  };
};

interface GroupOutcomeInputs {
  readonly request: ComparisonRequestV1;
  readonly ubiReceived: number;
  readonly taxCollected: number;
  readonly groupTaxShare: ReadonlyMap<string, number>;
  readonly cumulativeGroupTax: ReadonlyMap<string, number>;
  readonly policyPriceLevel: number;
  readonly baselinePriceLevel: number;
  readonly housingPremium: number;
  readonly equityPremium: number;
  readonly rentPremiumChange: number;
  readonly bottom50PurchasingPowerChange: number;
  readonly renterDisposableChange: number;
}

// Year-ten real net worth versus the no-policy path, as a channel decomposition
// relative to the group's baseline net worth. This keeps the measure consistent
// with the engine's existing homeowner-wealth and top-1% measures and, unlike a
// blanket deflation of net worth, correctly credits leveraged owners for the
// real value inflation strips from their fixed-nominal debt:
//   + policy-driven housing- and equity-price premia on those holdings
//   + inflationary erosion of fixed-nominal debt (helps leveraged owners)
//   - inflationary erosion of fixed-nominal deposits (hurts cash holders)
//   - the group's cumulative real wealth tax
const groupRealWealthChange = (
  group: UsWealthGroupBaseline,
  cumulativeTax: number,
  inputs: GroupOutcomeInputs,
): number => {
  const netWorth = Math.max(1, group.netWorth);
  const excessInflation = inputs.policyPriceLevel / inputs.baselinePriceLevel - 1;
  const housingGain =
    (inputs.housingPremium - 1) * (group.assetClasses.housing / netWorth);
  const equityGain =
    (inputs.equityPremium - 1) * (group.assetClasses.publicEquity / netWorth);
  const debtErosion = excessInflation * (group.liabilities / netWorth);
  const cashErosion = -excessInflation * (group.assetClasses.deposits / netWorth);
  // cumulativeTax is a flow scaled to the represented population; the group's
  // net worth is a national baseline. Normalize the tax to national scale so the
  // burden ratio is correct for any representedHouseholds.
  const nationalTax = cumulativeTax / populationScale(inputs.request);
  const realTaxBurden = -(nationalTax / inputs.policyPriceLevel) / netWorth;
  return housingGain + equityGain + debtErosion + cashErosion + realTaxBurden;
};

// Ratio of the requested population to the national baseline. The engine's
// collected-tax and delivered-UBI flows scale with representedHouseholds, while
// the wealth-group baselines are national — so per-household and per-net-worth
// figures must divide the flows back down by this factor.
const populationScale = (request: ComparisonRequestV1): number =>
  Math.max(1e-9, request.representedHouseholds / US_BASELINE.households);

const rateGroupOutcome = (change: number): WealthGroupOutcome["rating"] =>
  change > GROUP_OUTCOME_BAND
    ? "better-off"
    : change < -GROUP_OUTCOME_BAND
      ? "worse-off"
      : "mixed";

const groupOf = (id: UsWealthGroupBaseline["id"]): UsWealthGroupBaseline => {
  const group = US_BASELINE.wealthGroups.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`Missing wealth-group baseline for ${id}.`);
  return group;
};

const buildGroupOutcomes = (inputs: GroupOutcomeInputs): WealthGroupOutcome[] => {
  const scale = populationScale(inputs.request);
  const representedHouseholds = inputs.request.representedHouseholds;
  // Per-household averages so cohorts are comparable and the persona card can
  // read them directly. UBI is modeled as near-universal per household; both the
  // delivered UBI and the collected tax are flows over the represented
  // population, so divide by represented (not national) household counts.
  const perHouseholdUbi = inputs.ubiReceived / Math.max(1, representedHouseholds);
  const perHouseholdTaxYearOne = (group: UsWealthGroupBaseline): number =>
    (inputs.taxCollected * (inputs.groupTaxShare.get(group.id) ?? 0)) /
    Math.max(1, group.households * scale);

  const bottom50 = groupOf("bottom-50");
  const renterHouseholds = bottom50.households * BOTTOM_HALF_RENTER_SHARE * scale;
  const ownerHouseholds = bottom50.households * scale - renterHouseholds;
  // The bottom half's taxable base (real estate, equity) sits with its owners;
  // renters hold negligible taxable wealth. So when a low exemption reaches into
  // the bottom half, attribute the whole group's tax to the owner cohort and
  // leave renters at ~zero, rather than splitting the average across both.
  const bottom50CumulativeTax = inputs.cumulativeGroupTax.get(bottom50.id) ?? 0;
  const bottom50TaxYearOne = inputs.taxCollected * (inputs.groupTaxShare.get(bottom50.id) ?? 0);
  const purchasingPowerLabel = (change: number): string =>
    change >= 0 ? `+${(change * 100).toFixed(1)}% buying power` : `${(change * 100).toFixed(1)}% buying power`;
  const wealthLabel = (change: number): string =>
    change >= 0 ? `+${(change * 100).toFixed(1)}% real wealth` : `${(change * 100).toFixed(1)}% real wealth`;

  const outcomes: WealthGroupOutcome[] = [];

  // Bottom 50% renters: no meaningful net worth; their story is real disposable
  // buying power after the modeled rent premium.
  outcomes.push({
    id: "bottom-50-renter",
    label: "Bottom 50% renter",
    households: renterHouseholds,
    primaryMetric: "purchasing-power",
    purchasingPowerChange: inputs.renterDisposableChange,
    realWealthChange: null,
    annualTaxPaid: 0,
    annualUbiReceived: perHouseholdUbi,
    rentPremiumChange: inputs.rentPremiumChange,
    rating: rateGroupOutcome(inputs.renterDisposableChange),
    headline: purchasingPowerLabel(inputs.renterDisposableChange),
  });

  // Bottom 50% owners: same transfers as renters, but leveraged home equity and
  // inflation-eroded mortgages make real net worth the leading measure. They also
  // carry the group's whole wealth-tax burden when a low exemption reaches it.
  const ownerWealthChange = groupRealWealthChange(bottom50, bottom50CumulativeTax, inputs);
  outcomes.push({
    id: "bottom-50-owner",
    label: "Bottom 50% owner",
    households: ownerHouseholds,
    primaryMetric: "real-wealth",
    purchasingPowerChange: inputs.bottom50PurchasingPowerChange,
    realWealthChange: ownerWealthChange,
    annualTaxPaid: bottom50TaxYearOne / Math.max(1, ownerHouseholds),
    annualUbiReceived: perHouseholdUbi,
    rentPremiumChange: inputs.rentPremiumChange,
    rating: rateGroupOutcome(ownerWealthChange),
    headline: wealthLabel(ownerWealthChange),
  });

  const assetGroups: readonly {
    readonly id: WealthGroupOutcome["id"];
    readonly source: UsWealthGroupBaseline["id"];
    readonly label: string;
  }[] = [
    { id: "middle-40", source: "next-40", label: "Middle 40%" },
    { id: "top-10", source: "next-9", label: "Top 10%" },
    { id: "top-1", source: "remaining-top-1", label: "Top 1%" },
    { id: "top-0.1", source: "top-0.1", label: "Top 0.1%" },
  ];
  for (const spec of assetGroups) {
    const group = groupOf(spec.source);
    const cumulativeTax = inputs.cumulativeGroupTax.get(group.id) ?? 0;
    const wealthChange = groupRealWealthChange(group, cumulativeTax, inputs);
    outcomes.push({
      id: spec.id,
      label: spec.label,
      households: group.households * scale,
      primaryMetric: "real-wealth",
      purchasingPowerChange: null,
      realWealthChange: wealthChange,
      annualTaxPaid: perHouseholdTaxYearOne(group),
      annualUbiReceived: perHouseholdUbi,
      rentPremiumChange: inputs.rentPremiumChange,
      rating: rateGroupOutcome(wealthChange),
      headline: wealthLabel(wealthChange),
    });
  }

  return outcomes;
};

const strategyWeights = (request: ComparisonRequestV1) => ({
  borrow: request.behavior.borrowShare,
  sell: request.behavior.sellShare,
  cash: Math.max(0, 1 - request.behavior.borrowShare - request.behavior.sellShare),
});

const wealthGroupForPercentile = (percentile: number): UsWealthGroupBaseline => {
  const group = US_BASELINE.wealthGroups.find(
    (candidate) =>
      percentile >= candidate.percentileMinimum &&
      (percentile < candidate.percentileMaximum ||
        (candidate.percentileMaximum === 1 && percentile <= 1)),
  );
  if (!group) {
    throw new Error(`Household percentile ${percentile} is outside the wealth groups.`);
  }
  return group;
};

const averageBottomHalf = (
  strategies: Strategies,
  weights: ReturnType<typeof strategyWeights>,
  select: (decile: StrategyOutcome["distribution"]["deciles"][number]) => number,
): number => {
  const average = (strategy: PaymentStrategy) => {
    const deciles = strategies[strategy].distribution.deciles.slice(0, 5);
    const households = deciles.reduce((sum, decile) => sum + decile.households, 0);
    return deciles.reduce(
      (sum, decile) => sum + select(decile) * decile.households,
      0,
    ) / Math.max(1, households);
  };
  return (
    average("cash-first") * weights.cash +
    average("borrow-first") * weights.borrow +
    average("sell-first") * weights.sell
  );
};

export interface InflationStressInput {
  readonly baselineInflation: number;
  readonly demandInflation: number;
  readonly moneyGrowth: number;
  readonly monetizedDeficitRatio: number;
  readonly priorConfidence: number;
}

/**
 * The single reduced-form inflation kernel used by every projection year and
 * stress cell. Exported so the historical backtest
 * (`historicalValidation.ts`) can feed real 2020–2023 monetary data through
 * the exact same coefficients the forward-looking policy simulation relies on.
 */
export const inflationFromStress = (input: InflationStressInput): {
  inflation: number;
  confidence: number;
} => {
  const kernel = MODEL_CONSTANTS.inflationKernel;
  const financingStress = Math.max(0, input.moneyGrowth - kernel.financingStressThreshold);
  const confidenceLoss = Math.max(
    0,
    financingStress * kernel.financingConfidenceWeight +
      input.monetizedDeficitRatio * kernel.monetizedConfidenceWeight -
      kernel.confidenceLossBuffer,
  );
  const confidence = Math.max(kernel.minimumConfidence, input.priorConfidence - confidenceLoss);
  const velocityPressure =
    (1 - confidence) ** kernel.velocityExponent * kernel.velocityCoefficient;
  const inflation = Math.min(
    MAX_ANNUAL_INFLATION,
    Math.max(
      kernel.inflationFloor,
      input.baselineInflation +
        input.demandInflation +
        financingStress * kernel.financingInflationWeight +
        input.monetizedDeficitRatio * kernel.monetizedInflationWeight +
        velocityPressure,
    ),
  );
  return { inflation, confidence };
};

const buildStressTest = (
  strategies: Strategies,
  demandProfiles: PolicyProjectionTaxInputs["demandProfiles"],
  newPrivateLoans: number,
  taxCollected: number,
  request: ComparisonRequestV1,
  loanAmortizationRate: number,
  baseDynamics: BaseDynamics,
): PolicyProjection["stressTest"] => {
  const ubiMultipliers = MODEL_CONSTANTS.stress.ubiMultipliers;
  const monetizationShares = MODEL_CONSTANTS.stress.monetizationShares;
  const requestedUbi = strategies["cash-first"].fiscal.requestedUbi;
  const weights = strategyWeights(request);
  const initialPublicDebt = initialFiscalStateForRequest(request).externalPublicDebt;
  const cells: StressCell[] = [];
  for (const multiplier of ubiMultipliers) {
    for (const monetizationShare of monetizationShares) {
      const peak = stressPeak({
        requestedUbi: requestedUbi * multiplier,
        taxCollected,
        newPrivateLoans,
        monetizationShare,
        request,
        loanAmortizationRate,
        demandProfiles,
        weights,
        initialPublicDebt,
        baseDynamics,
      });
      cells.push({
        ubiMultiplier: multiplier,
        monetizationShare,
        peakAnnualInflation: peak,
        peakMonthlyInflation: annualToMonthly(peak),
        regime: regimeForInflation(peak),
      });
    }
  }

  let firstUbiMultiplierAtFullMonetization: number | null = null;
  for (
    let multiplier = 1;
    multiplier <= MODEL_CONSTANTS.stress.maxSearchMultiplier;
    multiplier *= 2
  ) {
    const peak = stressPeak({
      requestedUbi: requestedUbi * multiplier,
      taxCollected,
      newPrivateLoans,
      monetizationShare: 1,
      request,
      loanAmortizationRate,
      demandProfiles,
      weights,
      initialPublicDebt,
      baseDynamics,
    });
    if (annualToMonthly(peak) >= STRICT_HYPER_MONTHLY_RATE) {
      firstUbiMultiplierAtFullMonetization = multiplier;
      break;
    }
  }

  return {
    fundingRule: request.ubi.fundingRule,
    surplusUse: normalizedSurplusUse(request),
    ubiMultipliers,
    monetizationShares,
    cells,
    threshold: {
      definition: "50% inflation per month (Cagan convention)",
      firstUbiMultiplierAtFullMonetization,
      annualInflationEquivalent: STRICT_HYPER_ANNUAL_RATE,
      explanation:
        firstUbiMultiplierAtFullMonetization === null
          ? `No strict hyperinflation breach occurs even at ${MODEL_CONSTANTS.stress.maxSearchMultiplier.toLocaleString("en-US")}× the selected benefit under the ${request.ubi.fundingRule} funding rule.`
          : `The first tested strict breach occurs around ${firstUbiMultiplierAtFullMonetization}× the selected benefit under the ${request.ubi.fundingRule} rule when issued debt is fully monetized and confidence is allowed to erode.`,
    },
  };
};

const stressPeak = (input: {
  requestedUbi: number;
  taxCollected: number;
  newPrivateLoans: number;
  monetizationShare: number;
  request: ComparisonRequestV1;
  loanAmortizationRate: number;
  demandProfiles: PolicyProjectionTaxInputs["demandProfiles"];
  weights: ReturnType<typeof strategyWeights>;
  initialPublicDebt: number;
  baseDynamics: BaseDynamics;
}): number => {
  let m2 = US_BASELINE.m2;
  let confidence = 1;
  let privateDebt = 0;
  let priceLevel = 1;
  let peak: number = US_BASELINE.baselineInflation;
  let fiscalState: FiscalState = createFiscalState(input.initialPublicDebt);
  let drainedTreasuryBalance = 0;
  // Same base-dynamics evolution as the main projection loop (issue #17), so the
  // stressed revenue and private-loan flows respond to asset returns, statutory-
  // rate erosion, and top-tier expatriation across the horizon instead of being
  // frozen at year one. Year 1: combined multiplier = 1, reproducing prior cells.
  let baseState: TaxBaseState = { top: 1, rest: 1 };
  for (let year = 1; year <= YEARS; year += 1) {
    const baseMultiplier = combinedBaseMultiplier(baseState, input.baseDynamics.topTierShare);
    const taxCollectedYear = input.taxCollected * baseMultiplier;
    const newPrivateLoansYear = input.newPrivateLoans * baseMultiplier;
    // CPI-indexed benefits grow the stressed outlay with the prior year's
    // price level (same one-year recognition lag as the main projection).
    const indexation =
      input.request.ubi.benefitIndexation === "cpi" ? priceLevel : 1;
    const requestedOutlay =
      input.requestedUbi * indexation * (1 + MODEL_CONSTANTS.stress.outlayGrowth);
    const openingTreasuryBalance = fiscalState.treasuryBalance;
    const fiscalTransition = resolveFiscalYear(
      {
        year,
        taxRevenue: taxCollectedYear,
        requestedProgramOutlay: requestedOutlay,
        fundingRule: input.request.ubi.fundingRule,
        surplusUse: normalizedSurplusUse(input.request),
      },
      fiscalState,
    );
    fiscalState = fiscalTransition.state;
    const fiscalYear = fiscalTransition.year;
    const allocation = allocateProgramOutlay(fiscalYear, input.request);
    const treasuryBalanceChange =
      fiscalYear.treasuryBalance - openingTreasuryBalance;
    const repayments = privateDebt * input.loanAmortizationRate;
    // The stress grid assumes scheduled interest is fully paid and retained by
    // the bank. Like the main projection's actual paid-interest flow, it
    // extinguishes deposits until a separately modeled bank outlay re-enters
    // household or firm deposits.
    const retainedInterest = privateDebt * input.request.behavior.loanInterestRate;
    privateDebt = Math.max(0, privateDebt + newPrivateLoansYear - repayments);
    const moneyFlow = applyTreasuryMoneyFlow({
      m2,
      nonTreasuryMoneyChange:
        newPrivateLoansYear -
        repayments -
        retainedInterest +
        fiscalYear.debtIssued * input.monetizationShare,
      treasuryBalanceChange,
      drainedTreasuryBalance,
    });
    const injection = moneyFlow.moneyChange;
    drainedTreasuryBalance = moneyFlow.drainedTreasuryBalance;
    const stress = inflationFromStress({
      baselineInflation: US_BASELINE.baselineInflation,
      demandInflation: demandInflationForAllocation(
        input.demandProfiles,
        input.weights,
        {
          taxBaseMultiplier: baseMultiplier,
          scheduledCash: allocation.ubiReceived - fiscalYear.rebate,
          rebate: fiscalYear.rebate,
          publicServices: allocation.publicServicesSpending,
          monetaryPolicyOffsetShare:
            input.request.model.monetaryPolicyOffsetShare,
        },
      ),
      moneyGrowth: injection / Math.max(1, m2),
      monetizedDeficitRatio:
        (fiscalYear.debtIssued * input.monetizationShare) /
        US_BASELINE.nominalGdp,
      priorConfidence: confidence,
    });
    confidence = stress.confidence;
    m2 += injection;
    priceLevel *= 1 + stress.inflation;
    peak = Math.max(peak, stress.inflation);
    // Same dynamics as the main loop; topTierShare is consumed by
    // combinedBaseMultiplier above, not the per-sub-base evolution.
    baseState = evolveTaxBase(baseState, {
      ...input.baseDynamics,
      annualInflation: stress.inflation,
    });
  }
  return peak;
};

const makeVerdict = (input: {
  bottom50PurchasingPowerChange: number;
  peakAnnualInflation: number;
  publicBurdenPerHousehold: number;
  gdpChange: number;
  borrowShare: number;
  harmfulPeakInflation: number;
  serviceValueScored: boolean;
}): PolicyProjection["verdict"] => {
  const v = MODEL_CONSTANTS.verdict;
  const harmfulPurchasingPower =
    input.bottom50PurchasingPowerChange < v.harmfulPurchasingPowerDrop;
  const harmfulGrowth = input.gdpChange <= v.harmfulGdpChange;
  const harmfulInflation =
    input.peakAnnualInflation >= input.harmfulPeakInflation;
  const harmfulDebt =
    input.publicBurdenPerHousehold >= v.harmfulPublicBurdenPerHousehold;
  const harmful =
    harmfulPurchasingPower || harmfulGrowth || harmfulInflation || harmfulDebt;
  const beneficial =
    input.bottom50PurchasingPowerChange >= v.beneficialPurchasingPowerGain &&
    input.peakAnnualInflation < v.beneficialPeakInflation &&
    input.publicBurdenPerHousehold < v.beneficialPublicBurdenPerHousehold;
  const margins = {
    beneficialPurchasingPower:
      input.bottom50PurchasingPowerChange - v.beneficialPurchasingPowerGain,
    harmfulPurchasingPower:
      input.bottom50PurchasingPowerChange - v.harmfulPurchasingPowerDrop,
    beneficialInflation: v.beneficialPeakInflation - input.peakAnnualInflation,
    harmfulInflation: input.harmfulPeakInflation - input.peakAnnualInflation,
    beneficialPublicBurden:
      v.beneficialPublicBurdenPerHousehold - input.publicBurdenPerHousehold,
    harmfulPublicBurden:
      v.harmfulPublicBurdenPerHousehold - input.publicBurdenPerHousehold,
  };
  if (harmful) {
    // Attribute the harm to its actual driver. A harmful GDP path gets the
    // growth explanation when inflation and debt do not independently cross
    // their harmful thresholds. If purchasing power also crosses its threshold
    // during elevated inflation, retain the macro-risk explanation rather than
    // claiming growth is the sole driver.
    const growthDriven =
      harmfulGrowth &&
      !harmfulInflation &&
      !harmfulDebt &&
      (input.peakAnnualInflation < 0.05 || !harmfulPurchasingPower);
    const growthDespitePurchasingPowerGain =
      growthDriven && input.bottom50PurchasingPowerChange >= 0;
    return {
      rating: "harmful",
      detail: "harmful",
      scope: input.serviceValueScored ? "cash-with-service-estimate" : "cash-only",
      headline: growthDriven
        ? growthDespitePurchasingPowerGain
          ? "The bottom half gains buying power, but the investment and output loss is harmful."
          : "The wealth-tax drag on investment and wages outweighs the transfer gain."
        : "The inflation or debt cost overwhelms the transfer gain.",
      explanation: growthDriven
        ? growthDespitePurchasingPowerGain
          ? "Under these assumptions, transfers or lower prices lift bottom-half buying power, but reduced saving and investment shrink output per worker past the model’s harmful threshold."
          : "Under these assumptions the tax reduces saving and investment enough to shrink the capital stock and wages, so the bottom half ends with less real buying power even without a modeled inflation or debt crisis."
        : "Under these assumptions, the bottom half ends with less relative buying power or the financing path enters a high-risk inflation/debt regime.",
      margins,
    };
  }
  if (beneficial) {
    return {
      rating: "beneficial",
      detail: "beneficial",
      scope: input.serviceValueScored ? "cash-with-service-estimate" : "cash-only",
      headline:
        input.borrowShare > v.fragileBorrowShare
          ? "The bottom half gains, but borrowing makes the result more fragile."
          : "The bottom half gains buying power without a modeled inflation crisis.",
      explanation:
        "The annual transfer remains larger than the modeled loss from higher prices, while the federal balance and inflation stay inside the model’s guardrails.",
      margins,
    };
  }
  const buyingPowerGap = Math.abs(margins.beneficialPurchasingPower * 100).toFixed(2);
  const detail =
    input.bottom50PurchasingPowerChange >= 0 ? "mixed-positive" : "mixed-negative";
  const primaryConstraint =
    margins.beneficialPurchasingPower < 0
      ? `cash buying power is ${buyingPowerGap} percentage points below the beneficial guardrail`
      : margins.beneficialInflation <= 0
        ? "peak inflation is outside the beneficial guardrail"
        : margins.beneficialPublicBurden <= 0
          ? "the public-burden guardrail is exceeded"
          : "the cash result remains inside the model’s middle band";
  return {
    rating: "mixed",
    detail,
    scope: input.serviceValueScored ? "cash-with-service-estimate" : "cash-only",
    headline: input.serviceValueScored
      ? `Mixed result: ${primaryConstraint}.`
      : `Cash-only mixed result: ${primaryConstraint}.`,
    explanation: input.serviceValueScored
      ? `The model keeps the three headline categories for comparability, while this scenario is ${detail.replace("-", " ")}. The binding constraint is that ${primaryConstraint}; the displayed service resource estimate remains conditional on the selected effectiveness assumption and is not spendable cash.`
      : `The model keeps the three headline categories for comparability, while this scenario is ${detail.replace("-", " ")}. The binding constraint is that ${primaryConstraint}. No service value is counted, so this cash-only rating is not an overall welfare claim.`,
    margins,
  };
};

const regimeForInflation = (annualInflation: number): InflationRegime => {
  if (annualToMonthly(annualInflation) >= STRICT_HYPER_MONTHLY_RATE) {
    return "hyperinflation";
  }
  const regime = MODEL_CONSTANTS.regimeThresholds;
  if (annualInflation >= regime.extreme) return "extreme";
  if (annualInflation >= regime.crisis) return "crisis";
  if (annualInflation >= regime.high) return "high";
  if (annualInflation >= regime.elevated) return "elevated";
  return "stable";
};

const annualToMonthly = (annualRate: number): number => {
  const floor = MODEL_CONSTANTS.minPeriodRate;
  return Math.max(floor, (1 + Math.max(floor, annualRate)) ** (1 / 12) - 1);
};

const topOnePercentWealth = (): number =>
  US_BASELINE.wealthGroups
    .filter((group) => group.percentileMinimum >= MODEL_CONSTANTS.topOnePercentPercentile)
    .reduce((sum, group) => sum + group.netWorth, 0);

const totalHousingWealth = (): number =>
  US_BASELINE.wealthGroups.reduce(
    (sum, group) => sum + group.assetClasses.housing,
    0,
  );

const totalPublicEquityWealth = (): number =>
  US_BASELINE.wealthGroups.reduce(
    (sum, group) => sum + group.assetClasses.publicEquity,
    0,
  );

const middleFortyHousingToNetWorth = (): number => {
  const group = US_BASELINE.wealthGroups.find(
    (candidate) => candidate.id === "next-40",
  );
  if (!group) throw new Error("Missing middle-forty wealth baseline.");
  return group.assetClasses.housing / Math.max(1, group.netWorth);
};
