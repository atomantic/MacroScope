import { SCENARIO_SCHEMA_VERSION } from "../policies/schema.js";
import {
  DEFAULT_COMPARISON_REQUEST,
  type ComparisonRequestV1,
  type ModelTunables,
  type WealthGroupOutcomeId,
} from "./contracts.js";
import {
  buildCalibratedPopulation,
  normalizeComparisonRequest,
  runComparisonWithPopulation,
} from "./scenarioRunner.js";

export const UNCERTAINTY_MODEL_VERSION = "joint-uncertainty-v1";
export const MIN_UNCERTAINTY_DRAWS = 32;
export const MAX_UNCERTAINTY_DRAWS = 1_000;

export type UncertaintyPopulationMode = "fixed" | "combined";
export type UncertaintyKind = "empirical" | "structural" | "normative";
export type UncertaintyDistribution = "triangular" | "fixed" | "seed-replicates";
export type UncertaintyUnit = "share" | "rate" | "elasticity" | "coefficient";

export interface UncertaintyOptions {
  readonly draws: number;
  readonly seed: number;
  readonly populationMode: UncertaintyPopulationMode;
  readonly populationReplicates: number;
}

export const DEFAULT_UNCERTAINTY_OPTIONS: UncertaintyOptions = {
  draws: 512,
  seed: 20_260_713,
  populationMode: "fixed",
  populationReplicates: 8,
};

export interface UncertaintyProgress {
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
  readonly phase: "sampling" | "summarizing" | "complete";
}

export interface UncertaintyHooks {
  readonly onProgress?: (progress: UncertaintyProgress) => void;
  readonly shouldCancel?: () => boolean;
}

export class UncertaintyCancelledError extends Error {
  constructor() {
    super("Uncertainty analysis cancelled.");
    this.name = "UncertaintyCancelledError";
  }
}

export interface UncertaintyParameterMetadata {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly unit: UncertaintyUnit;
  readonly low: number;
  readonly base: number;
  readonly high: number;
  readonly distribution: UncertaintyDistribution;
  readonly correlationGroup: string | null;
  readonly kind: UncertaintyKind;
  readonly sampled: true;
  readonly source: string;
  readonly sourceUrl: string | null;
}

export interface FixedUncertaintyAssumption {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly value: string | number;
  readonly kind: UncertaintyKind;
  readonly sampled: false;
  readonly reason: string;
}

interface ParameterSpec {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly unit: UncertaintyUnit;
  readonly low: number;
  readonly high: number;
  readonly correlationGroup: string | null;
  readonly kind: Exclude<UncertaintyKind, "normative">;
  readonly source: string;
  readonly read: (request: ComparisonRequestV1) => number;
  readonly apply: (request: ComparisonRequestV1, value: number) => ComparisonRequestV1;
}

const withBehavior = (
  request: ComparisonRequestV1,
  patch: Partial<ComparisonRequestV1["behavior"]>,
): ComparisonRequestV1 => ({
  ...request,
  behavior: { ...request.behavior, ...patch },
});

const withMarket = (
  request: ComparisonRequestV1,
  patch: Partial<ComparisonRequestV1["market"]>,
): ComparisonRequestV1 => ({
  ...request,
  market: { ...request.market, ...patch },
});

const withModel = (
  request: ComparisonRequestV1,
  patch: Partial<ModelTunables>,
): ComparisonRequestV1 => ({
  ...request,
  model: { ...request.model, ...patch },
});

/**
 * Source-linked assumption distributions used by the joint ensemble. These are
 * declared distributions over model assumptions, not statistical confidence
 * intervals. Normative policy choices are deliberately held fixed below.
 */
