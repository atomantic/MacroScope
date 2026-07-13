import { describe, expect, it } from "vitest";
import {
  BACKTEST_TOLERANCE_POINTS,
  CASH_TRANSFER_ANCHOR,
  DEFAULT_COMPARISON_REQUEST,
  HISTORICAL_BACKTEST,
  HISTORICAL_BASELINE_INFLATION,
  HISTORICAL_MONETIZED_DEFICIT_RATIO_2020,
  HISTORICAL_SERIES,
  inflationFromStress,
  runComparison,
  runHistoricalBacktest,
  type ComparisonRequestV1,
} from "../src/index.js";

// These bands pin the published `inflationFromStress` coefficients to the one
// large episode we can actually check. If a future edit drifts the kernel away
// from the 2020–2023 U.S. inflation path, these assertions fail before the
// change can ship. The bands are wide enough to allow for the supply/energy
// channels the reduced form openly omits, but tight enough to catch a material
// coefficient change (e.g. the money-growth pass-through moving 0.35 → 0.5
// pushes the modeled peak past 12% and breaks the peak band below).

describe("historical inflation backtest (2020–2023)", () => {
  const backtest = HISTORICAL_BACKTEST;

  it("is computed from the live inflationFromStress kernel, not a hard-coded copy", () => {
    // Reproduce year one of the backtest by calling the same exported kernel
    // the projection uses. If someone re-implements the backtest math instead
    // of calling the kernel, this drifts and fails.
    const driver = HISTORICAL_SERIES[0];
    const observed = HISTORICAL_SERIES[1];
    expect(driver).toBeDefined();
    expect(observed).toBeDefined();
    const direct = inflationFromStress({
      baselineInflation: HISTORICAL_BASELINE_INFLATION,
      demandInflation: 0,
      moneyGrowth: driver!.m2GrowthYoY,
      monetizedDeficitRatio: 0,
      priorConfidence: 1,
    });
    const firstYear = backtest.years[0];
    expect(firstYear?.year).toBe(observed!.year);
    expect(firstYear?.modeledInflation).toBeCloseTo(direct.inflation, 12);
  });

  it("stays within the documented tolerance band every year", () => {
    expect(backtest.years.length).toBeGreaterThanOrEqual(4);
    for (const year of backtest.years) {
      expect(
        Math.abs(year.errorPoints),
        `year ${year.year}: modeled ${(year.modeledInflation * 100).toFixed(2)}% vs actual ${(year.actualInflation * 100).toFixed(1)}%`,
      ).toBeLessThanOrEqual(BACKTEST_TOLERANCE_POINTS);
    }
    expect(backtest.allWithinTolerance).toBe(true);
  });

  it("keeps mean absolute error small enough to pin coefficient drift", () => {
    // Realized ~1.6pp. A 2.5pp ceiling leaves headroom for data revisions but
    // fails fast on a coefficient change that degrades the fit.
    expect(backtest.meanAbsoluteErrorPoints).toBeLessThan(0.025);
  });

  it("reproduces the timing and magnitude of the 2021–2022 inflation peak", () => {
    // The model peaks the year after the 2020 M2 explosion, matching the
    // realized December-over-December CPI peak year.
    expect(backtest.modeledPeak.year).toBe(backtest.actualPeak.year);
    expect(backtest.modeledPeak.year).toBe(2021);
    // Modeled peak brackets the realized surge (Dec/Dec 7%, headline 9.1%).
    expect(backtest.modeledPeak.inflation).toBeGreaterThan(0.06);
    expect(backtest.modeledPeak.inflation).toBeLessThan(0.115);
    // Within the per-year band of the within-year headline peak.
    expect(
      Math.abs(backtest.modeledPeak.inflation - backtest.actualHeadlinePeak.inflation),
    ).toBeLessThanOrEqual(BACKTEST_TOLERANCE_POINTS);
  });

  it("reproduces the 2023 disinflation as M2 growth collapses", () => {
    const finalYear = backtest.years.at(-1);
    expect(finalYear?.year).toBe(2023);
    // The M2 contraction pulls modeled inflation back down from the peak toward
    // baseline, as it did in reality.
    expect(finalYear!.modeledInflation).toBeLessThan(backtest.modeledPeak.inflation);
    expect(finalYear!.modeledInflation).toBeLessThan(0.03);
    expect(finalYear!.drivingM2Growth).toBeLessThan(0);
  });

  it("is deterministic and input-free", () => {
    const a = runHistoricalBacktest();
    const b = runHistoricalBacktest();
    expect(a).toEqual(b);
    expect(a).toEqual(backtest);
  });

  it("ships FRED sources and honest caveats about what the reduced form misses", () => {
    expect(backtest.sources.some((source) => source.url.includes("M2SL"))).toBe(true);
    // The committed Dec/Dec values are the non-seasonally-adjusted CPI-U series.
    expect(backtest.sources.some((source) => source.url.includes("CPIAUCNS"))).toBe(true);
    expect(
      backtest.caveats.some((caveat) => /supply|energy/i.test(caveat)),
    ).toBe(true);
  });

  it("pins the monetized-deficit channel the primary path folds into M2", () => {
    // The primary money-channel backtest feeds monetizedDeficitRatio=0 to avoid
    // double-counting, so it does not exercise the kernel's fiscal coefficients.
    // This isolated check does, so a change to the `monetizedDeficitRatio`
    // inflation/confidence coefficients still fails a test.
    const fiscal = backtest.fiscalChannel;
    expect(fiscal.monetizedDeficitRatio).toBe(HISTORICAL_MONETIZED_DEFICIT_RATIO_2020);
    // Money growth is held at threshold, so the no-fiscal case is pure baseline.
    expect(fiscal.inflationWithoutFiscal).toBeCloseTo(HISTORICAL_BASELINE_INFLATION, 12);
    expect(fiscal.marginalInflation).toBeCloseTo(
      fiscal.inflationWithFiscal - fiscal.inflationWithoutFiscal,
      12,
    );
    // The fiscal ratio adds a few points of inflation (pins the *0.25 term) and
    // erodes confidence a little (pins the *0.35 confidence term).
    expect(fiscal.marginalInflation).toBeGreaterThan(0.02);
    expect(fiscal.marginalInflation).toBeLessThan(0.045);
    expect(fiscal.confidenceAfter).toBeGreaterThan(0.95);
    expect(fiscal.confidenceAfter).toBeLessThan(0.99);
    // Computed from the live kernel, not a stored copy.
    const direct = inflationFromStress({
      baselineInflation: HISTORICAL_BASELINE_INFLATION,
      demandInflation: 0,
      moneyGrowth: 0.025,
      monetizedDeficitRatio: HISTORICAL_MONETIZED_DEFICIT_RATIO_2020,
      priorConfidence: 1,
    });
    expect(fiscal.inflationWithFiscal).toBeCloseTo(direct.inflation, 12);
    expect(fiscal.confidenceAfter).toBeCloseTo(direct.confidence, 12);
  });
});

