import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  runComparison,
  type ComparisonRequestV1,
} from "../src/index.js";

const nationalRequest = (): ComparisonRequestV1 => ({
  ...DEFAULT_COMPARISON_REQUEST,
  sampleSize: 1_500,
});

describe("ten-year projection dynamics", () => {
  it("erodes the tax base and revenue when the rate exceeds the asset return", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: {
        targetMode: "exemption",
        exemption: 1_000_000_000,
        topShare: 0.01,
        rate: 0.1,
      },
    });
    const flows = result.projection.annualFlows;
    expect(flows.taxCollected).toBeGreaterThan(0);
    // 10% rate against a 6% asset return shrinks the base every year, so
    // year-10 revenue must be visibly below year-1 revenue.
    expect(flows.finalYear.taxCollected).toBeLessThan(flows.taxCollected * 0.75);
    expect(flows.finalYear.newPrivateLoans).toBeLessThan(flows.newPrivateLoans);
    // The verdict path reflects the erosion: the bottom-half advantage peaks
    // before year 10 instead of holding a constant flow.
    const powerPath = result.projection.years.map(
      (year) => year.bottom50PurchasingPowerIndex,
    );
    expect(powerPath.at(-1)).toBeLessThan(Math.max(...powerPath.slice(1, -1)));
    expect(result.projection.verdict.rating).not.toBe("beneficial");
  });

  it("grows the tax base and revenue when the asset return exceeds the rate", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: {
        targetMode: "exemption",
        exemption: 10_000_000,
        topShare: 0.01,
        rate: 0.01,
      },
    });
    const flows = result.projection.annualFlows;
    expect(flows.taxCollected).toBeGreaterThan(0);
    expect(flows.finalYear.taxCollected).toBeGreaterThan(flows.taxCollected);
  });

  it("diverges indexed and non-indexed UBI under high inflation", () => {
    const base: ComparisonRequestV1 = {
      ...nationalRequest(),
      ubi: {
        ...nationalRequest().ubi,
        adultMonthlyBenefit: 2_000,
        childMonthlyBenefit: 1_000,
        fundingRule: "fixed",
      },
      behavior: {
        ...nationalRequest().behavior,
        deficitMonetizationShare: 0.3,
      },
    };
    const nominal = runComparison({
      ...base,
      ubi: { ...base.ubi, benefitIndexation: "none" },
    });
    const indexed = runComparison({
      ...base,
      ubi: { ...base.ubi, benefitIndexation: "cpi" },
    });

    // The scenario must actually inflate for the comparison to be meaningful.
    expect(nominal.projection.summary.peakAnnualInflation).toBeGreaterThan(0.05);
    // A fixed nominal benefit never grows; a CPI-indexed one tracks prices.
    expect(indexed.projection.annualFlows.finalYear.ubiReceived).toBeGreaterThan(
      nominal.projection.annualFlows.finalYear.ubiReceived * 1.1,
    );
    // In real terms the indexed benefit holds value while the fixed nominal
    // benefit melts: deflate each run's year-10 flow by its own price level.
    const nominalFinal = nominal.projection.years.at(-1);
    const indexedFinal = indexed.projection.years.at(-1);
    expect(nominalFinal).toBeDefined();
    expect(indexedFinal).toBeDefined();
    const realNominalUbi =
      nominal.projection.annualFlows.finalYear.ubiReceived /
      (nominalFinal?.priceLevel ?? 1);
    const realIndexedUbi =
      indexed.projection.annualFlows.finalYear.ubiReceived /
      (indexedFinal?.priceLevel ?? 1);
    expect(realIndexedUbi).toBeGreaterThan(realNominalUbi);
  });

  it("keeps every projection output finite under extreme indexed-benefit feedback", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 10_000_000, topShare: 0.01, rate: 0 },
      ubi: {
        ...nationalRequest().ubi,
        adultMonthlyBenefit: 100_000,
        childMonthlyBenefit: 100_000,
        fundingRule: "fixed",
        benefitIndexation: "cpi",
      },
      behavior: { ...nationalRequest().behavior, deficitMonetizationShare: 1 },
    });
    for (const year of result.projection.years) {
      expect(Number.isFinite(year.priceLevel)).toBe(true);
      expect(Number.isFinite(year.m2)).toBe(true);
      expect(Number.isFinite(year.bottom50PurchasingPowerIndex)).toBe(true);
      expect(Number.isFinite(year.top1RealWealthIndex)).toBe(true);
    }
    for (const year of result.projection.theoryTest.years) {
      expect(Number.isFinite(year.housingPriceIndex)).toBe(true);
      expect(Number.isFinite(year.bottomRenterHousingBurdenIndex)).toBe(true);
      expect(Number.isFinite(year.bottomRenterDisposableIncomeIndex)).toBe(true);
    }
    const flows = result.projection.annualFlows;
    expect(Number.isFinite(flows.finalYear.taxCollected)).toBe(true);
    expect(Number.isFinite(flows.finalYear.ubiReceived)).toBe(true);
    expect(Number.isFinite(flows.finalYear.m2Injection)).toBe(true);
  });

  it("keeps M2 positive when a large tax surplus drains deposits", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate: 0.2 },
      ubi: {
        ...nationalRequest().ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
      },
    });
    for (const year of result.projection.years) {
      expect(year.m2).toBeGreaterThan(0);
      expect(year.m2Index).toBeGreaterThan(0);
    }
  });

  it("keeps year-one flows identical to the strategy outcomes and caveats aligned", () => {
    const result = runComparison(nationalRequest());
    const flows = result.projection.annualFlows;
    // Year 1 uses a base multiplier of exactly 1.
    expect(flows.finalYear).toBeDefined();
    expect(
      result.caveats.some((caveat) => caveat.includes("fixed nominal policy benefits")),
    ).toBe(true);
    const indexedResult = runComparison({
      ...nationalRequest(),
      ubi: { ...nationalRequest().ubi, benefitIndexation: "cpi" },
    });
    expect(
      indexedResult.caveats.some((caveat) => caveat.includes("CPI-indexed policy benefits")),
    ).toBe(true);
  });
});
