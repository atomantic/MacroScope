import { describe, expect, it } from "vitest";
// The browser module is untyped JS; importing it here also asserts it stays
// dependency-free and node-loadable, giving a real encode/decode round-trip test.
import {
  DEFAULT_STRATEGY,
  FIELD_SPECS,
  PRESET_PARAM,
  STRATEGY_PARAM,
  decodeScenarioParams,
  encodeScenarioParams,
} from "../public/scenario-params.js";

const defaults = Object.fromEntries(FIELD_SPECS.map((spec) => [spec.id, "0"]));

describe("scenario URL parameters", () => {
  it("omits values equal to the defaults", () => {
    const query = encodeScenarioParams({ values: { ...defaults }, defaults });
    expect(query).toBe("");
  });

  it("encodes only fields that differ from the defaults", () => {
    const values = { ...defaults, "tax-rate": "10", exemption: "1000" };
    const query = encodeScenarioParams({ values, defaults });
    const params = new URLSearchParams(query);
    expect(params.get("tr")).toBe("10");
    expect(params.get("ex")).toBe("1000");
    expect(params.get("bs")).toBeNull();
  });

  it("round-trips an arbitrary changed field set through encode/decode", () => {
    const values = {
      ...defaults,
      "target-mode": "top-share",
      "top-share": "1",
      "tax-rate": "1",
      seed: "7",
    };
    const decoded = decodeScenarioParams(
      encodeScenarioParams({ values, defaults, strategy: "borrow-first" }),
    );
    expect(decoded.fields["target-mode"]).toBe("top-share");
    expect(decoded.fields["top-share"]).toBe("1");
    expect(decoded.fields["tax-rate"]).toBe("1");
    expect(decoded.fields.seed).toBe("7");
    expect(decoded.strategy).toBe("borrow-first");
    expect(decoded.preset).toBeNull();
  });

  it("encodes a pristine preset as ?preset=name without field params", () => {
    const values = { ...defaults, "tax-rate": "10" };
    const query = encodeScenarioParams({ values, defaults, preset: "billionaire" });
    const params = new URLSearchParams(query);
    expect(params.get(PRESET_PARAM)).toBe("billionaire");
    expect(params.get("tr")).toBeNull();
    expect(decodeScenarioParams(query).preset).toBe("billionaire");
  });

  it("decodes a preset alongside explicit field overrides (fields win)", () => {
    // Hand-crafted "preset + tweak" links must surface both, so the app's
    // hydration layer can let the explicit field override the preset value.
    const decoded = decodeScenarioParams("preset=billionaire&tr=20");
    expect(decoded.preset).toBe("billionaire");
    expect(decoded.fields["tax-rate"]).toBe("20");
  });

  it("keeps the default strategy out of the URL", () => {
    const query = encodeScenarioParams({
      values: { ...defaults },
      defaults,
      strategy: DEFAULT_STRATEGY,
    });
    expect(new URLSearchParams(query).has(STRATEGY_PARAM)).toBe(false);
  });

  it("round-trips a custom graduated schedule through the br param", () => {
    const query = encodeScenarioParams({
      values: { ...defaults },
      defaults,
      brackets: "50:2,1000:6",
    });
    expect(new URLSearchParams(query).get("br")).toBe("50:2,1000:6");
    expect(decodeScenarioParams(query).brackets).toBe("50:2,1000:6");
  });

  it("omits brackets from a pristine preset link", () => {
    // A preset reconstructs its own schedule on decode, so br must not ride along.
    const query = encodeScenarioParams({
      values: { ...defaults },
      defaults,
      preset: "warren-2020",
      brackets: "50:2,1000:6",
    });
    expect(new URLSearchParams(query).has("br")).toBe(false);
    expect(decodeScenarioParams(query).preset).toBe("warren-2020");
  });
});
