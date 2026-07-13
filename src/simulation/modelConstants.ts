import type { ConsumptionSector } from "./contracts.js";
import type { ModelTunables } from "./contracts.js";

/**
 * MODEL_CONSTANTS — every load-bearing numeric assumption in the single-year
 * scenario engine (`scenarioRunner.ts`) and the ten-year projection
 * (`projection.ts`), gathered in one documented place.
 *
 * The goal (issue #8) is that no unexplained magic number sits in the model
 * math: each constant here carries a one-line rationale and a source note, and
 * the highest-leverage ones are additionally promoted into the request schema's
 * `model` block so a reader can retune them from the UI (see MODEL_TUNABLES).
 *
 * Pure unit conversions (×100 to render an index as a percent, ÷100 for a
 * percent input, the 100 index base, 12 months per year, ±1 to move between a
 * ratio and a fractional change) and numerical guards (`Math.max(1, …)`) are
 * NOT modeled assumptions and stay inline at their call sites.
 */
export const MODEL_CONSTANTS = {
  // --- Horizon ------------------------------------------------------------
  // Ten-year policy window, the standard scoring horizon used by CBO and the
  // Warren/Sanders revenue estimates this tool is calibrated against.
  projectionYears: 10,

  // --- Real income growth -------------------------------------------------
  // Trend real growth of the bottom-half wage/resource base, absent the policy.
  // ~1%/yr matches long-run real median-income growth (BLS/Census).
  realWageGrowth: 0.01,

  // Share of policy-driven EXCESS inflation that lifts the bottom-half nominal
  // wage base the same year (partial, sticky wage catch-up). Reduced-form.
  wageExcessInflationPassThrough: 0.55,

  // --- Money / inflation kernel ------------------------------------------
  // Numerical ceiling on modeled annual inflation. Far above the strict
  // hyperinflation threshold (50%/month ≈ 129×/yr) so regime classification is
  // unaffected; keeps indexed-benefit feedback finite over the horizon.
  maxAnnualInflation: 10_000,
  // Reduced-form floor on M2 as a share of its baseline: a sustained Treasury
  // surplus retires debt or is respent rather than destroying the money stock,
  // so M2 (and everything derived from it) stays positive.
  m2FloorShare: 0.1,
  // Coefficients of the single reduced-form inflation kernel (inflationFromStress).
  inflationKernel: {
    // Money growth above this "tolerated" rate begins to stress financing.
    financingStressThreshold: 0.025,
    // Confidence erosion per unit of financing stress and monetized deficit,
    // net of a standing buffer before any confidence is lost.
    financingConfidenceWeight: 0.22,
    monetizedConfidenceWeight: 0.35,
    confidenceLossBuffer: 0.015,
    // Confidence cannot fall below this floor (a fully de-anchored regime).
    minimumConfidence: 0.05,
    // Velocity/de-anchoring pressure: (1 - confidence)^exponent × coefficient.
    velocityCoefficient: 1.5,
    velocityExponent: 2,
    // Pass-through of financing stress and monetized deficit into inflation.
    financingInflationWeight: 0.35,
    monetizedInflationWeight: 0.25,
    // Deflation floor for a single modeled year.
    inflationFloor: -0.02,
  },
  // Cagan strict-hyperinflation convention: 50% inflation per month.
  strictHyperMonthlyRate: 0.5,
  // Floor used when converting an annual rate to a monthly one (a total wipeout
  // of −99% is the worst single-period move the geometric conversion admits).
  minPeriodRate: -0.99,
  // Annual-inflation regime cutoffs used to label each year (fractional).
  regimeThresholds: {
    extreme: 5,
    crisis: 0.5,
    high: 0.1,
    elevated: 0.05,
  },

  // --- Fiscal rounding ----------------------------------------------------
  // Deficits below $1M are treasury rounding, not a financed gap; zero them so
  // a balanced budget does not register a spurious monetized deficit.
  deficitRoundingFloor: 1_000_000,

  // --- Wealth-tax base dynamics ------------------------------------------
  // Share of policy-driven excess inflation that passes into the nominal price
  // of the taxed asset base each year. Reduced-form asset-price channel.
  assetPriceInflationPassThrough: 0.5,
  // Share of the year's collected wealth tax and of debt-service cost borne by
  // the top tier (the tax is calibrated to fall on top-tier net worth).
  topTaxIncidenceShare: 0.8,
  // Fraction of outstanding private tax-payment loans amortized each year
  // (≈10-year straight-line runoff of collateralized borrowing).
  loanAmortizationRate: 0.1,

  // --- Asset / housing feedback ------------------------------------------
  // Floor added to the user's housing supply elasticity so a perfectly
  // inelastic (0) input still clears through a finite price move.
  housingSupplyElasticityFloor: 0.25,
  // Amplifies the equity price-impact coefficient in the ten-year feedback loop
  // relative to the single-year cascade (thin secondary demand moves prices more).
  equityPriceImpactAmplifier: 4,
  // e-folding time (years) over which the one-off demand shock decays as
  // domestic supply and wages adapt. exp(-(year-1)/decay).
  demandShockDecayYears: 3,

  // --- Renter / owner split ----------------------------------------------
  // Baseline renter housing-cost-to-income share (~31%, the HUD affordability
  // line and the ACS median gross-rent burden).
  baselineRenterHousingCostShare: 0.31,
  // Reduced-form split of the bottom 50% between renters and owners.
  bottomHalfRenterShare: 0.5,
  // Bottom half of households (population share) and their share of aggregate
  // personal consumption, used to seed the bottom-half wage base.
  bottomHalfPopulationShare: 0.5,
  bottomHalfConsumptionShare: 0.3,

  // --- Verdict / outcome bands -------------------------------------------
  // A cohort reads as better/worse off once its leading real measure clears
  // this band around the no-policy path; inside it the result is "mixed".
  groupOutcomeBand: 0.005,
  // Verdict thresholds (makeVerdict). Any one "harmful" trigger, or all
  // "beneficial" conditions, decides the headline rating.
  verdict: {
    harmfulPurchasingPowerDrop: -0.02,
    harmfulPeakInflation: 0.2,
    harmfulPublicBurdenPerHousehold: 50_000,
    beneficialPurchasingPowerGain: 0.02,
    beneficialPeakInflation: 0.1,
    beneficialPublicBurdenPerHousehold: 10_000,
    // Above this borrow share a beneficial result is flagged as more fragile.
    fragileBorrowShare: 0.5,
  },

  // --- Owner–renter gap theory test --------------------------------------
  theoryTest: {
    // Minimum change for a causal link (monetary, asset, renter-harm) to count.
    linkThreshold: 0.005,
    // Minimum owner–renter position-gap widening for the channel to be "active".
    positionGapThreshold: 0.01,
  },
  // Percentile at or above which a wealth group is counted in the top 1%.
  topOnePercentPercentile: 0.99,

  // --- Inflation & monetization stress grid ------------------------------
  stress: {
    // UBI-size and deficit-monetization axes of the published 5×5 grid.
    ubiMultipliers: [0.5, 1, 2, 4, 8],
    monetizationShares: [0, 0.25, 0.5, 0.75, 1],
    // Upper bound of the doubling search for the first strict-hyperinflation breach.
    maxSearchMultiplier: 4_096,
    // Annual growth applied to the stressed outlay (baseline drift of the program).
    outlayGrowth: 0.012,
  },

  // --- Single-year consumption / demand model (scenarioRunner) -----------
  // Share of the delivered program that leaks (fraud, mis-targeting).
  programLeakageRate: 0.002,
  // Household precautionary cash buffer kept before paying tax from deposits:
  // max($5,000, incomeShare × annual income).
  householdCashBufferFloor: 5_000,
  householdCashBufferIncomeShare: 0.15,
  // Baseline household consumption as a share of income, rising with the
  // household's marginal propensity to consume.
  baselineConsumptionIncomeShare: 0.52,
  baselineConsumptionMpcWeight: 0.25,
  // Extra inflation pressure from supply constraints, as a share of raw demand
  // pressure; and the share of that combined pressure offset by monetary policy.
  supplyConstraintShare: 0.35,
  monetaryPolicyOffsetShare: 0.4,
  // Split of in-kind public-services spending across sectors.
  publicServicesHealthcareShare: 0.6,
  publicServicesServicesShare: 0.4,
  // Per-sector supply sensitivity translating a demand shock into a price move
  // (housing and energy are inelastic; discretionary and services are elastic).
  supplySensitivity: {
    housing: 1.2,
    food: 0.6,
    healthcare: 0.9,
    transportation: 0.5,
    energy: 1.1,
    "durable-goods": 0.7,
    discretionary: 0.35,
    services: 0.5,
  } as Readonly<Record<ConsumptionSector, number>>,
  // Consumption budget shares by income percentile: base share at the bottom,
  // plus a linear slope across the distribution (BLS CES cross-section shape;
  // housing/food/energy fall with income, services/discretionary rise).
  consumptionShareCoefficients: {
    housing: { base: 0.32, slope: -0.13 },
    food: { base: 0.18, slope: -0.09 },
    healthcare: { base: 0.1, slope: 0.02 },
    transportation: { base: 0.12, slope: -0.02 },
    energy: { base: 0.08, slope: -0.035 },
    "durable-goods": { base: 0.07, slope: 0.015 },
    discretionary: { base: 0.05, slope: 0.13 },
    services: { base: 0.08, slope: 0.11 },
  } as Readonly<Record<ConsumptionSector, { readonly base: number; readonly slope: number }>>,

  // --- Equity liquidation cascade ----------------------------------------
  cascade: {
    // Maximum fixed-point iterations before the price cascade is cut off.
    maxIterations: 8,
    // Hard floor on the cleared equity price (an 80% crash is the modeled worst case).
    priceFloor: 0.2,
    // Forced sales above this share of primary sales flag a triggered cascade.
    triggerShare: 0.1,
  },
  // Relative convergence epsilon for the cascade and accounting tolerances.
  convergenceEpsilon: 1e-10,
  // Absolute floor (dollars / book units) for those same floating-point
  // tolerances, so tiny aggregates still get a non-zero comparison band.
  absoluteToleranceFloor: 0.01,
} as const;

