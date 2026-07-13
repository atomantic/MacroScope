import type { TaxBracket, WealthTaxPolicyV1 } from "../policies/schema.js";
import { assessWealthTax } from "../policies/wealthTax.js";
import {
  DEFAULT_COMPARISON_REQUEST,
  type ComparisonRequestV1,
  type ComparisonResultV1,
  type ConsumptionSector,
  type PaymentStrategy,
  type PopulationSummary,
  type SectorDemandOutcome,
  type StrategyOutcome,
} from "./contracts.js";
import {
  buildDeciles,
  weightedGini,
  type DistributionRecord,
} from "./distribution.js";
import {
  generateSyntheticPopulation,
  householdNetWorth,
  type SyntheticHousehold,
} from "./population.js";
import { calibratePopulationToUs } from "./usBaseline.js";
import { buildPolicyProjection } from "./projection.js";
import { computeStrategyAccounting } from "./ledgerAudit.js";
import { MODEL_CONSTANTS } from "./modelConstants.js";

interface HouseholdFunding {
  readonly taxAssessed: number;
  readonly cash: number;
  readonly borrowed: number;
  readonly equitySold: number;
  readonly housingSold: number;
  readonly deferred: number;
}

interface CascadeResult {
  readonly price: number;
  readonly forcedBookSales: ReadonlyMap<string, number>;
  readonly forcedRepayments: ReadonlyMap<string, number>;
  readonly totalForcedBookSales: number;
  readonly totalForcedRepayments: number;
  readonly iterations: number;
}

const STRATEGIES: readonly PaymentStrategy[] = [
  "cash-first",
  "borrow-first",
  "sell-first",
];

const SECTORS: readonly ConsumptionSector[] = [
  "housing",
  "food",
  "healthcare",
  "transportation",
  "energy",
  "durable-goods",
  "discretionary",
  "services",
];

const SUPPLY_SENSITIVITY = MODEL_CONSTANTS.supplySensitivity;

// Build the calibrated synthetic population a comparison runs against. Depends
// only on the sampling dials (seed, sampleSize, representedHouseholds), so a
// sensitivity sweep that perturbs policy/behavior assumptions can generate this
// once and reuse it across every run for determinism and speed (issue #11).
export const buildCalibratedPopulation = (
  request: ComparisonRequestV1,
): readonly SyntheticHousehold[] =>
  calibratePopulationToUs(
    generateSyntheticPopulation({
      seed: request.seed,
      sampleSize: request.sampleSize,
      representedHouseholds: request.representedHouseholds,
    }),
    request.representedHouseholds,
  );

export const runComparison = (
  request: ComparisonRequestV1 = DEFAULT_COMPARISON_REQUEST,
): ComparisonResultV1 => {
  const normalized = normalizeComparisonRequest(request);
  return runComparisonWithPopulation(normalized, buildCalibratedPopulation(normalized));
};