const PARAMETER_SPECS: readonly ParameterSpec[] = [
  {
    id: "borrow-share",
    label: "Borrow share",
    group: "financing",
    unit: "share",
    low: 0.1,
    high: 0.9,
    correlationGroup: "payment-strategy",
    kind: "structural",
    source: "Scenario financing range; constrained jointly with asset sales.",
    read: (request) => request.behavior.borrowShare,
    apply: (request, value) => withBehavior(request, { borrowShare: value }),
  },
  {
    id: "sell-share",
    label: "Asset-sale share",
    group: "financing",
    unit: "share",
    low: 0.05,
    high: 0.6,
    correlationGroup: "payment-strategy",
    kind: "structural",
    source: "Scenario financing range; constrained jointly with borrowing.",
    read: (request) => request.behavior.sellShare,
    apply: (request, value) => withBehavior(request, { sellShare: value }),
  },
  {
    id: "annual-asset-return",
    label: "Annual asset return",
    group: "growth",
    unit: "rate",
    low: 0.02,
    high: 0.1,
    correlationGroup: "asset-market",
    kind: "empirical",
    source: "Broad long-run nominal return range around the scenario baseline.",
    read: (request) => request.behavior.annualAssetReturn,
    apply: (request, value) => withBehavior(request, { annualAssetReturn: value }),
  },
  {
    id: "loan-interest-rate",
    label: "Tax-loan interest rate",
    group: "financing",
    unit: "rate",
    low: 0.025,
    high: 0.09,
    correlationGroup: "credit-conditions",
    kind: "empirical",
    source: "Secured-credit rate range around the modeled collateralized loan.",
    read: (request) => request.behavior.loanInterestRate,
    apply: (request, value) => withBehavior(request, { loanInterestRate: value }),
  },
  {
    id: "deficit-monetization",
    label: "Deficit monetized",
    group: "fiscal",
    unit: "share",
    low: 0,
    high: 0.5,
    correlationGroup: "fiscal-monetary",
    kind: "structural",
    source: "Reduced-form monetary financing range.",
    read: (request) => request.behavior.deficitMonetizationShare,
    apply: (request, value) => withBehavior(request, { deficitMonetizationShare: value }),
  },
  {
    id: "asset-hedge-share",
    label: "New liquidity to assets",
    group: "asset-market",
    unit: "share",
    low: 0.1,
    high: 0.7,
    correlationGroup: "asset-market",
    kind: "structural",
    source: "Portfolio-allocation scenario range.",
    read: (request) => request.behavior.assetHedgeShare,
    apply: (request, value) => withBehavior(request, { assetHedgeShare: value }),
  },
  {
    id: "housing-hedge-share",
    label: "Asset flow to housing",
    group: "housing",
    unit: "share",
    low: 0.2,
    high: 0.9,
    correlationGroup: "housing-demand",
    kind: "structural",
    source: "Portfolio-allocation scenario range.",
    read: (request) => request.behavior.housingHedgeShare,
    apply: (request, value) => withBehavior(request, { housingHedgeShare: value }),
  },
  {
    id: "rent-pass-through",
    label: "Housing gains passed to rent",
    group: "housing",
    unit: "share",
    low: 0.1,
    high: 0.7,
    correlationGroup: "housing-demand",
    kind: "empirical",
    source: "Reduced-form owner-to-renter price pass-through range.",
    read: (request) => request.behavior.rentPassThrough,
    apply: (request, value) => withBehavior(request, { rentPassThrough: value }),
  },
  {
    id: "avoidance-elasticity",
    label: "Avoidance per tax-rate point",
    group: "compliance",
    unit: "share",
    low: 0,
    high: 0.25,
    correlationGroup: "compliance",
    kind: "empirical",
    source: "Behavioral-response range exposed by the scenario model.",
    read: (request) => request.behavior.avoidanceElasticity,
    apply: (request, value) => withBehavior(request, { avoidanceElasticity: value }),
  },
  {
    id: "expatriation-share",
    label: "Expatriation over decade",
    group: "compliance",
    unit: "share",
    low: 0,
    high: 0.3,
    correlationGroup: "compliance",
    kind: "empirical",
    source: "Behavioral-response range exposed by the scenario model.",
    read: (request) => request.behavior.expatriationShare,
    apply: (request, value) => withBehavior(request, { expatriationShare: value }),
  },
  {
    id: "private-business-inclusion",
    label: "Private-business value included",
    group: "compliance",
    unit: "share",
    low: 0.5,
    high: 1,
    correlationGroup: "valuation",
    kind: "structural",
    source: "Valuation-discount range for illiquid private businesses.",
    read: (request) => request.behavior.privateBusinessInclusionRate,
    apply: (request, value) => withBehavior(request, { privateBusinessInclusionRate: value }),
  },
  {
    id: "savings-response",
    label: "Savings response elasticity",
    group: "growth",
    unit: "elasticity",
    low: 0,
    high: 1.5,
    correlationGroup: "growth-response",
    kind: "structural",
    source: "Dynamic-scoring range documented in the scenario control.",
    read: (request) => request.behavior.savingsResponseElasticity,
    apply: (request, value) => withBehavior(request, { savingsResponseElasticity: value }),
  },
  {
    id: "demand-growth-offset",
    label: "Demand growth offset",
    group: "growth",
    unit: "elasticity",
    low: 0,
    high: 1.5,
    correlationGroup: "growth-response",
    kind: "structural",
    source: "Reduced-form transfer-to-investment response range.",
    read: (request) => request.behavior.demandGrowthOffset,
    apply: (request, value) => withBehavior(request, { demandGrowthOffset: value }),
  },
  {
    id: "buyer-depth",
    label: "Buyer depth",
    group: "asset-market",
    unit: "share",
    low: 0.03,
    high: 0.2,
    correlationGroup: "asset-market-liquidity",
    kind: "empirical",
    source: "Market-depth scenario range.",
    read: (request) => request.market.buyerDepthRatio,
    apply: (request, value) => withMarket(request, { buyerDepthRatio: value }),
  },
  {
    id: "price-impact",
    label: "Equity price impact",
    group: "asset-market",
    unit: "coefficient",
    low: 0.05,
    high: 0.35,
    correlationGroup: "asset-market-liquidity",
    kind: "structural",
    source: "Reduced-form market-impact range.",
    read: (request) => request.market.priceImpactCoefficient,
    apply: (request, value) => withMarket(request, { priceImpactCoefficient: value }),
  },
  {
    id: "maximum-collateral-ltv",
    label: "Maximum collateral LTV",
    group: "financing",
    unit: "share",
    low: 0.3,
    high: 0.7,
    correlationGroup: "credit-conditions",
    kind: "empirical",
    source: "Secured-credit underwriting range.",
    read: (request) => request.market.maximumCollateralLtv,
    apply: (request, value) => withMarket(request, { maximumCollateralLtv: value }),
  },
  {
    id: "housing-supply",
    label: "Housing supply response",
    group: "housing",
    unit: "elasticity",
    low: 0.1,
    high: 1.2,
    correlationGroup: "housing-demand",
    kind: "empirical",
    source: "Housing supply-elasticity scenario range.",
    read: (request) => request.market.housingSupplyElasticity,
    apply: (request, value) => withMarket(request, { housingSupplyElasticity: value }),
  },
  {
    id: "wage-pass-through",
    label: "Wage pass-through",
    group: "income",
    unit: "share",
    low: 0.2,
    high: 0.8,
    correlationGroup: "inflation-response",
    kind: "structural",
    source: "Promoted reduced-form model constant.",
    read: (request) => request.model.wagePassThrough,
    apply: (request, value) => withModel(request, { wagePassThrough: value }),
  },
  {
    id: "loan-amortization",
    label: "Annual loan amortization",
    group: "financing",
    unit: "rate",
    low: 0.05,
    high: 0.2,
    correlationGroup: "credit-conditions",
    kind: "structural",
    source: "Promoted reduced-form model constant.",
    read: (request) => request.model.loanAmortizationRate,
    apply: (request, value) => withModel(request, { loanAmortizationRate: value }),
  },
  {
    id: "top-tax-incidence",
    label: "Top-1% tax incidence",
    group: "distribution",
    unit: "share",
    low: 0.7,
    high: 1,
    correlationGroup: "incidence",
    kind: "structural",
    source: "Promoted distributional-incidence constant.",
    read: (request) => request.model.topTaxIncidenceShare,
    apply: (request, value) => withModel(request, { topTaxIncidenceShare: value }),
  },
  {
    id: "monetary-policy-offset",
    label: "Monetary-policy offset",
    group: "inflation",
    unit: "share",
    low: 0.2,
    high: 0.7,
    correlationGroup: "inflation-response",
    kind: "structural",
    source: "Promoted reduced-form monetary-reaction constant.",
    read: (request) => request.model.monetaryPolicyOffsetShare,
    apply: (request, value) => withModel(request, { monetaryPolicyOffsetShare: value }),
  },
  {
    id: "asset-price-inflation-pass-through",
    label: "Asset-price inflation pass-through",
    group: "asset-market",
    unit: "share",
    low: 0.25,
    high: 0.85,
    correlationGroup: "asset-market",
    kind: "structural",
    source: "Promoted reduced-form asset-price constant.",
    read: (request) => request.model.assetPriceInflationPassThrough,
    apply: (request, value) => withModel(request, { assetPriceInflationPassThrough: value }),
  },
];

