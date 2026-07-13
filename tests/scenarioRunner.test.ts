import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
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
    expect(borrowed.projection.summary.cumulativeM2Change).toBeGreaterThan(
      cashOnly.projection.summary.cumulativeM2Change,
    );
    expect(borrowed.projection.summary.publicBurdenPerHousehold).toBe(0);
    expect(cashOnly.projection.summary.cumulativeM2Change).toBeCloseTo(0, 8);
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
        rentPassThrough: 0.7,
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
});
