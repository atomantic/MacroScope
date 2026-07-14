import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  DEFAULT_UNCERTAINTY_OPTIONS,
  analyzeUncertainty,
  parseUncertaintyOptions,
  runUncertaintyAnalysis,
  type ComparisonRequestV1,
  type UncertaintyOptions,
} from "../src/index.js";

const request: ComparisonRequestV1 = {
  ...DEFAULT_COMPARISON_REQUEST,
  sampleSize: 100,
  representedHouseholds: 1_000,
};

const options: UncertaintyOptions = {
  ...DEFAULT_UNCERTAINTY_OPTIONS,
  draws: 32,
  seed: 987_654,
  populationMode: "fixed",
};

describe("joint uncertainty analysis", () => {
  it("replays exactly with the same request, seed, and model version", () => {
    const first = runUncertaintyAnalysis(request, options);
    const second = runUncertaintyAnalysis(request, options);
    expect(second).toStrictEqual(first);
    expect(first.modelVersion).toBe("joint-uncertainty-v1");
    expect(first.runs).toBe(options.draws);
  });

  it("reports ordered percentile bands, verdict frequencies, and bounded output", () => {
    const analysis = runUncertaintyAnalysis(request, options);
    const verdictCount = Object.values(analysis.verdictFrequencies)
      .reduce((sum, frequency) => sum + frequency.count, 0);
    expect(verdictCount).toBe(options.draws);
    expect(analysis.years).toHaveLength(11);
    expect(analysis.years[0]?.year).toBe(0);
    expect(analysis.years.at(-1)?.year).toBe(10);
    expect(analysis.groups).toHaveLength(6);
    expect(analysis.influences.length).toBeGreaterThan(0);
    expect(analysis.interactions.length).toBeGreaterThan(0);
    expect(analysis.influenceMethod).toBe("absolute-standardized-regression-coefficient");
    expect(analysis.interactionMethod)
      .toBe("pair-product-partial-correlation-after-main-effects");
    expect(analysis.correlationMethod).toBe("rank-reordered-latin-hypercube-factor");
    expect(analysis.correlationChecks.length).toBeGreaterThan(0);
    for (const check of analysis.correlationChecks) {
      expect(Math.abs(check.observedCorrelation)).toBeGreaterThan(0.15);
      expect(Math.sign(check.observedCorrelation)).toBe(
        check.expectedDirection === "positive" ? 1 : -1,
      );
    }
    expect(analysis.influences.every((influence) => Number.isFinite(influence.score))).toBe(true);
    expect(analysis.interactions.every((interaction) => interaction.score <= 1)).toBe(true);
    for (const metric of analysis.metrics) {
      expect(metric.band.p10).toBeLessThanOrEqual(metric.band.p50);
      expect(metric.band.p50).toBeLessThanOrEqual(metric.band.p90);
    }
    expect(JSON.stringify(analysis).length).toBeLessThan(100_000);
  });

  it("covers high-leverage families and marks normative choices fixed", () => {
    const analysis = runUncertaintyAnalysis(request, options);
    const sampled = new Set(analysis.sampledParameters.map((parameter) => parameter.id));
    for (const id of [
      "savings-response",
      "demand-growth-offset",
      "avoidance-elasticity",
      "maximum-collateral-ltv",
      "housing-supply",
      "wage-pass-through",
      "monetary-policy-offset",
    ]) {
      expect(sampled.has(id)).toBe(true);
    }
    expect(analysis.sampledParameters.some((parameter) => parameter.sourceUrl !== null)).toBe(true);
    const fixed = new Set(analysis.fixedAssumptions.map((assumption) => assumption.id));
    expect(fixed.has("funding-rule")).toBe(true);
    expect(fixed.has("wealth-tax-design")).toBe(true);
    expect(fixed.has("benefit-levels")).toBe(true);
    expect(fixed.has("direct-cash-share")).toBe(true);
    expect(fixed.has("administrative-share")).toBe(true);
    expect(fixed.has("verdict-threshold")).toBe(true);
    expect(analysis.note).toMatch(/assumption distributions, not statistical confidence intervals/i);
  });

  it("enforces joint constraints in every completed draw", () => {
    const analysis = runUncertaintyAnalysis(request, options);
    expect(analysis.constraintChecks).toEqual({
      borrowPlusSellAtMostOne: true,
      allocationSharesValid: true,
      fiscalAndLedgerRunsCompleted: options.draws,
    });
  });

  it("separates parameter-only from combined population uncertainty", () => {
    const combined = runUncertaintyAnalysis(request, {
      ...options,
      populationMode: "combined",
      populationReplicates: 4,
    });
    expect(combined.sampledParameters.some((parameter) => parameter.id === "population-seed"))
      .toBe(true);
    expect(combined.options.populationMode).toBe("combined");
    expect(combined.populationInfluenceMethod).toBe("categorical-correlation-ratio");
    expect(combined.influences.find((influence) => influence.parameterId === "population-seed"))
      .toMatchObject({ direction: "flat" });
  });

  it("keeps adversarial derived population seeds distinct without retaining every population", () => {
    const combined = runUncertaintyAnalysis(request, {
      ...options,
      draws: 32,
      seed: -1_640_531_527,
      populationMode: "combined",
      populationReplicates: 32,
    });
    expect(combined.populationSeeds).toHaveLength(32);
    expect(new Set(combined.populationSeeds).size).toBe(32);
    expect(combined.runs).toBe(32);
  });

  it("reports progress and validates the run budget", () => {
    const onProgress = vi.fn();
    runUncertaintyAnalysis(request, options, { onProgress });
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({ completed: 0, phase: "sampling" });
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      completed: options.draws,
      phase: "complete",
    });
    expect(parseUncertaintyOptions({ draws: 31 }).errors).toContain(
      "draws must be a safe integer from 32 to 1000.",
    );
    expect(parseUncertaintyOptions({ draws: 1_001 }).value).toBeUndefined();
    expect(() =>
      runUncertaintyAnalysis(request, options, { shouldCancel: () => true }))
      .toThrow("Uncertainty analysis cancelled.");
  });

  it("uses the same validated implementation through the browser engine", () => {
    const response = analyzeUncertainty(request, options);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result).toStrictEqual(runUncertaintyAnalysis(request, options));

    const invalid = analyzeUncertainty(request, { ...options, draws: 2 });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error).toBe("Invalid uncertainty request.");
  });
});