/**
 * The subset of MODEL_CONSTANTS promoted into the request schema's `model`
 * block so they are user-tunable with server-side validation. Defaults
 * reproduce the calibrated baseline exactly, so a default request is
 * numerically identical to the pre-issue-#8 engine.
 */
export const DEFAULT_MODEL_TUNABLES: ModelTunables = {
  wagePassThrough: MODEL_CONSTANTS.wageExcessInflationPassThrough,
  loanAmortizationRate: MODEL_CONSTANTS.loanAmortizationRate,
  topTaxIncidenceShare: MODEL_CONSTANTS.topTaxIncidenceShare,
  monetaryPolicyOffsetShare: MODEL_CONSTANTS.monetaryPolicyOffsetShare,
  assetPriceInflationPassThrough: MODEL_CONSTANTS.assetPriceInflationPassThrough,
  verdictHarmfulInflation: MODEL_CONSTANTS.verdict.harmfulPeakInflation,
};

export interface TunableModelConstant {
  readonly key: keyof ModelTunables;
  readonly label: string;
  // Display/serialization unit: "share" and "rate" are 0–1 fractions rendered
  // as percents in the UI.
  readonly unit: "share" | "rate";
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly rationale: string;
  readonly source: string;
}

/**
 * Validation + display metadata for the promoted, tunable model constants.
 * `comparisonInput.ts` iterates this to validate ranges; the UI iterates it to
 * render the tunable rows of the Model-boundaries constants table.
 */