const SOURCE_URL_BY_GROUP: Readonly<Record<string, string | null>> = {
  financing: null,
  growth: "https://budgetmodel.wharton.upenn.edu/issues/2019/12/12/senator-warren-wealth-tax",
  fiscal: null,
  "asset-market": null,
  housing: "https://www.federalreserve.gov/econres/feds/homeowner-balance-sheets-and-monetary-policy.htm",
  compliance: "https://www.oecd.org/en/publications/the-role-and-design-of-net-wealth-taxes-in-the-oecd_9789264290303-en.html",
  income: null,
  distribution: "https://www.federalreserve.gov/releases/z1/dataviz/dfa/",
  inflation: null,
  population: "https://www.federalreserve.gov/releases/z1/dataviz/dfa/compare/chart/index.html",
};

export interface PercentileBand {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
}

export interface UncertaintyMetricBand {
  readonly id: string;
  readonly label: string;
  readonly unit: "dollars" | "share" | "index";
  readonly band: PercentileBand;
}

export interface UncertaintyYearBand {
  readonly year: number;
  readonly annualInflation: PercentileBand;
  readonly bottom50PurchasingPowerIndex: PercentileBand;
  readonly top1RealWealthIndex: PercentileBand;
  readonly gdpIndex: PercentileBand;
  readonly privateTaxDebt: PercentileBand;
  readonly governmentDebtAdded: PercentileBand;
}

