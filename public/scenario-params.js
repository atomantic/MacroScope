// Pure URL <-> scenario-form serialization. No DOM access here so the
// round-trip is unit-testable; app.js binds these helpers to form elements.
//
// Each spec maps a form element id to a compact query-parameter key. Values are
// carried as the raw string the input holds, which keeps this layer agnostic to
// the display-unit transforms (percent, $M) that formRequest() applies. Only
// values that differ from the fetched defaults are serialized, so shared URLs
// stay short and stable regardless of how many dials the model grows.
export const FIELD_SPECS = [
  { id: "target-mode", param: "tm" },
  { id: "exemption", param: "ex" },
  { id: "top-share", param: "ts" },
  { id: "tax-rate", param: "tr" },
  { id: "adult-benefit", param: "ab" },
  { id: "child-benefit", param: "cb" },
  { id: "funding-rule", param: "fr" },
  { id: "benefit-indexation", param: "bi" },
  { id: "direct-cash-share", param: "dc" },
  { id: "administrative-share", param: "as" },
  { id: "borrow-share", param: "bs" },
  { id: "sell-share", param: "ss" },
  { id: "loan-rate", param: "lr" },
  { id: "asset-return", param: "ar" },
  { id: "monetization", param: "mon" },
  { id: "buyer-depth", param: "bd" },
  { id: "asset-hedge-share", param: "ah" },
  { id: "housing-hedge-share", param: "hh" },
  { id: "housing-supply", param: "hs" },
  { id: "rent-pass-through", param: "rp" },
  { id: "seed", param: "seed" },
  { id: "sample-size", param: "n" },
  { id: "price-impact", param: "pi" },
  { id: "maximum-ltv", param: "ltv" },
];

export const PRESET_PARAM = "preset";
export const STRATEGY_PARAM = "strat";
export const BRACKETS_PARAM = "br";
export const DEFAULT_STRATEGY = "cash-first";

// Serialize the current form state to a compact query string. When `preset` is
// set the scenario is a pristine named preset and encodes as `?preset=name`;
// otherwise only fields differing from `defaults` are emitted. A custom graduated
// schedule (which has no single form field) rides along as `br` when present. The
// decile strategy selector round-trips alongside either form.
export const encodeScenarioParams = ({
  values,
  defaults,
  preset = null,
  strategy = DEFAULT_STRATEGY,
  brackets = null,
} = {}) => {
  const params = new URLSearchParams();
  if (preset) {
    params.set(PRESET_PARAM, preset);
  } else {
    for (const spec of FIELD_SPECS) {
      const value = values?.[spec.id];
      if (value !== undefined && String(value) !== String(defaults?.[spec.id])) {
        params.set(spec.param, String(value));
      }
    }
    // Brackets only carry outside a pristine preset — a preset reconstructs its
    // own schedule on decode, so emitting br there would be redundant.
    if (brackets) params.set(BRACKETS_PARAM, brackets);
  }
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
    fields,
  };
};
