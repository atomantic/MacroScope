import {
  SCENARIO_SCHEMA_VERSION,
  type SurplusUse,
  type TaxBracket,
  type UbiFundingRule,
} from "../policies/schema.js";
import { US_BASELINE, type PopulationFlowDiagnostic } from "./usBaseline.js";
import { DEFAULT_MODEL_TUNABLES } from "./modelConstants.js";
import type { RecipientCashAllocation } from "./cashAllocation.js";

/**
 * The promoted, user-tunable model constants (issue #8). Each mirrors a
 * documented entry in MODEL_CONSTANTS; defaults reproduce the calibrated
 * baseline exactly. Validation ranges and display metadata live in
 * `MODEL_TUNABLES` (modelConstants.ts).
 */
export interface ModelTunables {
  // Share of policy-driven excess inflation that lifts the bottom-half wage base.
  readonly wagePassThrough: number;
  // Fraction of outstanding private tax-payment loans repaid each year.
  readonly loanAmortizationRate: number;
  // Share of collected tax and debt service borne by the top tier.
  readonly topTaxIncidenceShare: number;
  // Share of first-year inflation pressure offset by monetary policy.
  readonly monetaryPolicyOffsetShare: number;
  // Share of excess inflation passing into the taxed asset base's price.
  readonly assetPriceInflationPassThrough: number;
  // Peak annual inflation at/above which the verdict is rated harmful.
  readonly verdictHarmfulInflation: number;
}

export type PaymentStrategy = "cash-first" | "borrow-first" | "sell-first";
/** Who absorbs a tax-payment loan loss after pledged collateral is seized. */
export type TaxLoanResolution =
  | "private-bank-loss"
  | "government-guarantee"
  | "central-bank-facility";
