import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_REQUEST,
  runComparison,
  type ComparisonRequestV1,
} from "../src/index.js";
import { applyTreasuryMoneyFlow } from "../src/simulation/projection.js";
import { US_BASELINE } from "../src/simulation/usBaseline.js";

const nationalRequest = (): ComparisonRequestV1 => ({
  ...DEFAULT_COMPARISON_REQUEST,
  sampleSize: 1_500,
});

describe("ten-year projection dynamics", () => {
  it("does not let a higher retained tax-loan interest rate increase M2", () => {
    const request = nationalRequest();
    const cumulativeM2At = (loanInterestRate: number): number =>
      runComparison({
        ...request,
        behavior: {
          ...request.behavior,
          borrowShare: 1,
          sellShare: 0,
          loanInterestRate,
        },
      }).projection.summary.cumulativeM2Change;

    const noInterest = cumulativeM2At(0);
    const defaultInterest = cumulativeM2At(0.045);
    const highInterest = cumulativeM2At(0.1);
    expect(defaultInterest).toBeLessThanOrEqual(noInterest);
    expect(highInterest).toBeLessThanOrEqual(defaultInterest);
  });

  it("keeps the closed-economy baseline unchanged and reports zero foreign flows", () => {
    const result = runComparison({
      ...nationalRequest(),
      economy: {
        ...nationalRequest().economy,
        // Closed is a mode, not a cosmetic label: even an API caller that
        // carries stale nonzero shares receives the domestic-only path.
        foreignBuyerShare: 1,
        foreignTreasuryDebtShare: 1,
        capitalOutflowResponse: 1,
        repatriationFxPassThrough: 1,
      },
    });
    const openEconomy = result.projection.openEconomy;
    expect(openEconomy.closure).toBe("closed");
    expect(openEconomy.summary.foreignOwnedDomesticClaims).toBe(0);
    expect(openEconomy.summary.foreignHeldTreasuryDebt).toBe(0);
    expect(openEconomy.summary.residentForeignClaims).toBe(0);
    expect(openEconomy.summary.netForeignAssetPosition).toBe(0);
    expect(openEconomy.accounting.passed).toBe(true);
  });

  it("routes foreign asset sales, Treasury debt, and resident capital flows through a balanced rest-of-world ledger", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: {
        ...nationalRequest().wealthTax,
        exemption: 0,
        rate: 0.12,
      },
      ubi: { ...nationalRequest().ubi, fundingRule: "fixed", adultMonthlyBenefit: 8_000 },
      behavior: {
        ...nationalRequest().behavior,
        sellShare: 0.8,
        borrowShare: 0,
        expatriationShare: 0.3,
        expatriationResidenceShare: 0.4,
        expatriationTaxBaseShare: 0.5,
      },
      economy: {
        closure: "partially-open",
        foreignBuyerShare: 0.45,
        foreignTreasuryDebtShare: 0.4,
        capitalOutflowResponse: 0.6,
        repatriationFxPassThrough: 0.25,
      },
    });
    const openEconomy = result.projection.openEconomy;
    expect(openEconomy.summary.foreignOwnedDomesticClaims).toBeGreaterThan(0);
    expect(openEconomy.summary.foreignHeldTreasuryDebt).toBeGreaterThan(0);
    expect(openEconomy.summary.residentForeignClaims).toBeGreaterThan(0);
    expect(openEconomy.summary.netForeignAssetPosition).not.toBe(0);
    expect(openEconomy.years.some((year) => year.residentsChangingJurisdiction > 0)).toBe(true);
    expect(openEconomy.years.some((year) => year.taxableBaseLeavingJurisdiction > 0)).toBe(true);
    expect(openEconomy.accounting.passed).toBe(true);
    expect(openEconomy.accounting.trialBalanceResidual).toBeCloseTo(0, 6);
    expect(openEconomy.accounting.instrumentResidual).toBeCloseTo(0, 6);
  });

  it("reports threshold margins and never attributes a cash-funded mixed result to borrowing", () => {
    const result = runComparison({
      ...nationalRequest(),
      behavior: { ...nationalRequest().behavior, borrowShare: 0, sellShare: 0 },
    });
    const verdict = result.projection.verdict;
    expect(["mixed-positive", "mixed-negative", "beneficial", "harmful"]).toContain(verdict.detail);
    expect(verdict.margins.beneficialPurchasingPower).toBeCloseTo(
      result.projection.summary.bottom50PurchasingPowerChange - 0.02,
      8,
    );
    if (verdict.rating === "mixed") expect(verdict.explanation).not.toMatch(/borrow/i);
  });
  it("never releases more Treasury cash than previously drained from M2", () => {
    const parked = applyTreasuryMoneyFlow({
      m2: US_BASELINE.m2,
      nonTreasuryMoneyChange: 0,
      treasuryBalanceChange: US_BASELINE.m2 * 2,
      drainedTreasuryBalance: 0,
    });
    expect(parked.moneyChange).toBeCloseTo(-US_BASELINE.m2 * 0.9, 2);
    expect(parked.drainedTreasuryBalance).toBeCloseTo(US_BASELINE.m2 * 0.9, 2);

    const released = applyTreasuryMoneyFlow({
      m2: US_BASELINE.m2 + parked.moneyChange,
      nonTreasuryMoneyChange: 0,
      treasuryBalanceChange: -US_BASELINE.m2 * 2,
      drainedTreasuryBalance: parked.drainedTreasuryBalance,
    });
    expect(released.moneyChange).toBeCloseTo(US_BASELINE.m2 * 0.9, 2);
    expect(released.drainedTreasuryBalance).toBe(0);
    expect(US_BASELINE.m2 + parked.moneyChange + released.moneyChange).toBeCloseTo(
      US_BASELINE.m2,
      2,
    );
  });

  it("re-assesses fixed-exemption threshold crossings instead of applying aggregate erosion", () => {
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
    const firstYear = result.projection.years[1];
    const finalYear = result.projection.years.at(-1);
    expect(firstYear).toBeDefined();
    expect(finalYear).toBeDefined();
    // The $1B cutoff admits additional households as balances evolve. A single
    // tax-base multiplier cannot represent that threshold crossing.
    expect(finalYear?.taxpayerHouseholds).toBeGreaterThan(firstYear?.taxpayerHouseholds ?? 0);
    expect(flows.finalYear.taxCollected).toBeGreaterThan(flows.taxCollected);
    // Every funded taxpayer still pays the flat statutory rate; the point of
    // this case is that threshold crossings come from household re-assessment,
    // not an aggregate multiplier that would miss new taxpayers entirely.
    expect(finalYear?.effectiveTaxRate).toBeCloseTo(firstYear?.effectiveTaxRate ?? 0, 8);
  });

  it("keeps a flat zero-exemption schedule proportional and reconciles each year's cohorts", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: {
        targetMode: "exemption",
        exemption: 0,
        topShare: 0.01,
        rate: 0.01,
      },
    });
    const annualYears = result.projection.years.slice(1);
    const firstTaxpayerCount = annualYears[0]?.taxpayerHouseholds;
    for (const year of annualYears) {
      expect(year.effectiveTaxRate).toBeCloseTo(0.01, 8);
      expect(year.taxpayerHouseholds).toBeCloseTo(firstTaxpayerCount ?? 0, 6);
      expect(
        Object.values(year.taxGroupCollections).reduce((sum, value) => sum + value, 0),
      ).toBeCloseTo(year.taxCollected, 2);
    }
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

  it("gives every wealth group an explicit ten-year winners/losers outcome", () => {
    const result = runComparison(nationalRequest());
    const outcomes = result.projection.groupOutcomes;
    // Every named cohort in the issue is represented, in a stable order.
    expect(outcomes.map((group) => group.id)).toEqual([
      "bottom-50-renter",
      "bottom-50-owner",
      "middle-40",
      "top-10",
      "top-1",
      "top-0.1",
    ]);

    const byId = Object.fromEntries(outcomes.map((group) => [group.id, group]));
    // The default $10M exemption cuts through the synthetic 90th–99th-percentile
    // cohort even though that DFA cohort's average wealth is below $10M. Its
    // paying households must not disappear from the projected burden.
    expect(byId["bottom-50-renter"].annualTaxPaid).toBe(0);
    expect(byId["middle-40"].annualTaxPaid).toBe(0);
    expect(byId["top-10"].annualTaxPaid).toBeGreaterThan(0);
    expect(byId["top-1"].annualTaxPaid).toBeGreaterThan(0);
    expect(byId["top-0.1"].annualTaxPaid).toBeGreaterThan(byId["top-1"].annualTaxPaid);

    // The winners/losers split: the transfer and asset/inflation channels leave
    // the bottom and middle better off, the tax leaves the very top worse off.
    expect(byId["bottom-50-renter"].rating).toBe("better-off");
    expect(byId["bottom-50-owner"].rating).toBe("better-off");
    expect(byId["top-1"].rating).toBe("worse-off");
    expect(byId["top-0.1"].rating).toBe("worse-off");
    // The most leveraged group gains most from inflationary debt erosion.
    expect(byId["bottom-50-owner"].realWealthChange).toBeGreaterThan(
      byId["middle-40"].realWealthChange ?? 0,
    );
    // The heavier tax makes the top 0.1% worse off than the top 1%.
    expect(byId["top-0.1"].realWealthChange).toBeLessThan(
      byId["top-1"].realWealthChange ?? 0,
    );

    // Renters read on purchasing power, asset holders on real wealth; every
    // outcome is a finite number.
    expect(byId["bottom-50-renter"].primaryMetric).toBe("purchasing-power");
    expect(byId["top-1"].primaryMetric).toBe("real-wealth");
    for (const group of outcomes) {
      const change =
        group.primaryMetric === "real-wealth"
          ? group.realWealthChange
          : group.purchasingPowerChange;
      expect(change).not.toBeNull();
      expect(Number.isFinite(change ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(group.annualUbiReceived)).toBe(true);
    }
  });

  it("reconciles cohort tax burdens to household-level year-one collection", () => {
    const result = runComparison(nationalRequest());
    const attributedCollection = result.projection.groupOutcomes.reduce(
      (sum, group) => sum + group.annualTaxPaid * group.households,
      0,
    );

    expect(attributedCollection).toBeCloseTo(
      result.projection.annualFlows.taxCollected,
      2,
    );
  });

  it("uses collected revenue to weight the top tier under graduated rates", () => {
    const request = nationalRequest();
    const topTierRevenueShare = (result: ReturnType<typeof runComparison>): number => {
      const topTierCollection = result.projection.groupOutcomes
        .filter((group) => group.id === "top-1" || group.id === "top-0.1")
        .reduce((sum, group) => sum + group.annualTaxPaid * group.households, 0);
      return topTierCollection / result.projection.annualFlows.taxCollected;
    };
    const flat = runComparison({
      ...request,
      wealthTax: {
        targetMode: "exemption",
        exemption: 10_000_000,
        topShare: 0.01,
        rate: 0.01,
      },
    });
    const graduated = runComparison({
      ...request,
      wealthTax: {
        targetMode: "exemption",
        exemption: 10_000_000,
        topShare: 0.01,
        rate: 0.01,
        brackets: [
          { threshold: 10_000_000, rate: 0.01 },
          { threshold: 50_000_000, rate: 0.02 },
          { threshold: 250_000_000, rate: 0.03 },
          { threshold: 500_000_000, rate: 0.04 },
          { threshold: 1_000_000_000, rate: 0.05 },
        ],
      },
    });

    // Higher marginal rates on the very top raise its share of actual revenue,
    // even though the exemption and household population are unchanged.
    expect(topTierRevenueShare(graduated)).toBeGreaterThan(
      topTierRevenueShare(flat),
    );
  });

  it("retains the default policy's non-top revenue under full expatriation", () => {
    const request = nationalRequest();
    const result = runComparison({
      ...request,
      behavior: {
        ...request.behavior,
        expatriationShare: 1,
      },
    });

    // Full expatriation removes the top-tier sub-base after year one, but the
    // default $10M cutoff also reaches some 90th–99th-percentile households.
    // Their revenue remains, proving the tier split is not the old coarse 100%.
    expect(result.projection.annualFlows.finalYear.taxCollected).toBeGreaterThan(0);
    expect(result.projection.annualFlows.finalYear.taxCollected).toBeLessThan(
      result.projection.annualFlows.taxCollected,
    );
  });

  it("charges the bottom-50 owner cohort when a zero exemption reaches it", () => {
    // The "universal" preset taxes from the first dollar, so the bottom half's
    // owners must show a real burden — not a hardcoded $0 — that scales with the
    // rate, and renters (with negligible taxable wealth) must stay at zero.
    const ownerTaxAt = (rate: number): number => {
      const result = runComparison({
        ...nationalRequest(),
        wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate },
      });
      const renter = result.projection.groupOutcomes.find((g) => g.id === "bottom-50-renter");
      expect(renter?.annualTaxPaid).toBe(0);
      return (
        result.projection.groupOutcomes.find((g) => g.id === "bottom-50-owner")?.annualTaxPaid ?? 0
      );
    };
    const taxAtOne = ownerTaxAt(0.01);
    const taxAtTwo = ownerTaxAt(0.02);
    expect(taxAtOne).toBeGreaterThan(0);
    // A higher rate lands a larger per-household burden on the owner cohort.
    expect(taxAtTwo).toBeGreaterThan(taxAtOne);
    // Under the default $10M exemption the bottom half is untouched.
    const owner = runComparison(nationalRequest()).projection.groupOutcomes.find(
      (g) => g.id === "bottom-50-owner",
    );
    expect(owner?.annualTaxPaid).toBe(0);
  });

  it("drains only top-tier cohorts' cumulative tax under expatriation (issue #17)", () => {
    // Universal tax (reaches every tier), low-inflation setup so the per-cohort
    // real-wealth change is dominated by its own cumulative tax burden rather
    // than the shared inflation channels.
    const run = (expatriationShare: number) =>
      runComparison({
        ...nationalRequest(),
        wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate: 0.01 },
        behavior: {
          ...nationalRequest().behavior,
          borrowShare: 0,
          sellShare: 0,
          deficitMonetizationShare: 0,
          expatriationShare,
        },
      });
    const wealth = (result: ReturnType<typeof run>, id: string) =>
      result.projection.groupOutcomes.find((group) => group.id === id)?.realWealthChange ?? 0;
    const none = run(0);
    const heavy = run(0.8);
    // Top-tier cohorts (>= 99th percentile) shed cumulative tax as their sub-base
    // expatriates, so their real wealth improves markedly.
    const topGain = wealth(heavy, "top-0.1") - wealth(none, "top-0.1");
    expect(topGain).toBeGreaterThan(0.03);
    // A non-top cohort's base is retained, so its burden — and real wealth — barely
    // move. Under the pre-fix blended multiplier the top tier's departure would
    // have relieved every cohort's cumulative tax alike, collapsing this contrast;
    // that it survives pins the per-tier cohort attribution.
    const midChange = Math.abs(wealth(heavy, "middle-40") - wealth(none, "middle-40"));
    expect(midChange).toBeLessThan(0.01);
    expect(topGain).toBeGreaterThan(midChange * 5);
  });

  it("attributes tax to the top tail when the exemption exceeds every cohort average", () => {
    // The "10% over $1B" preset sits above every cohort's AVERAGE wealth, so the
    // group-level taxable base is zero everywhere — but the top tail still pays,
    // so the burden must land on the wealthiest cohort, not vanish to $0.
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 1_000_000_000, topShare: 0.01, rate: 0.1 },
    });
    expect(result.projection.annualFlows.taxCollected).toBeGreaterThan(0);
    const byId = Object.fromEntries(
      result.projection.groupOutcomes.map((group) => [group.id, group]),
    );
    expect(byId["top-0.1"].annualTaxPaid).toBeGreaterThan(0);
    expect(byId["top-1"].annualTaxPaid).toBe(0);
    expect(byId["middle-40"].annualTaxPaid).toBe(0);
  });

  it("keeps per-household group figures invariant to the represented population", () => {
    // Collected tax and delivered UBI scale with representedHouseholds while the
    // wealth-group baselines are national; the per-household outputs must divide
    // the flows back down so they don't collapse to fractions of a dollar.
    const national = runComparison(nationalRequest());
    const scaled = runComparison({ ...nationalRequest(), representedHouseholds: 5_000 });
    const ubiNational = national.projection.groupOutcomes[0]?.annualUbiReceived ?? 0;
    const ubiScaled = scaled.projection.groupOutcomes[0]?.annualUbiReceived ?? 0;
    expect(ubiScaled).toBeGreaterThan(1_000);
    expect(ubiScaled).toBeCloseTo(ubiNational, 2);
    const taxNational =
      national.projection.groupOutcomes.find((g) => g.id === "top-1")?.annualTaxPaid ?? 0;
    const taxScaled =
      scaled.projection.groupOutcomes.find((g) => g.id === "top-1")?.annualTaxPaid ?? 0;
    expect(taxScaled).toBeCloseTo(taxNational, 2);
  });

  it("removes every group's tax burden when the wealth-tax rate is zero", () => {
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 10_000_000, topShare: 0.01, rate: 0 },
    });
    for (const group of result.projection.groupOutcomes) {
      expect(group.annualTaxPaid).toBe(0);
    }
    // With no tax the top 1% is no longer dragged into worse-off territory.
    const top1 = result.projection.groupOutcomes.find((group) => group.id === "top-1");
    expect(top1?.rating).not.toBe("worse-off");
  });

  it("allocates the tax burden to the top when targeting a top wealth share", () => {
    // Top-share targeting resolves the effective exemption from the population,
    // which must reach buildPolicyProjection so the burden lands on the top.
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "top-share", exemption: 0, topShare: 0.01, rate: 0.02 },
    });
    const byId = Object.fromEntries(
      result.projection.groupOutcomes.map((group) => [group.id, group]),
    );
    expect(byId["top-1"].annualTaxPaid + byId["top-0.1"].annualTaxPaid).toBeGreaterThan(0);
    expect(byId["bottom-50-renter"].annualTaxPaid).toBe(0);
    expect(byId["middle-40"].annualTaxPaid).toBe(0);
  });

  it("keeps M2 positive under a large tax surplus", () => {
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

  it("exposes reconciled fiscal stocks and does not destroy M2 when surplus retires debt", () => {
    const base = nationalRequest();
    const result = runComparison({
      ...base,
      wealthTax: {
        targetMode: "exemption",
        exemption: 0,
        topShare: 0.01,
        rate: 0.01,
      },
      ubi: {
        ...base.ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
        fundingRule: "fixed",
        surplusUse: "debt-reduction",
      },
      behavior: { ...base.behavior, borrowShare: 0, sellShare: 0 },
    });

    expect(result.projection.fiscal.cumulativeDebtRepaid).toBeGreaterThan(0);
    expect(result.projection.fiscal.endingTreasuryBalance).toBe(0);
    const parked = runComparison({
      ...base,
      wealthTax: {
        targetMode: "exemption",
        exemption: 0,
        topShare: 0.01,
        rate: 0.01,
      },
      ubi: {
        ...base.ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
        fundingRule: "fixed",
        surplusUse: "treasury-balance",
      },
      behavior: { ...base.behavior, borrowShare: 0, sellShare: 0 },
    });
    expect(result.projection.summary.cumulativeM2Change).toBeGreaterThan(
      parked.projection.summary.cumulativeM2Change,
    );
    for (const year of result.projection.fiscal.years) {
      expect(Math.abs(year.budgetIdentityResidual)).toBeLessThan(0.1);
    }
  });

  it("parks surplus only when Treasury balance is selected", () => {
    const base = nationalRequest();
    const result = runComparison({
      ...base,
      wealthTax: {
        targetMode: "exemption",
        exemption: 0,
        topShare: 0.01,
        rate: 0.2,
      },
      ubi: {
        ...base.ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
        fundingRule: "fixed",
        surplusUse: "treasury-balance",
      },
      behavior: { ...base.behavior, borrowShare: 0, sellShare: 0 },
    });

    expect(result.projection.fiscal.endingTreasuryBalance).toBeGreaterThan(0);
    expect(result.projection.summary.cumulativeM2Change).toBeLessThan(0);
  });

  it("routes surplus into services or household rebates when selected", () => {
    const base = nationalRequest();
    const request: ComparisonRequestV1 = {
      ...base,
      wealthTax: {
        targetMode: "exemption",
        exemption: 0,
        topShare: 0.01,
        rate: 0.05,
      },
      ubi: {
        ...base.ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
        fundingRule: "fixed",
      },
    };
    const services = runComparison({
      ...request,
      ubi: { ...request.ubi, surplusUse: "additional-services" },
    });
    const rebate = runComparison({
      ...request,
      ubi: { ...request.ubi, surplusUse: "rebate" },
    });

    expect(services.projection.annualFlows.publicServicesSpending).toBeGreaterThan(0);
    expect(services.projection.annualFlows.ubiReceived).toBe(0);
    expect(rebate.projection.annualFlows.ubiReceived).toBeGreaterThan(0);
    expect(rebate.projection.annualFlows.rebate).toBe(
      rebate.projection.annualFlows.ubiReceived,
    );
    expect(rebate.projection.annualFlows.publicServicesSpending).toBe(0);
    expect(
      Object.values(rebate.strategies).every((outcome) => outcome.accounting.passed),
    ).toBe(true);
  });

  it("keeps service-heavy results cash-only until a service value is explicitly selected", () => {
    const base = nationalRequest();
    const unscored = runComparison({
      ...base,
      ubi: { ...base.ubi, directCashShare: 0, serviceEffectiveness: "unscored" },
    }).projection;
    const scored = runComparison({
      ...base,
      ubi: { ...base.ubi, directCashShare: 0, serviceEffectiveness: "base" },
    }).projection;

    expect(unscored.annualFlows.publicServicesSpending).toBeGreaterThan(0);
    expect(unscored.annualFlows.serviceValue.selected).toBeNull();
    expect(unscored.verdict.scope).toBe("cash-only");
    const zero = runComparison({
      ...base,
      ubi: { ...base.ubi, directCashShare: 0, serviceEffectiveness: "zero" },
    }).projection;
    expect(zero.annualFlows.serviceValue.selected).toBe(0);
    expect(zero.verdict.scope).toBe("cash-only");
    expect(scored.annualFlows.serviceValue.zero).toBe(0);
    expect(scored.annualFlows.serviceValue.base).toBeGreaterThan(0);
    expect(scored.annualFlows.serviceValue.high).toBeGreaterThan(
      scored.annualFlows.serviceValue.base,
    );
    expect(scored.annualFlows.serviceValue.selected).toBe(
      scored.annualFlows.serviceValue.base,
    );
    expect(scored.summary.selectedAnnualResourceValue).toBeGreaterThan(
      scored.annualFlows.ubiReceived,
    );
  });

  it("normalizes stress demand against funded surplus spending when requested benefits are zero", () => {
    const base = nationalRequest();
    for (const surplusUse of ["additional-services", "rebate"] as const) {
      const result = runComparison({
        ...base,
        ubi: {
          ...base.ubi,
          adultMonthlyBenefit: 0,
          childMonthlyBenefit: 0,
          fundingRule: "fixed",
          surplusUse,
        },
      });

      expect(result.projection.fiscal.years[0]?.programOutlay).toBeGreaterThan(0);
      expect(
        result.projection.stressTest.cells.every(
          (cell) => Number.isFinite(cell.peakAnnualInflation) && cell.peakAnnualInflation < 1,
        ),
      ).toBe(true);
    }
  });

  it("recomputes stress demand when surplus services become household cash", () => {
    const base = nationalRequest();
    const result = runComparison({
      ...base,
      wealthTax: {
        targetMode: "exemption",
        exemption: 10_000_000,
        topShare: 0.01,
        rate: 0.2,
      },
      ubi: {
        ...base.ubi,
        fundingRule: "fixed",
        surplusUse: "additional-services",
        directCashShare: 1,
      },
      behavior: { ...base.behavior, borrowShare: 0, sellShare: 1 },
    });
    const noMonetization = result.projection.stressTest.cells.filter(
      (cell) => cell.monetizationShare === 0,
    );
    const halfBenefit = noMonetization.find((cell) => cell.ubiMultiplier === 0.5);
    const doubleBenefit = noMonetization.find((cell) => cell.ubiMultiplier === 2);

    expect(halfBenefit).toBeDefined();
    expect(doubleBenefit).toBeDefined();
    // Both rows spend roughly the same tax revenue, but the smaller scheduled
    // benefit leaves more of it in direct public services. Services have a
    // different sector/supply profile than household cash, so the stress result
    // must not collapse to the same total-outlay ratio.
    expect(halfBenefit?.peakAnnualInflation).toBeGreaterThan(
      doubleBenefit?.peakAnnualInflation ?? Number.POSITIVE_INFINITY,
    );
  });

  it("attributes rebates created by later revenue growth to bottom-half income", () => {
    const base = nationalRequest();
    const calibration = runComparison(base);
    const requested = calibration.strategies["cash-first"].fiscal.requestedUbi;
    const scale = calibration.projection.annualFlows.taxCollected / requested;
    const request: ComparisonRequestV1 = {
      ...base,
      ubi: {
        ...base.ubi,
        adultMonthlyBenefit: base.ubi.adultMonthlyBenefit * scale,
        childMonthlyBenefit: base.ubi.childMonthlyBenefit * scale,
        directCashShare: 0,
        fundingRule: "fixed",
      },
      model: {
        ...base.model,
        monetaryPolicyOffsetShare: 1,
      },
    };
    const debtReduction = runComparison({
      ...request,
      ubi: { ...request.ubi, surplusUse: "debt-reduction" },
    });
    const rebate = runComparison({
      ...request,
      ubi: { ...request.ubi, surplusUse: "rebate" },
    });

    expect(rebate.projection.fiscal.years[0]?.rebate).toBeLessThan(1);
    expect(rebate.projection.fiscal.years.at(-1)?.rebate).toBeGreaterThan(0);
    expect(rebate.projection.summary.bottom50PurchasingPowerChange).toBeGreaterThan(
      debtReduction.projection.summary.bottom50PurchasingPowerChange,
    );
  });

  it("leaves output on the no-policy trend when both growth dials are zero", () => {
    // The growth/investment block must be inert at its defaults: the capital
    // index stays pinned at 1, so every year's GDP index is exactly 100 and the
    // year-ten change is exactly 0 (the golden/no-regression guarantee).
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate: 0.05 },
    });
    for (const year of result.projection.years) {
      expect(year.gdpIndex).toBe(100);
    }
    expect(result.projection.summary.gdpChange).toBe(0);
  });

  it("drags wages and GDP when the savings response to a large wealth tax is on", () => {
    const base: ComparisonRequestV1 = {
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate: 0.05 },
    };
    const noResponse = runComparison(base);
    const withResponse = runComparison({
      ...base,
      behavior: { ...base.behavior, savingsResponseElasticity: 0.8 },
    });

    // A positive savings elasticity shrinks the capital stock, so real GDP per
    // worker ends visibly below the no-policy path...
    expect(withResponse.projection.summary.gdpChange).toBeLessThan(-0.01);
    expect(noResponse.projection.summary.gdpChange).toBe(0);
    // ...the GDP index ends below where it started...
    expect(withResponse.projection.years.at(-1)?.gdpIndex).toBeLessThan(100);
    // ...and because wages track capital per worker, the bottom half ends with
    // less real buying power than the same tax without the growth drag — the
    // verdict weighs the steelman against the transfer gain.
    expect(
      withResponse.projection.summary.bottom50PurchasingPowerChange,
    ).toBeLessThan(noResponse.projection.summary.bottom50PurchasingPowerChange);
    // Every GDP value stays finite even as the capital index is dragged down.
    for (const year of withResponse.projection.years) {
      expect(Number.isFinite(year.gdpIndex)).toBe(true);
    }
  });

  it("scales the savings drag by actual collection, not the statutory rate", () => {
    // The drag must track the tax actually levied on wealth. With the same
    // savings elasticity and rate, a high exemption that collects little should
    // drag GDP far less than a universal tax that collects a lot — the growth
    // penalty never fires on a statutory rate that isn't actually collected.
    const withResponse = (exemption: number) =>
      runComparison({
        ...nationalRequest(),
        wealthTax: { targetMode: "exemption", exemption, topShare: 0.01, rate: 0.05 },
        behavior: { ...nationalRequest().behavior, savingsResponseElasticity: 0.8 },
      }).projection.summary.gdpChange;
    const universalDrag = withResponse(0); // taxes from the first dollar → large collection
    const highExemptionDrag = withResponse(1_000_000_000); // reaches only the top tail
    expect(universalDrag).toBeLessThan(-0.02);
    // The sparse-collection case drags far less than the broad one...
    expect(highExemptionDrag).toBeGreaterThan(universalDrag);
    // ...and stays modest despite the identical 5% statutory rate + 0.8 response.
    expect(highExemptionDrag).toBeGreaterThan(-0.03);
  });

  it("attributes a growth-driven harmful verdict to investment/wages, not inflation/debt", () => {
    // A universal wealth tax with a modest transfer and strong savings response
    // drags wages with no inflation or debt crisis — the harmful verdict must
    // name the growth channel, not blame inflation or debt it didn't cause.
    const result = runComparison({
      ...nationalRequest(),
      wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate: 0.05 },
      ubi: {
        ...nationalRequest().ubi,
        adultMonthlyBenefit: 500,
        childMonthlyBenefit: 250,
        surplusUse: "treasury-balance",
      },
      behavior: { ...nationalRequest().behavior, savingsResponseElasticity: 0.8 },
    });
    expect(result.projection.summary.gdpChange).toBeLessThan(-0.02);
    // The calibrated transfer keeps the cash measure outside its harmful band.
    // The verdict must therefore recognize the independently harmful output
    // loss instead of passing only because purchasing power crossed -2%.
    expect(result.projection.summary.bottom50PurchasingPowerChange).toBeGreaterThan(
      -0.02,
    );
    expect(result.projection.summary.peakAnnualInflation).toBeLessThan(0.2);
    expect(result.projection.summary.publicBurdenPerHousehold).toBeLessThan(50_000);
    expect(result.projection.verdict.rating).toBe("harmful");
    expect(result.projection.verdict.headline).toMatch(/investment and wages/);
    expect(result.projection.verdict.explanation).toMatch(/saving and investment/);
  });

  it("acknowledges a purchasing-power gain when output loss drives harm", () => {
    const base = nationalRequest();
    const result = runComparison({
      ...base,
      wealthTax: { targetMode: "exemption", exemption: 0, topShare: 0.01, rate: 0.01 },
      ubi: {
        ...base.ubi,
        adultMonthlyBenefit: 0,
        childMonthlyBenefit: 0,
        surplusUse: "rebate",
      },
      behavior: { ...base.behavior, savingsResponseElasticity: 1 },
      model: { ...base.model, monetaryPolicyOffsetShare: 1 },
    });

    expect(result.projection.summary.bottom50PurchasingPowerChange).toBeGreaterThan(0);
    expect(result.projection.summary.gdpChange).toBeLessThan(-0.02);
    expect(result.projection.verdict.rating).toBe("harmful");
    expect(result.projection.verdict.headline).toMatch(/gains buying power.*output loss/i);
    expect(result.projection.verdict.explanation).toMatch(/lift bottom-half buying power/i);
    expect(result.projection.verdict.explanation).not.toMatch(/less real buying power/i);
  });

  it("lifts output when the transfer's demand offset is on", () => {
    // With no savings response, a positive demand offset feeds the transfer's
    // fiscal impulse into investment and output, so GDP ends ABOVE the no-policy
    // path — the pure demand case, isolated from the supply drag.
    const base: ComparisonRequestV1 = {
      ...nationalRequest(),
      ubi: { ...nationalRequest().ubi, adultMonthlyBenefit: 1_500, childMonthlyBenefit: 750 },
    };
    const noOffset = runComparison(base);
    const withOffset = runComparison({
      ...base,
      behavior: {
        ...base.behavior,
        savingsResponseElasticity: 0,
        demandGrowthOffset: 1,
      },
    });
    expect(noOffset.projection.summary.gdpChange).toBe(0);
    expect(withOffset.projection.summary.gdpChange).toBeGreaterThan(0.01);
    expect(withOffset.projection.years.at(-1)?.gdpIndex).toBeGreaterThan(100);
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