export interface UncertaintyGroupBand {
  readonly id: WealthGroupOutcomeId;
  readonly label: string;
  readonly metric: "purchasing-power" | "real-wealth";
  readonly band: PercentileBand;
}

export interface UncertaintyInfluence {
  readonly parameterId: string;
  readonly label: string;
  readonly score: number;
  readonly direction: "positive" | "negative" | "flat";
}

export interface UncertaintyInteraction {
  readonly leftParameterId: string;
  readonly leftLabel: string;
  readonly rightParameterId: string;
  readonly rightLabel: string;
  readonly score: number;
  readonly direction: "positive" | "negative" | "flat";
}

export interface UncertaintyAnalysis {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly modelVersion: typeof UNCERTAINTY_MODEL_VERSION;
  readonly options: UncertaintyOptions;
  readonly note: string;
  readonly runs: number;
  readonly constraintChecks: {
    readonly borrowPlusSellAtMostOne: true;
    readonly allocationSharesValid: true;
    readonly fiscalAndLedgerRunsCompleted: number;
  };
  readonly sampledParameters: readonly UncertaintyParameterMetadata[];
  readonly fixedAssumptions: readonly FixedUncertaintyAssumption[];
  readonly verdictFrequencies: Readonly<
    Record<"beneficial" | "mixed" | "harmful", { readonly count: number; readonly share: number }>
  >;
  readonly metrics: readonly UncertaintyMetricBand[];
  readonly years: readonly UncertaintyYearBand[];
  readonly groups: readonly UncertaintyGroupBand[];
  readonly influenceTarget: "bottom50PurchasingPowerChange";
  readonly influenceMethod: "absolute-standardized-correlation";
  readonly interactionMethod: "pair-product-correlation-with-main-effect-residual";
  readonly influences: readonly UncertaintyInfluence[];
  readonly interactions: readonly UncertaintyInteraction[];
}

export interface ParsedUncertaintyOptions {
  readonly value?: UncertaintyOptions;
  readonly errors: readonly string[];
}

export const parseUncertaintyOptions = (input: unknown): ParsedUncertaintyOptions => {
  if (input === undefined) return { value: DEFAULT_UNCERTAINTY_OPTIONS, errors: [] };
  if (!isRecord(input)) return { errors: ["uncertainty options must be an object."] };
  const errors: string[] = [];
  const draws = readInteger(
    input.draws,
    DEFAULT_UNCERTAINTY_OPTIONS.draws,
    MIN_UNCERTAINTY_DRAWS,
    MAX_UNCERTAINTY_DRAWS,
    "draws",
    errors,
  );
  const seed = readInteger(
    input.seed,
    DEFAULT_UNCERTAINTY_OPTIONS.seed,
    -2_147_483_648,
    2_147_483_647,
    "uncertainty seed",
    errors,
  );
  const populationReplicates = readInteger(
    input.populationReplicates,
    DEFAULT_UNCERTAINTY_OPTIONS.populationReplicates,
    2,
    32,
    "populationReplicates",
    errors,
  );
  const populationMode = input.populationMode ?? DEFAULT_UNCERTAINTY_OPTIONS.populationMode;
  if (populationMode !== "fixed" && populationMode !== "combined") {
    errors.push("populationMode must be fixed or combined.");
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    value: {
      draws,
      seed,
      populationMode: populationMode as UncertaintyPopulationMode,
      populationReplicates,
    },
  };
};

