// Structured, source-linked definitions for the named real-world wealth-tax
// proposals. This is the single source of truth shared by the browser UI
// (app.js), the validation-harness test (tests/policyPresets.test.ts), and —
// through the identical engine request the UI builds — the API/simulation path.
//
// The point of centralizing them is auditability: a named preset is no longer a
// bare row of numbers layered onto generic defaults but a declaration of its tax
// base, filing unit, deferral/enforcement assumptions, spending interpretation,
// the components the model does NOT yet capture (with the direction each biases
// revenue), and the published benchmarks to validate against.
//
// This module is DOM-free and dependency-free so vitest can import it directly,
// exactly like scenario-params.js.

// How a component the plan specifies but the model does not yet capture biases
// the modeled revenue relative to the real proposal.
export const BIAS_DIRECTION = {
  "understates-revenue": "Model under-counts — real revenue would be higher",
  "overstates-revenue": "Model over-counts — real revenue would be lower",
  ambiguous: "Direction unclear — timing/composition effect",
};

// The published-benchmark bases a validation report compares the model against.
export const REVENUE_BASIS = {
  campaign: "Campaign / authors' estimate",
  "no-avoidance": "Static, no behavioral response",
  conventional: "Conventional (with avoidance)",
  dynamic: "Dynamic (macro feedback)",
};

// Shared spending-linkage copy: every named tax proposal here is a revenue
// measure, not a spending package, so selecting it must not silently attach the
// generic cash-transfer bundle.
const TAX_SCHEDULE_ONLY = {
  linkage: "tax-schedule-only",
  note: "Revenue proposal — selecting it applies the tax schedule and zeroes the generic transfer, so it is tax side only. No cash-transfer or service package is implied; pair it with a spending preset to model where the revenue goes.",
};

// The base categories the engine's wealth-tax assessment models today, so a
// definition can state plainly which of a plan's asset classes are captured.
const MODELED_BASE = [
  { class: "Publicly traded assets", note: "Included at market value." },
  {
    class: "Private business",
    note: "Included at the private-business inclusion dial (70% by default).",
  },
  { class: "Housing and other property", note: "Included at market value." },
];

// The plan-specified components the current base omits. Warren and Sanders share
// most of these; the note reflects each plan's own language.
const SHARED_UNMODELED = [
  {
    component: "Retirement assets",
    direction: "understates-revenue",
    note: "The plan taxes retirement wealth; the model's base excludes it, biasing modeled revenue low.",
  },
  {
    component: "Trusts and closely-held vehicles",
    direction: "understates-revenue",
    note: "No distinct trust/estate class; wealth held through such vehicles is under-counted.",
  },
  {
    component: "Valuable personal property (art, collectibles)",
    direction: "understates-revenue",
    note: "No personal-property class; excluded from the taxable base.",
  },
  {
    component: "Interest-bearing deferral for illiquid taxpayers",
    direction: "ambiguous",
    note: "The plan lets illiquid taxpayers defer with interest; the model defers unpaid tax without an interest-bearing collection path, so timing and deferral interest are not captured.",
  },
];

