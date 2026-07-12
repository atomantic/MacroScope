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
const STRICT_HYPER_MONTHLY_RATE = 0.5;
const STRICT_HYPER_ANNUAL_RATE = (1 + STRICT_HYPER_MONTHLY_RATE) ** 12 - 1;

type Strategies = Readonly<Record<PaymentStrategy, StrategyOutcome>>;

export const buildPolicyProjection = (
  request: ComparisonRequestV1,
  strategies: Strategies,
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

  let m2 = US_BASELINE.m2;
  let priceLevel = 1;
  let baselinePriceLevel = 1;
  let privateTaxDebt = 0;
  let publicDebt = 0;
  let confidence = 1;
  let bottomWageBase = (US_BASELINE.annualPce * 0.3) / (US_BASELINE.households * 0.5);
  let baselineResources = bottomWageBase;
  let topWealth = topOnePercentWealth();
  let baselineTopWealth = topWealth;
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
    const repayments = privateTaxDebt * ANNUAL_LOAN_AMORTIZATION;
    privateTaxDebt = Math.max(0, privateTaxDebt + newPrivateLoans - repayments);
    publicDebt += governmentDeficit;
    const moneyInjection =
      newPrivateLoans - repayments +
      governmentDeficit * request.behavior.deficitMonetizationShare;
    const moneyGrowth = moneyInjection / Math.max(1, m2);
    m2 += moneyInjection;

    const stress = inflationFromStress({
      baselineInflation: US_BASELINE.baselineInflation,
      // The transfer creates a level shock; domestic supply and wages partially
      // adapt rather than repeating the full first-year shock forever.
      demandInflation: demandInflation * Math.exp(-(year - 1) / 3),
      moneyGrowth,
      monetizedDeficitRatio:
        (governmentDeficit * request.behavior.deficitMonetizationShare) /
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
    const policyRealResources = (bottomWageBase + bottom50AnnualUbi) / priceLevel;
    const baselineRealResources = baselineResources / baselinePriceLevel;

    const topTaxBurden = taxCollected * 0.8;
    const interestCost = privateTaxDebt * request.behavior.loanInterestRate * 0.8;
    topWealth = Math.max(
      0,
      topWealth * (1 + request.behavior.annualAssetReturn) - topTaxBurden - interestCost,
    );
    baselineTopWealth *= 1 + request.behavior.annualAssetReturn;

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
  const stressTest = buildStressTest(strategies, newPrivateLoans, taxCollected);

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
      newPrivateLoans,
      assetSales,
      governmentDeficit,
      m2Injection:
        newPrivateLoans +
        governmentDeficit * request.behavior.deficitMonetizationShare,
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
    interpretation: [
      "A tax-funded UBI moves existing deposits between households; it does not by itself create money.",
      "Bank borrowing creates deposits while the tax loans remain outstanding, so borrowing can expand M2 and add inflation pressure even when the federal budget balances.",
      "Private loans remain liabilities of the wealthy borrowers. They become a burden on other households only if losses are later socialized through bailouts, guarantees, or inflationary deficit finance; this model assumes no such bailout.",
      "Purchasing-power results compare the bottom half with a no-policy baseline after prices; they include partial wage adjustment and an annual UBI flow.",
    ],
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
  const inflation = Math.max(
    -0.02,
    input.baselineInflation +
      input.demandInflation +
      financingStress * 0.35 +
      input.monetizedDeficitRatio * 0.25 +
      velocityPressure,
  );
  return { inflation, confidence };
};

const buildStressTest = (
  strategies: Strategies,
  newPrivateLoans: number,
  taxCollected: number,
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
  demandInflation: number;
}): number => {
  let m2 = US_BASELINE.m2;
  let confidence = 1;
  let privateDebt = 0;
  let peak: number = US_BASELINE.baselineInflation;
  const deficit = Math.max(0, input.requestedUbi * 1.012 - input.taxCollected);
  for (let year = 1; year <= YEARS; year += 1) {
    const repayments = privateDebt * ANNUAL_LOAN_AMORTIZATION;
    privateDebt = Math.max(0, privateDebt + input.newPrivateLoans - repayments);
    const injection =
      input.newPrivateLoans - repayments + deficit * input.monetizationShare;
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