interface DrawRecord {
  readonly parameterValues: readonly number[];
  readonly populationReplicate: number;
  readonly verdict: "beneficial" | "mixed" | "harmful";
  readonly metrics: readonly number[];
  readonly years: readonly {
    year: number;
    annualInflation: number;
    bottom50PurchasingPowerIndex: number;
    top1RealWealthIndex: number;
    gdpIndex: number;
    privateTaxDebt: number;
    governmentDebtAdded: number;
  }[];
  readonly groups: ReadonlyMap<WealthGroupOutcomeId, number>;
}

const METRIC_DEFINITIONS = [
  { id: "tax-collected", label: "First-year wealth tax collected", unit: "dollars" },
  { id: "ubi-received", label: "First-year cash benefits", unit: "dollars" },
  {
    id: "public-services-spending",
    label: "First-year public-service value (spending proxy)",
    unit: "dollars",
  },
  { id: "peak-inflation", label: "Peak annual inflation", unit: "share" },
  { id: "bottom50-buying-power", label: "Bottom-50 buying-power change", unit: "share" },
  { id: "top1-real-wealth", label: "Top-1% real-wealth change", unit: "share" },
  { id: "real-gdp", label: "Real GDP per worker change", unit: "share" },
  { id: "private-tax-debt", label: "Final private tax debt", unit: "dollars" },
  { id: "public-burden", label: "Public burden per household", unit: "dollars" },
  { id: "final-tax-collected", label: "Final-year wealth tax collected", unit: "dollars" },
  { id: "final-ubi-received", label: "Final-year cash benefits", unit: "dollars" },
  {
    id: "final-public-services-spending",
    label: "Final-year public-service value (spending proxy)",
    unit: "dollars",
  },
  { id: "final-government-deficit", label: "Final-year government deficit", unit: "dollars" },
  { id: "cumulative-m2-change", label: "Cumulative M2 change", unit: "share" },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly unit: UncertaintyMetricBand["unit"];
}[];

