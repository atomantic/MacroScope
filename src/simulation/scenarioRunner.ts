import type { WealthTaxPolicyV1 } from "../policies/schema.js";
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

const SUPPLY_SENSITIVITY: Readonly<Record<ConsumptionSector, number>> = {
  housing: 1.2,
  food: 0.6,
  healthcare: 0.9,
  transportation: 0.5,
  energy: 1.1,
  "durable-goods": 0.7,
  discretionary: 0.35,
  services: 0.5,
};

export const runComparison = (
  request: ComparisonRequestV1 = DEFAULT_COMPARISON_REQUEST,
): ComparisonResultV1 => {
  const generatedHouseholds = generateSyntheticPopulation({
    seed: request.seed,
    sampleSize: request.sampleSize,
    representedHouseholds: request.representedHouseholds,
  });
  const households = calibratePopulationToUs(
    generatedHouseholds,
    request.representedHouseholds,
  );
  const population = summarizePopulation(households);
  const policy = buildWealthTaxPolicy(request);
  const strategies = Object.fromEntries(
    STRATEGIES.map((strategy) => [
      strategy,
      runStrategy(households, population, policy, request, strategy),
    ]),
  ) as Record<PaymentStrategy, StrategyOutcome>;

  return {
    schemaVersion: request.schemaVersion,
    assumptions: request,
    population,
    strategies,
    projection: buildPolicyProjection(request, strategies),
    caveats: [
      "Results are conditional scenarios, not forecasts.",
      "Wealth-group totals are calibrated to the Federal Reserve DFA for 2026:Q1; within-group joint distributions remain stylized.",
      "Equity price impact and inflation are reduced-form assumptions exposed for sensitivity testing.",
      "The current closed economy assumes domestic buyers absorb all equity and housing sales.",
      "Housing is a slower last-resort transfer channel without endogenous regional price feedback in this slice.",
      "Wealth Gini values treat negative net worth as zero for the inequality calculation.",
      "The ten-year path is a transparent reduced-form projection with constant real policy flows, partial wage adjustment, and no private-loan bailout.",
    ],
  };
};

const runStrategy = (
  households: readonly SyntheticHousehold[],
  population: PopulationSummary,
  policy: WealthTaxPolicyV1,
  request: ComparisonRequestV1,
  strategy: PaymentStrategy,
): StrategyOutcome => {
  const funding = new Map<string, HouseholdFunding>();
  for (const household of households) {
    const tax = assessWealthTax(
      { assets: household.assets, liabilities: household.liabilities },
      policy,
    ).annualTax;
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
  const administrativeRate = 0.01;
  const leakageRate = 0.002;
  const fundingRatio =
    request.ubi.fundingRule === "revenue-constrained"
      ? Math.min(1, taxCollected / Math.max(1, requestedUbi * (1 + administrativeRate)))
      : 1;
  const ubiReceived = requestedUbi * fundingRatio * (1 - leakageRate);
  const leakage = requestedUbi * fundingRatio * leakageRate;
  const administrativeCost = requestedUbi * fundingRatio * administrativeRate;
  const governmentOutlays = ubiReceived + leakage + administrativeCost;

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
    const receivedUbi = grossUbi * fundingRatio * (1 - leakageRate);
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
      household.annualIncome * (0.52 + household.marginalPropensityToConsume * 0.25);
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

  const paidFromCash = weightedSum(households, (household) =>
    requireFunding(funding, household.id).cash,
  );
  const newLoans = weightedSum(households, (household) =>
    requireFunding(funding, household.id).borrowed,
  );
  const taxFundingResidual =
    taxCollected -
    weightedSum(households, (household) => {
      const item = requireFunding(funding, household.id);
      return item.cash + item.borrowed + item.equitySold + item.housingSold;
    });
  const depositsChange =
    newLoans - taxCollected + governmentOutlays - cascade.totalForcedRepayments;
  const depositsIdentityResidual =
    depositsChange -
    (newLoans - taxCollected + governmentOutlays - cascade.totalForcedRepayments);
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
        0.35 *
        (sector.baselineDemand / Math.max(1, population.baselineAnnualConsumption)),
    0,
  );
  const monetaryPolicyOffset = -(demandInflation + supplyConstraintInflation) * 0.4;
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
  const tolerance = Math.max(0.01, population.aggregatePublicEquity * 1e-10);
  const accountingPassed =
    Math.abs(depositsIdentityResidual) <= tolerance &&
    Math.abs(taxFundingResidual) <= tolerance &&
    Math.abs(equityQuantityResidual) <= tolerance &&
    Math.abs(housingQuantityResidual) <= tolerance;

  return {
    strategy,
    fiscal: {
      taxAssessed,
      taxCollected,
      taxDeferred: taxAssessed - taxCollected,
      requestedUbi,
      ubiReceived,
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
        cascade.totalForcedBookSales > Math.max(1, primaryBookSales * 0.1),
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
    accounting: {
      depositsIdentityResidual,
      taxFundingResidual,
      equityQuantityResidual,
      housingQuantityResidual,
      passed: accountingPassed,
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
  const cashBuffer = Math.max(5_000, household.annualIncome * 0.15);
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

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const nextPrice = Math.max(
      0.2,
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
          Math.max(0.01, price * (1 - request.market.maximumCollateralLtv)),
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

    if (iterationBookSales <= Math.max(0.01, totalEquity * 1e-10)) break;
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
    (household) => household.annualIncome * (0.52 + household.marginalPropensityToConsume * 0.25),
  ),
});

const buildWealthTaxPolicy = (
  request: ComparisonRequestV1,
): WealthTaxPolicyV1 => ({
  unit: "tax-household",
  exemption: request.wealthTax.exemption,
  brackets: [{ threshold: 0, rate: request.wealthTax.rate }],
  assets: {
    deposits: { inclusionRate: 1, valuationFactor: 1 },
    governmentBonds: { inclusionRate: 1, valuationFactor: 1 },
    publicEquity: { inclusionRate: 1, valuationFactor: 1 },
    housing: { inclusionRate: 1, valuationFactor: 1 },
    privateBusiness: { inclusionRate: 0.7, valuationFactor: 1 },
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

const consumptionShares = (
  percentile: number,
): Readonly<Record<ConsumptionSector, number>> => {
  const raw: Record<ConsumptionSector, number> = {
    housing: 0.32 - percentile * 0.13,
    food: 0.18 - percentile * 0.09,
    healthcare: 0.1 + percentile * 0.02,
    transportation: 0.12 - percentile * 0.02,
    energy: 0.08 - percentile * 0.035,
    "durable-goods": 0.07 + percentile * 0.015,
    discretionary: 0.05 + percentile * 0.13,
    services: 0.08 + percentile * 0.11,
  };
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
