import { describe, expect, it } from "vitest";
import {
  calculatePersonaCashBenefit,
  calculatePersonaWealthTax,
  personaScheduleFromRequest,
} from "../public/persona-calculation.js";

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

  it("uses the response's graduated schedule instead of a stale headline rate", () => {
    const brackets = [
      { threshold: 50_000_000, upperThreshold: 1_000_000_000, rate: 0.02 },
      { threshold: 1_000_000_000, upperThreshold: null, rate: 0.06 },
    ];

    expect(calculatePersonaWealthTax({ netWorth: 51_000_000, brackets })).toBe(20_000);
    expect(calculatePersonaWealthTax({ netWorth: 20_000_000_000, brackets })).toBe(
      1_159_000_000,
    );
    expect(
      calculatePersonaWealthTax({
        netWorth: 51_000_000,
        brackets: [{ threshold: 50_000_000, rate: 0.02 }],
      }),
    ).toBe(20_000);
  });

  it("derives a complete schedule from an older response's policy request", () => {
    const brackets = personaScheduleFromRequest({
      exemption: 50_000_000,
      rate: 0.02,
      brackets: [
        { threshold: 1_000_000_000, rate: 0.06 },
        { threshold: 50_000_000, rate: 0.02 },
      ],
    });

    expect(brackets).toEqual([
      { threshold: 50_000_000, upperThreshold: 1_000_000_000, rate: 0.02 },
      { threshold: 1_000_000_000, upperThreshold: null, rate: 0.06 },
    ]);
    expect(calculatePersonaWealthTax({ netWorth: 51_000_000, brackets })).toBe(20_000);
  });
});
