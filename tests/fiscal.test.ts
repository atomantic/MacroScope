import { describe, expect, it } from "vitest";
import { projectFiscalPath } from "../src/index.js";

const path = (
  fundingRule: "fixed" | "revenue-constrained" | "smoothed",
  taxRevenues: readonly number[],
  requestedProgramOutlays: readonly number[],
) =>
  projectFiscalPath({
    fundingRule,
    surplusUse: "debt-reduction",
    taxRevenues,
    requestedProgramOutlays,
  });

describe("explicit fiscal closure", () => {
  it("makes all funding rules converge when revenue matches the requested schedule", () => {
    const rules = ["fixed", "revenue-constrained", "smoothed"] as const;
    const outcomes = rules.map((rule) => path(rule, [100, 100, 100], [100, 100, 100]));

    for (const years of outcomes) {
      expect(years.map((year) => year.programOutlay)).toEqual([100, 100, 100]);
      expect(years.every((year) => year.debtIssued === 0)).toBe(true);
      expect(years.every((year) => Math.abs(year.budgetIdentityResidual) < 1e-9)).toBe(
        true,
      );
    }
  });

  it("distinguishes fixed, current-revenue, and smoothed paths during a revenue shock", () => {
    const revenues = [100, 0, 100];
    const requested = [100, 100, 100];
    const fixed = path("fixed", revenues, requested);
    const constrained = path("revenue-constrained", revenues, requested);
    const smoothed = path("smoothed", revenues, requested);

    expect(fixed.map((year) => year.scheduledProgramOutlay)).toEqual([100, 100, 100]);
    expect(constrained.map((year) => year.scheduledProgramOutlay)).toEqual([100, 0, 100]);
    expect(smoothed.map((year) => year.scheduledProgramOutlay)).toEqual([100, 50, 200 / 3]);
    expect(smoothed[1]?.scheduledProgramOutlay).toBeGreaterThan(
      constrained[1]?.scheduledProgramOutlay ?? 0,
    );
    expect(smoothed[1]?.scheduledProgramOutlay).toBeLessThan(
      fixed[1]?.scheduledProgramOutlay ?? 0,
    );

    const smoothedFinal = smoothed.at(-1);
    expect(smoothedFinal?.programDebt).toBeCloseTo(
      smoothed.reduce((sum, year) => sum + year.debtIssued - year.debtRepaid, 0),
      10,
    );
  });

  it("uses a later surplus to repay program debt and scores interest", () => {
    const years = projectFiscalPath({
      fundingRule: "fixed",
      surplusUse: "debt-reduction",
      taxRevenues: [0, 220],
      requestedProgramOutlays: [100, 100],
      averageInterestRate: 0.1,
    });

    expect(years[0]?.debtIssued).toBe(100);
    expect(years[1]?.interestExpense).toBe(10);
    expect(years[1]?.debtRepaid).toBe(110);
    expect(years[1]?.programDebt).toBe(0);
    expect(years[1]?.netPublicDebtChange).toBe(-10);
    expect(years[1]?.interestSavings).toBe(11);
  });

  it("makes every surplus destination explicit and keeps the annual identity closed", () => {
    const uses = [
      "debt-reduction",
      "additional-services",
      "rebate",
      "treasury-balance",
    ] as const;
    const outcomes = Object.fromEntries(
      uses.map((surplusUse) => [
        surplusUse,
        projectFiscalPath({
          fundingRule: "fixed",
          surplusUse,
          taxRevenues: [150],
          requestedProgramOutlays: [100],
        })[0],
      ]),
    );

    expect(outcomes["debt-reduction"]?.debtRepaid).toBe(50);
    expect(outcomes["additional-services"]?.additionalServices).toBe(50);
    expect(outcomes.rebate?.rebate).toBe(50);
    expect(outcomes["treasury-balance"]?.treasuryBalance).toBe(50);
    for (const year of Object.values(outcomes)) {
      expect(year).toBeDefined();
      expect(year?.budgetIdentityResidual).toBeCloseTo(0, 12);
    }
  });
});
