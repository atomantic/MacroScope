import { SCENARIO_SCHEMA_VERSION, type UbiFundingRule } from "../policies/schema.js";
import { US_BASELINE } from "./usBaseline.js";

export type PaymentStrategy = "cash-first" | "borrow-first" | "sell-first";
export type ConsumptionSector =
  | "housing"
  | "food"
  | "healthcare"
  | "transportation"
  | "energy"
  | "durable-goods"
  | "discretionary"
  | "services";

export interface SectorDemandOutcome {
  readonly sector: ConsumptionSector;
  readonly baselineDemand: number;
  readonly demandChange: number;
  readonly inflationPressure: number;
}

export interface ComparisonRequestV1 {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly seed: number;
  readonly sampleSize: number;
  readonly representedHouseholds: number;
  readonly wealthTax: {
    readonly targetMode: "exemption" | "top-share";
    readonly exemption: number;
    readonly topShare: number;
    readonly rate: number;
  };
  readonly ubi: {
    readonly adultMonthlyBenefit: number;
    readonly childMonthlyBenefit: number;
    readonly fundingRule: UbiFundingRule;
    readonly directCashShare: number;
    readonly administrativeShare: number;
  };
  readonly market: {
    readonly buyerDepthRatio: number;
    readonly priceImpactCoefficient: number;
    readonly maximumCollateralLtv: number;
    readonly housingSupplyElasticity: number;
  };
  readonly behavior: {
    readonly borrowShare: number;
    readonly sellShare: number;
    readonly annualAssetReturn: number;
    readonly loanInterestRate: number;
    readonly deficitMonetizationShare: number;
    readonly assetHedgeShare: number;
    readonly housingHedgeShare: number;
    readonly rentPassThrough: number;
  };
}

export type InflationRegime =
  | "stable"
  | "elevated"
  | "high"
  | "crisis"
  | "extreme"
  | "hyperinflation";

export interface ProjectionYear {
  readonly year: number;
  readonly annualInflation: number;
  readonly monthlyInflation: number;
  readonly priceLevel: number;
  readonly m2: number;
  readonly m2Index: number;
  readonly privateTaxDebt: number;
  readonly governmentDebtAdded: number;
  readonly bottom50PurchasingPowerIndex: number;
  readonly top1RealWealthIndex: number;
  readonly confidenceIndex: number;
  readonly regime: InflationRegime;
}

export interface TheoryTestYear {
  readonly year: number;
  readonly liquiditySeekingAssets: number;
  readonly housingPriceIndex: number;
  readonly equityPriceIndex: number;
  readonly middleHomeownerWealthIndex: number;
  readonly bottomRenterHousingBurdenIndex: number;
  readonly bottomRenterDisposableIncomeIndex: number;
}

export interface StressCell {
  readonly ubiMultiplier: number;
  readonly monetizationShare: number;
  readonly peakAnnualInflation: number;
  readonly peakMonthlyInflation: number;
  readonly regime: InflationRegime;
}

export interface PolicyProjection {
  readonly verdict: {
    readonly rating: "beneficial" | "mixed" | "harmful";
    readonly headline: string;
    readonly explanation: string;
  };
  readonly behaviorMix: {
    readonly cashShare: number;
    readonly borrowShare: number;
    readonly sellShare: number;
  };
  readonly annualFlows: {
    readonly taxCollected: number;
    readonly ubiReceived: number;
    readonly publicServicesSpending: number;
    readonly administrativeCost: number;
    readonly newPrivateLoans: number;
    readonly assetSales: number;
    readonly governmentDeficit: number;
    readonly m2Injection: number;
  };
  readonly summary: {
    readonly peakAnnualInflation: number;
    readonly cumulativeM2Change: number;
    readonly bottom50PurchasingPowerChange: number;
    readonly top1RealWealthChange: number;
    readonly privateTaxDebt: number;
    readonly publicBurdenPerHousehold: number;
    readonly firstHyperinflationYear: number | null;
  };
  readonly years: readonly ProjectionYear[];
  readonly stressTest: {
    readonly ubiMultipliers: readonly number[];
    readonly monetizationShares: readonly number[];
    readonly cells: readonly StressCell[];
    readonly threshold: {
      readonly definition: string;
      readonly firstUbiMultiplierAtFullMonetization: number | null;
      readonly annualInflationEquivalent: number;
      readonly explanation: string;
    };
  };
  readonly theoryTest: {
    readonly verdict: {
      readonly rating: "active" | "partial" | "inactive";
      readonly headline: string;
      readonly explanation: string;
    };
    readonly assumptions: {
      readonly assetHedgeShare: number;
      readonly housingHedgeShare: number;
      readonly housingSupplyElasticity: number;
      readonly rentPassThrough: number;
      readonly baselineRenterHousingCostShare: number;
    };
    readonly summary: {
      readonly annualLiquiditySeekingAssets: number;
      readonly housingPriceChange: number;
      readonly equityPriceChange: number;
      readonly middleHomeownerWealthChange: number;
      readonly bottomRenterHousingBurdenChange: number;
      readonly bottomRenterDisposableIncomeChange: number;
      readonly housingPositionGapChange: number;
    };
    readonly years: readonly TheoryTestYear[];
  };
  readonly interpretation: readonly string[];
}

