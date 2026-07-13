import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  DEFAULT_MODEL_TUNABLES,
  MODEL_CONSTANTS,
  MODEL_CONSTANT_DOCS,
  MODEL_TUNABLES,
  parseComparisonRequest,
  runComparison,
  type ComparisonRequestV1,
} from "../src/index.js";

const compactRequest = (): ComparisonRequestV1 => ({
  ...DEFAULT_COMPARISON_REQUEST,
  sampleSize: 800,
  representedHouseholds: 10_000,
});

describe("promoted model constants (issue #8)", () => {
  it("keeps the tunable defaults identical to the calibrated constants", () => {
    expect(DEFAULT_MODEL_TUNABLES).toEqual(DEFAULT_COMPARISON_REQUEST.model);
    expect(DEFAULT_MODEL_TUNABLES.wagePassThrough).toBe(
      MODEL_CONSTANTS.wageExcessInflationPassThrough,
    );
    expect(DEFAULT_MODEL_TUNABLES.loanAmortizationRate).toBe(
      MODEL_CONSTANTS.loanAmortizationRate,
    );
    expect(DEFAULT_MODEL_TUNABLES.monetaryPolicyOffsetShare).toBe(
      MODEL_CONSTANTS.monetaryPolicyOffsetShare,
    );
    expect(DEFAULT_MODEL_TUNABLES.verdictHarmfulInflation).toBe(
      MODEL_CONSTANTS.verdict.harmfulPeakInflation,
    );
  });

  it("exposes at least five tunable constants with display docs", () => {
    expect(MODEL_TUNABLES.length).toBeGreaterThanOrEqual(5);
    const tunableDocs = MODEL_CONSTANT_DOCS.filter((doc) => doc.tunable);
    expect(tunableDocs.length).toBe(MODEL_TUNABLES.length);
    for (const doc of MODEL_CONSTANT_DOCS) {
      expect(doc.rationale.length).toBeGreaterThan(0);
      expect(doc.source.length).toBeGreaterThan(0);
    }
  });

  it("produces byte-identical output whether model defaults are omitted or explicit", () => {
    const { model, ...withoutModel } = compactRequest();
    void model;
    const omitted = runComparison(withoutModel as ComparisonRequestV1);
    const explicit = runComparison(compactRequest());
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicit));
  });

  it("changes deterministic output when a tunable constant is retuned", () => {
    const base = compactRequest();
    const retuned = runComparison({
      ...base,
      model: { ...base.model, monetaryPolicyOffsetShare: 0 },
    });
    const baseline = runComparison(base);
    // A zero monetary-policy offset removes the modeled inflation dampener, so
    // the single-year estimate must rise above the calibrated default.
    expect(retuned.strategies["cash-first"].macro.monetaryPolicyOffset).toBeCloseTo(0, 10);
    expect(
      retuned.strategies["cash-first"].macro.estimatedInflationChange,
    ).toBeGreaterThan(baseline.strategies["cash-first"].macro.estimatedInflationChange);
  });

  it("validates tunable model constants against their declared ranges", () => {
    const parsed = parseComparisonRequest({
      ...compactRequest(),
      model: { monetaryPolicyOffsetShare: 5 },
    });
    expect(parsed.value).toBeUndefined();
    expect(
      parsed.errors.some((error) => error.includes("monetaryPolicyOffsetShare")),
    ).toBe(true);
  });

  it("defaults omitted model fields during validation", () => {
    const parsed = parseComparisonRequest({
      ...compactRequest(),
      model: { wagePassThrough: 0.4 },
    });
    expect(parsed.value?.model.wagePassThrough).toBe(0.4);
    expect(parsed.value?.model.loanAmortizationRate).toBe(
      DEFAULT_MODEL_TUNABLES.loanAmortizationRate,
    );
  });
});
