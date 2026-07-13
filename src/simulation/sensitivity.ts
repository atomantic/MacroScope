import { SCENARIO_SCHEMA_VERSION } from "../policies/schema.js";
import {
  DEFAULT_COMPARISON_REQUEST,
  type ComparisonRequestV1,
} from "./contracts.js";
import {
  buildCalibratedPopulation,
  normalizeComparisonRequest,
  runComparisonWithPopulation,
} from "./scenarioRunner.js";

// Sensitivity analysis (issue #11). For a given scenario we perturb each key
// assumption one dial at a time across a documented low/high range, holding the
// sampled population fixed, and record how the headline outputs move:
//   - bottom-50 real purchasing power vs. the no-policy path (the ranking metric)
//   - peak annual inflation over the ten-year projection
// The result feeds a tornado chart ranking assumptions by their impact on the
// bottom-half outcome, and a "verdict flip" annotation naming the smallest
// single-dial change that flips the overall verdict.
//
// Every dial is a continuous numeric field the API already accepts. Its low and
// high bounds are chosen to stay inside the request validator's accepted range
// (see server/comparisonInput.ts) so every perturbed run is a valid scenario.
// "Wage pass-through" from the issue's illustrative list is a fixed internal
// projection constant rather than an exposed request dial, so it is not swept.

export type SensitivityVerdict = "beneficial" | "mixed" | "harmful";
export type SensitivityUnit = "share" | "rate" | "elasticity" | "coefficient";
export type SensitivityGroup = "behavior" | "market" | "ubi";
export type SensitivityDirection = "beneficial" | "harmful" | "flat";

