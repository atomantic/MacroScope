import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  POPULATION_FLOW_CALIBRATION,
  US_BASELINE,
  runComparison,
  type ComparisonRequestV1,
} from "../src/index.js";

const compactRequest = (): ComparisonRequestV1 => ({
  ...DEFAULT_COMPARISON_REQUEST,
  sampleSize: 800,
  representedHouseholds: 10_000,
});

describe("vertical-slice scenario runner", () => {
  it("compares the three funding paths deterministically", () => {
    const request = compactRequest();
    const first = runComparison(request);
    const second = runComparison(request);
    expect(first).toEqual(second);

    const cash = first.strategies["cash-first"];
    const borrow = first.strategies["borrow-first"];
    const sell = first.strategies["sell-first"];
    expect(Object.values(first.strategies).every((outcome) => outcome.accounting.passed)).toBe(
      true,
    );
    for (const outcome of Object.values(first.strategies)) {
      expect(outcome.accounting.ledgerEvents).toBeGreaterThanOrEqual(3);
      expect(outcome.accounting.ledgerFailures).toEqual([]);
      expect(Math.abs(outcome.accounting.depositsIdentityResidual)).toBeLessThan(1_000);
      expect(Math.abs(outcome.accounting.ledgerTrialBalanceResidual)).toBeLessThan(1);
      expect(Math.abs(outcome.accounting.ledgerInstrumentResidual)).toBeLessThan(1);
    }
    expect(borrow.funding.newCollateralizedLoans).toBeGreaterThan(0);
    expect(borrow.moneyAndCredit.bankDepositsChange).toBeGreaterThan(
      cash.moneyAndCredit.bankDepositsChange,
    );
    expect(sell.funding.equitySoldForTax).toBeGreaterThan(0);
    expect(sell.markets.equityPriceChange).toBeLessThan(0);
    expect(cash.distribution.deciles).toHaveLength(10);
    expect(cash.macro.sectors).toHaveLength(8);
    const scale = request.representedHouseholds / US_BASELINE.households;
    expect(first.population.representedAdults).toBeCloseTo(
      POPULATION_FLOW_CALIBRATION.adults * scale,
      7,
    );
    expect(first.population.representedChildren).toBeCloseTo(
      POPULATION_FLOW_CALIBRATION.children * scale,
      7,
    );
    expect(first.population.aggregateAnnualIncome).toBeCloseTo(
      US_BASELINE.annualPersonalIncome * scale,
      -2,
    );
    expect(first.population.baselineAnnualConsumption).toBeCloseTo(
      US_BASELINE.annualPce * scale,
      -2,
    );
    expect(
      cash.macro.sectors.reduce((total, sector) => total + sector.baselineDemand, 0),
    ).toBeCloseTo(first.population.baselineAnnualConsumption, -2);
    for (const sector of cash.macro.sectors) {
      expect(sector.baselineDemand).toBeCloseTo(
        first.population.baselineAnnualConsumption *
          POPULATION_FLOW_CALIBRATION.consumptionSectors.shares[sector.sector],
        -2,
      );
    }
    expect(cash.fiscal.requestedUbi).toBeCloseTo(
      12 *
        (POPULATION_FLOW_CALIBRATION.adults *
          scale *
          request.ubi.adultMonthlyBenefit +
          POPULATION_FLOW_CALIBRATION.children *
            scale *
            request.ubi.childMonthlyBenefit),
      -2,
    );
    expect(first.population.aggregateNetWorth).toBeCloseTo(
      174_009_620_000_000 * (request.representedHouseholds / 135_134_121),
      -2,
    );
    expect(first.projection.years).toHaveLength(11);
    expect(first.projection.summary.firstHyperinflationYear).toBeNull();
    expect(first.projection.stressTest.cells).toHaveLength(25);
    expect(
      cash.macro.sectors.reduce((total, sector) => total + sector.demandChange, 0),
    ).toBeCloseTo(cash.macro.firstYearConsumptionDemandChange, 4);
    expect(Math.abs(sell.accounting.housingQuantityResidual)).toBeLessThan(0.01);
  });

  it("scales transfer demand pressure against the fixed calibrated PCE denominator", () => {
    const request = compactRequest();
    const run = (benefitMultiplier: number) =>
      runComparison({
        ...request,
        ubi: {
          ...request.ubi,
          adultMonthlyBenefit: 100 * benefitMultiplier,
          childMonthlyBenefit: 50 * benefitMultiplier,
          fundingRule: "fixed",
          administrativeShare: 0,
          directCashShare: 1,
        },
      });
    const single = run(1);
    const double = run(2);
    const triple = run(3);
    const singleCash = single.strategies["cash-first"];
    const doubleCash = double.strategies["cash-first"];
    const tripleCash = triple.strategies["cash-first"];

    expect(double.population.baselineAnnualConsumption).toBeCloseTo(
      single.population.baselineAnnualConsumption,
      -2,
    );
    expect(
      tripleCash.macro.firstYearConsumptionDemandChange -
        singleCash.macro.firstYearConsumptionDemandChange,
    ).toBeCloseTo(
      (doubleCash.macro.firstYearConsumptionDemandChange -
        singleCash.macro.firstYearConsumptionDemandChange) *
        2,
      -2,
    );
    expect(
      tripleCash.macro.demandInflation - singleCash.macro.demandInflation,
    ).toBeCloseTo(
      (doubleCash.macro.demandInflation - singleCash.macro.demandInflation) * 2,
      10,
    );
  });

  it("produces a liquidation cascade only under stressed depth and leverage", () => {
    const normal = runComparison(compactRequest());
    const stressed = runComparison({
      ...compactRequest(),
      market: {
        buyerDepthRatio: 0.005,
        priceImpactCoefficient: 2,
        maximumCollateralLtv: 0.1,
      },
    });
    expect(normal.strategies["sell-first"].markets.cascadeTriggered).toBe(false);
    expect(stressed.strategies["sell-first"].markets.cascadeTriggered).toBe(true);
    expect(stressed.strategies["sell-first"].markets.forcedEquitySales).toBeGreaterThan(0);
  });

  it("keeps revenue-constrained UBI within realized tax resources", () => {
    const result = runComparison(compactRequest());
    for (const outcome of Object.values(result.strategies)) {
      expect(outcome.fiscal.fundingRatio).toBeLessThanOrEqual(1);
      expect(Math.abs(outcome.fiscal.governmentBalance)).toBeLessThan(0.01);
    }
  });

  it("separates private borrowing from public debt and money-neutral transfers", () => {
    const borrowed = runComparison(compactRequest());
    const cashOnly = runComparison({
      ...compactRequest(),
      behavior: {
        ...compactRequest().behavior,
        borrowShare: 0,
        sellShare: 0,
      },
    });
    expect(borrowed.projection.summary.privateTaxDebt).toBeGreaterThan(0);
    expect(borrowed.projection.annualFlows.m2Injection).toBeGreaterThan(0);
    expect(borrowed.projection.summary.publicBurdenPerHousehold).toBe(0);
    expect(cashOnly.projection.summary.cumulativeM2Change).toBeCloseTo(0, 8);
  });

  it("re-underwrites annual tax loans instead of repeating year-one borrowing", () => {
    const result = runComparison({
      ...compactRequest(),
      wealthTax: { exemption: 0, rate: 0.2 },
      market: { ...compactRequest().market, maximumCollateralLtv: 0.1 },
      behavior: { ...compactRequest().behavior, borrowShare: 1, sellShare: 0 },
    });
    const years = result.projection.years.slice(1);
    const firstYear = years[0];
    const finalYear = years.at(-1);
    expect(firstYear?.newPrivateLoans).toBeGreaterThan(0);
    expect(finalYear?.newPrivateLoans).toBeLessThan(firstYear?.newPrivateLoans ?? 0);
    expect(finalYear?.deferredTax).toBeGreaterThan(0);
    expect(finalYear?.privateTaxDebt).toBeLessThan(
      (firstYear?.newPrivateLoans ?? 0) * years.length,
    );
    expect(finalYear?.privateTaxLoanInterestPaid).toBeGreaterThan(0);
    expect(finalYear?.privateTaxLoanRepayments).toBeGreaterThan(0);
  });

  it("uses housing sales as a reconciled last-resort liquidity channel", () => {
    const result = runComparison({
      ...compactRequest(),
      wealthTax: { exemption: 0, rate: 0.2 },
      market: {
        ...compactRequest().market,
        maximumCollateralLtv: 0.1,
      },
    });
    const sell = result.strategies["sell-first"];
    expect(sell.markets.housingSold).toBeGreaterThan(0);
    expect(Math.abs(sell.accounting.housingQuantityResidual)).toBeLessThan(0.01);
    // A 20% zero-exemption tax is not settleable in the closed economy:
    // buyers cannot fund the required asset purchases from existing deposits.
    // The ledger audit reports that honestly instead of a tautological pass.
    expect(sell.accounting.passed).toBe(false);
    expect(
      sell.accounting.ledgerFailures.some((failure) => failure.includes("overdraw")),
    ).toBe(true);
  });

  it("keeps the owner-renter gap channel contingent on portfolio feedback", () => {
    // With the tax base evolving, the default scenario's growing revenue also
    // grows the revenue-constrained UBI, so renter income keeps pace and only
    // tighter housing supply with stronger rent pass-through activates the
    // full renter-harm chain.
    const harshHousing = {
      market: {
        ...DEFAULT_COMPARISON_REQUEST.market,
        housingSupplyElasticity: 0.1,
      },
      behavior: {
        ...DEFAULT_COMPARISON_REQUEST.behavior,
        rentPassThrough: 0.9,
        assetHedgeShare: 1,
        housingHedgeShare: 1,
      },
    };
    const active = runComparison({
      ...DEFAULT_COMPARISON_REQUEST,
      ...harshHousing,
    });
    const noAssetFeedback = runComparison({
      ...DEFAULT_COMPARISON_REQUEST,
      ...harshHousing,
      behavior: {
        ...harshHousing.behavior,
        assetHedgeShare: 0,
      },
    });

    expect(runComparison(DEFAULT_COMPARISON_REQUEST).projection.theoryTest.verdict.rating).toBe(
      "partial",
    );
    expect(active.projection.theoryTest.verdict.rating).toBe("active");
    expect(active.projection.theoryTest.summary.housingPriceChange).toBeGreaterThan(0.01);
    expect(active.projection.theoryTest.summary.housingPositionGapChange).toBeGreaterThan(0.01);
    expect(active.projection.summary.top1RealWealthChange).toBeLessThan(0);
    expect(noAssetFeedback.projection.theoryTest.verdict.rating).toBe("inactive");
    expect(noAssetFeedback.projection.theoryTest.summary.housingPriceChange).toBe(0);
  });

  it("allocates the funded budget between administration, cash, and services", () => {
    const result = runComparison({
      ...compactRequest(),
      ubi: {
        ...compactRequest().ubi,
        directCashShare: 0.4,
        administrativeShare: 0.25,
      },
    });
    const fiscal = result.strategies["cash-first"].fiscal;
    expect(fiscal.administrativeCost).toBeCloseTo(fiscal.taxCollected * 0.25, 4);
    expect(fiscal.publicServicesSpending).toBeGreaterThan(fiscal.ubiReceived);
    expect(
      fiscal.ubiReceived +
        fiscal.publicServicesSpending +
        fiscal.administrativeCost +
        fiscal.leakage,
    ).toBeCloseTo(fiscal.taxCollected, 4);
    expect(Math.abs(fiscal.governmentBalance)).toBeLessThan(0.01);
  });

  it("leaves revenue unchanged at the full-compliance boundary", () => {
    const base = compactRequest();
    const neutral = runComparison({
      ...base,
      behavior: {
        ...base.behavior,
        avoidanceElasticity: 0,
        expatriationShare: 0,
        privateBusinessInclusionRate: 0.7,
      },
    });
    // The neutral dials equal the historical defaults, so the run must be
    // byte-for-byte identical to the untouched default behavior.
    expect(neutral).toEqual(runComparison(base));
  });

  it("erodes revenue monotonically as avoidance elasticity rises", () => {
    const base = compactRequest();
    const withAvoidance = (avoidanceElasticity: number) =>
      runComparison({
        ...base,
        behavior: { ...base.behavior, avoidanceElasticity },
      });
    const none = withAvoidance(0);
    const some = withAvoidance(0.1);
    const more = withAvoidance(0.2);

    const revenue = (result: ReturnType<typeof runComparison>) =>
      result.strategies["cash-first"].fiscal.taxCollected;
    expect(revenue(some)).toBeLessThan(revenue(none));
    expect(revenue(more)).toBeLessThan(revenue(some));
    // rate 2% at elasticity 0.1 erases 20% of the base and thus the tax.
    expect(revenue(some)).toBeCloseTo(revenue(none) * 0.8, -2);
    // Less revenue funds less redistribution, moving the verdict metric down.
    expect(more.projection.summary.bottom50PurchasingPowerChange).toBeLessThan(
      none.projection.summary.bottom50PurchasingPowerChange,
    );
  });

  it("scales revenue monotonically with the private-business inclusion dial", () => {
    const base = compactRequest();
    const withInclusion = (privateBusinessInclusionRate: number) =>
      runComparison({
        ...base,
        behavior: { ...base.behavior, privateBusinessInclusionRate },
      });
    const revenue = (rate: number) =>
      withInclusion(rate).strategies["cash-first"].fiscal.taxCollected;
    expect(revenue(0.3)).toBeLessThan(revenue(0.7));
    expect(revenue(0.7)).toBeLessThan(revenue(1));
  });

  it("shrinks the year-ten base with expatriation but leaves year one intact", () => {
    const base = compactRequest();
    const withExpatriation = (expatriationShare: number) =>
      runComparison({
        ...base,
        behavior: { ...base.behavior, expatriationShare },
      });
    const none = withExpatriation(0);
    const heavy = withExpatriation(0.5);
    // Expatriation is a gradual decade process: year one is unchanged.
    expect(heavy.projection.annualFlows.taxCollected).toBeCloseTo(
      none.projection.annualFlows.taxCollected,
      4,
    );
    // By year ten the eroded base collects strictly less.
    expect(heavy.projection.annualFlows.finalYear.taxCollected).toBeLessThan(
      none.projection.annualFlows.finalYear.taxCollected,
    );
  });

  it("propagates base dynamics through the inflation stress grid (issue #17)", () => {
    const base = compactRequest();
    const grid = (expatriationShare: number) =>
      runComparison({
        ...base,
        behavior: { ...base.behavior, expatriationShare },
      }).projection.stressTest;
    const none = grid(0);
    const heavy = grid(0.8);
    const peaks = (test: ReturnType<typeof grid>) =>
      test.cells.map((cell) => cell.peakAnnualInflation);
    // Expatriation leaves year-one revenue untouched, so before the base
    // dynamics were threaded through the stress horizon it could not move the
    // grid at all. Now it drains the taxed base across the decade, so the cells
    // respond — proving the grid is no longer frozen at year-one revenue.
    expect(peaks(heavy)).not.toEqual(peaks(none));
    // Under the selected revenue-constrained rule, the eroding base lowers the
    // out-year program budget, so the deep stress cell runs strictly cooler.
    const deepCell = (test: ReturnType<typeof grid>) =>
      test.cells.find(
        (cell) => cell.ubiMultiplier === 8 && cell.monetizationShare === 1,
      )?.peakAnnualInflation ?? 0;
    expect(deepCell(heavy)).toBeLessThan(deepCell(none));
  });

  it("scopes expatriation to the top-tier sub-base under a universal tax (issue #17)", () => {
    const base = compactRequest();
    // Exercises the shared evolveTaxBase/combinedBaseMultiplier scoping that both
    // the main projection loop and the stress grid use, observed here through the
    // main loop's year-ten revenue (the grid's own cells are regime-dominated
    // under a universal tax, where revenue so exceeds outlay that base erosion
    // can't move the peak). Ten-year revenue retained under heavy expatriation,
    // relative to none — the channels other than expatriation cancel in the
    // ratio, isolating its drain.
    const finalRatio = (exemption: number) => {
      const finalTax = (expatriationShare: number) =>
        runComparison({
          ...base,
          wealthTax: { targetMode: "exemption", exemption, topShare: 0.01, rate: 0.02 },
          behavior: { ...base.behavior, expatriationShare },
        }).projection.annualFlows.finalYear.taxCollected;
      return finalTax(0.5) / finalTax(0);
    };
    const universalRatio = finalRatio(0); // zero exemption reaches every tier
    const topTierRatio = finalRatio(50_000_000); // exemption confines tax to the top
    // A fixed exemption makes the top-tier tax path nonlinear: after
    // expatriation, balances can fall back through the cutoff as well as losing
    // the retained base. The annual household reassessment therefore erodes
    // revenue more than the former aggregate retention shortcut predicted.
    expect(topTierRatio).toBeLessThan((1 - 0.5) ** (9 / 10));
    expect(universalRatio).toBeGreaterThan(topTierRatio);
  });

  it("resolves percentile targets separately from dollar exemptions", () => {
    const topOne = runComparison({
      ...compactRequest(),
      wealthTax: {
        targetMode: "top-share",
        topShare: 0.01,
        exemption: 0,
        rate: 0.01,
      },
    });
    const billionaire = runComparison({
      ...compactRequest(),
      wealthTax: {
        targetMode: "exemption",
        topShare: 0.01,
        exemption: 1_000_000_000,
        rate: 0.1,
      },
    });
    expect(topOne.wealthTaxTarget.mode).toBe("top-share");
    expect(topOne.wealthTaxTarget.effectiveExemption).toBeGreaterThan(0);
    expect(billionaire.wealthTaxTarget.effectiveExemption).toBe(1_000_000_000);
  });

  it("runs graduated schedules with the lowest threshold as the exemption", () => {
    // Warren 2020: 2% over $50M, 6% over $1B — supplied out of order and with a
    // stale top-share target that the schedule must override.
    const warren = runComparison({
      ...compactRequest(),
      wealthTax: {
        targetMode: "top-share",
        topShare: 0.01,
        exemption: 0,
        rate: 0.02,
        brackets: [
          { threshold: 1_000_000_000, rate: 0.06 },
          { threshold: 50_000_000, rate: 0.02 },
        ],
      },
    });
    expect(warren.wealthTaxTarget.mode).toBe("exemption");
    expect(warren.wealthTaxTarget.effectiveExemption).toBe(50_000_000);

    // The graduated top rate must collect strictly more than a flat 2% applied
    // above the same $50M exemption, because wealth above $1B is taxed at 6%.
    const flat = runComparison({
      ...compactRequest(),
      wealthTax: {
        targetMode: "exemption",
        topShare: 0.01,
        exemption: 50_000_000,
        rate: 0.02,
      },
    });
    expect(warren.strategies["cash-first"].fiscal.taxAssessed).toBeGreaterThan(
      flat.strategies["cash-first"].fiscal.taxAssessed,
    );
    expect(warren.strategies["cash-first"].accounting.passed).toBe(true);
    expect(warren.wealthTaxAssessment.brackets).toEqual([
      expect.objectContaining({ threshold: 50_000_000, rate: 0.02 }),
      expect.objectContaining({ threshold: 1_000_000_000, rate: 0.06 }),
    ]);
    expect(warren.wealthTaxAssessment.fullComplianceTax).toBeGreaterThan(
      flat.wealthTaxAssessment.fullComplianceTax,
    );

    // The out-year projection must erode the base at the graduated schedule's
    // blended effective rate, not the (lower) flat 2% floor rate. With the same
    // $50M exemption but a 6% top bracket, the graduated top-1% real wealth must
    // fall at least as fast as under the flat 2%.
    expect(warren.projection.summary.top1RealWealthChange).toBeLessThan(
      flat.projection.summary.top1RealWealthChange,
    );

    const sanders = runComparison({
      ...compactRequest(),
      wealthTax: {
        targetMode: "exemption",
        topShare: 0.01,
        exemption: 32_000_000,
        rate: 0.01,
        brackets: [
          { threshold: 32_000_000, rate: 0.01 },
          { threshold: 50_000_000, rate: 0.02 },
          { threshold: 250_000_000, rate: 0.03 },
          { threshold: 500_000_000, rate: 0.04 },
          { threshold: 1_000_000_000, rate: 0.05 },
          { threshold: 2_500_000_000, rate: 0.06 },
          { threshold: 5_000_000_000, rate: 0.07 },
          { threshold: 10_000_000_000, rate: 0.08 },
        ],
      },
    });
    // The annual household reassessment keeps named schedules distinct after
    // multiple years; this is not a shared aggregate-base trajectory with a
    // different year-one multiplier.
    expect(sanders.projection.years.map((year) => year.taxCollected)).not.toEqual(
      warren.projection.years.map((year) => year.taxCollected),
    );
  });

  it("uses each household's graduated marginal rate for taxpayer response", () => {
    const base = compactRequest();
    const request = {
      ...base,
      wealthTax: {
        targetMode: "exemption" as const,
        topShare: 0.01,
        exemption: 50_000_000,
        rate: 0.02,
        brackets: [
          { threshold: 50_000_000, rate: 0.02 },
          { threshold: 1_000_000_000, rate: 0.06 },
        ],
      },
      behavior: { ...base.behavior, avoidanceElasticity: 0.1 },
    };
    const graduated = runComparison(request);
    const flat = runComparison({
      ...request,
      wealthTax: {
        targetMode: "exemption",
        topShare: 0.01,
        exemption: 50_000_000,
        rate: 0.02,
      },
    });

    expect(graduated.wealthTaxAssessment.avoidedTax).toBeGreaterThan(
      flat.wealthTaxAssessment.avoidedTax,
    );
    expect(graduated.wealthTaxAssessment.responseAdjustedTax).toBeLessThan(
      graduated.wealthTaxAssessment.fullComplianceTax,
    );
    expect(
      graduated.wealthTaxAssessment.responseAdjustedTax /
        graduated.wealthTaxAssessment.fullComplianceTax,
    ).toBeLessThan(0.8);
  });
});
