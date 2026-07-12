import { describe, expect, it } from "vitest";
import {
  generateSyntheticPopulation,
  householdNetWorth,
} from "../src/index.js";

describe("synthetic population", () => {
  it("is deterministic, weighted, and explicitly oversamples the top tail", () => {
    const config = { seed: 42, sampleSize: 1_000, representedHouseholds: 50_000 };
    const first = generateSyntheticPopulation(config);
    const second = generateSyntheticPopulation(config);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1_000);
    expect(first.reduce((total, household) => total + household.weight, 0)).toBeCloseTo(
      50_000,
      6,
    );
    expect(first.filter((household) => household.percentile >= 0.99).length).toBe(200);
    expect(householdNetWorth(first.at(-1)!)).toBeGreaterThan(
      householdNetWorth(first[0]!),
    );
  });

  it("changes the micro population when the seed changes", () => {
    const baseline = generateSyntheticPopulation({
      seed: 1,
      sampleSize: 100,
      representedHouseholds: 1_000,
    });
    const alternate = generateSyntheticPopulation({
      seed: 2,
      sampleSize: 100,
      representedHouseholds: 1_000,
    });
    expect(alternate).not.toEqual(baseline);
  });
});
