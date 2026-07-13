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
  // Number of full scenario runs performed (base + the 2N tornado endpoints +
  // the coarse flip-scan grid + bounded bisection), exposed so the run budget
  // stays observable and testable. Kept to a small bounded multiple of N so the
  // sweep stays within a few seconds at 4,000 agents.
  readonly runs: number;
}

interface HeadlineOutputs {
  readonly bottom50: number;
  readonly peakInflation: number;
  readonly verdict: SensitivityVerdict;
}

// Finding the smallest single-dial change that flips the verdict is a two-stage
// deterministic search per dial:
//   1. A coarse uniform grid across the dial's range (FLIP_SCAN_SAMPLES points,
//      reusing the two tornado endpoints) locates the flip transition NEAREST
//      the base value. A grid — rather than only the two endpoints — is required
//      because verdicts are not monotonic in every dial, so a flip can live
//      strictly inside the range with both endpoints agreeing with the base.
//   2. A bisection within that localized bracket refines the exact threshold.
// Candidates across dials are then compared by their span-normalized threshold
// distance, searched in ascending order of a valid lower bound (the base-side
// grid sample's distance) so the branch-and-bound can stop as soon as the
// remaining lower bounds exceed the best threshold found — this cannot discard
// the true minimum, unlike ranking by the endpoint distance (only an upper
// bound). Fixed counts keep the whole search deterministic and bounded.
const FLIP_SCAN_SAMPLES = 5;
const BISECTION_ITERATIONS = 14;
const MAX_FLIP_REFINEMENTS = 6;

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
    // Impact ranks dials by how far the bottom-50 outcome travels across the
    // dial's whole low→high range — the same span the tornado bar spans (its
    // length is |highDelta - lowDelta|) — so the ranking and the rendered bar
    // lengths always agree.
    const impact = Math.abs(swing);
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

// A flip transition bracketed to a single grid cell nearest the base value:
// `near` (base-verdict side) → `far` (a different verdict). `lowerBound` is the
// span-normalized distance from base to `near`, a valid lower bound on the true
// threshold's distance (the threshold lies beyond `near`, further from base).
interface FlipBracket {
  readonly dial: DialSpec;
  readonly baseValue: number;
  readonly near: number;
  readonly far: number;
  readonly farVerdict: SensitivityVerdict;
  readonly lowerBound: number;
}

const findVerdictFlip = (
  baseRequest: ComparisonRequestV1,
  base: HeadlineOutputs,
  dials: readonly SensitivityDialResult[],
  evaluate: (candidate: ComparisonRequestV1) => HeadlineOutputs,
): SensitivityFlip | null => {
  const specById = new Map(SENSITIVITY_DIALS.map((dial) => [dial.id, dial]));
  const brackets: FlipBracket[] = [];
  for (const result of dials) {
    const dial = specById.get(result.id);
    if (!dial) continue;
    brackets.push(...scanDialForFlip(dial, result, baseRequest, base.verdict, evaluate));
  }
  if (brackets.length === 0) return null;

  // Branch-and-bound over the localized brackets: ascending lower bound, stop as
  // soon as the remaining lower bounds can't beat the best refined threshold.
  brackets.sort((left, right) => left.lowerBound - right.lowerBound);
  let best:
    | { bracket: FlipBracket; threshold: number; verdict: SensitivityVerdict; distance: number }
    | null = null;
  let refinements = 0;
  for (const bracket of brackets) {
    if (best && bracket.lowerBound >= best.distance) break;
    if (refinements >= MAX_FLIP_REFINEMENTS) break;
    refinements += 1;
    const refined = bisectBracket(bracket, baseRequest, base.verdict, evaluate);
    const span = Math.abs(bracket.dial.high - bracket.dial.low) || 1;
    const distance = Math.abs(refined.threshold - bracket.baseValue) / span;
    if (!best || distance < best.distance) {
      best = { bracket, threshold: refined.threshold, verdict: refined.verdict, distance };
    }
  }
  if (!best) return null;

  const { dial } = best.bracket;
  return {
    dialId: dial.id,
    label: dial.label,
    formId: dial.form.id,
    value: best.threshold,
    formValue: best.threshold * dial.form.scale,
    fromValue: best.bracket.baseValue,
    fromVerdict: base.verdict,
    toVerdict: best.verdict,
    sentence: flipSentence(dial, best.bracket.baseValue, best.threshold, base.verdict, best.verdict),
  };
};

