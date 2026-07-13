import type {
  ComparisonRequestV1,
  InflationRegime,
  PaymentStrategy,
  PolicyProjection,
  StrategyOutcome,
  StressCell,
  WealthGroupOutcome,
} from "./contracts.js";
import { US_BASELINE, type UsWealthGroupBaseline } from "./usBaseline.js";
import { MODEL_CONSTANTS } from "./modelConstants.js";

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
// A cohort ends "better off"/"worse off" once its leading real measure clears
// this band around the no-policy path; inside it the result reads as mixed.
const GROUP_OUTCOME_BAND = MODEL_CONSTANTS.groupOutcomeBand;

type Strategies = Readonly<Record<PaymentStrategy, StrategyOutcome>>;

export const buildPolicyProjection = (
  request: ComparisonRequestV1,
  strategies: Strategies,
  effectiveExemption: number = request.wealthTax.exemption,
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
  const governmentDeficit =
    rawGovernmentDeficit < MODEL_CONSTANTS.deficitRoundingFloor ? 0 : rawGovernmentDeficit;
  const demandInflation = blended(
    (outcome) => outcome.macro.estimatedInflationChange,
  );
  const bottom50AnnualUbi = averageBottomHalf(
    strategies,
    weights,
    (decile) => decile.averageUbiReceived,
  );
  const requestedUbi = blended((outcome) => outcome.fiscal.requestedUbi);

  // Allocate each year's collected tax across the calibrated U.S. wealth groups
  // by their net worth above the effective exemption. The engine's total tax is
  // authoritative; this only apportions it so every cohort gets an explicit
  // burden. Under a high exemption only the top groups carry a positive share.
  const groupTaxShare = new Map<string, number>();
  const groupTaxableBase = US_BASELINE.wealthGroups.map((group) => ({
    id: group.id,
    taxable: Math.max(0, group.netWorth - effectiveExemption * group.households),
  }));
  const totalTaxableBase = groupTaxableBase.reduce((sum, group) => sum + group.taxable, 0);
  if (totalTaxableBase > 0) {
    for (const group of groupTaxableBase) {
      groupTaxShare.set(group.id, group.taxable / totalTaxableBase);
    }
  } else {
    // A very high exemption (e.g. the "10% over $1B" preset) sits above every
    // cohort's AVERAGE wealth, so no group-level base is positive — yet the
    // synthetic top tail still pays. Attribute the whole burden to the
    // wealthiest cohort rather than reporting $0 tax for everyone.
    const wealthiest = [...US_BASELINE.wealthGroups].sort(
      (left, right) =>
        right.netWorth / Math.max(1, right.households) -
        left.netWorth / Math.max(1, left.households),
    )[0];
    for (const group of groupTaxableBase) {
      groupTaxShare.set(group.id, group.id === wealthiest?.id ? 1 : 0);
    }
  }
  const cumulativeGroupTax = new Map<string, number>(
    US_BASELINE.wealthGroups.map((group) => [group.id, 0]),
  );

  // Reduced-form wealth-tax base dynamics: the taxable base compounds with the
  // selected nominal asset return plus partial pass-through of policy-driven
  // excess inflation into asset prices, and shrinks by the statutory rate paid
  // out of the base each year (so cumulative tax paid compounds against it).
  // Year 1 reproduces the strategy outcomes exactly (multiplier = 1).
  let taxBaseMultiplier = 1;
  // Expatriation drains a cumulative share of the taxable base over the decade
  // (issue #6). It acts on the aggregate taxed base (taxBaseMultiplier below),
  // which equals top-tier wealth whenever a positive exemption confines the tax
  // to the top; under a universal (zero-exemption) tax it approximates the whole
  // taxed base leaving. Spread geometrically so each year retains an equal
  // fraction and the base has lost expatriationShare by year ten. Share 0 leaves
  // the retention at 1 and reproduces the prior path.
  const expatriationRetention =
    (1 - request.behavior.expatriationShare) ** (1 / YEARS);
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
    for (const [id, share] of groupTaxShare) {
      cumulativeGroupTax.set(id, (cumulativeGroupTax.get(id) ?? 0) + taxCollectedYear * share);
    }
    const newPrivateLoansYear = newPrivateLoans * taxBaseMultiplier;
    const requestedUbiYear = requestedUbi * indexation;
    const programBudgetYear =
      request.ubi.fundingRule === "revenue-constrained"
        ? Math.min(requestedUbiYear, taxCollectedYear)
        : requestedUbiYear;
    const budgetScale = programBudgetYear / Math.max(1, yearOneProgramBudget);
    const rawDeficitYear = Math.max(0, programBudgetYear - taxCollectedYear);
    const governmentDeficitYear =
      rawDeficitYear < MODEL_CONSTANTS.deficitRoundingFloor ? 0 : rawDeficitYear;
    // Revenue collected beyond the program budget stays at Treasury, removing
    // deposits from M2 until spent — a drain symmetric to the monetized deficit.
    const surplusYear = Math.max(0, taxCollectedYear - programBudgetYear);
    const bottom50UbiYear = bottom50AnnualUbi * budgetScale;

    const repayments = privateTaxDebt * request.model.loanAmortizationRate;
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
      (MODEL_CONSTANTS.housingSupplyElasticityFloor +
        request.market.housingSupplyElasticity);
    const equityPricePressure =
      (equityDemand / Math.max(1, publicEquityWealth)) *
      (1 + request.market.priceImpactCoefficient * MODEL_CONSTANTS.equityPriceImpactAmplifier);
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
        demandInflation *
        Math.exp(-(year - 1) / MODEL_CONSTANTS.demandShockDecayYears) *
        (budgetScale / priceLevel),
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
      Math.max(0, annualInflation - US_BASELINE.baselineInflation) *
        request.model.wagePassThrough;
    baselineResources *= 1 + REAL_GROWTH + US_BASELINE.baselineInflation;
    const policyRealResources = (bottomWageBase + bottom50UbiYear) / priceLevel;
    const baselineRealResources = baselineResources / baselinePriceLevel;

    const topTaxBurden = taxCollectedYear * request.model.topTaxIncidenceShare;
    const interestCost =
      privateTaxDebt * request.behavior.loanInterestRate * request.model.topTaxIncidenceShare;
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
            request.model.assetPriceInflationPassThrough) *
        (1 - effectiveTaxRate) *
        expatriationRetention,
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
    harmfulPeakInflation: request.model.verdictHarmfulInflation,
  });
  const stressTest = buildStressTest(
    strategies,
    newPrivateLoans,
    taxCollected,
    request.ubi.benefitIndexation ?? "none",
    request.model.loanAmortizationRate,
  );
  const theoryTest = buildTheoryTest(request, theoryYears, finalYear.m2Index / 100 - 1);

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
    groupOutcomes,
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

  const { linkThreshold, positionGapThreshold } = MODEL_CONSTANTS.theoryTest;
  const hasMonetaryLink = cumulativeM2Change > linkThreshold;
  const hasAssetLink =
    housingPriceChange > linkThreshold || equityPriceChange > linkThreshold;
  const hasRenterHarm = bottomRenterHousingBurdenChange > linkThreshold;
  const hasWiderPositionGap = housingPositionGapChange > positionGapThreshold;
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
  const housingGain = (inputs.housingPremium - 1) * (group.realEstate / netWorth);
  const equityGain = (inputs.equityPremium - 1) * (group.publicEquity / netWorth);
  const debtErosion = excessInflation * (group.liabilities / netWorth);
  const cashErosion = -excessInflation * (group.deposits / netWorth);
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
  newPrivateLoans: number,
  taxCollected: number,
  benefitIndexation: "none" | "cpi",
  loanAmortizationRate: number,
): PolicyProjection["stressTest"] => {
  const ubiMultipliers = MODEL_CONSTANTS.stress.ubiMultipliers;
  const monetizationShares = MODEL_CONSTANTS.stress.monetizationShares;
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
        loanAmortizationRate,
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
      benefitIndexation,
      loanAmortizationRate,
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
          ? `No strict hyperinflation breach occurs even at ${MODEL_CONSTANTS.stress.maxSearchMultiplier.toLocaleString("en-US")}× the selected UBI under this reduced-form stress test.`
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
  loanAmortizationRate: number;
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
    const outlay = input.requestedUbi * indexation * (1 + MODEL_CONSTANTS.stress.outlayGrowth);
    const deficit = Math.max(0, outlay - input.taxCollected);
    // Same Treasury-surplus drain and M2 floor as the main projection loop.
    const surplus = Math.max(0, input.taxCollected - outlay);
    const repayments = privateDebt * input.loanAmortizationRate;
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
  harmfulPeakInflation: number;
}): PolicyProjection["verdict"] => {
  const v = MODEL_CONSTANTS.verdict;
  const harmful =
    input.bottom50PurchasingPowerChange < v.harmfulPurchasingPowerDrop ||
    input.peakAnnualInflation >= input.harmfulPeakInflation ||
    input.publicBurdenPerHousehold >= v.harmfulPublicBurdenPerHousehold;
  const beneficial =
    input.bottom50PurchasingPowerChange >= v.beneficialPurchasingPowerGain &&
    input.peakAnnualInflation < v.beneficialPeakInflation &&
    input.publicBurdenPerHousehold < v.beneficialPublicBurdenPerHousehold;
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
        input.borrowShare > v.fragileBorrowShare
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
