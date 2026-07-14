import { describe, expect, it } from "vitest";
import {
  DFA_INSTRUMENT_CALIBRATION,
  US_BASELINE,
  US_WEALTH_GROUPS,
  calibratePopulationToUsWithDiagnostics,
  generateSyntheticPopulation,
} from "../src/index.js";

const recordTotal = (record: Readonly<Record<string, number>>): number =>
  Object.values(record).reduce((total, value) => total + value, 0);

const calibrate = (sampleSize = 4_000, representedHouseholds = US_BASELINE.households) =>
  calibratePopulationToUsWithDiagnostics(
    generateSyntheticPopulation({
      seed: 42,
      sampleSize,
      representedHouseholds,
    }),
    representedHouseholds,
  );

describe("DFA instrument calibration", () => {
  it("reconciles the stored instrument targets to every wealth-group balance sheet", () => {
    for (const group of US_WEALTH_GROUPS) {
      expect(recordTotal(group.assetClasses)).toBe(group.assets);
      expect(recordTotal(group.liabilityClasses)).toBe(group.liabilities);
      expect(group.deposits).toBe(group.assetClasses.deposits);
      expect(group.publicEquity).toBe(group.assetClasses.publicEquity);
      expect(group.realEstate).toBe(group.assetClasses.housing);
      // The published net-worth column can differ from rounded assets less
      // rounded liabilities by $1 million.
      expect(Math.abs(group.assets - group.liabilities - group.netWorth)).toBeLessThanOrEqual(
        1_000_000,
      );
    }
  });

  it("calibrates every asset and liability instrument by wealth group", () => {
    const result = calibrate();

    expect(result.diagnostics).toHaveLength(50);
    expect(Math.max(...result.diagnostics.map((entry) => entry.relativeError))).toBeLessThan(
      1e-12,
    );
    expect(
      result.diagnostics.some(
        (entry) => entry.wealthGroup === "top-0.1" && entry.instrument === "otherAssets",
      ),
    ).toBe(true);
    expect(
      result.households.every((household) =>
        [...Object.values(household.assets), ...Object.values(household.liabilities)].every(
          (value) => Number.isFinite(value) && value >= 0,
        ),
      ),
    ).toBe(true);
    for (const group of US_WEALTH_GROUPS) {
      const represented = result.households
        .filter(
          (household) =>
            household.percentile >= group.percentileMinimum &&
            (household.percentile < group.percentileMaximum ||
              group.percentileMaximum === 1),
        )
        .reduce((total, household) => total + household.weight, 0);
      expect(represented).toBeCloseTo(group.households, 5);
    }
  });

  it("preserves instrument targets when a scenario represents a scaled population", () => {
    const representedHouseholds = 10_000;
    const result = calibrate(800, representedHouseholds);
    const scale = representedHouseholds / US_BASELINE.households;
    const topEquity = result.diagnostics.find(
      (entry) => entry.wealthGroup === "top-0.1" && entry.instrument === "publicEquity",
    );

    expect(topEquity?.target).toBeCloseTo(
      US_WEALTH_GROUPS.at(-1)!.assetClasses.publicEquity * scale,
      6,
    );
    expect(topEquity?.relativeError).toBeLessThan(1e-12);
  });

  it("documents the otherwise-unmapped DFA instruments as a separate residual class", () => {
    expect(DFA_INSTRUMENT_CALIBRATION.residualAssetClass).toMatchObject({
      modelClass: "otherAssets",
      includedInModel: true,
    });
    expect(
      DFA_INSTRUMENT_CALIBRATION.assets.otherAssets.sourceInstruments,
    ).toEqual(
      expect.arrayContaining([
        "Consumer durables",
        "Money market fund shares",
        "Life insurance reserves",
      ]),
    );
  });
});