// The comparison body, given an already-normalized request and a calibrated
// population. `households` must have been built for the same seed, sampleSize,
// and representedHouseholds as `request`; the sensitivity engine passes one
// shared population across all perturbed runs so the only thing that varies is
// the perturbed dial.
export const runComparisonWithPopulation = (
  request: ComparisonRequestV1,
  households: readonly SyntheticHousehold[],
): ComparisonResultV1 => {
  request = normalizeComparisonRequest(request);
  const population = summarizePopulation(households);
  const effectiveExemption = resolveEffectiveExemption(households, request);
  const policy = buildWealthTaxPolicy(request, effectiveExemption);
  const strategies = Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      runStrategy(households, population, policy, request, strategy),
    ]),
  ) as Record<PaymentStrategy, StrategyOutcome>;

  return {
    schemaVersion: request.schemaVersion,
    assumptions: request,
    wealthTaxTarget: {
      mode: request.wealthTax.targetMode,
      requestedExemption: request.wealthTax.exemption,
      topShare: request.wealthTax.topShare,
      effectiveExemption,
    },
    population,
    strategies,
    projection: buildPolicyProjection(
      request,
      strategies,
      effectiveExemption,
      resolveEffectiveTaxRate(households, policy),
    ),
    caveats: [
      "Results are conditional scenarios, not forecasts.",
      "Wealth-group totals are calibrated to the Federal Reserve DFA for 2026:Q1; within-group joint distributions remain stylized.",
      "Equity price impact and inflation are reduced-form assumptions exposed for sensitivity testing.",
      "The current closed economy assumes domestic buyers absorb all equity and housing sales.",
      "Housing sales remain a national, closed-economy transfer channel; the ten-year owner-renter view adds reduced-form price, supply, and rent feedback rather than regional market clearing.",
      "Wealth Gini values treat negative net worth as zero for the inequality calculation.",
      `The ten-year path is a transparent reduced-form projection with ${request.ubi.benefitIndexation === "cpi" ? "CPI-indexed policy benefits (one-year recognition lag)" : "fixed nominal policy benefits"}, a wealth-tax base that compounds with asset returns and erodes with taxes paid, partial wage adjustment, and no private-loan bailout.`,
      "Taxpayer-response dials act on the aggregate taxed base as reduced-form revenue multipliers: avoidance and the private-business inclusion rate scale year-one collections directly, while expatriation erodes the base gradually over the decade (equivalent to top-tier wealth leaving whenever a positive exemption makes the taxed base top-tier). The ten-year inflation stress grid holds year-one revenue flat, so it reflects avoidance and inclusion but not the gradual expatriation decay.",
      "Cash purchasing-power measures do not assign a dollar welfare value to healthcare or social services delivered in kind.",
      "Percentile targeting resolves an effective exemption from the synthetic weighted population, so its dollar cutoff varies with calibration and sample size.",
      "Accounting checks replay each strategy's aggregate sector-level flows through the double-entry ledger and cross-check them against independent per-household deposit sums; intra-household asset trades net out within the household sector.",
    ],
  };
};

export const normalizeComparisonRequest = (
  request: ComparisonRequestV1,
): ComparisonRequestV1 => ({
  ...DEFAULT_COMPARISON_REQUEST,
  ...request,
  wealthTax: normalizeWealthTax({
    ...DEFAULT_COMPARISON_REQUEST.wealthTax,
    ...request.wealthTax,
  }),
  ubi: {
    ...DEFAULT_COMPARISON_REQUEST.ubi,
    ...request.ubi,
  },
  market: {
    ...DEFAULT_COMPARISON_REQUEST.market,
    ...request.market,
  },
  behavior: {
    ...DEFAULT_COMPARISON_REQUEST.behavior,
    ...request.behavior,
  },
  model: {
    ...DEFAULT_COMPARISON_REQUEST.model,
    ...request.model,
  },
});

// A graduated schedule is self-describing: its lowest absolute threshold is the
// exemption, and dollar targeting always applies (percentile targeting has no
// meaning once explicit thresholds are given). Sort defensively so downstream
// rebasing and the effective-exemption lookup can trust the ordering.
const normalizeWealthTax = (
  wealthTax: ComparisonRequestV1["wealthTax"],
): ComparisonRequestV1["wealthTax"] => {
  const brackets = wealthTax.brackets;
  if (!brackets || brackets.length === 0) return wealthTax;
  const sorted = [...brackets].sort((left, right) => left.threshold - right.threshold);
  return {
    ...wealthTax,
    targetMode: "exemption",
    exemption: sorted[0]?.threshold ?? wealthTax.exemption,
    brackets: sorted,
  };
};

