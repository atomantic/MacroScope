import { describe, expect, it } from "vitest";
// The browser module is untyped JS; importing it here asserts it stays
// dependency-free and node-loadable, and lets the validation harness score the
// SAME audited definition the UI renders against the engine.
import {
  POLICY_PRESETS,
  BIAS_DIRECTION,
  REVENUE_BASIS,
  presetFormFields,
  modelTenYearRevenue,
  benchmarkDeviation,
} from "../public/policy-presets.js";
import { DEFAULT_COMPARISON_REQUEST, compareScenarios } from "../src/index.js";
import type { ComparisonRequestV1 } from "../src/index.js";

// Build the exact engine request the UI would run for a preset, driven by the
// shared derivation so a drift between the audited definition and the simulated
// schedule fails here rather than silently mis-reporting revenue.
const requestFromPreset = (def: (typeof POLICY_PRESETS)[keyof typeof POLICY_PRESETS]): ComparisonRequestV1 => {
  const form = presetFormFields(def) as {
    exemption: number;
    rate: number;
    brackets?: readonly (readonly [number, number])[];
    adultBenefit?: number;
    childBenefit?: number;
  };
  const brackets = (form.brackets ?? []).map(([thresholdM, ratePct]) => ({
    threshold: thresholdM * 1_000_000,
    rate: ratePct / 100,
  }));
  return {
    ...DEFAULT_COMPARISON_REQUEST,
    wealthTax: {
      targetMode: "exemption",
      exemption: form.exemption * 1_000_000,
      topShare: DEFAULT_COMPARISON_REQUEST.wealthTax.topShare,
      rate: form.rate / 100,
      ...(brackets.length > 0 ? { brackets } : {}),
    },
    // Mirror the transfer the UI applies (tax-schedule presets zero UBI), so the
    // harness scores the same tax-side-only scenario the browser runs.
    ubi: {
      ...DEFAULT_COMPARISON_REQUEST.ubi,
      ...(form.adultBenefit !== undefined ? { adultMonthlyBenefit: form.adultBenefit } : {}),
      ...(form.childBenefit !== undefined ? { childMonthlyBenefit: form.childBenefit } : {}),
    },
  };
};

const namedProposals = Object.values(POLICY_PRESETS).filter(
  (def) => def.kind === "tax-schedule",
);

describe("policy preset definitions", () => {
  it("exposes a structured, source-linked definition for every named proposal", () => {
    expect(namedProposals.length).toBeGreaterThan(0);
    for (const def of namedProposals) {
      expect(def.filingUnit).toBeTruthy();
      expect(def.filingNote).toBeTruthy();
      expect(def.scheduleNote).toBeTruthy();
      expect(def.brackets.length).toBeGreaterThan(0);
      expect(def.spending.linkage).toBe("tax-schedule-only");
      expect(def.spending.note).toMatch(/tax side only/i);
      expect(def.citations.length).toBeGreaterThan(0);
      for (const cite of def.citations) {
        expect(cite.url).toMatch(/^https?:\/\//);
      }
    }
  });

  it("marks each not-yet-modeled component with a valid bias direction", () => {
    for (const def of namedProposals) {
      for (const item of def.unmodeled) {
        expect(item.component).toBeTruthy();
        expect(item.note).toBeTruthy();
        expect(Object.keys(BIAS_DIRECTION)).toContain(item.direction);
      }
    }
  });

  it("labels the Sanders preset as married-household with the single-filer caveat", () => {
    const sanders = POLICY_PRESETS["sanders-2020"];
    expect(sanders.filingUnit).toBe("married-household");
    expect(sanders.filingNote).toMatch(/married/i);
    expect(sanders.filingNote.toLowerCase()).toMatch(/single|halved|half/);
    expect(sanders.unmodeled.some((u) => /single/i.test(u.component))).toBe(true);
  });

  it("derives a tax-side-only form that zeroes the generic transfer", () => {
    for (const def of namedProposals) {
      const form = presetFormFields(def) as {
        adultBenefit?: number;
        childBenefit?: number;
      };
      expect(form.adultBenefit).toBe(0);
      expect(form.childBenefit).toBe(0);
    }
  });

  it("derives form fields whose exemption equals the lowest bracket threshold", () => {
    const warren = presetFormFields(POLICY_PRESETS["warren-2020"]) as {
      exemption: number;
      rate: number;
      brackets: [number, number][];
    };
    expect(warren.exemption).toBe(50);
    expect(warren.rate).toBe(2);
    expect(warren.brackets).toEqual([
      [50, 2],
      [1000, 6],
    ]);
    for (const def of namedProposals) {
      const form = presetFormFields(def) as { exemption: number };
      expect(form.exemption).toBe(def.brackets[0][0]);
    }
  });

  it("reports the model beside campaign, no-avoidance, conventional, and dynamic benchmarks with vintages", () => {
    const warren = POLICY_PRESETS["warren-2020"];
    const bases = new Set(warren.benchmarks.map((b) => b.basis));
    for (const basis of ["campaign", "no-avoidance", "conventional", "dynamic"]) {
      expect(bases.has(basis)).toBe(true);
    }
    for (const def of namedProposals) {
      expect(def.benchmarks.length).toBeGreaterThan(0);
      for (const bench of def.benchmarks) {
        expect(Object.keys(REVENUE_BASIS)).toContain(bench.basis);
        expect(Number.isFinite(bench.vintage)).toBe(true);
        expect(bench.tenYearRevenue).toBeGreaterThan(0);
      }
    }
  });
});

describe("policy preset validation harness", () => {
  it("scores each named proposal's revenue against its published benchmarks", () => {
    for (const def of namedProposals) {
      const response = compareScenarios(requestFromPreset(def));
      expect(response.ok).toBe(true);
      if (!response.ok) continue;
      const yearOneRevenue = response.result.wealthTaxAssessment.responseAdjustedTax;
      const tenYearRevenue = modelTenYearRevenue(response.result.projection);

      // Real revenue, not a degenerate zero or NaN.
      expect(Number.isFinite(yearOneRevenue)).toBe(true);
      expect(yearOneRevenue).toBeGreaterThan(100e9);
      expect(tenYearRevenue).toBeGreaterThan(yearOneRevenue);

      // Broad plausibility guard against a gross calibration regression; NOT a
      // tuning target — the benchmarks below are for validation only.
      expect(yearOneRevenue).toBeLessThan(1_500e9);

      // The report the UI renders: model figure beside each published benchmark
      // with a finite deviation. Producing the report is the acceptance bar, not
      // matching any benchmark.
      const report = def.benchmarks.map((bench) => ({
        basis: bench.basis,
        published: bench.tenYearRevenue,
        model: tenYearRevenue,
        deviation: benchmarkDeviation(tenYearRevenue, bench.tenYearRevenue),
      }));
      expect(report.length).toBe(def.benchmarks.length);
      for (const row of report) {
        expect(row.deviation).not.toBeNull();
        expect(Number.isFinite(row.deviation as number)).toBe(true);
      }
    }
  });

  it("reproduces a near-zero revenue baseline for current law", () => {
    const response = compareScenarios(requestFromPreset(POLICY_PRESETS["current-law"]));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result.wealthTaxAssessment.responseAdjustedTax).toBe(0);
  });
});