// How a perturbed value reads in plain language and in the form field the click
// handler drives. `form.id` matches the DOM input id in public/index.html so a
// bar click can set that field directly; `form.scale` converts the engine's
// fractional value to the field's display unit (e.g. a 0.65 share shows as 65).
interface DialSpec {
  readonly id: string;
  readonly label: string;
  readonly group: SensitivityGroup;
  readonly unit: SensitivityUnit;
  readonly low: number;
  readonly high: number;
  readonly form: { readonly id: string; readonly scale: number };
  readonly read: (request: ComparisonRequestV1) => number;
  readonly apply: (request: ComparisonRequestV1, value: number) => ComparisonRequestV1;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

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
const withUbi = (
  request: ComparisonRequestV1,
  patch: Partial<ComparisonRequestV1["ubi"]>,
): ComparisonRequestV1 => ({
  ...request,
  ubi: { ...request.ubi, ...patch },
});

// The tornado dials, richest drivers first for readability before ranking. The
// borrow/sell shares clamp against each other so their sum never exceeds 1
// (which would leave the cash path negative-weighted in the projection).
export const SENSITIVITY_DIALS: readonly DialSpec[] = [
  {
    id: "borrow-share",
    label: "Borrow share",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 1,
    form: { id: "borrow-share", scale: 100 },
    read: (request) => request.behavior.borrowShare,
    apply: (request, value) =>
      withBehavior(request, {
        borrowShare: clamp(value, 0, 1 - request.behavior.sellShare),
      }),
  },
  {
    id: "asset-hedge-share",
    label: "New liquidity to assets",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 1,
    form: { id: "asset-hedge-share", scale: 100 },
    read: (request) => request.behavior.assetHedgeShare,
    apply: (request, value) => withBehavior(request, { assetHedgeShare: clamp(value, 0, 1) }),
  },
  {
    id: "monetization",
    label: "Deficit monetized",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 1,
    form: { id: "monetization", scale: 100 },
    read: (request) => request.behavior.deficitMonetizationShare,
    apply: (request, value) =>
      withBehavior(request, { deficitMonetizationShare: clamp(value, 0, 1) }),
  },
  {
    id: "avoidance-elasticity",
    label: "Avoidance per point",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 0.5,
    form: { id: "avoidance-elasticity", scale: 100 },
    read: (request) => request.behavior.avoidanceElasticity,
    apply: (request, value) =>
      withBehavior(request, { avoidanceElasticity: clamp(value, 0, 0.5) }),
  },
  {
    id: "housing-supply",
    label: "Housing supply response",
    group: "market",
    unit: "elasticity",
    low: 0,
    high: 2,
    form: { id: "housing-supply", scale: 1 },
    read: (request) => request.market.housingSupplyElasticity,
    apply: (request, value) =>
      withMarket(request, { housingSupplyElasticity: clamp(value, 0, 2) }),
  },
  {
    id: "rent-pass-through",
    label: "Price gain passed to rent",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 1,
    form: { id: "rent-pass-through", scale: 100 },
    read: (request) => request.behavior.rentPassThrough,
    apply: (request, value) => withBehavior(request, { rentPassThrough: clamp(value, 0, 1) }),
  },
  {
    id: "asset-return",
    label: "Annual asset return",
    group: "behavior",
    unit: "rate",
    low: -0.02,
    high: 0.12,
    form: { id: "asset-return", scale: 100 },
    read: (request) => request.behavior.annualAssetReturn,
    apply: (request, value) =>
      withBehavior(request, { annualAssetReturn: clamp(value, -0.5, 0.5) }),
  },
  {
    id: "administrative-share",
    label: "Administration share",
    group: "ubi",
    unit: "share",
    low: 0,
    high: 0.3,
    form: { id: "administrative-share", scale: 100 },
    read: (request) => request.ubi.administrativeShare,
    apply: (request, value) => withUbi(request, { administrativeShare: clamp(value, 0, 0.5) }),
  },
  {
    id: "expatriation-share",
    label: "Expatriation over decade",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 0.9,
    form: { id: "expatriation-share", scale: 100 },
    read: (request) => request.behavior.expatriationShare,
    apply: (request, value) => withBehavior(request, { expatriationShare: clamp(value, 0, 0.9) }),
  },
  {
    id: "private-business-inclusion",
    label: "Private-business included",
    group: "behavior",
    unit: "share",
    low: 0.3,
    high: 1,
    form: { id: "private-business-inclusion", scale: 100 },
    read: (request) => request.behavior.privateBusinessInclusionRate,
    apply: (request, value) =>
      withBehavior(request, { privateBusinessInclusionRate: clamp(value, 0, 1) }),
  },
  {
    id: "housing-hedge-share",
    label: "Asset flow to housing",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 1,
    form: { id: "housing-hedge-share", scale: 100 },
    read: (request) => request.behavior.housingHedgeShare,
    apply: (request, value) => withBehavior(request, { housingHedgeShare: clamp(value, 0, 1) }),
  },
  {
    id: "sell-share",
    label: "Asset-sale share",
    group: "behavior",
    unit: "share",
    low: 0,
    high: 1,
    form: { id: "sell-share", scale: 100 },
    read: (request) => request.behavior.sellShare,
    apply: (request, value) =>
      withBehavior(request, { sellShare: clamp(value, 0, 1 - request.behavior.borrowShare) }),
  },
  {
    id: "direct-cash-share",
    label: "Delivered as cash",
    group: "ubi",
    unit: "share",
    low: 0.5,
    high: 1,
    form: { id: "direct-cash-share", scale: 100 },
    read: (request) => request.ubi.directCashShare,
    apply: (request, value) => withUbi(request, { directCashShare: clamp(value, 0, 1) }),
  },
];

export interface SensitivityOutcome {
  // The perturbed dial value, plus the display-unit value for the form field a
  // bar click should populate (form id carried on the parent dial result).
  readonly value: number;
  readonly formValue: number;
  readonly bottom50PurchasingPowerChange: number;
  readonly peakAnnualInflation: number;
  readonly verdict: SensitivityVerdict;
  // Change in each headline output relative to the base scenario.
  readonly bottom50Delta: number;
  readonly peakInflationDelta: number;
}

export interface SensitivityDialResult {
  readonly id: string;
  readonly label: string;
  readonly group: SensitivityGroup;
  readonly unit: SensitivityUnit;
  readonly formId: string;
  readonly baseValue: number;
  readonly lowValue: number;
  readonly highValue: number;
  readonly low: SensitivityOutcome;
  readonly high: SensitivityOutcome;
  // Ranking metric: the larger absolute swing in bottom-50 purchasing power the
  // dial produces across its low/high range. Dials are sorted by this desc.
  readonly impact: number;
  // Signed swing in bottom-50 purchasing power from the low to the high end. Its
  // sign gives the tornado bar its direction/color: raising the dial helps
  // ("beneficial"), hurts ("harmful"), or does effectively nothing ("flat").
  readonly swing: number;
  readonly direction: SensitivityDirection;
}

export interface SensitivityFlip {
  readonly dialId: string;
  readonly label: string;
  readonly formId: string;
  // The threshold value (engine and display units) at which the verdict flips,
  // refined by bisection so it is the smallest single-dial change that flips.
  readonly value: number;
  readonly formValue: number;
  readonly fromValue: number;
  readonly fromVerdict: SensitivityVerdict;
  readonly toVerdict: SensitivityVerdict;
  readonly sentence: string;
}

export interface SensitivityAnalysis {
  readonly schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly base: {
    readonly bottom50PurchasingPowerChange: number;
    readonly peakAnnualInflation: number;
    readonly verdict: SensitivityVerdict;
  };
  readonly dials: readonly SensitivityDialResult[];
  readonly verdictFlip: SensitivityFlip | null;
  // Number of full scenario runs performed (base + perturbations + bisection),
  // exposed so the ~2N run budget stays observable and testable.
  readonly runs: number;
}

interface HeadlineOutputs {
  readonly bottom50: number;
  readonly peakInflation: number;
  readonly verdict: SensitivityVerdict;
}

// A small deterministic bisection is done per flipping dial to name the smallest
// change that flips the verdict. Fixed iteration count keeps it deterministic
// and bounds the run budget; only the closest candidate dials are refined.
const BISECTION_ITERATIONS = 16;
const MAX_BISECTED_CANDIDATES = 3;

export const runSensitivityAnalysis = (
  request: ComparisonRequestV1 = DEFAULT_COMPARISON_REQUEST,
): SensitivityAnalysis => {
  const baseRequest = normalizeComparisonRequest(request);
  // One shared calibrated population across every run: identical sampling makes
  // the sweep deterministic and skips the per-run population rebuild.
  const population = buildCalibratedPopulation(baseRequest);
  let runs = 0;
  const evaluate = (candidate: ComparisonRequestV1): HeadlineOutputs => {
    runs += 1;
    const projection = runComparisonWithPopulation(candidate, population).projection;
    return {
      bottom50: projection.summary.bottom50PurchasingPowerChange,
      peakInflation: projection.summary.peakAnnualInflation,
      verdict: projection.verdict.rating,
    };
  };

  const base = evaluate(baseRequest);

  const dials = SENSITIVITY_DIALS.map((dial): SensitivityDialResult => {
    const baseValue = dial.read(baseRequest);
    const lowOutcome = outcomeFor(dial, baseRequest, dial.low, base, evaluate);
    const highOutcome = outcomeFor(dial, baseRequest, dial.high, base, evaluate);
    const swing = highOutcome.bottom50Delta - lowOutcome.bottom50Delta;
    const impact = Math.max(
      Math.abs(lowOutcome.bottom50Delta),
      Math.abs(highOutcome.bottom50Delta),
    );
    return {
      id: dial.id,
      label: dial.label,
      group: dial.group,
      unit: dial.unit,
      formId: dial.form.id,
      baseValue,
      lowValue: dial.low,
      highValue: dial.high,
      low: lowOutcome,
      high: highOutcome,
      impact,
      swing,
      direction: swing > 1e-6 ? "beneficial" : swing < -1e-6 ? "harmful" : "flat",
    };
  }).sort((left, right) => right.impact - left.impact);

  const verdictFlip = findVerdictFlip(baseRequest, base, dials, evaluate);

  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    base: {
      bottom50PurchasingPowerChange: base.bottom50,
      peakAnnualInflation: base.peakInflation,
      verdict: base.verdict,
    },
    dials,
    verdictFlip,
    runs,
  };
};