export const MODEL_TUNABLES: readonly TunableModelConstant[] = [
  {
    key: "wagePassThrough",
    label: "Wage pass-through of excess inflation",
    unit: "share",
    min: 0,
    max: 1,
    default: DEFAULT_MODEL_TUNABLES.wagePassThrough,
    rationale:
      "Share of policy-driven excess inflation that lifts the bottom-half nominal wage base the same year (sticky, partial wage catch-up).",
    source: "Reduced-form wage-adjustment assumption (BLS real-wage trend).",
  },
  {
    key: "loanAmortizationRate",
    label: "Annual loan amortization",
    unit: "rate",
    min: 0,
    max: 1,
    default: DEFAULT_MODEL_TUNABLES.loanAmortizationRate,
    rationale:
      "Fraction of outstanding private tax-payment loans repaid each year (~10-year straight-line runoff).",
    source: "Reduced-form collateralized-lending assumption.",
  },
  {
    key: "topTaxIncidenceShare",
    label: "Top-1% aggregate tax incidence",
    unit: "share",
    min: 0,
    max: 1,
    default: DEFAULT_MODEL_TUNABLES.topTaxIncidenceShare,
    rationale:
      "Share of collected wealth tax and debt-service cost charged against the top-1% AGGREGATE real-wealth trajectory (the summary/chart top-1 line). Per-cohort winners-grid outcomes attribute tax precisely by each cohort's taxable base instead, so they do not move with this dial.",
    source: "Fed DFA wealth-concentration calibration.",
  },
  {
    key: "monetaryPolicyOffsetShare",
    label: "Monetary-policy offset",
    unit: "share",
    min: 0,
    max: 1,
    default: DEFAULT_MODEL_TUNABLES.monetaryPolicyOffsetShare,
    rationale:
      "Share of first-year demand-plus-supply inflation pressure offset by the central bank's reaction.",
    source: "Reduced-form monetary-reaction assumption.",
  },
  {
    key: "assetPriceInflationPassThrough",
    label: "Asset-price inflation pass-through",
    unit: "share",
    min: 0,
    max: 1,
    default: DEFAULT_MODEL_TUNABLES.assetPriceInflationPassThrough,
    rationale:
      "Share of excess inflation that passes into the nominal price of the taxed asset base each year.",
    source: "Reduced-form asset-price channel.",
  },
  {
    key: "verdictHarmfulInflation",
    label: "Verdict: harmful inflation threshold",
    unit: "rate",
    min: 0.05,
    max: 2,
    default: DEFAULT_MODEL_TUNABLES.verdictHarmfulInflation,
    rationale:
      "Peak annual inflation at or above which the overall verdict is rated harmful.",
    source: "Author threshold; adjustable to your own risk tolerance.",
  },
];

