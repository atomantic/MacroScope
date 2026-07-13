import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  SENSITIVITY_DIALS,
  runComparison,
  runSensitivityAnalysis,
  type ComparisonRequestV1,
} from "../src/index.js";

// Sensitivity runs stay deterministic regardless of sample size, so the tests
// use a smaller population for speed (mirrors projection.test.ts).
const request = (overrides: Partial<ComparisonRequestV1> = {}): ComparisonRequestV1 => ({
  ...DEFAULT_COMPARISON_REQUEST,
  sampleSize: 1_500,
  ...overrides,
});

describe("sensitivity tornado analysis", () => {
  it("produces identical output for identical requests (determinism)", () => {
    const first = runSensitivityAnalysis(request());
    const second = runSensitivityAnalysis(request());
    expect(second).toStrictEqual(first);
  });

  it("reports the same base verdict and headline outputs as a single comparison", () => {
    const req = request();
    const analysis = runSensitivityAnalysis(req);
    const comparison = runComparison(req);
    expect(analysis.base.verdict).toBe(comparison.projection.verdict.rating);
    expect(analysis.base.bottom50PurchasingPowerChange).toBe(
      comparison.projection.summary.bottom50PurchasingPowerChange,
    );
    expect(analysis.base.peakAnnualInflation).toBe(
      comparison.projection.summary.peakAnnualInflation,
    );
  });

  it("perturbs every documented dial and ranks by bottom-50 impact", () => {
    const analysis = runSensitivityAnalysis(request());
    expect(analysis.dials).toHaveLength(SENSITIVITY_DIALS.length);
    // Ranked descending by absolute impact on bottom-50 purchasing power.
    for (let index = 1; index < analysis.dials.length; index += 1) {
      const dial = analysis.dials[index];
      const previous = analysis.dials[index - 1];
      if (!dial || !previous) throw new Error("missing dial");
      expect(previous.impact).toBeGreaterThanOrEqual(dial.impact);
    }
    // Impact is the larger of the two endpoint deltas, and each direction agrees
    // with the signed low→high swing.
    for (const dial of analysis.dials) {
      expect(dial.impact).toBeCloseTo(
        Math.max(Math.abs(dial.low.bottom50Delta), Math.abs(dial.high.bottom50Delta)),
        12,
      );
      const expectedDirection =
        dial.swing > 1e-6 ? "beneficial" : dial.swing < -1e-6 ? "harmful" : "flat";
      expect(dial.direction).toBe(expectedDirection);
    }
  });

  it("runs on the ~2N budget (base + two endpoints per dial, plus bounded flip search)", () => {
    const analysis = runSensitivityAnalysis(request());
    const endpointRuns = 1 + SENSITIVITY_DIALS.length * 2;
    expect(analysis.runs).toBeGreaterThanOrEqual(endpointRuns);
    // At most three candidate dials are bisected (16 iterations each).
    expect(analysis.runs).toBeLessThanOrEqual(endpointRuns + 3 * 16);
  });

  it("carries click-to-set form metadata for each dial and its endpoints", () => {
    const analysis = runSensitivityAnalysis(request());
    for (const dial of analysis.dials) {
      const spec = SENSITIVITY_DIALS.find((candidate) => candidate.id === dial.id);
      if (!spec) throw new Error(`missing spec for ${dial.id}`);
      expect(dial.formId).toBe(spec.form.id);
      // formValue converts the engine's fractional value to the field's display
      // unit, so the panel can populate the input directly.
      expect(dial.low.formValue).toBeCloseTo(dial.low.value * spec.form.scale, 9);
      expect(dial.high.formValue).toBeCloseTo(dial.high.value * spec.form.scale, 9);
    }
  });

  it("names the smallest single-dial change that flips the verdict when one exists", () => {
    // A near break-even mixed scenario flips to beneficial as the asset return
    // rises, so a flip must be reported with a plain-language sentence.
    const analysis = runSensitivityAnalysis(request());
    expect(analysis.base.verdict).toBe("mixed");
    const flip = analysis.verdictFlip;
    expect(flip).not.toBeNull();
    if (!flip) throw new Error("expected a verdict flip");
    expect(flip.fromVerdict).toBe("mixed");
    expect(flip.toVerdict).not.toBe("mixed");
    expect(flip.sentence).toContain("flips the verdict");
    expect(flip.sentence).toContain(flip.label.toLowerCase());
    // The reported threshold really does flip the verdict when applied alone.
    const spec = SENSITIVITY_DIALS.find((candidate) => candidate.id === flip.dialId);
    if (!spec) throw new Error("missing flip dial spec");
    const flipped = runComparison(spec.apply(request(), flip.value));
    expect(flipped.projection.verdict.rating).toBe(flip.toVerdict);
  });

  it("reports no flip when the verdict is stable across every tested range", () => {
    // Current law: no wealth tax, no UBI. The bottom half is unaffected, so the
    // verdict cannot be moved by any single dial in its tested range.
    const analysis = runSensitivityAnalysis(
      request({
        wealthTax: { targetMode: "exemption", exemption: 10_000_000, topShare: 0.01, rate: 0 },
        ubi: {
          adultMonthlyBenefit: 0,
          childMonthlyBenefit: 0,
          fundingRule: "revenue-constrained",
          benefitIndexation: "none",
          directCashShare: 1,
          administrativeShare: 0.05,
        },
      }),
    );
    const allStable = analysis.dials.every(
      (dial) => dial.low.verdict === analysis.base.verdict && dial.high.verdict === analysis.base.verdict,
    );
    if (allStable) {
      expect(analysis.verdictFlip).toBeNull();
    } else {
      expect(analysis.verdictFlip).not.toBeNull();
    }
  });
});