const runStrategy = (
  households: readonly SyntheticHousehold[],
  population: PopulationSummary,
  policy: WealthTaxPolicyV1,
  request: ComparisonRequestV1,
  strategy: PaymentStrategy,
): StrategyOutcome => {
  const complianceFactor = avoidanceComplianceFactor(request);
  const funding = new Map<string, HouseholdFunding>();
  for (const household of households) {
    const tax =
      assessWealthTax(
        { assets: household.assets, liabilities: household.liabilities },
        policy,
      ).annualTax * complianceFactor;
    funding.set(household.id, fundTax(household, tax, strategy, request));
  }

  const taxAssessed = weightedSum(households, (household) =>
    requireFunding(funding, household.id).taxAssessed,
  );
  const taxCollected = weightedSum(households, (household) => {
    const item = requireFunding(funding, household.id);
    return item.cash + item.borrowed + item.equitySold + item.housingSold;
  });
  const requestedUbi = weightedSum(
    households,
    (household) =>
      12 *
      (household.adults * request.ubi.adultMonthlyBenefit +
        household.children * request.ubi.childMonthlyBenefit),
  );
  const leakageRate = MODEL_CONSTANTS.programLeakageRate;
  const programBudget =
    request.ubi.fundingRule === "revenue-constrained"
      ? Math.min(taxCollected, requestedUbi)
      : requestedUbi;
  const fundingRatio = programBudget / Math.max(1, requestedUbi);
  const administrativeCost =
    programBudget * request.ubi.administrativeShare;
  const postAdministrationBudget = programBudget - administrativeCost;
  const leakage = postAdministrationBudget * leakageRate;
  const deliveredBudget = postAdministrationBudget - leakage;
  const ubiReceived = deliveredBudget * request.ubi.directCashShare;
  const publicServicesSpending =
    deliveredBudget * (1 - request.ubi.directCashShare);
  const governmentOutlays = programBudget;
  const householdCashDeliveryRatio = ubiReceived / Math.max(1, requestedUbi);

  const cascade = calculateCascade(households, funding, request);
  const primaryBookSales = weightedSum(
    households,
    (household) => requireFunding(funding, household.id).equitySold,
  );
  const totalBookSales = primaryBookSales + cascade.totalForcedBookSales;
  const primaryHousingSales = weightedSum(
    households,
    (household) => requireFunding(funding, household.id).housingSold,
  );
  const buyerWeights = households.map((household) =>
    Math.max(1, household.assets.deposits) * household.weight,
  );
  const totalBuyerWeight = buyerWeights.reduce((total, value) => total + value, 0);
  const totalPurchaseConsideration =
    primaryBookSales + primaryHousingSales + cascade.totalForcedRepayments;

  const distributionRecords: DistributionRecord[] = [];
  let endingBookEquity = 0;
  let endingBookHousing = 0;
  let perHouseholdDepositsChange = 0;
  let consumptionDemandChange = 0;
  const sectorBaseline = emptySectorRecord();
  const sectorChanges = emptySectorRecord();
  let householdIndex = 0;
  for (const household of households) {
    const item = requireFunding(funding, household.id);
    const grossUbi =
      12 *
      (household.adults * request.ubi.adultMonthlyBenefit +
        household.children * request.ubi.childMonthlyBenefit);
    const receivedUbi = grossUbi * householdCashDeliveryRatio;
    const forcedBookSale = cascade.forcedBookSales.get(household.id) ?? 0;
    const forcedRepayment = cascade.forcedRepayments.get(household.id) ?? 0;
    const buyerWeight = buyerWeights[householdIndex] ?? 0;
    const purchaseBook = totalBuyerWeight === 0 ? 0 : totalBookSales * (buyerWeight / totalBuyerWeight) / household.weight;
    const housingPurchaseBook =
      totalBuyerWeight === 0
        ? 0
        : primaryHousingSales * (buyerWeight / totalBuyerWeight) / household.weight;
    const purchaseCost =
      totalBuyerWeight === 0
        ? 0
        : totalPurchaseConsideration * (buyerWeight / totalBuyerWeight) / household.weight;
    const taxPaid = item.cash + item.borrowed + item.equitySold + item.housingSold;
    const depositsAfter =
      household.assets.deposits +
      item.borrowed +
      item.equitySold +
      item.housingSold -
      taxPaid +
      receivedUbi -
      purchaseCost;
    perHouseholdDepositsChange +=
      (depositsAfter - household.assets.deposits) * household.weight;
    const collateralizedLoanAfter = Math.max(
      0,
      household.liabilities.collateralizedLoan + item.borrowed - forcedRepayment,
    );
    const equityBookAfter = Math.max(
      0,
      household.assets.publicEquity - item.equitySold - forcedBookSale + purchaseBook,
    );
    endingBookEquity += equityBookAfter * household.weight;
    const housingBookAfter = Math.max(
      0,
      household.assets.housing - item.housingSold + housingPurchaseBook,
    );
    endingBookHousing += housingBookAfter * household.weight;
    const netWorthAfter =
      depositsAfter +
      household.assets.governmentBonds +
      equityBookAfter * cascade.price +
      housingBookAfter +
      household.assets.privateBusiness +
      household.assets.retirementAssets -
      household.liabilities.mortgage -
      collateralizedLoanAfter -
      household.liabilities.consumerDebt;
    const consumptionChange =
      (receivedUbi - item.cash) * household.marginalPropensityToConsume;
    consumptionDemandChange += consumptionChange * household.weight;
    const shares = consumptionShares(household.percentile);
    const baselineConsumption =
      household.annualIncome * baselineConsumptionShare(household.marginalPropensityToConsume);
    for (const sector of SECTORS) {
      sectorBaseline[sector] +=
        baselineConsumption * shares[sector] * household.weight;
      sectorChanges[sector] += consumptionChange * shares[sector] * household.weight;
    }
    distributionRecords.push({
      weight: household.weight,
      netWorthBefore: householdNetWorth(household),
      netWorthAfter,
      taxAssessed: item.taxAssessed,
      taxPaid,
      ubiReceived: receivedUbi,
      debtChange: item.borrowed - forcedRepayment,
      consumptionChange,
    });
    householdIndex += 1;
  }

  sectorChanges.healthcare +=
    publicServicesSpending * MODEL_CONSTANTS.publicServicesHealthcareShare;
  sectorChanges.services +=
    publicServicesSpending * MODEL_CONSTANTS.publicServicesServicesShare;
  consumptionDemandChange += publicServicesSpending;

  const paidFromCash = weightedSum(households, (household) =>
    requireFunding(funding, household.id).cash,
  );
  const newLoans = weightedSum(households, (household) =>
    requireFunding(funding, household.id).borrowed,
  );
  const taxDeferred = weightedSum(households, (household) =>
    requireFunding(funding, household.id).deferred,
  );
  const openingCollateralizedLoans = weightedSum(
    households,
    (household) => household.liabilities.collateralizedLoan,
  );
  const depositsChange =
    newLoans - taxCollected + governmentOutlays - cascade.totalForcedRepayments;
  const equityQuantityResidual = population.aggregatePublicEquity - endingBookEquity;
  const openingBookHousing = weightedSum(
    households,
    (household) => household.assets.housing,
  );
  const housingQuantityResidual = openingBookHousing - endingBookHousing;
  const sectors: SectorDemandOutcome[] = SECTORS.map((sector) => ({
    sector,
    baselineDemand: sectorBaseline[sector],
    demandChange: sectorChanges[sector],
    inflationPressure:
      (sectorChanges[sector] / Math.max(1, sectorBaseline[sector])) *
      SUPPLY_SENSITIVITY[sector],
  }));
  const demandInflation = sectors.reduce(
    (total, sector) =>
      total +
      sector.inflationPressure *
        (sector.baselineDemand / Math.max(1, population.baselineAnnualConsumption)),
    0,
  );
  const supplyConstraintInflation = sectors.reduce(
    (total, sector) =>
      total +
      Math.max(0, sector.inflationPressure) *
        MODEL_CONSTANTS.supplyConstraintShare *
        (sector.baselineDemand / Math.max(1, population.baselineAnnualConsumption)),
    0,
  );
  const monetaryPolicyOffset =
    -(demandInflation + supplyConstraintInflation) *
    request.model.monetaryPolicyOffsetShare;
  const estimatedInflationChange =
    demandInflation + supplyConstraintInflation + monetaryPolicyOffset;
  const householdsBorrowing = weightedSum(
    households,
    (household) => (requireFunding(funding, household.id).borrowed > 0 ? 1 : 0),
  );
  const householdsSelling = weightedSum(
    households,
    (household) => (requireFunding(funding, household.id).equitySold > 0 ? 1 : 0),
  );
  const tolerance = Math.max(
    MODEL_CONSTANTS.absoluteToleranceFloor,
    (population.aggregatePublicEquity + population.aggregateDeposits) *
      MODEL_CONSTANTS.convergenceEpsilon,
  );
  const accounting = computeStrategyAccounting({
    flows: {
      openingDeposits: population.aggregateDeposits,
      openingCollateralizedLoans,
      openingPublicEquity: population.aggregatePublicEquity,
      newLoans,
      taxCollected,
      ubiReceived,
      otherGovernmentOutlays: governmentOutlays - ubiReceived,
      forcedLoanRepayments: cascade.totalForcedRepayments,
    },
    perHouseholdDepositsChange,
    bankDepositsChange: depositsChange,
    taxAssessed,
    taxDeferred,
    equityQuantityResidual,
    housingQuantityResidual,
    tolerance,
  });

  return {
    strategy,
    fiscal: {
      taxAssessed,
      taxCollected,
      taxDeferred,
      requestedUbi,
      ubiReceived,
      publicServicesSpending,
      administrativeCost,
      leakage,
      governmentBalance: taxCollected - governmentOutlays,
      fundingRatio,
    },
    funding: {
      paidFromCash,
      newCollateralizedLoans: newLoans,
      equitySoldForTax: primaryBookSales,
      housingSoldForTax: primaryHousingSales,
      householdsBorrowing,
      householdsSelling,
    },
    moneyAndCredit: {
      bankDepositsChange: depositsChange,
      bankLoansChange: newLoans - cascade.totalForcedRepayments,
      forcedLoanRepayments: cascade.totalForcedRepayments,
    },
    markets: {
      equitySoldForTax: primaryBookSales,
      forcedEquitySales: cascade.totalForcedBookSales,
      totalEquitySales: totalBookSales,
      equityPriceChange: cascade.price - 1,
      cascadeTriggered:
        cascade.totalForcedBookSales >
        Math.max(1, primaryBookSales * MODEL_CONSTANTS.cascade.triggerShare),
      cascadeIterations: cascade.iterations,
      housingSold: primaryHousingSales,
    },
    macro: {
      firstYearConsumptionDemandChange: consumptionDemandChange,
      taxWedgeInflation: 0,
      demandInflation,
      supplyConstraintInflation,
      monetaryPolicyOffset,
      estimatedInflationChange,
      sectors,
    },
    distribution: {
      wealthGiniBefore: weightedGini(distributionRecords, (record) => record.netWorthBefore),
      wealthGiniAfter: weightedGini(distributionRecords, (record) => record.netWorthAfter),
      deciles: buildDeciles(distributionRecords),
    },
    accounting,
  };
};

