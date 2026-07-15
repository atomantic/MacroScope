// Pure URL <-> scenario-form serialization. No DOM access here so the
// round-trip is unit-testable; app.js binds these helpers to form elements.
//
// Each spec maps a form element id to a compact query-parameter key. Values are
// carried as the raw string the input holds, which keeps this layer agnostic to
// the display-unit transforms (percent, $M) that formRequest() applies. Only
// values that differ from the fetched defaults are serialized, so shared URLs
// stay short and stable regardless of how many dials the model grows.
export const SCENARIO_FIELD_SPECS = [
  { id: "target-mode", param: "tm" },
  { id: "exemption", param: "ex" },
  { id: "top-share", param: "ts" },
  { id: "tax-rate", param: "tr" },
  { id: "adult-benefit", param: "ab" },
  { id: "child-benefit", param: "cb" },
  { id: "funding-rule", param: "fr" },
  { id: "surplus-use", param: "su" },
  { id: "benefit-indexation", param: "bi" },
  { id: "service-effectiveness", param: "se" },
  { id: "direct-cash-share", param: "dc" },
  { id: "administrative-share", param: "as" },
  { id: "borrow-share", param: "bs" },
  { id: "sell-share", param: "ss" },
  { id: "loan-rate", param: "lr" },
  { id: "tax-loan-resolution", param: "tlr" },
  { id: "avoidance-elasticity", param: "ae" },
  { id: "expatriation-share", param: "es" },
  { id: "expatriation-residence-share", param: "ers" },
  { id: "expatriation-tax-base-share", param: "etb" },
  { id: "private-business-inclusion", param: "pb" },
  { id: "asset-return", param: "ar" },
  { id: "monetization", param: "mon" },
  { id: "buyer-depth", param: "bd" },
  { id: "asset-hedge-share", param: "ah" },
  { id: "housing-hedge-share", param: "hh" },
  { id: "housing-supply", param: "hs" },
  { id: "rent-pass-through", param: "rp" },
  { id: "economy-closure", param: "ec" },
  { id: "foreign-buyer-share", param: "fbs" },
  { id: "foreign-treasury-share", param: "fts" },
  { id: "capital-outflow-response", param: "cor" },
  { id: "repatriation-fx-pass-through", param: "rfp" },
  { id: "savings-response", param: "sr" },
  { id: "demand-offset", param: "dg" },
  { id: "seed", param: "seed" },
  { id: "sample-size", param: "n" },
  { id: "price-impact", param: "pi" },
  { id: "maximum-ltv", param: "ltv" },
  // Promoted, tunable model constants (issue #8).
  { id: "wage-pass-through", param: "wpt" },
  { id: "loan-amortization", param: "lam" },
  { id: "top-tax-incidence", param: "tti" },
  { id: "monetary-offset", param: "mpo" },
  { id: "asset-price-passthrough", param: "apt" },
  { id: "verdict-harmful-inflation", param: "vhi" },
];

export const PERSONA_FIELD_SPECS = [
  { id: "persona-net-worth", param: "nw" },
  { id: "persona-adults", param: "pa" },
  { id: "persona-children", param: "pc" },
  { id: "persona-tenure", param: "pt" },
];

export const FIELD_SPECS = [...SCENARIO_FIELD_SPECS, ...PERSONA_FIELD_SPECS];

const SCENARIO_FIELD_IDS = new Set(SCENARIO_FIELD_SPECS.map((spec) => spec.id));

export const PRESET_PARAM = "preset";
export const STRATEGY_PARAM = "strat";
export const BRACKETS_PARAM = "br";
// A pinned "Scenario A" rides alongside the live scenario as a single nested
// query string (itself the output of encodeScenarioParams) so an A/B comparison
// is fully reproducible from one shareable link.
export const PIN_PARAM = "pin";
export const DEFAULT_STRATEGY = "cash-first";

// Serialize the current form state to a compact query string. When `preset` is
// set the policy is encoded as `?preset=name`; household settings may accompany
// it. Otherwise only fields differing from `defaults` are emitted. A custom
// graduated schedule (which has no single form field) rides along as `br` when
// present. The decile strategy selector round-trips alongside either form.
export const encodeScenarioParams = ({
  values,
  defaults,
  preset = null,
  strategy = DEFAULT_STRATEGY,
  brackets = null,
  pin = null,
} = {}) => {
  const params = new URLSearchParams();
  if (preset) params.set(PRESET_PARAM, preset);
  for (const spec of FIELD_SPECS) {
    // A pristine policy preset reconstructs all scenario controls, but personal
    // household settings still need to accompany it in a shared link.
    if (preset && SCENARIO_FIELD_IDS.has(spec.id)) continue;
    const value = values?.[spec.id];
    if (value !== undefined && String(value) !== String(defaults?.[spec.id])) {
      params.set(spec.param, String(value));
    }
  }
  // Brackets only carry outside a pristine preset — a preset reconstructs its
  // own schedule on decode, so emitting br there would be redundant.
  if (!preset && brackets) params.set(BRACKETS_PARAM, brackets);
  // The pinned scenario is a complete, independently-encoded query string. It
  // nests as one param value (URLSearchParams percent-encodes it), so it never
  // collides with the live scenario's own keys.
  if (pin) params.set(PIN_PARAM, pin);
  if (strategy && strategy !== DEFAULT_STRATEGY) params.set(STRATEGY_PARAM, strategy);
  return params.toString();
};

// Parse a location.search string back into a preset name, per-field overrides
// keyed by element id, and the decile strategy. Explicit field params always
// win over a preset so a preset link with tweaks reproduces exactly.
export const decodeScenarioParams = (search) => {
  const params = new URLSearchParams(search ?? "");
  const fields = {};
  for (const spec of FIELD_SPECS) {
    if (params.has(spec.param)) fields[spec.id] = params.get(spec.param);
  }
  return {
    preset: params.get(PRESET_PARAM),
    strategy: params.get(STRATEGY_PARAM),
    brackets: params.get(BRACKETS_PARAM),
    pin: params.get(PIN_PARAM),
    fields,
  };
};
