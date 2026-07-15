import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_PRESETS } from "../public/diagnostic-presets.js";
import { decodeScenarioParams, encodeScenarioParams } from "../public/scenario-params.js";

describe("diagnostic presets", () => {
  it("defines stable, mechanism-specific diagnostic corners", () => {
    expect(Object.isFrozen(DIAGNOSTIC_PRESETS)).toBe(true);
    expect(Object.isFrozen(DIAGNOSTIC_PRESETS["cash-rebate"].form)).toBe(true);
    expect(DIAGNOSTIC_PRESETS["cash-rebate"].form.borrowShare).toBe(0);
    expect(DIAGNOSTIC_PRESETS["borrow-rent-stress"].form.rentPassThrough).toBe(100);
    expect(DIAGNOSTIC_PRESETS["asset-sale-stress"].form.sellShare).toBe(100);
    expect(DIAGNOSTIC_PRESETS["services-only"].form.directCashShare).toBe(0);
    expect(DIAGNOSTIC_PRESETS["extreme-universal-borrow"].nonForecast).toBe(true);
    expect(DIAGNOSTIC_PRESETS["extreme-universal-borrow"].form.rate).toBe(20);
    const query = encodeScenarioParams({
      values: {}, defaults: {}, preset: "extreme-universal-borrow",
    });
    expect(decodeScenarioParams(query).preset).toBe("extreme-universal-borrow");
  });
});