const fundTax = (
  household: SyntheticHousehold,
  tax: number,
  strategy: PaymentStrategy,
  request: ComparisonRequestV1,
): HouseholdFunding => {
  let remaining = tax;
  let cash = 0;
  let borrowed = 0;
  let equitySold = 0;
  let housingSold = 0;
  const cashBuffer = Math.max(
    MODEL_CONSTANTS.householdCashBufferFloor,
    household.annualIncome * MODEL_CONSTANTS.householdCashBufferIncomeShare,
  );
  const capacity = {
    cash: Math.max(0, household.assets.deposits - cashBuffer),
    borrow: Math.max(
      0,
      request.market.maximumCollateralLtv *
          (household.assets.publicEquity + household.assets.housing) -
        household.liabilities.mortgage -
        household.liabilities.collateralizedLoan,
    ),
    equity: household.assets.publicEquity,
    housing: household.assets.housing,
  };
  const order =
    strategy === "cash-first"
      ? (["cash", "borrow", "equity", "housing"] as const)
      : strategy === "borrow-first"
        ? (["borrow", "cash", "equity", "housing"] as const)
        : (["equity", "housing", "cash", "borrow"] as const);

  for (const source of order) {
    const amount = Math.min(remaining, capacity[source]);
    if (source === "cash") cash += amount;
    else if (source === "borrow") borrowed += amount;
    else if (source === "equity") equitySold += amount;
    else housingSold += amount;
    remaining -= amount;
  }
  return {
    taxAssessed: tax,
    cash,
    borrowed,
    equitySold,
    housingSold,
    deferred: remaining,
  };
};