// Scan a dial across a coarse uniform grid (reusing the two tornado endpoints,
// so only the interior points cost new runs) and return the flip transition
// nearest the base value on EACH side (up to two brackets), or an empty array
// when no sampled point leaves the base verdict. Returning both directions —
// rather than only the closer-by-lower-bound one — matters when the samples on
// both sides of base already flipped: both brackets then have lowerBound 0, but
// their true (bisected) thresholds can differ, so both must be refined before
// the caller picks the minimum.
// The grid catches interior flips that endpoint-only checks miss, down to its
// resolution (~1/(FLIP_SCAN_SAMPLES-1) of the dial's range). A flip occupying a
// window narrower than one grid cell and touching no grid point can still be
// missed — closing that fully would need dense per-dial sampling that blows the
// bounded run budget, so it is an accepted limit of this reduced-form annotation.
const scanDialForFlip = (
  dial: DialSpec,
  result: SensitivityDialResult,
  baseRequest: ComparisonRequestV1,
  baseVerdict: SensitivityVerdict,
  evaluate: (candidate: ComparisonRequestV1) => HeadlineOutputs,
): FlipBracket[] => {
  const span = Math.abs(dial.high - dial.low) || 1;
  const samples: { value: number; verdict: SensitivityVerdict }[] = [];
  for (let index = 0; index < FLIP_SCAN_SAMPLES; index += 1) {
    const target = dial.low + ((dial.high - dial.low) * index) / (FLIP_SCAN_SAMPLES - 1);
    // Reuse the already-evaluated endpoints; only interior points run the model.
    if (index === 0) {
      samples.push({ value: result.low.value, verdict: result.low.verdict });
    } else if (index === FLIP_SCAN_SAMPLES - 1) {
      samples.push({ value: result.high.value, verdict: result.high.verdict });
    } else {
      const perturbed = dial.apply(baseRequest, target);
      samples.push({ value: dial.read(perturbed), verdict: evaluate(perturbed).verdict });
    }
  }
  // Insert the base value (its verdict is known) so the walk outward from base
  // has a guaranteed base-verdict anchor, then sort by dial value.
  samples.push({ value: result.baseValue, verdict: baseVerdict });
  samples.sort((left, right) => left.value - right.value);
  const baseIndex = samples.findIndex(
    (sample) => sample.value === result.baseValue && sample.verdict === baseVerdict,
  );
  if (baseIndex < 0) return [];

  const brackets: FlipBracket[] = [];
  const add = (nearIndex: number, farIndex: number) => {
    const near = samples[nearIndex];
    const far = samples[farIndex];
    if (!near || !far || far.verdict === baseVerdict) return;
    brackets.push({
      dial,
      baseValue: result.baseValue,
      near: near.value,
      far: far.value,
      farVerdict: far.verdict,
      lowerBound: Math.abs(near.value - result.baseValue) / span,
    });
  };
  // Walk right from base to the first non-base sample, and left likewise; the
  // sample just before each transition (toward base) has the base verdict. Both
  // directions are kept so the caller bisects and compares both.
  for (let index = baseIndex; index + 1 < samples.length; index += 1) {
    if (samples[index + 1]?.verdict !== baseVerdict) {
      add(index, index + 1);
      break;
    }
  }
  for (let index = baseIndex; index - 1 >= 0; index -= 1) {
    if (samples[index - 1]?.verdict !== baseVerdict) {
      add(index, index - 1);
      break;
    }
  }
  return brackets;
};

// Binary-search within a bracket [near (base verdict) → far (a different
// verdict)] for the value nearest the base at which the verdict has already
// flipped — the smallest change on that dial that flips.
const bisectBracket = (
  bracket: FlipBracket,
  baseRequest: ComparisonRequestV1,
  baseVerdict: SensitivityVerdict,
  evaluate: (candidate: ComparisonRequestV1) => HeadlineOutputs,
): { threshold: number; verdict: SensitivityVerdict } => {
  let unflipped = bracket.near;
  let flipped = bracket.far;
  let flippedVerdict = bracket.farVerdict;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const mid = (unflipped + flipped) / 2;
    const outcome = evaluate(bracket.dial.apply(baseRequest, mid));
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