export interface PopulationSummary {
  readonly sampledHouseholds: number;
  readonly representedHouseholds: number;
  readonly representedAdults: number;
  readonly representedChildren: number;
  readonly aggregateNetWorth: number;
  readonly aggregateDeposits: number;
  readonly aggregatePublicEquity: number;
  readonly baselineAnnualConsumption: number;
}

export interface DistributionOutcome {
  readonly decile: number;
  readonly households: number;
  readonly averageNetWorthBefore: number;
  readonly averageNetWorthAfter: number;
  readonly averageTaxAssessed: number;
  readonly averageTaxPaid: number;
  readonly averageUbiReceived: number;
  readonly averageDebtChange: number;
  readonly averageConsumptionChange: number;
}

export interface StrategyOutcome {
  readonly strategy: PaymentStrategy;
  readonly fiscal: {
    readonly taxAssessed: number;
    readonly taxCollected: number;
    readonly taxDeferred: number;
    readonly requestedUbi: number;
    readonly ubiReceived: number;
    readonly publicServicesSpending: number;
    readonly administrativeCost: number;
    readonly leakage: number;
    readonly governmentBalance: number;
    readonly fundingRatio: number;
  };
  readonly funding: {
    readonly paidFromCash: number;
    readonly newCollateralizedLoans: number;
    readonly equitySoldForTax: number;
    readonly housingSoldForTax: number;
    readonly householdsBorrowing: number;
    readonly householdsSelling: number;
  };
  readonly moneyAndCredit: {
    readonly bankDepositsChange: number;
    readonly bankLoansChange: number;
    readonly forcedLoanRepayments: number;
  };
  readonly markets: {
    readonly equitySoldForTax: number;
    readonly forcedEquitySales: number;
    readonly totalEquitySales: number;
    readonly equityPriceChange: number;
    readonly cascadeTriggered: boolean;
    readonly cascadeIterations: number;
    readonly housingSold: number;
  };
  readonly macro: {
    readonly firstYearConsumptionDemandChange: number;
    readonly taxWedgeInflation: number;
    readonly demandInflation: number;
    readonly supplyConstraintInflation: number;
    readonly monetaryPolicyOffset: number;
    readonly estimatedInflationChange: number;
    readonly sectors: readonly SectorDemandOutcome[];
  };
  readonly distribution: {
    readonly wealthGiniBefore: number;
    readonly wealthGiniAfter: number;
    readonly deciles: readonly DistributionOutcome[];
  };
  readonly accounting: {
    readonly depositsIdentityResidual: number;
    readonly bankDepositsIdentityResidual: number;
    readonly taxFundingResidual: number;
    readonly equityQuantityResidual: number;
    readonly housingQuantityResidual: number;
    readonly ledgerTrialBalanceResidual: number;
    readonly ledgerInstrumentResidual: number;
    readonly ledgerEvents: number;
    readonly ledgerFailures: readonly string[];
    readonly passed: boolean;
  };
}

export interface ComparisonResultV1 {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly assumptions: ComparisonRequestV1;
  readonly wealthTaxTarget: {
    readonly mode: "exemption" | "top-share";
    readonly requestedExemption: number;
    readonly topShare: number;
    readonly effectiveExemption: number;
  };
  readonly population: PopulationSummary;
  readonly strategies: Readonly<Record<PaymentStrategy, StrategyOutcome>>;
  readonly projection: PolicyProjection;
  readonly caveats: readonly string[];
}

export const DEFAULT_COMPARISON_REQUEST: ComparisonRequestV1 = {
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  seed: 42,
  sampleSize: 4_000,
  representedHouseholds: US_BASELINE.households,
  wealthTax: {
    targetMode: "exemption",
    exemption: 10_000_000,
    topShare: 0.01,
    rate: 0.02,
  },
  ubi: {
    adultMonthlyBenefit: 1_000,
    childMonthlyBenefit: 500,
    fundingRule: "revenue-constrained",
    directCashShare: 1,
    administrativeShare: 0.05,
  },
  market: {
    buyerDepthRatio: 0.08,
    priceImpactCoefficient: 0.12,
    maximumCollateralLtv: 0.5,
    housingSupplyElasticity: 0.4,
  },
  behavior: {
    borrowShare: 0.65,
    sellShare: 0.2,
    annualAssetReturn: 0.06,
    loanInterestRate: 0.045,
    deficitMonetizationShare: 0,
    assetHedgeShare: 0.35,
    housingHedgeShare: 0.6,
    rentPassThrough: 0.3,
  },
};