const calculateCascade = (
  households: readonly SyntheticHousehold[],
  funding: ReadonlyMap<string, HouseholdFunding>,
  request: ComparisonRequestV1,
): CascadeResult => {
  const primarySales = weightedSum(
    households,
    (household) => requireFunding(funding, household.id).equitySold,
  );
  const totalEquity = weightedSum(households, (household) => household.assets.publicEquity);
  const marketDepth = Math.max(1, totalEquity * request.market.buyerDepthRatio);
  const forcedBookSales = new Map<string, number>();
  const forcedRepayments = new Map<string, number>();
  let totalForcedBookSales = 0;
  let totalForcedRepayments = 0;
  let price = 1;
  let iterations = 0;

  for (let iteration = 0; iteration < MODEL_CONSTANTS.cascade.maxIterations; iteration += 1) {
    const nextPrice = Math.max(
      MODEL_CONSTANTS.cascade.priceFloor,
      1 -
        request.market.priceImpactCoefficient *
          ((primarySales + totalForcedBookSales) / marketDepth),
    );
    price = Math.min(price, nextPrice);
    let iterationBookSales = 0;
    let iterationRepayments = 0;

    for (const household of households) {
      const item = requireFunding(funding, household.id);
      const alreadyForced = forcedBookSales.get(household.id) ?? 0;
      const equityRemaining = Math.max(
        0,
        household.assets.publicEquity - item.equitySold - alreadyForced,
      );
      const collateralAssets = household.assets.publicEquity + household.assets.housing;
      const equityShare =
        collateralAssets === 0 ? 0 : household.assets.publicEquity / collateralAssets;
      const equityBackedLoan =
        (household.liabilities.collateralizedLoan + item.borrowed) * equityShare -
        (forcedRepayments.get(household.id) ?? 0);
      const excessDebt =
        equityBackedLoan -
        request.market.maximumCollateralLtv * equityRemaining * price;
      if (excessDebt <= 0 || equityRemaining <= 0) continue;
      const requiredBookSale = Math.min(
        equityRemaining,
        excessDebt /
          Math.max(
            MODEL_CONSTANTS.absoluteToleranceFloor,
            price * (1 - request.market.maximumCollateralLtv),
          ),
      );
      const repayment = requiredBookSale * price;
      forcedBookSales.set(household.id, alreadyForced + requiredBookSale);
      forcedRepayments.set(
        household.id,
        (forcedRepayments.get(household.id) ?? 0) + repayment,
      );
      iterationBookSales += requiredBookSale * household.weight;
      iterationRepayments += repayment * household.weight;
    }

    if (
      iterationBookSales <=
      Math.max(
        MODEL_CONSTANTS.absoluteToleranceFloor,
        totalEquity * MODEL_CONSTANTS.convergenceEpsilon,
      )
    )
      break;
    totalForcedBookSales += iterationBookSales;
    totalForcedRepayments += iterationRepayments;
    iterations = iteration + 1;
  }

  return {
    price,
    forcedBookSales,
    forcedRepayments,
    totalForcedBookSales,
    totalForcedRepayments,
    iterations,
  };
};

