import type { TaxBracket, WealthTaxPolicyV1 } from "../policies/schema.js";
import {
  applyWealthTaxpayerResponse,
  assessWealthTax,
  type TaxBracketAssessment,
} from "../policies/wealthTax.js";
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
import {
  buildPopulationFlowDiagnostics,
  calibratePopulationToUs,
  POPULATION_FLOW_CALIBRATION,
} from "./usBaseline.js";
import {
  buildPolicyProjection,
  type HouseholdProjectionTaxAssessment,
  type ProjectionDemandProfile,
} from "./projection.js";
import { computeStrategyAccounting } from "./ledgerAudit.js";
import { MODEL_CONSTANTS } from "./modelConstants.js";
import {
  initialFiscalStateForRequest,
  normalizedSurplusUse,
  resolveFiscalYear,
} from "./fiscal.js";

interface HouseholdFunding {
  readonly taxAssessed: number;
  readonly cash: number;
  readonly borrowed: number;
  readonly equitySold: number;
  readonly housingSold: number;
  readonly deferred: number;
}

interface HouseholdTaxAssessment {
  readonly weight: number;
  readonly taxableBase: number;
  readonly fullComplianceTax: number;
  readonly avoidedTax: number;
  readonly taxAssessed: number;
  readonly bracketBreakdown: readonly TaxBracketAssessment[];
}