export const runUncertaintyAnalysis = (
  request: ComparisonRequestV1 = DEFAULT_COMPARISON_REQUEST,
  options: UncertaintyOptions = DEFAULT_UNCERTAINTY_OPTIONS,
  hooks: UncertaintyHooks = {},
): UncertaintyAnalysis => {
  const parsedOptions = parseUncertaintyOptions(options);
  if (!parsedOptions.value) throw new Error(parsedOptions.errors.join(" "));
  options = parsedOptions.value;
  const baseRequest = normalizeComparisonRequest(request);
  const metadata = parameterMetadata(baseRequest);
  const random = mulberry32(options.seed);
  const uniforms = PARAMETER_SPECS.map(() => latinHypercubeColumn(options.draws, random));
  const populationCount = options.populationMode === "combined"
    ? Math.min(options.populationReplicates, options.draws)
    : 1;
  const populations = Array.from({ length: populationCount }, (_, index) => {
    const populationRequest = {
      ...baseRequest,
      seed: options.populationMode === "fixed"
        ? baseRequest.seed
        : derivePopulationSeed(options.seed, index),
    };
    return {
      seed: populationRequest.seed,
      households: buildCalibratedPopulation(populationRequest),
    };
  });

  const records: DrawRecord[] = [];
  const progressEvery = Math.max(1, Math.ceil(options.draws / 50));
  hooks.onProgress?.({ completed: 0, total: options.draws, percent: 0, phase: "sampling" });
  for (let draw = 0; draw < options.draws; draw += 1) {
    if (hooks.shouldCancel?.()) throw new UncertaintyCancelledError();
    let candidate = baseRequest;
    for (let parameterIndex = 0; parameterIndex < PARAMETER_SPECS.length; parameterIndex += 1) {
      const spec = PARAMETER_SPECS[parameterIndex];
      const column = uniforms[parameterIndex];
      const meta = metadata[parameterIndex];
      if (!spec || !column || !meta) throw new Error("Uncertainty sampler metadata mismatch.");
      const uniform = column[draw];
      if (uniform === undefined) throw new Error("Uncertainty sampler draw missing.");
      candidate = spec.apply(candidate, triangularQuantile(uniform, meta.low, meta.base, meta.high));
    }
    candidate = enforceJointConstraints(candidate);
    if (candidate.behavior.borrowShare + candidate.behavior.sellShare > 1 + 1e-12) {
      throw new Error("Uncertainty draw violated the borrow-plus-sell constraint.");
    }
    if (
      candidate.ubi.directCashShare < 0 ||
      candidate.ubi.directCashShare > 1 ||
      candidate.ubi.administrativeShare < 0 ||
      candidate.ubi.administrativeShare > 0.5
    ) {
      throw new Error("Uncertainty draw violated a program-allocation constraint.");
    }
    const populationReplicate = draw % populationCount;
    const population = populations[populationReplicate];
    if (!population) throw new Error("Uncertainty population replicate missing.");
    candidate = { ...candidate, seed: population.seed };
    const projection = runComparisonWithPopulation(candidate, population.households).projection;
    const parameterValues = PARAMETER_SPECS.map((spec) => spec.read(candidate));
    const groups = new Map<WealthGroupOutcomeId, number>();
    for (const group of projection.groupOutcomes) {
      const value = group.primaryMetric === "purchasing-power"
        ? group.purchasingPowerChange
        : group.realWealthChange;
      groups.set(group.id, value ?? 0);
    }
    records.push({
      parameterValues,
      populationReplicate,
      verdict: projection.verdict.rating,
      metrics: [
        projection.annualFlows.taxCollected,
        projection.annualFlows.ubiReceived,
        projection.annualFlows.publicServicesSpending,
        projection.summary.peakAnnualInflation,
        projection.summary.bottom50PurchasingPowerChange,
        projection.summary.top1RealWealthChange,
        projection.summary.gdpChange,
        projection.summary.privateTaxDebt,
        projection.summary.publicBurdenPerHousehold,
        projection.annualFlows.finalYear.taxCollected,
        projection.annualFlows.finalYear.ubiReceived,
        projection.annualFlows.finalYear.publicServicesSpending,
        projection.annualFlows.finalYear.governmentDeficit,
        projection.summary.cumulativeM2Change,
      ],
      years: projection.years.map((year) => ({
        year: year.year,
        annualInflation: year.annualInflation,
        bottom50PurchasingPowerIndex: year.bottom50PurchasingPowerIndex,
        top1RealWealthIndex: year.top1RealWealthIndex,
        gdpIndex: year.gdpIndex,
        privateTaxDebt: year.privateTaxDebt,
        governmentDebtAdded: year.governmentDebtAdded,
      })),
      groups,
    });
    const completed = draw + 1;
    if (completed % progressEvery === 0 || completed === options.draws) {
      hooks.onProgress?.({
        completed,
        total: options.draws,
        percent: completed / options.draws,
        phase: "sampling",
      });
    }
  }
  hooks.onProgress?.({
    completed: options.draws,
    total: options.draws,
    percent: 1,
    phase: "summarizing",
  });

  const outcome = records.map((record) => record.metrics[4] ?? 0);
  const influenceInputs = metadata.map((_parameter, index) =>
    records.map((record) => record.parameterValues[index] ?? 0));
  const influenceMetadata: UncertaintyParameterMetadata[] = [...metadata];
  if (options.populationMode === "combined") {
    influenceInputs.push(records.map((record) => record.populationReplicate));
    influenceMetadata.push({
      id: "population-seed",
      label: "Synthetic-population seed",
      group: "population",
      unit: "coefficient",
      low: 0,
      base: 0,
      high: populationCount - 1,
      distribution: "seed-replicates",
      correlationGroup: null,
      kind: "empirical",
      sampled: true,
      source: `${populationCount} deterministic population replicates derived from the ensemble seed.`,
      sourceUrl: SOURCE_URL_BY_GROUP.population ?? null,
    });
  }
  const influenceResult = globalInfluence(influenceInputs, influenceMetadata, outcome);
  const analysis: UncertaintyAnalysis = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    modelVersion: UNCERTAINTY_MODEL_VERSION,
    options,
    note:
      "These are assumption distributions, not statistical confidence intervals or a forecast. " +
      "Public-service value currently uses dollars spent as a transparent proxy.",
    runs: records.length,
    constraintChecks: {
      borrowPlusSellAtMostOne: true,
      allocationSharesValid: true,
      fiscalAndLedgerRunsCompleted: records.length,
    },
    sampledParameters: influenceMetadata,
    fixedAssumptions: fixedAssumptions(baseRequest),
    verdictFrequencies: verdictFrequencies(records),
    metrics: METRIC_DEFINITIONS.map((metric, index) => ({
      ...metric,
      band: percentileBand(records.map((record) => record.metrics[index] ?? 0)),
    })),
    years: summarizeYears(records),
    groups: summarizeGroups(records),
    influenceTarget: "bottom50PurchasingPowerChange",
    influenceMethod: "absolute-standardized-correlation",
    interactionMethod: "pair-product-correlation-with-main-effect-residual",
    influences: influenceResult.influences,
    interactions: influenceResult.interactions,
  };
  hooks.onProgress?.({
    completed: options.draws,
    total: options.draws,
    percent: 1,
    phase: "complete",
  });
  return analysis;
};