describe("secondary prediction: a cash-funded transfer barely moves M2", () => {
  const cashFundedRequest = (): ComparisonRequestV1 => ({
    ...DEFAULT_COMPARISON_REQUEST,
    sampleSize: 1_500,
    ubi: {
      ...DEFAULT_COMPARISON_REQUEST.ubi,
      fundingRule: "revenue-constrained",
      benefitIndexation: "none",
      adultMonthlyBenefit: 1_000,
      childMonthlyBenefit: 500,
    },
    behavior: {
      ...DEFAULT_COMPARISON_REQUEST.behavior,
      borrowShare: 0,
      sellShare: 0,
      deficitMonetizationShare: 0,
    },
  });

  it("moves existing deposits without creating money when the wealthy pay in cash", () => {
    const result = runComparison(cashFundedRequest());
    const { summary, annualFlows } = result.projection;
    // A tax-and-transfer paid from existing balances is money-neutral: no new
    // bank loans, no monetized deficit, so M2 is unchanged over ten years.
    expect(Math.abs(summary.cumulativeM2Change)).toBeLessThan(0.001);
    expect(Math.abs(annualFlows.m2Injection)).toBeLessThan(1_000_000);
    // With no money creation, inflation stays near the structural baseline.
    expect(summary.peakAnnualInflation).toBeLessThan(0.05);
    // Actual dollars still reach households — the transfer happens.
    expect(annualFlows.ubiReceived).toBeGreaterThan(0);
  });

  it("reproduces the observed transfer-funded vs. deficit-monetized contrast", () => {
    // The prediction is anchored to a real distinction: transfer-funded fiscal
    // expansions did not grow M2, while the 2020–2021 deficit-monetized
    // expansion drove the ~40% surge this backtest ties to the inflation.
    expect(CASH_TRANSFER_ANCHOR.source.url).toContain("M2SL");
    expect(CASH_TRANSFER_ANCHOR.historicalContrast).toMatch(/2020|monetiz/i);

    // Model side of the contrast: the same request, cash-funded vs. with the
    // unfunded portion monetized, must split exactly as the history did.
    const cashFunded = runComparison(cashFundedRequest());
    const monetized = runComparison({
      ...cashFundedRequest(),
      ubi: {
        ...cashFundedRequest().ubi,
        adultMonthlyBenefit: 2_000,
        childMonthlyBenefit: 1_000,
        fundingRule: "fixed",
      },
      behavior: {
        ...cashFundedRequest().behavior,
        deficitMonetizationShare: 1,
      },
    });
    // Transfer-funded ≈ no money growth; monetized deficit expands M2 markedly.
    expect(Math.abs(cashFunded.projection.summary.cumulativeM2Change)).toBeLessThan(0.001);
    expect(monetized.projection.summary.cumulativeM2Change).toBeGreaterThan(
      cashFunded.projection.summary.cumulativeM2Change + 0.05,
    );
    // And the money that gets created is what lifts inflation.
    expect(monetized.projection.summary.peakAnnualInflation).toBeGreaterThan(
      cashFunded.projection.summary.peakAnnualInflation,
    );
  });
});