const outcomeFor = (
  dial: DialSpec,
  baseRequest: ComparisonRequestV1,
  value: number,
  base: HeadlineOutputs,
  evaluate: (candidate: ComparisonRequestV1) => HeadlineOutputs,
): SensitivityOutcome => {
  const perturbed = dial.apply(baseRequest, value);
  // The dial may clamp the requested value against a joint constraint (e.g.
  // borrow + sell <= 1); report the value the engine actually saw.
  const appliedValue = dial.read(perturbed);
  const outcome = evaluate(perturbed);
  return {
    value: appliedValue,
    formValue: appliedValue * dial.form.scale,
    bottom50PurchasingPowerChange: outcome.bottom50,
    peakAnnualInflation: outcome.peakInflation,
    verdict: outcome.verdict,
    bottom50Delta: outcome.bottom50 - base.bottom50,
    peakInflationDelta: outcome.peakInflation - base.peakInflation,
  };
};

interface FlipCandidate {
  readonly dial: DialSpec;
  readonly baseValue: number;
  readonly endpointValue: number;
  readonly endpointVerdict: SensitivityVerdict;
  readonly normalizedDistance: number;
}

const findVerdictFlip = (
  baseRequest: ComparisonRequestV1,
  base: HeadlineOutputs,
  dials: readonly SensitivityDialResult[],
  evaluate: (candidate: ComparisonRequestV1) => HeadlineOutputs,
): SensitivityFlip | null => {
  const specById = new Map(SENSITIVITY_DIALS.map((dial) => [dial.id, dial]));
  const candidates: FlipCandidate[] = [];
  for (const result of dials) {
    const dial = specById.get(result.id);
    if (!dial) continue;
    const span = Math.abs(dial.high - dial.low) || 1;
    for (const end of [result.low, result.high] as const) {
      if (end.verdict === base.verdict) continue;
      candidates.push({
        dial,
        baseValue: result.baseValue,
        endpointValue: end.value,
        endpointVerdict: end.verdict,
        normalizedDistance: Math.abs(end.value - result.baseValue) / span,
      });
    }
  }
  if (candidates.length === 0) return null;

  // Refine the closest few endpoint flips by bisection to find the actual
  // threshold, then keep whichever flips with the smallest real dial change.
  candidates.sort((left, right) => left.normalizedDistance - right.normalizedDistance);
  let best: { candidate: FlipCandidate; threshold: number; verdict: SensitivityVerdict } | null =
    null;
  for (const candidate of candidates.slice(0, MAX_BISECTED_CANDIDATES)) {
    const refined = bisectFlip(baseRequest, base.verdict, candidate, evaluate);
    const span = Math.abs(candidate.dial.high - candidate.dial.low) || 1;
    const distance = Math.abs(refined.threshold - candidate.baseValue) / span;
    if (!best || distance < Math.abs(best.threshold - best.candidate.baseValue) / span) {
      best = { candidate, threshold: refined.threshold, verdict: refined.verdict };
    }
  }
  if (!best) return null;

  const { dial } = best.candidate;
  return {
    dialId: dial.id,
    label: dial.label,
    formId: dial.form.id,
    value: best.threshold,
    formValue: best.threshold * dial.form.scale,
    fromValue: best.candidate.baseValue,
    fromVerdict: base.verdict,
    toVerdict: best.verdict,
    sentence: flipSentence(
      dial,
      best.candidate.baseValue,
      best.threshold,
      base.verdict,
      best.verdict,
    ),
  };
};

