import { describe, expect, it } from "vitest";
import {
  FISCAL_PACKAGES,
  fiscalPackageFormFields,
} from "../public/fiscal-packages.js";
import {
  DEFAULT_COMPARISON_REQUEST,
  compareScenarios,
  type ComparisonRequestV1,
  type ComparisonResultV1,
} from "../src/index.js";

const requestFor = (name: keyof typeof FISCAL_PACKAGES): ComparisonRequestV1 => {
  const form = fiscalPackageFormFields(FISCAL_PACKAGES[name]);
  return {
    ...DEFAULT_COMPARISON_REQUEST,
    sampleSize: 1000,
    ubi: {
      ...DEFAULT_COMPARISON_REQUEST.ubi,
      adultMonthlyBenefit: form.adultBenefit,
      childMonthlyBenefit: form.childBenefit,
      fundingRule: form.fundingRule,
      surplusUse: form.surplusUse,
      benefitIndexation: form.benefitIndexation,
      serviceEffectiveness: form.serviceEffectiveness,
      directCashShare: form.directCashShare / 100,
      administrativeShare: form.administrativeShare / 100,
    },
  };
};

const runPackage = (name: keyof typeof FISCAL_PACKAGES): ComparisonResultV1 => {
  const response = compareScenarios(requestFor(name));
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.errors.join("; "));
  return response.result;
};

describe("wealth-tax fiscal packages", () => {
  it("classifies no-cash closures separately from rebates and scheduled UBI", () => {
    for (const name of ["debt-reduction", "services", "treasury-retention"] as const) {
      const definition = FISCAL_PACKAGES[name];
      expect(definition.classification).toBe("no-cash-transfer");
      expect(definition.form.adultBenefit).toBe(0);
      expect(definition.form.childBenefit).toBe(0);
    }
    for (const name of ["rebate", "scheduled-ubi"] as const) {
      expect(FISCAL_PACKAGES[name].classification).toBe("household-cash-transfer");
    }
    expect(FISCAL_PACKAGES.rebate.note).toMatch(/redistribution/i);
  });

  it("holds tax and behavior constant while only the no-benefit closure changes", () => {
    const names = ["debt-reduction", "services", "treasury-retention", "rebate"] as const;
    const requests = names.map(requestFor);
    const normalize = (request: ComparisonRequestV1) => ({
      ...request,
      ubi: { ...request.ubi, surplusUse: "held-out" },
    });
    for (const request of requests.slice(1)) {
      expect(normalize(request)).toEqual(normalize(requests[0]));
    }
  });

  it("reconciles and reports each no-benefit fiscal closure", () => {
    const results = Object.fromEntries(
      (["debt-reduction", "services", "treasury-retention", "rebate"] as const)
        .map((name) => [name, runPackage(name)]),
    ) as Record<string, ComparisonResultV1>;
    const referenceTax = results["debt-reduction"].projection.annualFlows.taxCollected;

    for (const result of Object.values(results)) {
      expect(result.projection.annualFlows.taxCollected).toBeCloseTo(referenceTax, 2);
      let openingTreasury = 0;
      for (const year of result.projection.fiscal.years) {
        expect(year.budgetIdentityResidual).toBeCloseTo(0, 2);
        expect(
          year.taxRevenue + year.debtIssued + openingTreasury,
        ).toBeCloseTo(
          year.governmentOutlay + year.debtRepaid + year.treasuryBalance,
          2,
        );
        expect(Number.isFinite(year.interestSavings)).toBe(true);
        openingTreasury = year.treasuryBalance;
      }
      expect(Object.values(result.strategies).every((outcome) => outcome.accounting.passed)).toBe(true);
      expect(result.projection.groupOutcomes.length).toBeGreaterThan(0);
    }

    expect(results["debt-reduction"].projection.fiscal.cumulativeDebtRepaid).toBeGreaterThan(0);
    expect(results.services.projection.annualFlows.publicServicesSpending).toBeGreaterThan(0);
    expect(results.services.projection.annualFlows.ubiReceived).toBe(0);
    expect(results.services.projection.verdict.scope).toBe("cash-only");
    expect(results["treasury-retention"].projection.fiscal.endingTreasuryBalance).toBeGreaterThan(0);
    expect(results.rebate.projection.annualFlows.rebate).toBeGreaterThan(0);
    expect(results.rebate.projection.annualFlows.ubiReceived).toBe(
      results.rebate.projection.annualFlows.rebate,
    );
    expect(results.rebate.projection.annualFlows.publicServicesSpending).toBe(0);

    const monetaryOutcomes = Object.values(results).map((result) =>
      result.projection.summary.cumulativeM2Change.toFixed(6),
    );
    expect(new Set(monetaryOutcomes).size).toBeGreaterThan(2);
  });
});
