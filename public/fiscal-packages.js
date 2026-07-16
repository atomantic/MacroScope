// First-class spending/closure packages. These are deliberately separate from
// wealth-tax schedule presets: applying one changes only benefit and revenue-use
// fields, so users can hold the tax and taxpayer behavior fixed while comparing
// fiscal closures.

export const FISCAL_PACKAGES = {
  "debt-reduction": {
    label: "No cash — reduce debt",
    classification: "no-cash-transfer",
    form: {
      adultBenefit: 0,
      childBenefit: 0,
      fundingRule: "revenue-constrained",
      surplusUse: "debt-reduction",
      benefitIndexation: "none",
      serviceEffectiveness: "unscored",
      directCashShare: 100,
      administrativeShare: 0,
    },
    note: "No scheduled benefit or household cash transfer. Revenue retires program debt first, then existing public debt; any amount beyond the available debt remains at Treasury.",
  },
  services: {
    label: "No cash — public services",
    classification: "no-cash-transfer",
    form: {
      adultBenefit: 0,
      childBenefit: 0,
      fundingRule: "revenue-constrained",
      surplusUse: "additional-services",
      benefitIndexation: "none",
      serviceEffectiveness: "unscored",
      directCashShare: 100,
      administrativeShare: 0,
    },
    note: "No scheduled benefit or household cash transfer. Revenue funds public services; the default verdict remains cash-only until a service-value assumption is selected.",
  },
  "treasury-retention": {
    label: "No cash — hold at Treasury",
    classification: "no-cash-transfer",
    form: {
      adultBenefit: 0,
      childBenefit: 0,
      fundingRule: "revenue-constrained",
      surplusUse: "treasury-balance",
      benefitIndexation: "none",
      serviceEffectiveness: "unscored",
      directCashShare: 100,
      administrativeShare: 0,
    },
    note: "No scheduled benefit or household cash transfer. Revenue accumulates at Treasury and can drain deposits subject to the modeled M2 floor.",
  },
  rebate: {
    label: "Cash transfer — household rebate",
    classification: "household-cash-transfer",
    form: {
      adultBenefit: 0,
      childBenefit: 0,
      fundingRule: "revenue-constrained",
      surplusUse: "rebate",
      benefitIndexation: "none",
      serviceEffectiveness: "unscored",
      directCashShare: 100,
      administrativeShare: 0,
    },
    note: "Revenue is returned to households as cash. This is redistribution and is never classified as a tax-only or no-transfer package.",
  },
  "scheduled-ubi": {
    label: "Cash transfer — scheduled UBI",
    classification: "household-cash-transfer",
    form: {
      adultBenefit: 1000,
      childBenefit: 500,
      fundingRule: "revenue-constrained",
      surplusUse: "debt-reduction",
      benefitIndexation: "none",
      serviceEffectiveness: "unscored",
      directCashShare: 100,
      administrativeShare: 8,
    },
    note: "A $1,000 monthly adult and $500 child scheduled cash benefit, constrained by annual revenue; surplus revenue reduces public debt.",
  },
};

export const fiscalPackageFormFields = (definition) => ({ ...definition.form });

