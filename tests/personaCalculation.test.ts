import { describe, expect, it } from "vitest";
import { calculatePersonaCashBenefit } from "../public/persona-calculation.js";

describe("persona cash-benefit calculation", () => {
  it("adds a zero-benefit rebate uniformly instead of dropping it", () => {
    const input = {
      aggregateRequestedBenefit: 0,
      aggregateCashDelivered: 50_000,
      aggregateRebate: 50_000,
      representedHouseholds: 10,
    };

    expect(calculatePersonaCashBenefit({ ...input, grossScheduledBenefit: 0 })).toBe(
      5_000,
    );
    expect(
      calculatePersonaCashBenefit({ ...input, grossScheduledBenefit: 100_000 }),
    ).toBe(5_000);
  });

  it("scales only the scheduled leg by household composition", () => {
    const input = {
      aggregateRequestedBenefit: 1_000,
      aggregateCashDelivered: 900,
      aggregateRebate: 100,
      representedHouseholds: 10,
    };

    expect(calculatePersonaCashBenefit({ ...input, grossScheduledBenefit: 200 })).toBe(
      170,
    );
    expect(calculatePersonaCashBenefit({ ...input, grossScheduledBenefit: 400 })).toBe(
      330,
    );
  });
});