export interface ModelConstantDoc {
  readonly category: string;
  readonly label: string;
  readonly value: string;
  readonly rationale: string;
  readonly source: string;
  readonly tunable: boolean;
}

const pct = (value: number): string =>
  `${Number((value * 100).toPrecision(6))}%`;

const CATEGORY_BY_KEY: Readonly<Record<keyof ModelTunables, string>> = {
  wagePassThrough: "Income",
  assetPriceInflationPassThrough: "Wealth-tax base",
  topTaxIncidenceShare: "Wealth-tax base",
  loanAmortizationRate: "Credit",
  monetaryPolicyOffsetShare: "Inflation kernel",
  verdictHarmfulInflation: "Verdict",
};

// Display rows for the promoted, tunable constants, derived straight from the
// validation metadata so the table and the schema never drift.
const TUNABLE_DOCS: readonly ModelConstantDoc[] = MODEL_TUNABLES.map((spec) => ({
  category: CATEGORY_BY_KEY[spec.key],
  label: spec.label,
  value: pct(spec.default),
  rationale: spec.rationale,
  source: spec.source,
  tunable: true,
}));

// Fixed (non-tunable) headline constants worth surfacing alongside the tunable ones.
const FIXED_DOCS: readonly ModelConstantDoc[] = [
  {
    category: "Horizon",
    label: "Projection horizon",
    value: `${MODEL_CONSTANTS.projectionYears} years`,
    rationale: "Standard ten-year scoring window.",
    source: "CBO / Saez–Zucman revenue-estimate horizon.",
    tunable: false,
  },
  {
    category: "Income",
    label: "Trend real wage growth",
    value: pct(MODEL_CONSTANTS.realWageGrowth),
    rationale: "Real growth of the bottom-half resource base absent the policy.",
    source: "Long-run BLS/Census real median income.",
    tunable: false,
  },
  {
    category: "Inflation kernel",
    label: "Supply-constraint pressure",
    value: pct(MODEL_CONSTANTS.supplyConstraintShare),
    rationale: "Extra inflation from supply limits, as a share of demand pressure.",
    source: "Reduced-form supply-elasticity assumption.",
    tunable: false,
  },
  {
    category: "Inflation kernel",
    label: "Strict hyperinflation line",
    value: `${pct(MODEL_CONSTANTS.strictHyperMonthlyRate)} / month`,
    rationale: "Cagan convention distinguishing high inflation from hyperinflation.",
    source: "Cagan (1956).",
    tunable: false,
  },
  {
    category: "Verdict",
    label: "Harmful public burden / household",
    value: `$${MODEL_CONSTANTS.verdict.harmfulPublicBurdenPerHousehold.toLocaleString("en-US")}`,
    rationale: "Added public debt per household at or above which the verdict is harmful.",
    source: "Author threshold.",
    tunable: false,
  },
  {
    category: "Housing",
    label: "Baseline renter cost burden",
    value: pct(MODEL_CONSTANTS.baselineRenterHousingCostShare),
    rationale: "Renter housing-cost-to-income share before the policy.",
    source: "HUD affordability line / ACS median gross-rent burden.",
    tunable: false,
  },
];

/**
 * Flat, display-ready description of the headline model constants for the UI's
 * "Model boundaries" panel. Tunable rows are flagged so the table can mark them
 * as adjustable in the advanced controls.
 */
export const MODEL_CONSTANT_DOCS: readonly ModelConstantDoc[] = [
  ...TUNABLE_DOCS,
  ...FIXED_DOCS,
];