interface StrategyRunResult {
  readonly outcome: StrategyOutcome;
  readonly taxCollectedByHousehold: ReadonlyMap<string, number>;
  readonly demandProfile: ProjectionDemandProfile;
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
  const householdTaxAssessments = buildHouseholdTaxAssessments(
    households,
    policy,
    request,
  );
  const strategyRuns = Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      runStrategy(
        households,
        population,
        householdTaxAssessments,
        request,
        strategy,
      ),
    ]),
  ) as Record<PaymentStrategy, StrategyRunResult>;
  const strategies = Object.fromEntries(
    STRATEGIES.map((strategy) => [strategy, strategyRuns[strategy].outcome]),
  ) as Record<PaymentStrategy, StrategyOutcome>;
  const projectionHouseholdAssessments: HouseholdProjectionTaxAssessment[] =
    households.map((household) => ({
      percentile: household.percentile,
      weight: household.weight,
      taxAssessed: requireTaxAssessment(
        householdTaxAssessments,
        household.id,
      ).taxAssessed,
      taxCollected: {
        "cash-first": requireCollectedTax(
          strategyRuns["cash-first"].taxCollectedByHousehold,
          household.id,
        ),
        "borrow-first": requireCollectedTax(
          strategyRuns["borrow-first"].taxCollectedByHousehold,
          household.id,
        ),
        "sell-first": requireCollectedTax(
          strategyRuns["sell-first"].taxCollectedByHousehold,
          household.id,
        ),
      },
    }));

  return {
    schemaVersion: request.schemaVersion,
    assumptions: request,
    wealthTaxTarget: {
      mode: request.wealthTax.targetMode,
      requestedExemption: request.wealthTax.exemption,
      topShare: request.wealthTax.topShare,
      effectiveExemption,
    },
    wealthTaxAssessment: summarizeWealthTaxAssessment(
      householdTaxAssessments,
      policy,
      effectiveExemption,
    ),
    population,
    strategies,
    projection: buildPolicyProjection(request, strategies, {
      effectiveTaxRate: resolveEffectiveTaxRate(householdTaxAssessments),
      householdAssessments: projectionHouseholdAssessments,
      demandProfiles: Object.fromEntries(
        STRATEGIES.map((strategy) => [strategy, strategyRuns[strategy].demandProfile]),
      ) as Record<PaymentStrategy, ProjectionDemandProfile>,
    }),
    caveats: [
      "Results are conditional scenarios, not forecasts.",
      "Every modeled asset and liability class is calibrated by wealth group to the Federal Reserve DFA for 2026:Q1; within-group joint distributions remain stylized.",
      "Adult and child counts match the July 2025 resident population estimate, including group-quarters residents and excluding nonresidents. Personal income and consumption retain their synthetic percentile shapes but reconcile independently to calendar-year 2025 BEA totals.",
      "Equity price impact and inflation are reduced-form assumptions exposed for sensitivity testing.",
      "The current closed economy assumes domestic buyers absorb all equity and housing sales.",
      "Housing sales remain a national, closed-economy transfer channel; the ten-year owner-renter view adds reduced-form price, supply, and rent feedback rather than regional market clearing.",
      "Wealth Gini values treat negative net worth as zero for the inequality calculation.",
      `The ten-year path is a transparent reduced-form projection with ${request.ubi.benefitIndexation === "cpi" ? "CPI-indexed policy benefits (one-year recognition lag)" : "fixed nominal policy benefits"}, a wealth-tax base that compounds with asset returns and erodes with taxes paid, partial wage adjustment, and no private-loan bailout.`,
      `Fiscal closure is explicit: the ${request.ubi.fundingRule} funding rule is paired with ${normalizedSurplusUse(request)} for revenue left after scheduled outlays and program-debt service. Program debt carries a documented average interest rate; this is a stock-flow score, not a Treasury maturity model.`,
      "Demand pressure is recomputed from each year's household cash, uniform rebates, and public-service sector mix; equal total outlays can therefore produce different inflation paths when their composition differs.",
      "The growth/investment channel is a reduced-form Solow-style block: investment deviates from the capital-replacement rate as the wealth tax lowers the after-tax return on wealth (savings response) and the transfer adds a demand impulse (demand offset); wages and real GDP per worker track the resulting capital stock. Both response dials default to zero, which holds output on the constant-trend baseline. It captures direction and rough magnitude, not a general-equilibrium forecast.",
      "Taxpayer-response dials act on the aggregate taxed base as reduced-form revenue multipliers: avoidance and the private-business inclusion rate scale year-one collections directly, while expatriation drains the top-tier sub-base gradually over the decade. The top-tier share comes from the same synthetic household collections as the cohort burdens, so exemptions that cut through a cohort and graduated rates are reflected in the split. The ten-year inflation stress grid evolves its revenue and private-loan flows with the same base dynamics (asset returns, effective-rate erosion, and top-tier expatriation), so its cells and hyperinflation threshold reflect them alongside avoidance and inclusion.",
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
  householdTaxAssessments: ReadonlyMap<string, HouseholdTaxAssessment>,
  request: ComparisonRequestV1,
  strategy: PaymentStrategy,
): StrategyRunResult => {
  const funding = new Map<string, HouseholdFunding>();
  for (const household of households) {
    const tax = requireTaxAssessment(
      householdTaxAssessments,
      household.id,
    ).taxAssessed;
    funding.set(household.id, fundTax(household, tax, strategy, request));
  }

  const taxAssessed = weightedSum(households, (household) =>
    requireFunding(funding, household.id).taxAssessed,
  );
  const taxCollected = weightedSum(households, (household) => {
    const item = requireFunding(funding, household.id);
    return item.cash + item.borrowed + item.equitySold + item.housingSold;
  });
  const taxCollectedByHousehold = new Map<string, number>(
    households.map((household) => {
      const item = requireFunding(funding, household.id);
      return [
        household.id,
        item.cash + item.borrowed + item.equitySold + item.housingSold,
      ];
    }),
  );
  const requestedUbi = weightedSum(
    households,
    (household) =>
      12 *
      (household.adults * request.ubi.adultMonthlyBenefit +
        household.children * request.ubi.childMonthlyBenefit),
  );
  const leakageRate = MODEL_CONSTANTS.programLeakageRate;
  const fiscal = resolveFiscalYear(
    {
      year: 1,
      taxRevenue: taxCollected,
      requestedProgramOutlay: requestedUbi,
      fundingRule: request.ubi.fundingRule,
      surplusUse: normalizedSurplusUse(request),
    },
    initialFiscalStateForRequest(request),
  ).year;
  const programBudget = fiscal.scheduledProgramOutlay;
  const fundingRatio = programBudget / Math.max(1, requestedUbi);
  const administrativeCost =
    programBudget * request.ubi.administrativeShare;
  const postAdministrationBudget = programBudget - administrativeCost;
  const leakage = postAdministrationBudget * leakageRate;
  const deliveredBudget = postAdministrationBudget - leakage;
  const scheduledCash = deliveredBudget * request.ubi.directCashShare;
  const ubiReceived = scheduledCash + fiscal.rebate;
  const publicServicesSpending =
    deliveredBudget * (1 - request.ubi.directCashShare) + fiscal.additionalServices;
  const governmentOutlays = fiscal.governmentOutlay;
  const householdScheduledCashRatio = scheduledCash / Math.max(1, requestedUbi);
  const rebatePerHousehold =
    fiscal.rebate / Math.max(1, population.representedHouseholds);

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
  const sectorBaseline = Object.fromEntries(
    SECTORS.map((sector) => [
      sector,
      population.baselineAnnualConsumption *
        POPULATION_FLOW_CALIBRATION.consumptionSectors.shares[sector],
    ]),
  ) as Record<ConsumptionSector, number>;
  const sectorChanges = emptySectorRecord();
  const taxCashDemandBySector = emptySectorRecord();
  const scheduledCashDemandNumerator = emptySectorRecord();
  const rebateDemandPerDollar = emptySectorRecord();
  let householdIndex = 0;
  for (const household of households) {
    const item = requireFunding(funding, household.id);
    const grossUbi =
      12 *
      (household.adults * request.ubi.adultMonthlyBenefit +
        household.children * request.ubi.childMonthlyBenefit);
    const receivedUbi = grossUbi * householdScheduledCashRatio + rebatePerHousehold;
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
      household.assets.retirementAssets +
      household.assets.otherAssets -
      household.liabilities.mortgage -
      collateralizedLoanAfter -
      household.liabilities.consumerDebt;
    const consumptionChange =
      (receivedUbi - item.cash) * household.marginalPropensityToConsume;
    consumptionDemandChange += consumptionChange * household.weight;
    const shares = consumptionShares(household.percentile);
    for (const sector of SECTORS) {
      sectorChanges[sector] += consumptionChange * shares[sector] * household.weight;
      taxCashDemandBySector[sector] -=
        item.cash *
        household.marginalPropensityToConsume *
        shares[sector] *
        household.weight;
      scheduledCashDemandNumerator[sector] +=
        grossUbi *
        household.marginalPropensityToConsume *
        shares[sector] *
        household.weight;
      rebateDemandPerDollar[sector] +=
        (household.marginalPropensityToConsume *
          shares[sector] *
          household.weight) /
        Math.max(1, population.representedHouseholds);
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
    newLoans - taxCollected + governmentOutlays + fiscal.debtRepaid -
    cascade.totalForcedRepayments;
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
      otherGovernmentOutlays:
        governmentOutlays - ubiReceived + fiscal.debtRepaid,
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
    outcome: {
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
        scheduledProgramOutlay: fiscal.scheduledProgramOutlay,
        additionalServices: fiscal.additionalServices,
        rebate: fiscal.rebate,
        debtIssued: fiscal.debtIssued,
        debtRepaid: fiscal.debtRepaid,
        treasuryBalance: fiscal.treasuryBalance,
        budgetIdentityResidual: fiscal.budgetIdentityResidual,
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
        wealthGiniBefore: weightedGini(
          distributionRecords,
          (record) => record.netWorthBefore,
        ),
        wealthGiniAfter: weightedGini(
          distributionRecords,
          (record) => record.netWorthAfter,
        ),
        deciles: buildDeciles(distributionRecords),
      },
      accounting,
    },
    taxCollectedByHousehold,
    demandProfile: {
      baselineAnnualConsumption: population.baselineAnnualConsumption,
      taxCashDemandBySector,
      scheduledCashDemandPerDollar: Object.fromEntries(
        SECTORS.map((sector) => [
          sector,
          scheduledCashDemandNumerator[sector] / Math.max(1, requestedUbi),
        ]),
      ) as Record<ConsumptionSector, number>,
      rebateDemandPerDollar,
    },
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
  aggregateAnnualIncome: weightedSum(
    households,
    (household) => household.annualIncome,
  ),
  baselineAnnualConsumption: weightedSum(
    households,
    (household) => household.annualConsumption,
  ),
  calibration: buildPopulationFlowDiagnostics(households),
});

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
    otherAssets: { inclusionRate: 1, valuationFactor: 1 },
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

// Assess each synthetic household once, then reuse that result for all payment
// strategies, projection attribution, and the effective-rate calculation. The
// strategy-specific collected amount may differ because a household can defer
// tax it cannot fund, but its statutory assessment is common to every strategy.
const buildHouseholdTaxAssessments = (
  households: readonly SyntheticHousehold[],
  policy: WealthTaxPolicyV1,
  request: ComparisonRequestV1,
): ReadonlyMap<string, HouseholdTaxAssessment> => {
  return new Map(
    households.map((household) => {
      const assessment = assessWealthTax(
        { assets: household.assets, liabilities: household.liabilities },
        policy,
      );
      const response = applyWealthTaxpayerResponse(
        assessment,
        request.behavior.avoidanceElasticity,
      );
      return [
        household.id,
        {
          weight: household.weight,
          taxableBase: assessment.taxableBase,
          fullComplianceTax: assessment.annualTax,
          avoidedTax: response.avoidedTax,
          taxAssessed: response.taxAssessed,
          bracketBreakdown: assessment.bracketBreakdown,
        },
      ];
    }),
  );
};

// Weighted average response-adjusted rate paid out of the taxable base. This
// prevents avoided tax from eroding the projection's wealth base as if it had
// been collected; with no avoidance it reduces to the full statutory rate.
const resolveEffectiveTaxRate = (
  assessments: ReadonlyMap<string, HouseholdTaxAssessment>,
): number => {
  let weightedTax = 0;
  let weightedBase = 0;
  for (const household of assessments.values()) {
    weightedTax += household.taxAssessed * household.weight;
    weightedBase += household.taxableBase * household.weight;
  }
  return weightedBase > 0 ? weightedTax / weightedBase : 0;
};

const summarizeWealthTaxAssessment = (
  assessments: ReadonlyMap<string, HouseholdTaxAssessment>,
  policy: WealthTaxPolicyV1,
  exemption: number,
) => {
  let taxableBase = 0;
  let fullComplianceTax = 0;
  let responseAdjustedTax = 0;
  let avoidedTax = 0;
  let taxpayerHouseholds = 0;
  const brackets = policy.brackets.map((bracket, index) => {
    const nextThreshold = policy.brackets[index + 1]?.threshold;
    return {
      threshold: bracket.threshold + exemption,
      upperThreshold: nextThreshold === undefined ? null : nextThreshold + exemption,
      rate: bracket.rate,
      taxableAmount: 0,
      tax: 0,
    };
  });
  for (const assessment of assessments.values()) {
    taxableBase += assessment.taxableBase * assessment.weight;
    fullComplianceTax += assessment.fullComplianceTax * assessment.weight;
    responseAdjustedTax += assessment.taxAssessed * assessment.weight;
    avoidedTax += assessment.avoidedTax * assessment.weight;
    if (assessment.taxAssessed > 0) taxpayerHouseholds += assessment.weight;
    for (const [index, bracket] of assessment.bracketBreakdown.entries()) {
      const summary = brackets[index];
      if (!summary) continue;
      summary.taxableAmount += bracket.taxableAmount * assessment.weight;
      summary.tax += bracket.tax * assessment.weight;
    }
  }
  return {
    taxableBase,
    fullComplianceTax,
    responseAdjustedTax,
    avoidedTax,
    effectiveRate: taxableBase > 0 ? responseAdjustedTax / taxableBase : 0,
    taxpayerHouseholds,
    brackets,
  };
};

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

const requireTaxAssessment = (
  assessments: ReadonlyMap<string, HouseholdTaxAssessment>,
  householdId: string,
): HouseholdTaxAssessment => {
  const assessment = assessments.get(householdId);
  if (!assessment) throw new Error(`Missing tax assessment for ${householdId}.`);
  return assessment;
};

const requireCollectedTax = (
  collectedTax: ReadonlyMap<string, number>,
  householdId: string,
): number => {
  const collected = collectedTax.get(householdId);
  if (collected === undefined) {
    throw new Error(`Missing collected tax for ${householdId}.`);
  }
  return collected;
};

const weightedSum = (
  households: readonly SyntheticHousehold[],
  select: (household: SyntheticHousehold) => number,
): number =>
  households.reduce(
    (total, household) => total + select(household) * household.weight,
    0,
  );
