// Deliberately legible corner cases for explaining the model's mechanisms.
// These are versioned scenario definitions, not probability forecasts or policy
// recommendations. App.js resets to the calibrated defaults before applying a
// form, which makes each definition complete, repeatable, and safely shareable
// as `?preset=<id>`.
const freezeDeep = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
};

export const DIAGNOSTIC_PRESETS = freezeDeep({
  "cash-rebate": {
    id: "cash-rebate",
    label: "Cash tax / rebate",
    mechanism: "Moves an existing tax payment back to households without modeled borrowing, asset sales, or service delivery.",
    form: {
      targetMode: "exemption", exemption: 10, rate: 2, brackets: [],
      adultBenefit: 1_000, childBenefit: 500, directCashShare: 100,
      administrativeShare: 0, borrowShare: 0, sellShare: 0,
      surplusUse: "rebate",
    },
  },
  "borrow-rent-stress": {
    id: "borrow-rent-stress",
    label: "Borrowing + rent stress",
    mechanism: "Isolates the credit-to-assets-to-rents channel: tax bills are fully borrowed, liquidity seeks housing, supply cannot respond, and price gains fully pass through to rent.",
    form: {
      targetMode: "exemption", exemption: 10, rate: 2, brackets: [],
      borrowShare: 100, sellShare: 0, assetHedgeShare: 100,
      housingHedgeShare: 100, housingSupply: 0, rentPassThrough: 100,
    },
  },
  "asset-sale-stress": {
    id: "asset-sale-stress",
    label: "Asset-sale stress",
    mechanism: "Isolates forced-sale absorption: payments come from sales into a deliberately shallow buyer pool with high price impact.",
    form: {
      targetMode: "exemption", exemption: 10, rate: 2, brackets: [],
      borrowShare: 0, sellShare: 100, buyerDepth: 0.1, priceImpact: 1,
    },
  },
  "services-only": {
    id: "services-only",
    label: "Services only",
    mechanism: "Routes the program entirely through public services so cash buying power and the separately stated service-value assumption remain visibly distinct.",
    form: {
      targetMode: "exemption", exemption: 10, rate: 2, brackets: [],
      adultBenefit: 1_000, childBenefit: 500, directCashShare: 0,
      serviceEffectiveness: "base",
    },
  },
  "extreme-universal-borrow": {
    id: "extreme-universal-borrow",
    label: "Extreme 20% universal borrowing",
    mechanism: "A deliberately implausible diagnostic corner: a 20% tax from the first dollar, entirely debt-financed, with no housing supply response and full rent pass-through. It is not a forecast.",
    nonForecast: true,
    form: {
      targetMode: "exemption", exemption: 0, rate: 20, brackets: [],
      borrowShare: 100, sellShare: 0, assetHedgeShare: 100,
      housingHedgeShare: 100, housingSupply: 0, rentPassThrough: 100,
    },
  },
});