const summarizePopulation = (
  households: readonly SyntheticHousehold[],
): PopulationSummary => ({
  sampledHouseholds: households.length,
  representedHouseholds: weightedSum(households, () => 1),
  representedAdults: weightedSum(households, (household) => household.adults),
  representedChildren: weightedSum(households, (household) => household.children),
  aggregateNetWorth: weightedSum(households, householdNetWorth),
  aggregateDeposits: weightedSum(households, (household) => household.assets.deposits),
  aggregatePublicEquity: weightedSum(
    households,
    (household) => household.assets.publicEquity,
  ),
  baselineAnnualConsumption: weightedSum(
    households,
    (household) =>
      household.annualIncome *
      baselineConsumptionShare(household.marginalPropensityToConsume),
  ),
});

// Baseline household consumption as a share of income, rising with the
// household's marginal propensity to consume (shared by runStrategy and the
// population summary so both use one calibration).
const baselineConsumptionShare = (marginalPropensityToConsume: number): number =>
  MODEL_CONSTANTS.baselineConsumptionIncomeShare +
  marginalPropensityToConsume * MODEL_CONSTANTS.baselineConsumptionMpcWeight;

const buildWealthTaxPolicy = (
  request: ComparisonRequestV1,
  exemption = request.wealthTax.exemption,
): WealthTaxPolicyV1 => ({
  unit: "tax-household",
  exemption,
  brackets: resolveBrackets(request, exemption),
  assets: {
    deposits: { inclusionRate: 1, valuationFactor: 1 },
    governmentBonds: { inclusionRate: 1, valuationFactor: 1 },
    publicEquity: { inclusionRate: 1, valuationFactor: 1 },
    housing: { inclusionRate: 1, valuationFactor: 1 },
    privateBusiness: {
      inclusionRate: request.behavior.privateBusinessInclusionRate,
      valuationFactor: 1,
    },
    retirementAssets: { inclusionRate: 0, valuationFactor: 1 },
  },
  liabilities: {
    mortgage: { deductibleRate: 1 },
    collateralizedLoan: { deductibleRate: 1 },
    consumerDebt: { deductibleRate: 0 },
  },
  installments: 4,
  allowDeferral: true,
});