export const POLICY_PRESETS = {
  "warren-2020": {
    id: "warren-2020",
    label: "Warren 2020 — Ultra-Millionaire Tax",
    kind: "tax-schedule",
    vintage: 2019,
    filingUnit: "tax-household",
    filingNote:
      "Single $50M threshold applies per tax unit regardless of filing status.",
    // Absolute schedule: [thresholdInMillions, ratePercent]. The lowest
    // threshold acts as the exemption. These reproduce the engine's audited
    // Warren run exactly.
    brackets: [
      [50, 2],
      [1000, 6],
    ],
    scheduleNote:
      "2% on net worth above $50M; 6% above $1B (the revised billionaire surtax).",
    spending: TAX_SCHEDULE_ONLY,
    enforcement: {
      planned:
        "Plan pairs the tax with a 30% minimum audit rate, a 40% exit tax on wealth over $50M, and expanded IRS valuation authority.",
      modeled:
        "Default run assumes full remittance (avoidance 0, expatriation 0, 70% private-business inclusion). Use the taxpayer-response presets to stress compliance.",
    },
    assetInclusions: MODELED_BASE,
    unmodeled: SHARED_UNMODELED,
    benchmarks: [
      {
        basis: "campaign",
        label: "Saez & Zucman (campaign)",
        vintage: 2019,
        tenYearRevenue: 3_750e9,
        url: "https://elizabethwarren.com/plans/ultra-millionaire-tax",
        note: "$3.75T over 10 years headline estimate.",
      },
      {
        basis: "no-avoidance",
        label: "PWBM — no avoidance",
        vintage: 2019,
        tenYearRevenue: 4_781e9,
        url: "https://budgetmodel.wharton.upenn.edu/estimates/2019-12-12-warren-wealth-tax/charts.html",
      },
      {
        basis: "conventional",
        label: "PWBM — conventional",
        vintage: 2019,
        tenYearRevenue: 2_724e9,
        url: "https://budgetmodel.wharton.upenn.edu/estimates/2019-12-12-warren-wealth-tax/charts.html",
      },
      {
        basis: "dynamic",
        label: "PWBM — dynamic",
        vintage: 2019,
        tenYearRevenue: 2_294e9,
        url: "https://budgetmodel.wharton.upenn.edu/estimates/2019-12-12-warren-wealth-tax/charts.html",
      },
    ],
    citations: [
      {
        label: "Warren campaign — Ultra-Millionaire Tax",
        url: "https://elizabethwarren.com/plans/ultra-millionaire-tax",
      },
      {
        label: "PWBM — Warren wealth tax estimates",
        url: "https://budgetmodel.wharton.upenn.edu/estimates/2019-12-12-warren-wealth-tax/charts.html",
      },
    ],
  },
  "sanders-2020": {
    id: "sanders-2020",
    label: "Sanders 2020 — Tax on Extreme Wealth",
    kind: "tax-schedule",
    vintage: 2019,
    filingUnit: "married-household",
    filingNote:
      "Published thresholds are for MARRIED COUPLES; single-filer thresholds are halved (the tax reaches single filers at $16M, not $32M). This preset encodes the married-couple schedule only.",
    brackets: [
      [32, 1],
      [50, 2],
      [250, 3],
      [500, 4],
      [1000, 5],
      [2500, 6],
      [5000, 7],
      [10000, 8],
    ],
    scheduleNote:
      "Eight married-couple brackets: 1% above $32M rising to 8% above $10B.",
    spending: TAX_SCHEDULE_ONLY,
    enforcement: {
      planned:
        "Plan pairs the tax with a national wealth registry, a 40% exit tax, and stepped-up IRS auditing of the top 1%.",
      modeled:
        "Default run assumes full remittance (avoidance 0, expatriation 0, 70% private-business inclusion). Use the taxpayer-response presets to stress compliance.",
    },
    assetInclusions: MODELED_BASE,
    unmodeled: [
      {
        component: "Single-filer thresholds",
        direction: "understates-revenue",
        note: "Only the married-couple schedule is modeled; single filers are taxed at half these thresholds, widening the real base.",
      },
      ...SHARED_UNMODELED,
    ],
    benchmarks: [
      {
        basis: "campaign",
        label: "Saez & Zucman (campaign)",
        vintage: 2019,
        tenYearRevenue: 4_350e9,
        url: "https://berniesanders.com/issues/tax-extreme-wealth/",
        note: "$4.35T over 10 years headline estimate.",
      },
    ],
    citations: [
      {
        label: "Sanders campaign — Tax on Extreme Wealth",
        url: "https://berniesanders.com/issues/tax-extreme-wealth/",
      },
    ],
  },
  "current-law": {
    id: "current-law",
    label: "Current law — no federal wealth tax",
    kind: "baseline",
    vintage: 2024,
    filingUnit: "n/a",
    filingNote:
      "No federal net-wealth tax exists; this is the counterfactual baseline.",
    brackets: [],
    // Baseline needs an explicit compact form because it has no schedule to
    // derive the exemption/rate from.
    form: { targetMode: "exemption", topShare: 1, exemption: 10, rate: 0, brackets: [] },
    scheduleNote: "No wealth tax applied.",
    spending: TAX_SCHEDULE_ONLY,
    enforcement: null,
    assetInclusions: [],
    unmodeled: [],
    benchmarks: [],
    citations: [],
  },
};

// The compact form-field object app.js applies via setPresetFields, derived from
// the audited definition so the schedule the UI runs can never drift from the
// definition the benchmarks validate. Mirrors the legacy inline PRESETS shape:
// { targetMode, exemption ($M), rate (%), brackets: [[thresholdM, ratePct]] }.
export const presetFormFields = (def) => {
  if (def.form) return def.form;
  const [exemptionM, lowestRate] = def.brackets[0];
  return {
    targetMode: "exemption",
    exemption: exemptionM,
    rate: lowestRate,
    brackets: def.brackets.map((row) => [...row]),
    // A named tax proposal imposes no transfer of its own; zero the generic UBI
    // package the form defaults would otherwise carry so "tax side only" is
    // literally true and the revenue benchmark isn't a bundled spending scenario.
    adultBenefit: 0,
    childBenefit: 0,
  };
};

// Ten-year revenue the model produced for a preset, summed from the fiscal
// projection. Shared by the UI benchmark panel and the validation test so both
// measure revenue the same way.
export const modelTenYearRevenue = (projection) =>
  (projection?.fiscal?.years ?? [])
    .slice(0, 10)
    .reduce((sum, year) => sum + year.taxRevenue, 0);

// Signed fractional deviation of the model figure from a published benchmark
// (0.1 = model is 10% above the benchmark). Null when the benchmark is zero.
export const benchmarkDeviation = (modelRevenue, benchmarkRevenue) =>
  benchmarkRevenue ? (modelRevenue - benchmarkRevenue) / benchmarkRevenue : null;