const parameterMetadata = (
  request: ComparisonRequestV1,
): readonly UncertaintyParameterMetadata[] =>
  PARAMETER_SPECS.map((spec) => {
    const base = spec.read(request);
    return {
      id: spec.id,
      label: spec.label,
      group: spec.group,
      unit: spec.unit,
      low: Math.min(spec.low, base),
      base,
      high: Math.max(spec.high, base),
      distribution: "triangular",
      correlationGroup: spec.correlationGroup,
      kind: spec.kind,
      sampled: true,
      source: spec.source,
      sourceUrl: SOURCE_URL_BY_GROUP[spec.group] ?? null,
    };
  });

const fixedAssumptions = (
  request: ComparisonRequestV1,
): readonly FixedUncertaintyAssumption[] => [
  {
    id: "funding-rule",
    label: "Fiscal closure rule",
    group: "fiscal",
    value: request.ubi.fundingRule,
    kind: "normative",
    sampled: false,
    reason: "Categorical policy choice; compare it as a scenario rather than mixing it into one distribution.",
  },
  {
    id: "direct-cash-share",
    label: "Delivered as cash",
    group: "services",
    value: request.ubi.directCashShare,
    kind: "normative",
    sampled: false,
    reason: "Program design choice held at the scenario value.",
  },
  {
    id: "administrative-share",
    label: "Administration share",
    group: "services",
    value: request.ubi.administrativeShare,
    kind: "normative",
    sampled: false,
    reason: "Program design choice held at the scenario value.",
  },
  {
    id: "benefit-indexation",
    label: "Benefit indexation",
    group: "fiscal",
    value: request.ubi.benefitIndexation ?? "none",
    kind: "normative",
    sampled: false,
    reason: "Categorical policy choice held at the scenario value.",
  },
  {
    id: "verdict-threshold",
    label: "Harmful-inflation verdict threshold",
    group: "verdict",
    value: request.model.verdictHarmfulInflation,
    kind: "normative",
    sampled: false,
    reason: "Judgment threshold; varying it would change the label rather than the modeled economy.",
  },
];

const enforceJointConstraints = (request: ComparisonRequestV1): ComparisonRequestV1 => {
  const borrow = Math.max(0, request.behavior.borrowShare);
  const sell = Math.max(0, request.behavior.sellShare);
  const total = borrow + sell;
  if (total <= 1) return request;
  return withBehavior(request, {
    borrowShare: borrow / total,
    sellShare: sell / total,
  });
};

const summarizeYears = (records: readonly DrawRecord[]): readonly UncertaintyYearBand[] => {
  const yearCount = records[0]?.years.length ?? 0;
  return Array.from({ length: yearCount }, (_, index) => ({
    year: records[0]?.years[index]?.year ?? index,
    annualInflation: percentileBand(records.map((record) => record.years[index]?.annualInflation ?? 0)),
    bottom50PurchasingPowerIndex: percentileBand(
      records.map((record) => record.years[index]?.bottom50PurchasingPowerIndex ?? 0),
    ),
    top1RealWealthIndex: percentileBand(
      records.map((record) => record.years[index]?.top1RealWealthIndex ?? 0),
    ),
    gdpIndex: percentileBand(records.map((record) => record.years[index]?.gdpIndex ?? 0)),
    privateTaxDebt: percentileBand(
      records.map((record) => record.years[index]?.privateTaxDebt ?? 0),
    ),
    governmentDebtAdded: percentileBand(
      records.map((record) => record.years[index]?.governmentDebtAdded ?? 0),
    ),
  }));
};

const summarizeGroups = (records: readonly DrawRecord[]): readonly UncertaintyGroupBand[] => {
  const labels: Readonly<Record<WealthGroupOutcomeId, string>> = {
    "bottom-50-renter": "Bottom 50% renters",
    "bottom-50-owner": "Bottom 50% homeowners",
    "middle-40": "Middle 40%",
    "top-10": "Top 10%",
    "top-1": "Top 1%",
    "top-0.1": "Top 0.1%",
  };
  const ids = Object.keys(labels) as WealthGroupOutcomeId[];
  return ids.map((id) => ({
    id,
    label: labels[id],
    metric: id === "bottom-50-renter" || id === "bottom-50-owner"
      ? "purchasing-power"
      : "real-wealth",
    band: percentileBand(records.map((record) => record.groups.get(id) ?? 0)),
  }));
};