// Graduated proposals (Warren, Sanders) specify absolute wealth thresholds, but
// the policy applies brackets to the post-exemption taxable base. The lowest
// threshold is the exemption, so rebase every threshold by it. Falls back to the
// single flat rate when no schedule is supplied.
const resolveBrackets = (
  request: ComparisonRequestV1,
  exemption: number,
): readonly TaxBracket[] => {
  const brackets = request.wealthTax.brackets;
  if (!brackets || brackets.length === 0) {
    return [{ threshold: 0, rate: request.wealthTax.rate }];
  }
  return brackets.map((bracket) => ({
    threshold: Math.max(0, bracket.threshold - exemption),
    rate: bracket.rate,
  }));
};

// Weighted average rate paid out of the taxable base (assessed tax ÷ base). For
// a flat policy this collapses to the single rate; for a graduated schedule it
// is the blended effective rate the projection needs to erode the out-year base
// consistently with year-one collections.
const resolveEffectiveTaxRate = (
  households: readonly SyntheticHousehold[],
  policy: WealthTaxPolicyV1,
): number => {
  let weightedTax = 0;
  let weightedBase = 0;
  for (const household of households) {
    const assessment = assessWealthTax(
      { assets: household.assets, liabilities: household.liabilities },
      policy,
    );
    weightedTax += household.weight * assessment.annualTax;
    weightedBase += household.weight * assessment.taxableBase;
  }
  return weightedBase > 0 ? weightedTax / weightedBase : policy.brackets[0]?.rate ?? 0;
};

// Avoidance and evasion erode the reported taxable base in proportion to the
// statutory rate (issue #6). avoidanceElasticity is the fraction of the base
// lost per percentage point of rate, so a 2% rate at elasticity 0.1 loses 20%
// of the base. Because the single-bracket tax is linear in the post-exemption
// base, scaling the assessed tax by this factor is exactly a base reduction.
// Elasticity 0 reproduces the full-compliance revenue.
const avoidanceComplianceFactor = (request: ComparisonRequestV1): number =>
  Math.max(
    0,
    1 - request.behavior.avoidanceElasticity * request.wealthTax.rate * 100,
  );

const resolveEffectiveExemption = (
  households: readonly SyntheticHousehold[],
  request: ComparisonRequestV1,
): number => {
  if (request.wealthTax.targetMode === "exemption") {
    return request.wealthTax.exemption;
  }
  const zeroExemptionPolicy = buildWealthTaxPolicy(request, 0);
  const ranked = households
    .map((household) => {
      const assessment = assessWealthTax(
        { assets: household.assets, liabilities: household.liabilities },
        zeroExemptionPolicy,
      );
      return {
        wealth: Math.max(
          0,
          assessment.includedAssets - assessment.deductibleLiabilities,
        ),
        weight: household.weight,
      };
    })
    .sort((left, right) => left.wealth - right.wealth);
  const totalWeight = ranked.reduce((sum, item) => sum + item.weight, 0);
  const cutoffWeight = totalWeight * (1 - request.wealthTax.topShare);
  let cumulativeWeight = 0;
  for (const item of ranked) {
    cumulativeWeight += item.weight;
    if (cumulativeWeight >= cutoffWeight) return item.wealth;
  }
  return ranked.at(-1)?.wealth ?? 0;
};

const consumptionShares = (
  percentile: number,
): Readonly<Record<ConsumptionSector, number>> => {
  const coefficients = MODEL_CONSTANTS.consumptionShareCoefficients;
  const raw = Object.fromEntries(
    SECTORS.map((sector) => [
      sector,
      coefficients[sector].base + percentile * coefficients[sector].slope,
    ]),
  ) as Record<ConsumptionSector, number>;
  const total = SECTORS.reduce((sum, sector) => sum + raw[sector], 0);
  return Object.fromEntries(
    SECTORS.map((sector) => [sector, raw[sector] / total]),
  ) as Record<ConsumptionSector, number>;
};

const emptySectorRecord = (): Record<ConsumptionSector, number> => ({
  housing: 0,
  food: 0,
  healthcare: 0,
  transportation: 0,
  energy: 0,
  "durable-goods": 0,
  discretionary: 0,
  services: 0,
});

const requireFunding = (
  funding: ReadonlyMap<string, HouseholdFunding>,
  householdId: string,
): HouseholdFunding => {
  const item = funding.get(householdId);
  if (!item) throw new Error(`Missing tax funding result for ${householdId}.`);
  return item;
};

const weightedSum = (
  households: readonly SyntheticHousehold[],
  select: (household: SyntheticHousehold) => number,
): number =>
  households.reduce(
    (total, household) => total + select(household) * household.weight,
    0,
  );
