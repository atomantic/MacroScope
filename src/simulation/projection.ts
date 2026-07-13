import type {
  ComparisonRequestV1,
  InflationRegime,
  PaymentStrategy,
  PolicyProjection,
  StrategyOutcome,
  StressCell,
} from "./contracts.js";
import { US_BASELINE } from "./usBaseline.js";

const YEARS = 10;
const REAL_GROWTH = 0.01;
const ANNUAL_LOAN_AMORTIZATION = 0.1;
// Share of policy-driven excess inflation assumed to pass through into the
// nominal prices of the taxed asset base each year.
const ASSET_PRICE_INFLATION_PASS_THROUGH = 0.5;
// Numerical ceiling on modeled annual inflation. Far above the strict
// hyperinflation threshold (50%/month ≈ 129x/year) so regime classification
// is unaffected, but keeps indexed-benefit feedback loops finite over the
// ten-year horizon for every API-accepted input combination.
const MAX_ANNUAL_INFLATION = 10_000;
// Treasury surplus drains cannot destroy the whole money stock: in reality a
// sustained surplus retires debt or is respent. This reduced-form floor keeps
// M2 (and everything derived from it) positive for every accepted input.
const M2_FLOOR = US_BASELINE.m2 * 0.1;
const STRICT_HYPER_MONTHLY_RATE = 0.5;
const STRICT_HYPER_ANNUAL_RATE = (1 + STRICT_HYPER_MONTHLY_RATE) ** 12 - 1;
const BASELINE_RENTER_HOUSING_COST_SHARE = 0.31;

type Strategies = Readonly<Record<PaymentStrategy, StrategyOutcome>>;