export type TaxLoanStructure = "interest-only" | "amortizing" | "demand-rollover";
export type EconomyClosure = "closed" | "partially-open" | "open-stress";
export type BenefitIndexation = "none" | "cpi";
export type ServiceEffectiveness = "unscored" | "zero" | "base" | "high";
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
    // Optional graduated schedule. When present and non-empty, thresholds are
    // absolute wealth levels (dollars) with the lowest acting as the exemption,
    // and this replaces the single flat `rate`. Named proposals such as Warren
    // 2020 and Sanders 2020 use these. Omitted for the single-rate default.
    readonly brackets?: readonly TaxBracket[];
  };
  readonly ubi: {
    readonly adultMonthlyBenefit: number;
    readonly childMonthlyBenefit: number;
    readonly fundingRule: UbiFundingRule;
    // Optional on the wire for schema-v1 compatibility. The parser and runner
    // normalize omission to debt reduction rather than silently hoarding cash.
    readonly surplusUse?: SurplusUse;
    // Optional on the wire for schema-v1 compatibility; normalizeComparisonRequest
    // defaults an omitted value to "none" (fixed nominal benefits).
    readonly benefitIndexation?: BenefitIndexation;
    // Omitted values preserve the cash-only boundary rather than quietly
    // treating service spending as household income.
    readonly serviceEffectiveness?: ServiceEffectiveness;
    readonly directCashShare: number;
    readonly administrativeShare: number;
  };
  readonly market: {
    readonly buyerDepthRatio: number;
    readonly priceImpactCoefficient: number;
    readonly maximumCollateralLtv: number;
    readonly housingSupplyElasticity: number;
  };
  /**
   * Aggregate rest-of-world closure. This is deliberately one sector rather
   * than a multi-country forecast: it makes foreign ownership and financing
   * explicit without pretending to solve a full exchange-rate model.
   */
  readonly economy: {
    readonly closure: EconomyClosure;
    /** Share of forced equity/housing sales funded by non-resident buyers. */
    readonly foreignBuyerShare: number;
    /** Share of newly issued Treasury debt bought by the rest of the world. */
    readonly foreignTreasuryDebtShare: number;
    /** Fraction of the configured expatriation shock that converts into a capital outflow. */
    readonly capitalOutflowResponse: number;
    /** Share of an outflow immediately offset by repatriation / FX pass-through. */
    readonly repatriationFxPassThrough: number;
  };
  readonly behavior: {
    readonly borrowShare: number;
    readonly sellShare: number;
    readonly annualAssetReturn: number;
    readonly loanInterestRate: number;
    readonly taxLoanStructure: TaxLoanStructure;
    /** Declared loss-allocation path when a tax-payment loan misses debt service. */
    readonly taxLoanResolution: TaxLoanResolution;
    readonly deficitMonetizationShare: number;
    readonly assetHedgeShare: number;
    readonly housingHedgeShare: number;
    /** Share of recipients' post-consumption cash targeted to existing debt. */
    readonly recipientDebtRepaymentShare: number;
    /** Share of post-consumption, post-debt cash targeted to asset purchases. */
    readonly recipientAssetPurchaseShare: number;
    /** Portfolio split applied to recipient asset-purchase cash. */
    readonly recipientHousingShare: number;
    readonly recipientRetirementAndBondShare: number;
    readonly recipientSpeculativeShare: number;
    /** Cash down payment divided by this share yields housing purchase demand. */
    readonly recipientHousingDownPaymentShare: number;
    readonly rentPassThrough: number;
    // Taxpayer-response dials (issue #6). Fraction of the reported taxable base
    // erased per percentage point of statutory rate through avoidance and
    // evasion; cumulative share of top-tier taxable wealth that expatriates over
    // the decade; and the share of private-business value included in the base
    // (the valuation-discount dial). Defaults reproduce full-compliance behavior
    // with the model's historical 0.7 private-business inclusion.
    readonly avoidanceElasticity: number;
    readonly expatriationShare: number;
    /** Separately report people moving residence; it does not itself erase assets. */
    readonly expatriationResidenceShare: number;
    /** Share of the expatriation shock that leaves the U.S. tax jurisdiction. */
    readonly expatriationTaxBaseShare: number;
    readonly privateBusinessInclusionRate: number;
    // Growth/investment channel dials (issue #13). savingsResponseElasticity is
    // the fraction of the capital-replacement investment rate lost per unit of
    // after-tax-return drag the wealth tax imposes (the supply-side, real
    // objection: taxing wealth lowers saving/investment, the capital stock,
    // wages, and GDP). demandGrowthOffset is how strongly the transfer's demand
    // impulse (program budget as a share of GDP) feeds investment/output the
    // other way. Both default to 0, which pins the capital index at 1 and
    // reproduces the constant-trend growth path exactly.
    readonly savingsResponseElasticity: number;
    readonly demandGrowthOffset: number;
  };
  // Promoted model constants, tunable with server-side validation (issue #8).
  readonly model: ModelTunables;
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
  // Re-assessed from the evolved synthetic household balances each year. These
  // are intentionally separate from the year-one strategy summary so bracket
  // crossings and fixed exemptions remain visible in the ten-year path.
  readonly taxCollected: number;
  readonly taxpayerHouseholds: number;
  readonly effectiveTaxRate: number;
  readonly taxGroupCollections: Readonly<Record<string, number>>;
  readonly annualInflation: number;
  readonly monthlyInflation: number;
  readonly priceLevel: number;
  readonly m2: number;
  readonly m2Index: number;
  readonly privateTaxDebt: number;
  /** New collateralized tax-payment loans originated in this year. */
  readonly newPrivateLoans: number;
  /** Principal repaid from borrower deposits and extinguished this year. */
  readonly privateTaxLoanRepayments: number;
  /** Interest transferred from borrowers to banks this year. */
  readonly privateTaxLoanInterestPaid: number;
  /** Assets voluntarily sold to restore debt service or collateral before default. */
  readonly taxLoanSaleToCure: number;
  /** Tax-payment debt resolved after missed interest or scheduled principal. */
  readonly taxLoanDefaults: number;
  /** Pledged equity/housing transferred to the lender during resolution. */
  readonly collateralSeized: number;
  /** Loss absorbed by the modeled commercial-bank capital buffer. */
  readonly privateBankLosses: number;
  /** Loss converted into an explicit public-debt guarantee. */
  readonly governmentGuarantees: number;
  /** Loss purchased/funded by a central-bank liquidity facility. */
  readonly centralBankFacilities: number;
  /** Capital supporting the aggregate tax-payment loan book. */
  readonly bankCapital: number;
  /** Tax assessed but not fundable after current collateral is exhausted. */
  readonly deferredTax: number;
  readonly governmentDebtAdded: number;
  readonly bottom50PurchasingPowerIndex: number;
  readonly top1RealWealthIndex: number;
  readonly confidenceIndex: number;
  // Real output per worker versus the no-policy path, indexed to 100 (issue #13).
  // Moves with the endogenous capital stock: below 100 when the wealth tax's
  // savings drag shrinks investment, above 100 when the transfer's demand offset
  // dominates. Exactly 100 every year when both growth dials are 0.
  readonly gdpIndex: number;
  readonly regime: InflationRegime;
}