// Binary-search the boundary between the base value (base verdict) and the
// endpoint value (a different verdict). Returns the value nearest the base at
// which the verdict has already flipped, i.e. the smallest change that flips.
const bisectFlip = (
  baseRequest: ComparisonRequestV1,
  baseVerdict: SensitivityVerdict,
  candidate: FlipCandidate,
  evaluate: (candidate: ComparisonRequestV1) => HeadlineOutputs,
): { threshold: number; verdict: SensitivityVerdict } => {
  let unflipped = candidate.baseValue; // verdict === baseVerdict here
  let flipped = candidate.endpointValue; // verdict !== baseVerdict here
  let flippedVerdict = candidate.endpointVerdict;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const mid = (unflipped + flipped) / 2;
    const outcome = evaluate(candidate.dial.apply(baseRequest, mid));
    if (outcome.verdict === baseVerdict) {
      unflipped = mid;
    } else {
      flipped = mid;
      flippedVerdict = outcome.verdict;
    }
  }
  return { threshold: flipped, verdict: flippedVerdict };
};

const VERDICT_LABEL: Readonly<Record<SensitivityVerdict, string>> = {
  beneficial: "beneficial",
  mixed: "mixed",
  harmful: "harmful",
};

const formatDialValue = (dial: DialSpec, value: number): string => {
  if (dial.unit === "elasticity" || dial.unit === "coefficient") {
    return value.toFixed(2);
  }
  return `${Math.round(value * 100)}%`;
};

const flipSentence = (
  dial: DialSpec,
  fromValue: number,
  toValue: number,
  fromVerdict: SensitivityVerdict,
  toVerdict: SensitivityVerdict,
): string => {
  const direction = toValue >= fromValue ? "Raising" : "Lowering";
  return (
    `${direction} ${dial.label.toLowerCase()} from ${formatDialValue(dial, fromValue)} ` +
    `to about ${formatDialValue(dial, toValue)} — with every other dial unchanged — ` +
    `flips the verdict from ${VERDICT_LABEL[fromVerdict]} to ${VERDICT_LABEL[toVerdict]}.`
  );
};