export const buildPolicyProjection = (
  request: ComparisonRequestV1,
  strategies: Strategies,
  // Average rate actually paid out of the taxable base in year one (assessed
  // tax ÷ taxable base). For a flat schedule this equals wealthTax.rate; for a
  // graduated schedule (Warren/Sanders) it is the blended effective rate, so
  // the out-year base erosion below stays consistent with year-one collections
  // instead of under-eroding at the lowest bracket rate. Defaults to the flat
  // rate for callers that don't compute it.
  effectiveTaxRate: number = request.wealthTax.rate,
): PolicyProjection => {
  const weights = strategyWeights(request);
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
  const ubiReceived = blended((outcome) => outcome.fiscal.ubiReceived);
  const publicServicesSpending = blended(
    (outcome) => outcome.fiscal.publicServicesSpending,
  );
  const administrativeCost = blended(
    (outcome) => outcome.fiscal.administrativeCost,
  );
  const newPrivateLoans = blended(
    (outcome) => outcome.funding.newCollateralizedLoans,
  );
  const assetSales = blended(
    (outcome) => outcome.markets.totalEquitySales + outcome.markets.housingSold,
  );
  const rawGovernmentDeficit = Math.max(
    0,
    -blended((outcome) => outcome.fiscal.governmentBalance),
  );
  const governmentDeficit = rawGovernmentDeficit < 1_000_000 ? 0 : rawGovernmentDeficit;
  const demandInflation = blended(
    (outcome) => outcome.macro.estimatedInflationChange,
  );
  const bottom50AnnualUbi = averageBottomHalf(
    strategies,
    weights,
    (decile) => decile.averageUbiReceived,
  );
  const requestedUbi = blended((outcome) => outcome.fiscal.requestedUbi);

  // Reduced-form wealth-tax base dynamics: the taxable base compounds with the
  // selected nominal asset return plus partial pass-through of policy-driven
  // excess inflation into asset prices, and shrinks by the statutory rate paid
  // out of the base each year (so cumulative tax paid compounds against it).
  // Year 1 reproduces the strategy outcomes exactly (multiplier = 1).
  let taxBaseMultiplier = 1;
  const yearOneProgramBudget =
    request.ubi.fundingRule === "revenue-constrained"
      ? Math.min(requestedUbi, taxCollected)
      : requestedUbi;
  const yearOneSurplus = Math.max(0, taxCollected - yearOneProgramBudget);
  const yearOneM2Injection = Math.max(
    newPrivateLoans +
      governmentDeficit * request.behavior.deficitMonetizationShare -
      yearOneSurplus,
    M2_FLOOR - US_BASELINE.m2,
  );
  let finalYearFlows = {
    taxCollected,
    ubiReceived,
    publicServicesSpending,
    administrativeCost,
    newPrivateLoans,
    governmentDeficit,
    m2Injection: yearOneM2Injection,
  };

  let m2 = US_BASELINE.m2;
  let priceLevel = 1;
  let baselinePriceLevel = 1;
  let privateTaxDebt = 0;
  let publicDebt = 0;
  let confidence = 1;
  let bottomWageBase = (US_BASELINE.annualPce * 0.3) / (US_BASELINE.households * 0.5);
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
  const theoryYears: PolicyProjection["theoryTest"]["years"][number][] = [
    {
      year: 0,
      liquiditySeekingAssets: 0,
      housingPriceIndex: 100,
      equityPriceIndex: 100,
      middleHomeownerWealthIndex: 100,
      bottomRenterHousingBurdenIndex: 100,
      bottomRenterDisposableIncomeIndex: 100,
    },
  ];
  const years: PolicyProjection["years"][number][] = [
    {
      year: 0,
      annualInflation: US_BASELINE.baselineInflation,
      monthlyInflation: annualToMonthly(US_BASELINE.baselineInflation),
      priceLevel,
      m2,
      m2Index: 100,
      privateTaxDebt,
      governmentDebtAdded: publicDebt,
      bottom50PurchasingPowerIndex: 100,
      top1RealWealthIndex: 100,
      confidenceIndex: confidence * 100,
      regime: regimeForInflation(US_BASELINE.baselineInflation),
    },
  ];

  for (let year = 1; year <= YEARS; year += 1) {
    // CPI indexation applies the last observed policy price level (a one-year
    // recognition lag), so year 1 always matches the strategy outcomes.
    const indexation = request.ubi.benefitIndexation === "cpi" ? priceLevel : 1;
    const taxCollectedYear = taxCollected * taxBaseMultiplier;
    const newPrivateLoansYear = newPrivateLoans * taxBaseMultiplier;
    const requestedUbiYear = requestedUbi * indexation;
    const programBudgetYear =
      request.ubi.fundingRule === "revenue-constrained"
        ? Math.min(requestedUbiYear, taxCollectedYear)
        : requestedUbiYear;
    const budgetScale = programBudgetYear / Math.max(1, yearOneProgramBudget);
    const rawDeficitYear = Math.max(0, programBudgetYear - taxCollectedYear);
    const governmentDeficitYear = rawDeficitYear < 1_000_000 ? 0 : rawDeficitYear;
    // Revenue collected beyond the program budget stays at Treasury, removing
    // deposits from M2 until spent — a drain symmetric to the monetized deficit.
    const surplusYear = Math.max(0, taxCollectedYear - programBudgetYear);
    const bottom50UbiYear = bottom50AnnualUbi * budgetScale;

    const repayments = privateTaxDebt * ANNUAL_LOAN_AMORTIZATION;
    privateTaxDebt = Math.max(0, privateTaxDebt + newPrivateLoansYear - repayments);
    publicDebt += governmentDeficitYear;
    const moneyInjection = Math.max(
      newPrivateLoansYear - repayments +
        governmentDeficitYear * request.behavior.deficitMonetizationShare -
        surplusYear,
      M2_FLOOR - m2,
    );
    const moneyGrowth = moneyInjection / Math.max(1, m2);
    m2 += moneyInjection;

    // Tax-payment loans do not buy assets directly: they settle with Treasury.
    // This separate, exposed assumption asks how much of the resulting liquidity
    // is later recycled into inflation hedges by its eventual holders.
    const liquiditySeekingAssets =
      Math.max(0, moneyInjection) * request.behavior.assetHedgeShare;
    const housingDemand =
      liquiditySeekingAssets * request.behavior.housingHedgeShare;
    const equityDemand = liquiditySeekingAssets - housingDemand;
    const housingPricePressure =
      (housingDemand / Math.max(1, housingWealth)) /
      (0.25 + request.market.housingSupplyElasticity);
    const equityPricePressure =
      (equityDemand / Math.max(1, publicEquityWealth)) *
      (1 + request.market.priceImpactCoefficient * 4);
    housingPriceIndex *= 1 + housingPricePressure;
    equityPriceIndex *= 1 + equityPricePressure;
    rentPremiumIndex *=
      1 + housingPricePressure * request.behavior.rentPassThrough;

    const stress = inflationFromStress({
      baselineInflation: US_BASELINE.baselineInflation,
      // The transfer creates a level shock; domestic supply and wages partially
      // adapt rather than repeating the full first-year shock forever. The
      // shock also scales with the REAL size of this year's program relative
      // to year one (budgetScale is nominal; priceLevel here is still the
      // prior year's level, matching the indexation lag), so an eroding base
      // or a melting nominal benefit reduces demand pressure while an indexed
      // benefit sustains it. Year 1: budgetScale = priceLevel = 1.
      demandInflation:
        demandInflation * Math.exp(-(year - 1) / 3) * (budgetScale / priceLevel),
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

    bottomWageBase *=
      1 + REAL_GROWTH + US_BASELINE.baselineInflation +
      Math.max(0, annualInflation - US_BASELINE.baselineInflation) * 0.55;
    baselineResources *= 1 + REAL_GROWTH + US_BASELINE.baselineInflation;
    const policyRealResources = (bottomWageBase + bottom50UbiYear) / priceLevel;
    const baselineRealResources = baselineResources / baselinePriceLevel;

    const topTaxBurden = taxCollectedYear * 0.8;
    const interestCost = privateTaxDebt * request.behavior.loanInterestRate * 0.8;
    topWealth = Math.max(
      0,
      topWealth * (1 + request.behavior.annualAssetReturn) - topTaxBurden - interestCost,
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
      liquiditySeekingAssets,
      housingPriceIndex: housingPriceIndex * 100,
      equityPriceIndex: equityPriceIndex * 100,
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
      annualInflation,
      monthlyInflation: annualToMonthly(annualInflation),
      priceLevel,
      m2,
      m2Index: (m2 / US_BASELINE.m2) * 100,
      privateTaxDebt,
      governmentDebtAdded: publicDebt,
      bottom50PurchasingPowerIndex:
        (policyRealResources / Math.max(1, baselineRealResources)) * 100,
      top1RealWealthIndex:
        (topWealth / priceLevel) /
        Math.max(1, baselineTopWealth / baselinePriceLevel) *
        100,
      confidenceIndex: confidence * 100,
      regime: regimeForInflation(annualInflation),
    });

    finalYearFlows = {
      taxCollected: taxCollectedYear,
      ubiReceived: ubiReceived * budgetScale,
      publicServicesSpending: publicServicesSpending * budgetScale,
      administrativeCost: administrativeCost * budgetScale,
      newPrivateLoans: newPrivateLoansYear,
      governmentDeficit: governmentDeficitYear,
      m2Injection: moneyInjection,
    };
    // Evolve the taxable base for next year: nominal asset returns plus partial
    // excess-inflation pass-through grow it; the statutory rate erodes it.
    taxBaseMultiplier = Math.max(
      0,
      taxBaseMultiplier *
        (1 +
          request.behavior.annualAssetReturn +
          Math.max(0, annualInflation - US_BASELINE.baselineInflation) *
            ASSET_PRICE_INFLATION_PASS_THROUGH) *
        (1 - effectiveTaxRate),
    );
  }

  const finalYear = years.at(-1);
  if (!finalYear) throw new Error("Projection did not produce a final year.");
  const peakAnnualInflation = Math.max(...years.slice(1).map((year) => year.annualInflation));
  const bottom50PurchasingPowerChange = finalYear.bottom50PurchasingPowerIndex / 100 - 1;
  const top1RealWealthChange = finalYear.top1RealWealthIndex / 100 - 1;
  const publicBurdenPerHousehold = publicDebt / US_BASELINE.households;
  const verdict = makeVerdict({
    bottom50PurchasingPowerChange,
    peakAnnualInflation,
    publicBurdenPerHousehold,
    borrowShare: weights.borrow,
  });
  const stressTest = buildStressTest(
    strategies,
    newPrivateLoans,
    taxCollected,
    request.ubi.benefitIndexation ?? "none",
  );
  const theoryTest = buildTheoryTest(request, theoryYears, finalYear.m2Index / 100 - 1);

  return {
    verdict,
    behaviorMix: {
      cashShare: weights.cash,
      borrowShare: weights.borrow,
      sellShare: weights.sell,
    },
    annualFlows: {
      taxCollected,
      ubiReceived,
      publicServicesSpending,
      administrativeCost,
      newPrivateLoans,
      assetSales,
      governmentDeficit,
      m2Injection: yearOneM2Injection,
      finalYear: finalYearFlows,
    },
    summary: {
      peakAnnualInflation,
      cumulativeM2Change: finalYear.m2Index / 100 - 1,
      bottom50PurchasingPowerChange,
      top1RealWealthChange,
      privateTaxDebt,
      publicBurdenPerHousehold,
      firstHyperinflationYear:
        years.find((year) => year.monthlyInflation >= STRICT_HYPER_MONTHLY_RATE)?.year ??
        null,
    },
    years,
    stressTest,
    theoryTest,
    interpretation: [
      "A tax-funded UBI moves existing deposits between households; it does not by itself create money.",
      "Bank borrowing creates deposits while the tax loans remain outstanding, so borrowing can expand M2 and add inflation pressure even when the federal budget balances.",
      "Private loans remain liabilities of the wealthy borrowers. They become a burden on other households only if losses are later socialized through bailouts, guarantees, or inflationary deficit finance; this model assumes no such bailout.",
      "Purchasing-power results compare the bottom half with a no-policy baseline after prices; they include partial wage adjustment and an annual UBI flow.",
      "The asset-price and rent channel is not implied by the accounting identities. It activates only when the selected share of new liquidity seeks housing or equities, housing supply is constrained, and rents follow asset prices.",
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

  const hasMonetaryLink = cumulativeM2Change > 0.005;
  const hasAssetLink = housingPriceChange > 0.005 || equityPriceChange > 0.005;
  const hasRenterHarm = bottomRenterHousingBurdenChange > 0.005;
  const hasWiderPositionGap = housingPositionGapChange > 0.01;
  const rating =
    hasMonetaryLink && hasAssetLink && hasRenterHarm && hasWiderPositionGap
      ? "active"
      : hasMonetaryLink && hasAssetLink
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
            "Borrowing expands deposits and the selected portfolio response lifts asset prices, but income support, housing supply, or weak rent pass-through prevents a clear widening of renter housing burden.",
        }
      : {
          rating,
          headline: "The proposed feedback loop breaks under these assumptions.",
          explanation:
            "Borrowing or the portfolio shift is too small to produce a material policy-linked asset-price and rent effect in this reduced-form test.",
        };

  return {
    verdict,
    assumptions: {
      assetHedgeShare: request.behavior.assetHedgeShare,
      housingHedgeShare: request.behavior.housingHedgeShare,
      housingSupplyElasticity: request.market.housingSupplyElasticity,
      rentPassThrough: request.behavior.rentPassThrough,
      baselineRenterHousingCostShare: BASELINE_RENTER_HOUSING_COST_SHARE,
    },
    summary: {
      annualLiquiditySeekingAssets,
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

const strategyWeights = (request: ComparisonRequestV1) => ({
  borrow: request.behavior.borrowShare,
  sell: request.behavior.sellShare,
  cash: Math.max(0, 1 - request.behavior.borrowShare - request.behavior.sellShare),
});

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

const inflationFromStress = (input: {
  baselineInflation: number;
  demandInflation: number;
  moneyGrowth: number;
  monetizedDeficitRatio: number;
  priorConfidence: number;
}): { inflation: number; confidence: number } => {
  const financingStress = Math.max(0, input.moneyGrowth - 0.025);
  const confidenceLoss = Math.max(
    0,
    financingStress * 0.22 + input.monetizedDeficitRatio * 0.35 - 0.015,
  );
  const confidence = Math.max(0.05, input.priorConfidence - confidenceLoss);
  const velocityPressure = (1 - confidence) ** 2 * 1.5;
  const inflation = Math.min(
    MAX_ANNUAL_INFLATION,
    Math.max(
      -0.02,
      input.baselineInflation +
        input.demandInflation +
        financingStress * 0.35 +
        input.monetizedDeficitRatio * 0.25 +
        velocityPressure,
    ),
  );
  return { inflation, confidence };
};

const buildStressTest = (
  strategies: Strategies,
  newPrivateLoans: number,
  taxCollected: number,
  benefitIndexation: "none" | "cpi",
): PolicyProjection["stressTest"] => {
  const ubiMultipliers = [0.5, 1, 2, 4, 8] as const;
  const monetizationShares = [0, 0.25, 0.5, 0.75, 1] as const;
  const requestedUbi = strategies["cash-first"].fiscal.requestedUbi;
  const cells: StressCell[] = [];
  for (const multiplier of ubiMultipliers) {
    for (const monetizationShare of monetizationShares) {
      const peak = stressPeak({
        requestedUbi: requestedUbi * multiplier,
        taxCollected,
        newPrivateLoans,
        monetizationShare,
        benefitIndexation,
        demandInflation:
          strategies["cash-first"].macro.estimatedInflationChange * multiplier,
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
  for (let multiplier = 1; multiplier <= 4_096; multiplier *= 2) {
    const peak = stressPeak({
      requestedUbi: requestedUbi * multiplier,
      taxCollected,
      newPrivateLoans,
      monetizationShare: 1,
      benefitIndexation,
      demandInflation:
        strategies["cash-first"].macro.estimatedInflationChange * multiplier,
    });
    if (annualToMonthly(peak) >= STRICT_HYPER_MONTHLY_RATE) {
      firstUbiMultiplierAtFullMonetization = multiplier;
      break;
    }
  }

  return {
    ubiMultipliers,
    monetizationShares,
    cells,
    threshold: {
      definition: "50% inflation per month (Cagan convention)",
      firstUbiMultiplierAtFullMonetization,
      annualInflationEquivalent: STRICT_HYPER_ANNUAL_RATE,
      explanation:
        firstUbiMultiplierAtFullMonetization === null
          ? "No strict hyperinflation breach occurs even at 4,096× the selected UBI under this reduced-form stress test."
          : `The first tested strict breach occurs around ${firstUbiMultiplierAtFullMonetization}× the selected UBI only when its unfunded portion is fully monetized and confidence is allowed to erode.`,
    },
  };
};

const stressPeak = (input: {
  requestedUbi: number;
  taxCollected: number;
  newPrivateLoans: number;
  monetizationShare: number;
  benefitIndexation: "none" | "cpi";
  demandInflation: number;
}): number => {
  let m2 = US_BASELINE.m2;
  let confidence = 1;
  let privateDebt = 0;
  let priceLevel = 1;
  let peak: number = US_BASELINE.baselineInflation;
  for (let year = 1; year <= YEARS; year += 1) {
    // CPI-indexed benefits grow the stressed outlay with the prior year's
    // price level (same one-year recognition lag as the main projection).
    const indexation = input.benefitIndexation === "cpi" ? priceLevel : 1;
    const outlay = input.requestedUbi * indexation * 1.012;
    const deficit = Math.max(0, outlay - input.taxCollected);
    // Same Treasury-surplus drain and M2 floor as the main projection loop.
    const surplus = Math.max(0, input.taxCollected - outlay);
    const repayments = privateDebt * ANNUAL_LOAN_AMORTIZATION;
    privateDebt = Math.max(0, privateDebt + input.newPrivateLoans - repayments);
    const injection = Math.max(
      input.newPrivateLoans - repayments +
        deficit * input.monetizationShare -
        surplus,
      M2_FLOOR - m2,
    );
    const stress = inflationFromStress({
      baselineInflation: US_BASELINE.baselineInflation,
      demandInflation: input.demandInflation,
      moneyGrowth: injection / Math.max(1, m2),
      monetizedDeficitRatio:
        (deficit * input.monetizationShare) / US_BASELINE.nominalGdp,
      priorConfidence: confidence,
    });
    confidence = stress.confidence;
    m2 += injection;
    priceLevel *= 1 + stress.inflation;
    peak = Math.max(peak, stress.inflation);
  }
  return peak;
};

const makeVerdict = (input: {
  bottom50PurchasingPowerChange: number;
  peakAnnualInflation: number;
  publicBurdenPerHousehold: number;
  borrowShare: number;
}): PolicyProjection["verdict"] => {
  const harmful =
    input.bottom50PurchasingPowerChange < -0.02 ||
    input.peakAnnualInflation >= 0.2 ||
    input.publicBurdenPerHousehold >= 50_000;
  const beneficial =
    input.bottom50PurchasingPowerChange >= 0.02 &&
    input.peakAnnualInflation < 0.1 &&
    input.publicBurdenPerHousehold < 10_000;
  if (harmful) {
    return {
      rating: "harmful",
      headline: "The inflation or debt cost overwhelms the transfer gain.",
      explanation:
        "Under these assumptions, the bottom half ends with less relative buying power or the financing path enters a high-risk inflation/debt regime.",
    };
  }
  if (beneficial) {
    return {
      rating: "beneficial",
      headline:
        input.borrowShare > 0.5
          ? "The bottom half gains, but borrowing makes the result more fragile."
          : "The bottom half gains buying power without a modeled inflation crisis.",
      explanation:
        "The annual transfer remains larger than the modeled loss from higher prices, while the federal balance and inflation stay inside the model’s guardrails.",
    };
  }
  return {
    rating: "mixed",
    headline: "The benefit fades to near break-even—and borrowing is why.",
    explanation:
      "The bottom half gains at first, but most of that advantage is lost as prices adjust. The result is highly sensitive to whether wealthy households borrow or sell assets to pay the tax.",
  };
};

const regimeForInflation = (annualInflation: number): InflationRegime => {
  if (annualToMonthly(annualInflation) >= STRICT_HYPER_MONTHLY_RATE) {
    return "hyperinflation";
  }
  if (annualInflation >= 5) return "extreme";
  if (annualInflation >= 0.5) return "crisis";
  if (annualInflation >= 0.1) return "high";
  if (annualInflation >= 0.05) return "elevated";
  return "stable";
};

const annualToMonthly = (annualRate: number): number =>
  Math.max(-0.99, (1 + Math.max(-0.99, annualRate)) ** (1 / 12) - 1);

const topOnePercentWealth = (): number =>
  US_BASELINE.wealthGroups
    .filter((group) => group.percentileMinimum >= 0.99)
    .reduce((sum, group) => sum + group.netWorth, 0);

const totalHousingWealth = (): number =>
  US_BASELINE.wealthGroups.reduce((sum, group) => sum + group.realEstate, 0);

const totalPublicEquityWealth = (): number =>
  US_BASELINE.wealthGroups.reduce((sum, group) => sum + group.publicEquity, 0);

const middleFortyHousingToNetWorth = (): number => {
  const group = US_BASELINE.wealthGroups.find(
    (candidate) => candidate.id === "next-40",
  );
  if (!group) throw new Error("Missing middle-forty wealth baseline.");
  return group.realEstate / Math.max(1, group.netWorth);
};