export interface OpenEconomyProjectionYear {
  readonly year: number;
  readonly foreignAssetPurchases: number;
  readonly foreignTreasuryPurchases: number;
  readonly residentCapitalOutflow: number;
  readonly repatriatedCapital: number;
  readonly netForeignAssetPosition: number;
  readonly foreignOwnedDomesticClaims: number;
  /** Positive values are net capital-outflow / depreciation pressure. */
  readonly exchangeRatePressure: number;
  readonly residentsChangingJurisdiction: number;
  readonly taxableBaseLeavingJurisdiction: number;
}

export interface FiscalProjectionYear {
  readonly year: number;
  readonly taxRevenue: number;
  readonly requestedProgramOutlay: number;
  readonly scheduledProgramOutlay: number;
  readonly additionalServices: number;
  readonly rebate: number;
  readonly programOutlay: number;
  readonly interestExpense: number;
  readonly governmentOutlay: number;
  readonly debtIssued: number;
  readonly debtRepaid: number;
  readonly interestSavings: number;
  readonly programDebt: number;
  readonly publicDebtStock: number;
  readonly treasuryBalance: number;
  readonly netPublicDebtChange: number;
  readonly budgetIdentityResidual: number;
}

export interface TheoryTestYear {
  readonly year: number;
  readonly recipientCashAllocation: RecipientCashAllocation;
  /** Newly created deposits later recycled into assets; separate from transfers. */
  readonly liquiditySeekingAssets: number;
  readonly housingPriceIndex: number;
  readonly equityPriceIndex: number;
  readonly assetMarket: AnnualAssetMarketDiagnostics;
  readonly middleHomeownerWealthIndex: number;
  readonly bottomRenterHousingBurdenIndex: number;
  readonly bottomRenterDisposableIncomeIndex: number;
}

export interface AssetMarketDiagnostics {
  readonly domesticPurchases: number;
  readonly foreignPurchases: number;
  readonly voluntarySales: number;
  readonly forcedSales: number;
  readonly newSupply: number;
  readonly netOrderFlow: number;
  readonly priceChange: number;
}

export interface AnnualAssetMarketDiagnostics {
  readonly housing: AssetMarketDiagnostics;
  readonly publicEquity: AssetMarketDiagnostics;
  readonly collateralCalls: number;
  readonly forcedRepayments: number;
  readonly transactionResidual: number;
  readonly iterations: number;
  readonly converged: boolean;
}

export interface StressCell {
  readonly ubiMultiplier: number;
  readonly monetizationShare: number;
  readonly peakAnnualInflation: number;
  readonly peakMonthlyInflation: number;
  readonly regime: InflationRegime;
}

export type WealthGroupOutcomeId =
  | "bottom-50-renter"
  | "bottom-50-owner"
  | "middle-40"
  | "top-10"
  | "top-1"
  | "top-0.1";

/**
 * A single wealth cohort's explicit ten-year outcome versus the no-policy path,
 * combining the four channels the policy acts through: wealth tax paid, UBI
 * received, real purchasing power after inflation, and asset-price effects.
 */
export interface WealthGroupOutcome {
  readonly id: WealthGroupOutcomeId;
  readonly label: string;
  readonly households: number;
  // The metric that leads this group's story: renters and the liquidity-
  // constrained bottom half read on purchasing power; asset-holding groups
  // read on real net worth (which already nets out the wealth tax they pay).
  readonly primaryMetric: "purchasing-power" | "real-wealth";
  // Year-10 real disposable buying power vs. the no-policy path (fractional
  // change; e.g. 0.06 = +6%). Null when the cohort has no meaningful measure.
  readonly purchasingPowerChange: number | null;
  // Year-10 real net worth vs. the no-policy path (fractional change), after
  // asset-price premia, inflationary debt erosion, and cumulative tax paid.
  readonly realWealthChange: number | null;
  // Year-1 nominal wealth tax paid and UBI received by the cohort, exposed as
  // plain-dollar drivers behind the composite outcome.
  readonly annualTaxPaid: number;
  readonly annualUbiReceived: number;
  // Year-10 housing-cost premium vs. no policy (fractional; renters pay it,
  // owners bank the mirror-image asset gain).
  readonly rentPremiumChange: number;
  readonly rating: "better-off" | "worse-off" | "mixed";
  readonly headline: string;
}

/**
 * Resource-equivalent value of delivered public services. The zero/base/high
 * cases are explicit sensitivity cases, not a claim that a service dollar is
 * interchangeable with cash.
 */
export interface ServiceValueRange {
  readonly mode: ServiceEffectiveness;
  readonly zero: number;
  readonly base: number;
  readonly high: number;
  readonly selected: number | null;
}