const verdictFrequencies = (
  records: readonly DrawRecord[],
): UncertaintyAnalysis["verdictFrequencies"] => {
  const count = { beneficial: 0, mixed: 0, harmful: 0 };
  for (const record of records) count[record.verdict] += 1;
  const total = records.length || 1;
  return {
    beneficial: { count: count.beneficial, share: count.beneficial / total },
    mixed: { count: count.mixed, share: count.mixed / total },
    harmful: { count: count.harmful, share: count.harmful / total },
  };
};

const globalInfluence = (
  inputs: readonly (readonly number[])[],
  metadata: readonly UncertaintyParameterMetadata[],
  outcome: readonly number[],
): { influences: readonly UncertaintyInfluence[]; interactions: readonly UncertaintyInteraction[] } => {
  const standardizedInputs = inputs.map(standardize);
  const standardizedOutcome = standardize(outcome);
  const coefficients = standardizedInputs.map((input) => correlation(input, standardizedOutcome));
  const fitted = standardizedOutcome.map((_value, row) =>
    coefficients.reduce(
      (sum, coefficient, column) => sum + coefficient * (standardizedInputs[column]?.[row] ?? 0),
      0,
    ));
  const residual = standardizedOutcome.map((value, row) => value - (fitted[row] ?? 0));
  const standardizedResidual = standardize(residual);
  const influences = metadata
    .map((parameter, index): UncertaintyInfluence => {
      const coefficient = coefficients[index] ?? 0;
      return {
        parameterId: parameter.id,
        label: parameter.label,
        score: Math.abs(coefficient),
        direction: signedDirection(coefficient),
      };
    })
    .sort((left, right) => right.score - left.score);
  const interactions: UncertaintyInteraction[] = [];
  for (let left = 0; left < standardizedInputs.length; left += 1) {
    for (let right = left + 1; right < standardizedInputs.length; right += 1) {
      const leftValues = standardizedInputs[left];
      const rightValues = standardizedInputs[right];
      const leftMeta = metadata[left];
      const rightMeta = metadata[right];
      if (!leftValues || !rightValues || !leftMeta || !rightMeta) continue;
      const product = standardize(leftValues.map((value, row) => value * (rightValues[row] ?? 0)));
      const coefficient = correlation(product, standardizedResidual);
      interactions.push({
        leftParameterId: leftMeta.id,
        leftLabel: leftMeta.label,
        rightParameterId: rightMeta.id,
        rightLabel: rightMeta.label,
        score: Math.abs(coefficient),
        direction: signedDirection(coefficient),
      });
    }
  }
  interactions.sort((left, right) => right.score - left.score);
  return { influences: influences.slice(0, 10), interactions: interactions.slice(0, 8) };
};

const signedDirection = (value: number): "positive" | "negative" | "flat" =>
  value > 1e-9 ? "positive" : value < -1e-9 ? "negative" : "flat";

const standardize = (values: readonly number[]): number[] => {
  if (values.length === 0) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  if (deviation <= Number.EPSILON) return values.map(() => 0);
  return values.map((value) => (value - mean) / deviation);
};

const correlation = (left: readonly number[], right: readonly number[]): number => {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum / length;
};

const percentileBand = (values: readonly number[]): PercentileBand => ({
  p10: quantile(values, 0.1),
  p50: quantile(values, 0.5),
  p90: quantile(values, 0.9),
});

const quantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
};

const triangularQuantile = (uniform: number, low: number, mode: number, high: number): number => {
  if (high <= low) return low;
  const clampedMode = Math.min(high, Math.max(low, mode));
  const split = (clampedMode - low) / (high - low);
  if (uniform < split) return low + Math.sqrt(uniform * (high - low) * (clampedMode - low));
  return high - Math.sqrt((1 - uniform) * (high - low) * (high - clampedMode));
};

const latinHypercubeColumn = (draws: number, random: () => number): readonly number[] => {
  const strata = Array.from({ length: draws }, (_, index) => index);
  for (let index = strata.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const value = strata[index];
    strata[index] = strata[swap] ?? index;
    strata[swap] = value ?? swap;
  }
  return strata.map((stratum) => (stratum + random()) / draws);
};

const derivePopulationSeed = (seed: number, replicate: number): number =>
  (Math.imul(seed ^ 0x9e3779b9, replicate + 1) >>> 0) - 0x80000000;

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const readInteger = (
  raw: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  errors: string[],
): number => {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
    errors.push(`${label} must be a safe integer from ${minimum} to ${maximum}.`);
    return fallback;
  }
  return raw;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