export interface PolicyProjection {
  readonly verdict: {
    readonly rating: "beneficial" | "mixed" | "harmful";
    readonly detail: "beneficial" | "mixed-positive" | "mixed-negative" | "harmful";
    readonly scope: "cash-only" | "cash-with-service-estimate";
    readonly headline: string;
    readonly explanation: string;
    // Positive values are headroom; negative values are distance beyond the
    // corresponding guardrail. All purchasing-power values are fractions.
    readonly margins: {
      readonly beneficialPurchasingPower: number;
      readonly harmfulPurchasingPower: number;
      readonly beneficialInflation: number;
      readonly harmfulInflation: number;
      readonly beneficialPublicBurden: number;
      readonly harmfulPublicBurden: number;
    };
  };
  readonly behaviorMix: {
    readonly cashShare: number;
    readonly borrowShare: number;
    readonly sellShare: number;
    readonly householdsPayingCashShare: number;
    readonly householdsBorrowingShare: number;
    readonly householdsSellingShare: number;
    readonly calibration: "central" | "borrow-dominant" | "near-total-borrow-stress";
  };
  readonly annualFlows: {
    readonly taxCollected: number;
    readonly ubiReceived: number;
    readonly rebate: number;
    readonly publicServicesSpending: number;
    readonly serviceValue: ServiceValueRange;
    readonly administrativeCost: number;
    readonly newPrivateLoans: number;
    readonly assetSales: number;
    readonly governmentDeficit: number;
    readonly m2Injection: number;
    readonly finalYear: {
      readonly taxCollected: number;
      readonly ubiReceived: number;
      readonly rebate: number;
      readonly publicServicesSpending: number;
      readonly serviceValue: ServiceValueRange;
      readonly administrativeCost: number;
      readonly newPrivateLoans: number;
      readonly governmentDeficit: number;
      readonly m2Injection: number;
    };
  };
  readonly fiscal: {
    readonly fundingRule: UbiFundingRule;
    readonly surplusUse: SurplusUse;
    readonly averageInterestRate: number;
    readonly cumulativeDebtIssued: number;
    readonly cumulativeDebtRepaid: number;
    readonly netPublicDebtChange: number;
    readonly openingPublicDebt: number;
    readonly endingPublicDebt: number;
    readonly endingProgramDebt: number;
    readonly endingTreasuryBalance: number;
    readonly years: readonly FiscalProjectionYear[];
  };
  readonly summary: {
    readonly peakAnnualInflation: number;
    readonly cumulativeM2Change: number;
    readonly bottom50PurchasingPowerChange: number;
    readonly selectedAnnualResourceValue: number | null;
    readonly top1RealWealthChange: number;
    // Year-10 real GDP-per-worker change versus the no-policy path (fractional;
    // e.g. -0.04 = 4% output drag). Zero when both growth dials are 0.
    readonly gdpChange: number;
    readonly privateTaxDebt: number;
    /** Ten-year totals for resolved tax-payment-loan defaults. */
    readonly taxLoanDefaults: number;
    readonly collateralSeized: number;
    readonly privateBankLosses: number;
    readonly governmentGuarantees: number;
    readonly centralBankFacilities: number;
    readonly bankCapital: number;
    readonly publicBurdenPerHousehold: number;
    readonly firstHyperinflationYear: number | null;
  };
  readonly years: readonly ProjectionYear[];
  readonly groupOutcomes: readonly WealthGroupOutcome[];
  readonly stressTest: {
    readonly fundingRule: UbiFundingRule;
    readonly surplusUse: SurplusUse;
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
      readonly recipientDebtRepaymentShare: number;
      readonly recipientAssetPurchaseShare: number;
      readonly recipientHousingShare: number;
      readonly recipientRetirementAndBondShare: number;
      readonly recipientSpeculativeShare: number;
      readonly recipientHousingDownPaymentShare: number;
      readonly recipientUncertaintyRanges: {
        readonly debtRepaymentShare: { readonly low: number; readonly high: number };
        readonly assetPurchaseShare: { readonly low: number; readonly high: number };
        readonly housingDownPaymentShare: { readonly low: number; readonly high: number };
      };
      readonly housingSupplyElasticity: number;
      readonly rentPassThrough: number;
      readonly baselineRenterHousingCostShare: number;
    };
    readonly summary: {
      readonly annualLiquiditySeekingAssets: number;
      readonly annualRecipientAssetPurchaseCash: number;
      readonly annualRecipientHousingPurchaseDemand: number;
      readonly annualRecipientPublicEquityPurchases: number;
      readonly annualRecipientRetirementAndBondPurchases: number;
      readonly annualRecipientSpeculativeAssetPurchases: number;
      readonly cumulativeRecipientDebtRepayment: number;
      readonly cumulativeRecipientDepositSaving: number;
      readonly recipientCashReconciliationResidual: number;
      readonly housingPriceChange: number;
      readonly equityPriceChange: number;
      readonly middleHomeownerWealthChange: number;
      readonly bottomRenterHousingBurdenChange: number;
      readonly bottomRenterDisposableIncomeChange: number;
      readonly housingPositionGapChange: number;
    };
    readonly years: readonly TheoryTestYear[];
  };
  readonly openEconomy: {
    readonly closure: EconomyClosure;
    readonly assumptions: {
      readonly foreignBuyerShare: number;
      readonly foreignTreasuryDebtShare: number;
      readonly capitalOutflowResponse: number;
      readonly repatriationFxPassThrough: number;
      readonly residenceChangeShare: number;
      readonly taxBaseJurisdictionShare: number;
    };
    readonly summary: {
      readonly foreignOwnedDomesticClaims: number;
      readonly foreignHeldTreasuryDebt: number;
      readonly residentForeignClaims: number;
      readonly netForeignAssetPosition: number;
      readonly cumulativeNetCapitalOutflow: number;
      readonly peakExchangeRatePressure: number;
    };
    readonly accounting: {
      readonly trialBalanceResidual: number;
      readonly instrumentResidual: number;
      readonly events: number;
      readonly failures: readonly string[];
      readonly passed: boolean;
    };
    readonly years: readonly OpenEconomyProjectionYear[];
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
  readonly aggregateAnnualIncome: number;
  readonly baselineAnnualConsumption: number;
  readonly calibration: readonly PopulationFlowDiagnostic[];
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
    readonly scheduledProgramOutlay: number;
    readonly additionalServices: number;
    readonly rebate: number;
    readonly debtIssued: number;
    readonly debtRepaid: number;
    readonly treasuryBalance: number;
    readonly budgetIdentityResidual: number;
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
    readonly recipientDebtRepayments: number;
  };
  readonly recipientCashAllocation: RecipientCashAllocation;
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
    readonly cashAllocationResidual: number;
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
  // Canonical, dollar-denominated tax-schedule result. Consumers such as the
  // browser persona card use this rather than interpreting the headline flat
  // rate when a graduated schedule is active.
  readonly wealthTaxAssessment: {
    readonly taxableBase: number;
    readonly fullComplianceTax: number;
    readonly responseAdjustedTax: number;
    readonly avoidedTax: number;
    readonly effectiveRate: number;
    readonly taxpayerHouseholds: number;
    readonly brackets: readonly {
      readonly threshold: number;
      readonly upperThreshold: number | null;
      readonly rate: number;
      readonly taxableAmount: number;
      readonly tax: number;
    }[];
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
    surplusUse: "debt-reduction",
    benefitIndexation: "none",
    serviceEffectiveness: "unscored",
    directCashShare: 1,
    administrativeShare: 0.05,
  },
  market: {
    buyerDepthRatio: 0.08,
    priceImpactCoefficient: 0.12,
    maximumCollateralLtv: 0.5,
    housingSupplyElasticity: 0.4,
  },
  economy: {
    closure: "closed",
    foreignBuyerShare: 0,
    foreignTreasuryDebtShare: 0,
    capitalOutflowResponse: 0,
    repatriationFxPassThrough: 0,
  },
  behavior: {
    borrowShare: 0.45,
    sellShare: 0.25,
    annualAssetReturn: 0.06,
    loanInterestRate: 0.045,
    taxLoanStructure: "interest-only",
    taxLoanResolution: "private-bank-loss",
    deficitMonetizationShare: 0,
    assetHedgeShare: 0.35,
    housingHedgeShare: 0.6,
    recipientDebtRepaymentShare: 0.35,
    recipientAssetPurchaseShare: 0.25,
    recipientHousingShare: 0.3,
    recipientRetirementAndBondShare: 0.2,
    recipientSpeculativeShare: 0.1,
    recipientHousingDownPaymentShare: 0.2,
    rentPassThrough: 0.3,
    avoidanceElasticity: 0,
    expatriationShare: 0,
    expatriationResidenceShare: 1,
    expatriationTaxBaseShare: 1,
    privateBusinessInclusionRate: 0.7,
    savingsResponseElasticity: 0,
    demandGrowthOffset: 0,
  },
  model: DEFAULT_MODEL_TUNABLES,
};
