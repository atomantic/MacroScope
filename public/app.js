// Derive the asset version from this module's own URL (index.html loads
// `app.js?v=N`). A single page-bundle bump then flows to every sibling asset
// this file pulls — scenario params, the engine worker, the main-thread engine
// fallback, and the data snapshots — so a returning client can never pair a
// fresh app.js with a stale engine graph or data JSON. Empty in the unversioned
// dev case, which simply loads assets without a cache-busting query.
const ASSET_VERSION = new URL(import.meta.url).searchParams.get("v") ?? "";
const versionQuery = ASSET_VERSION ? `?v=${ASSET_VERSION}` : "";
const versioned = (path) => `${path}${versionQuery}`;

// Dynamically imported (rather than statically) so the specifier can carry the
// runtime-derived version; a bumped app.js always pulls the matching
// FIELD_SPECS rather than a browser-cached copy that predates newly added
// fields.
const {
  FIELD_SPECS,
  SCENARIO_FIELD_SPECS,
  DEFAULT_STRATEGY,
  encodeScenarioParams,
  decodeScenarioParams,
} = await import(versioned("./scenario-params.js"));
const {
  calculatePersonaCashBenefit,
  calculatePersonaWealthTax,
  personaScheduleFromRequest,
} = await import(
  versioned("./persona-calculation.js")
);
const {
  POLICY_PRESETS,
  BIAS_DIRECTION,
  REVENUE_BASIS,
  presetFormFields,
  modelTenYearRevenue,
  benchmarkDeviation,
} = await import(versioned("./policy-presets.js"));
const { DIAGNOSTIC_PRESETS } = await import(versioned("./diagnostic-presets.js"));

const STRATEGIES = ["cash-first", "borrow-first", "sell-first"];
const LABELS = {
  "cash-first": "Cash first",
  "borrow-first": "Borrow first",
  "sell-first": "Sell first",
};

let latestResult = null;
let baseline = null;
let historicalBacktest = null;
let representedHouseholds = 0;
// Display-unit snapshot of the default form values, captured once after the
// fetched defaults populate the form. Serialization emits only fields that
// differ from this, keeping shared URLs short.
let defaultFieldValues = {};
// Non-null while the form still matches a named preset exactly, so the URL can
// stay the shareable `?preset=name` form. Cleared on any manual edit.
let activePreset = null;
const syncPresetButtons = () => {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const selected = button.dataset.preset === activePreset;
    button.setAttribute("aria-pressed", String(selected));
    button.classList.toggle("is-active", selected);
  });
};
const setActivePreset = (name) => {
  activePreset = name;
  syncPresetButtons();
  renderPresetDefinition(name);
};
// A/B "Scenario A": a frozen run whose lines ghost onto every chart and whose
// outcomes anchor the comparison table. pinnedResult holds the computed run;
// the *FieldValues/*Brackets/*Strategy re-serialize a runtime pin; pinnedFromUrl
// carries a URL-restored pin verbatim so it round-trips without re-resolving a
// preset back into explicit fields.
let pinnedResult = null;
let pinnedFieldValues = null;
let pinnedBrackets = null;
let pinnedStrategy = null;
let pinnedFromUrl = null;
// Stashed by hydrateFormFromUrl so restorePinnedFromUrl can compute the pinned
// run once the engine is ready.
let urlPinString = null;
const isStaticSnapshot = document.documentElement.dataset.mode === "static";

const money = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const compactMoney = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

const byId = (id) => document.getElementById(id);

const setScenarioSummary = (summary) => {
  byId("scenario-summary").textContent = summary;
  const drawerSummary = byId("scenario-drawer-summary");
  if (drawerSummary) drawerSummary.textContent = summary;
};

const initialize = async () => {
  try {
    loadModelConstants();
    if (isStaticSnapshot) {
      const [defaultResponse, baselineResponse, snapshotResponse, backtestResponse] = await Promise.all([
        fetch(versioned("data/default-request.json")),
        fetch(versioned("data/us-baseline.json")),
        fetch(versioned("data/default-scenario.json")),
        fetch(versioned("data/historical-backtest.json")),
      ]);
      if (!defaultResponse.ok || !baselineResponse.ok || !snapshotResponse.ok || !backtestResponse.ok) {
        throw new Error("The published policy snapshot is unavailable.");
      }
      const defaults = await defaultResponse.json();
      baseline = await baselineResponse.json();
      const snapshot = await snapshotResponse.json();
      historicalBacktest = await backtestResponse.json();
      renderValidation(historicalBacktest);
      byId("service-status").classList.add("online");
      byId("service-status-text").textContent = "In-browser model";
      byId("baseline-label").textContent = `${baseline.label} · ${baseline.vintage} Fed wealth data · ${compactNumber(baseline.households)} households`;
      renderCalibrationSummary(baseline.calibration);
      renderSources(baseline.sources);
      populateForm(defaults);
      captureDefaultFieldValues();
      initSliders();
      syncAllSliders();
      const hasScenarioParams = hydrateFormFromUrl();
      // Pre-warm the engine worker so the first slider-driven run doesn't pay
      // worker startup; comparisonChannel is the shared scenario-run channel.
      if (typeof Worker !== "undefined") comparisonChannel.warm();
      await restorePinnedFromUrl();
      if (hasScenarioParams) {
        // A shared URL carries its own assumptions — recompute rather than
        // showing the prebuilt default snapshot.
        await runScenario();
      } else {
        latestResult = snapshot;
        render(snapshot);
        setScenarioSummary(scenarioSummary(defaults, snapshot));
        setFormStatus("Default scenario shown. Change any assumption and recalculate — the model runs in your browser.");
        void refreshSensitivity(formRequest());
      }
      return;
    }
    const [healthResponse, defaultResponse, baselineResponse, backtestResponse] = await Promise.all([
      fetch("/health"),
      fetch("/api/scenarios/default"),
      fetch("/api/baseline/us"),
      fetch("/api/validation/historical"),
    ]);
    if (!healthResponse.ok || !defaultResponse.ok || !baselineResponse.ok || !backtestResponse.ok) {
      throw new Error("MacroScope service is unavailable.");
    }
    const health = await healthResponse.json();
    const defaults = await defaultResponse.json();
    baseline = await baselineResponse.json();
    historicalBacktest = await backtestResponse.json();
    renderValidation(historicalBacktest);
    byId("service-status").classList.add("online");
    byId("service-status-text").textContent = health.status;
    byId("baseline-label").textContent = `${baseline.label} · ${baseline.vintage} Fed wealth data · ${compactNumber(baseline.households)} households`;
    renderCalibrationSummary(baseline.calibration);
    renderSources(baseline.sources);
    populateForm(defaults);
    captureDefaultFieldValues();
    initSliders();
    syncAllSliders();
    hydrateFormFromUrl();
    await restorePinnedFromUrl();
    await runScenario();
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : "Unable to initialize.", true);
    byId("service-status-text").textContent = "Unavailable";
    // Without the fetched defaults the form would submit an invalid request
    // (representedHouseholds 0) on every click — disable it instead.
    byId("run-button").disabled = true;
  }
};

const populateForm = (request) => {
  representedHouseholds = request.representedHouseholds;
  byId("seed").value = request.seed;
  byId("sample-size").value = request.sampleSize;
  byId("exemption").value = request.wealthTax.exemption / 1_000_000;
  byId("target-mode").value = request.wealthTax.targetMode;
  byId("top-share").value = request.wealthTax.topShare * 100;
  byId("tax-rate").value = request.wealthTax.rate * 100;
  byId("adult-benefit").value = request.ubi.adultMonthlyBenefit;
  byId("child-benefit").value = request.ubi.childMonthlyBenefit;
  byId("funding-rule").value = request.ubi.fundingRule;
  byId("surplus-use").value = request.ubi.surplusUse ?? "debt-reduction";
  byId("benefit-indexation").value = request.ubi.benefitIndexation ?? "none";
  byId("service-effectiveness").value = request.ubi.serviceEffectiveness ?? "unscored";
  byId("direct-cash-share").value = request.ubi.directCashShare * 100;
  byId("administrative-share").value = request.ubi.administrativeShare * 100;
  byId("buyer-depth").value = request.market.buyerDepthRatio * 100;
  byId("price-impact").value = request.market.priceImpactCoefficient;
  byId("maximum-ltv").value = request.market.maximumCollateralLtv * 100;
  byId("housing-supply").value = request.market.housingSupplyElasticity;
  byId("economy-closure").value = request.economy?.closure ?? "closed";
  byId("foreign-buyer-share").value = (request.economy?.foreignBuyerShare ?? 0) * 100;
  byId("foreign-treasury-share").value = (request.economy?.foreignTreasuryDebtShare ?? 0) * 100;
  byId("capital-outflow-response").value = (request.economy?.capitalOutflowResponse ?? 0) * 100;
  byId("repatriation-fx-pass-through").value = (request.economy?.repatriationFxPassThrough ?? 0) * 100;
  byId("borrow-share").value = request.behavior.borrowShare * 100;
  byId("sell-share").value = request.behavior.sellShare * 100;
  byId("asset-return").value = request.behavior.annualAssetReturn * 100;
  byId("loan-rate").value = request.behavior.loanInterestRate * 100;
  byId("tax-loan-resolution").value = request.behavior.taxLoanResolution ?? "private-bank-loss";
  byId("monetization").value = request.behavior.deficitMonetizationShare * 100;
  byId("asset-hedge-share").value = request.behavior.assetHedgeShare * 100;
  byId("housing-hedge-share").value = request.behavior.housingHedgeShare * 100;
  byId("rent-pass-through").value = request.behavior.rentPassThrough * 100;
  byId("avoidance-elasticity").value = request.behavior.avoidanceElasticity * 100;
  byId("expatriation-share").value = request.behavior.expatriationShare * 100;
  byId("expatriation-residence-share").value = (request.behavior.expatriationResidenceShare ?? 1) * 100;
  byId("expatriation-tax-base-share").value = (request.behavior.expatriationTaxBaseShare ?? 1) * 100;
  byId("private-business-inclusion").value =
    request.behavior.privateBusinessInclusionRate * 100;
  byId("savings-response").value = request.behavior.savingsResponseElasticity;
  byId("demand-offset").value = request.behavior.demandGrowthOffset;
  const model = request.model ?? {};
  byId("wage-pass-through").value = (model.wagePassThrough ?? 0.55) * 100;
  byId("loan-amortization").value = (model.loanAmortizationRate ?? 0.1) * 100;
  byId("top-tax-incidence").value = (model.topTaxIncidenceShare ?? 0.8) * 100;
  byId("monetary-offset").value = (model.monetaryPolicyOffsetShare ?? 0.4) * 100;
  byId("asset-price-passthrough").value =
    (model.assetPriceInflationPassThrough ?? 0.5) * 100;
  byId("verdict-harmful-inflation").value =
    (model.verdictHarmfulInflation ?? 0.2) * 100;
  renderBrackets(request.wealthTax.brackets);
  syncTargetControls();
};

const formRequest = () => {
  const brackets = readBracketRows();
  return {
    schemaVersion: 1,
    seed: Number(byId("seed").value),
    sampleSize: Number(byId("sample-size").value),
    representedHouseholds,
    wealthTax: {
      targetMode: byId("target-mode").value,
      exemption: Number(byId("exemption").value) * 1_000_000,
      topShare: Number(byId("top-share").value) / 100,
      rate: Number(byId("tax-rate").value) / 100,
      ...(brackets.length > 0 ? { brackets } : {}),
    },
    ubi: {
      adultMonthlyBenefit: Number(byId("adult-benefit").value),
      childMonthlyBenefit: Number(byId("child-benefit").value),
      fundingRule: byId("funding-rule").value,
      surplusUse: byId("surplus-use").value,
      benefitIndexation: byId("benefit-indexation").value,
      serviceEffectiveness: byId("service-effectiveness").value,
      directCashShare: Number(byId("direct-cash-share").value) / 100,
      administrativeShare: Number(byId("administrative-share").value) / 100,
    },
    market: {
      buyerDepthRatio: Number(byId("buyer-depth").value) / 100,
      priceImpactCoefficient: Number(byId("price-impact").value),
      maximumCollateralLtv: Number(byId("maximum-ltv").value) / 100,
      housingSupplyElasticity: Number(byId("housing-supply").value),
    },
    economy: {
      closure: byId("economy-closure").value,
      foreignBuyerShare: Number(byId("foreign-buyer-share").value) / 100,
      foreignTreasuryDebtShare: Number(byId("foreign-treasury-share").value) / 100,
      capitalOutflowResponse: Number(byId("capital-outflow-response").value) / 100,
      repatriationFxPassThrough: Number(byId("repatriation-fx-pass-through").value) / 100,
    },
    behavior: {
      borrowShare: Number(byId("borrow-share").value) / 100,
      sellShare: Number(byId("sell-share").value) / 100,
      annualAssetReturn: Number(byId("asset-return").value) / 100,
      loanInterestRate: Number(byId("loan-rate").value) / 100,
      taxLoanResolution: byId("tax-loan-resolution").value,
      deficitMonetizationShare: Number(byId("monetization").value) / 100,
      assetHedgeShare: Number(byId("asset-hedge-share").value) / 100,
      housingHedgeShare: Number(byId("housing-hedge-share").value) / 100,
      rentPassThrough: Number(byId("rent-pass-through").value) / 100,
      avoidanceElasticity: Number(byId("avoidance-elasticity").value) / 100,
      expatriationShare: Number(byId("expatriation-share").value) / 100,
      expatriationResidenceShare: Number(byId("expatriation-residence-share").value) / 100,
      expatriationTaxBaseShare: Number(byId("expatriation-tax-base-share").value) / 100,
      privateBusinessInclusionRate:
        Number(byId("private-business-inclusion").value) / 100,
      savingsResponseElasticity: Number(byId("savings-response").value),
      demandGrowthOffset: Number(byId("demand-offset").value),
    },
    model: {
      wagePassThrough: Number(byId("wage-pass-through").value) / 100,
      loanAmortizationRate: Number(byId("loan-amortization").value) / 100,
      topTaxIncidenceShare: Number(byId("top-tax-incidence").value) / 100,
      monetaryPolicyOffsetShare: Number(byId("monetary-offset").value) / 100,
      assetPriceInflationPassThrough:
        Number(byId("asset-price-passthrough").value) / 100,
      verdictHarmfulInflation:
        Number(byId("verdict-harmful-inflation").value) / 100,
    },
  };
};

// --- Graduated bracket editor -------------------------------------------------
// Rows hold absolute thresholds in $M and rates in %. When at least one row is
// present the schedule replaces the flat rate, and its lowest threshold acts as
// the exemption (mirroring the server's normalizeWealthTax).
const makeBracketRow = (thresholdMillions = "", ratePercent = "") => {
  const row = document.createElement("div");
  row.className = "bracket-row";
  const threshold = document.createElement("input");
  threshold.type = "number";
  threshold.min = "0";
  threshold.step = "1";
  threshold.className = "bracket-threshold";
  threshold.placeholder = "Above $M";
  threshold.setAttribute("aria-label", "Bracket threshold in millions of dollars");
  threshold.value = thresholdMillions;
  const rate = document.createElement("input");
  rate.type = "number";
  rate.min = "0";
  rate.max = "20";
  rate.step = "0.1";
  rate.className = "bracket-rate";
  rate.placeholder = "Rate %";
  rate.setAttribute("aria-label", "Bracket annual rate in percent");
  rate.value = ratePercent;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "bracket-remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove this bracket");
  remove.title = "Remove bracket";
  remove.addEventListener("click", () => {
    row.remove();
    // A structural bracket change no longer matches a named preset.
    setActivePreset(null);
    syncBracketMode();
    updateScenarioUrl();
  });
  row.append(element("span", "$"), threshold, element("span", "M →"), rate, element("span", "%"), remove);
  return row;
};

const renderBrackets = (brackets) => {
  // Tolerate anything a stale or hand-edited link can decode to: a non-array,
  // or entries missing numeric threshold/rate. Drop the bad ones rather than
  // throwing during init (which would brick the page via the outer catch).
  const rows = Array.isArray(brackets)
    ? brackets.filter(
        (bracket) =>
          bracket &&
          typeof bracket === "object" &&
          Number.isFinite(bracket.threshold) &&
          Number.isFinite(bracket.rate),
      )
    : [];
  const container = byId("bracket-rows");
  container.replaceChildren(
    ...rows.map((bracket) =>
      makeBracketRow(bracket.threshold / 1_000_000, round4(bracket.rate * 100)),
    ),
  );
  setBracketError(null);
  syncBracketMode();
};

// A blank cell reads as "" — keep it NaN (not Number("")===0) so an incomplete
// row is rejected by validateBrackets rather than silently taxing from $0 at 0%.
const parseCell = (raw, scale) => {
  const trimmed = raw.trim();
  return trimmed === "" ? Number.NaN : Number(trimmed) * scale;
};

const readBracketRows = () =>
  [...byId("bracket-rows").querySelectorAll(".bracket-row")].map((row) => ({
    threshold: parseCell(row.querySelector(".bracket-threshold").value, 1_000_000),
    rate: parseCell(row.querySelector(".bracket-rate").value, 0.01),
  }));

const validateBrackets = (brackets) => {
  let previousThreshold = -Infinity;
  let previousRate = -Infinity;
  for (const bracket of brackets) {
    if (Number.isNaN(bracket.threshold) || Number.isNaN(bracket.rate)) {
      return "Every bracket row needs both a threshold and a rate.";
    }
    if (!Number.isFinite(bracket.threshold) || bracket.threshold < 0) {
      return "Bracket thresholds must be nonnegative numbers.";
    }
    if (!Number.isFinite(bracket.rate) || bracket.rate < 0 || bracket.rate > 0.2) {
      return "Bracket rates must be between 0% and 20%.";
    }
    if (bracket.threshold <= previousThreshold) {
      return "Bracket thresholds must strictly increase from top to bottom.";
    }
    if (bracket.rate < previousRate) {
      return "Bracket rates must not decrease as thresholds rise.";
    }
    previousThreshold = bracket.threshold;
    previousRate = bracket.rate;
  }
  return null;
};

const syncBracketMode = () => {
  const active = byId("bracket-rows").children.length > 0;
  // A schedule forces exemption targeting server-side (normalizeWealthTax), so
  // reflect that here instead of leaving a top-share value the engine ignores.
  if (active) byId("target-mode").value = "exemption";
  byId("tax-rate").disabled = active;
  byId("tax-rate-label").classList.toggle("is-disabled", active);
  byId("clear-brackets").disabled = !active;
  byId("bracket-mode-note").textContent = active
    ? "On — the flat rate, exemption, and targeting inputs come from the schedule; its lowest threshold is the exemption."
    : "Off — a single flat rate applies above the exemption.";
  syncTargetControls();
};

const setBracketError = (message) => {
  const target = byId("bracket-error");
  target.hidden = !message;
  target.textContent = message ?? "";
};

const round4 = (value) => Math.round(value * 10000) / 10000;

// Compact bracket serialization for the shared URL (param `br`): "50:2,1000:6"
// means $50M→2%, $1B→6%. Kept alongside the field-based scenario params so a
// graduated schedule round-trips through a shared link (scenario-params.js owns
// the `br` query key; this pair just converts between rows and the value string).
const encodeBracketsParam = () => {
  const rows = readBracketRows();
  if (rows.length === 0) return null;
  return rows
    .map((bracket) => `${bracket.threshold / 1_000_000}:${round4(bracket.rate * 100)}`)
    .join(",");
};

const bracketsFromParam = (raw) => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => {
      const [thresholdM, ratePct] = pair.split(":");
      return {
        threshold: Number(thresholdM) * 1_000_000,
        rate: Number(ratePct) / 100,
      };
    })
    .filter(
      (bracket) => Number.isFinite(bracket.threshold) && Number.isFinite(bracket.rate),
    );
};


// --- Deep-linkable scenario URLs -----------------------------------------
const readFieldValues = () =>
  Object.fromEntries(FIELD_SPECS.map((spec) => [spec.id, byId(spec.id).value]));

const captureDefaultFieldValues = () => {
  defaultFieldValues = readFieldValues();
};

// URL serialization compares against the fetched defaults, so it must stay a
// no-op until those defaults have been captured — otherwise a click during the
// initial fetch would treat every empty field as an override.
const defaultsReady = () => Object.keys(defaultFieldValues).length > 0;

const currentStrategy = () => byId("distribution-strategy").value;

const scenarioQuery = () =>
  encodeScenarioParams({
    values: readFieldValues(),
    defaults: defaultFieldValues,
    preset: activePreset,
    strategy: currentStrategy(),
    brackets: encodeBracketsParam(),
    pin: pinnedQuery(),
  });

// The pinned Scenario A serializes as a nested query string. A URL-restored pin
// round-trips verbatim (so a preset-based pin need not be re-resolved into
// explicit fields); a runtime pin re-encodes from its captured field snapshot.
// A pinned scenario that happens to equal the defaults (default strategy, no
// brackets) encodes to "" — which the outer `if (pin)` would drop, silently
// losing Scenario A from a shared link. Emit an inert marker so the URL still
// records that a pin is present; it decodes to zero field overrides (== defaults).
const PIN_DEFAULT_MARKER = "d=1";
const pinnedQuery = () => {
  if (pinnedFromUrl) return pinnedFromUrl;
  if (!pinnedFieldValues) return null;
  return (
    encodeScenarioParams({
      values: pinnedFieldValues,
      defaults: defaultFieldValues,
      strategy: pinnedStrategy ?? DEFAULT_STRATEGY,
      brackets: pinnedBrackets,
    }) || PIN_DEFAULT_MARKER
  );
};

const scenarioQueryWithView = () => {
  const params = new URLSearchParams(scenarioQuery());
  const current = new URLSearchParams(location.search);
  const step = current.get("step");
  if (step) {
    params.set("step", step);
  } else if (document.body.dataset.view === "dashboard" || current.get("view") === "dashboard") {
    params.set("view", "dashboard");
  }
  return params.toString();
};

const scenarioLink = () => {
  const query = scenarioQueryWithView();
  return `${location.origin}${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
};

// Reflect the live form state in the address bar without adding history
// entries, so a reload or copied URL reproduces the current scenario.
const updateScenarioUrl = () => {
  if (!defaultsReady()) return;
  const query = scenarioQueryWithView();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
};

// Apply any scenario encoded in the current URL to the form. Returns true when
// the URL carried scenario state, so callers know to recompute.
const hydrateFormFromUrl = () => {
  const decoded = decodeScenarioParams(location.search);
  // Stash any pinned Scenario A so restorePinnedFromUrl can compute it once the
  // engine is ready; it does not itself alter the live form fields.
  urlPinString = decoded.pin || null;
  const appliedPreset = Boolean(decoded.preset && PRESETS[decoded.preset]);
  if (appliedPreset) {
    setPresetFields(decoded.preset);
    setActivePreset(decoded.preset);
  }
  const fieldIds = Object.keys(decoded.fields);
  for (const id of fieldIds) byId(id).value = decoded.fields[id];
  // A custom graduated schedule (br) overrides any preset-supplied brackets,
  // exactly as explicit field params override preset fields.
  const bracketRows = bracketsFromParam(decoded.brackets);
  const appliedBrackets = bracketRows.length > 0;
  if (appliedBrackets) renderBrackets(bracketRows);
  // Explicit field or bracket overrides make the state no longer a pristine preset.
  const scenarioFieldIds = new Set(SCENARIO_FIELD_SPECS.map((spec) => spec.id));
  if (fieldIds.some((id) => scenarioFieldIds.has(id)) || appliedBrackets) setActivePreset(null);
  // A stale/unknown strategy would blank the <select> and later crash
  // renderDistribution (strategies[""]); ignore anything not in STRATEGIES.
  const appliedStrategy = Boolean(decoded.strategy && STRATEGIES.includes(decoded.strategy));
  if (appliedStrategy) byId("distribution-strategy").value = decoded.strategy;
  syncTargetControls();
  syncAllSliders();
  syncPresetButtons();
  // An unknown preset name or strategy applies nothing, so it must not force a recompute.
  return appliedPreset || fieldIds.length > 0 || appliedBrackets || appliedStrategy;
};

const copyText = async (text) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the execCommand path (blocked permission, insecure origin).
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand?.("copy") ?? false;
  area.remove();
  return ok;
};

const copyScenarioLink = async () => {
  if (!defaultsReady()) return;
  updateScenarioUrl();
  const ok = await copyText(scenarioLink());
  showToast(
    ok ? "Scenario link copied to clipboard." : "Copy blocked — the link is in your address bar.",
    !ok,
  );
};

let globalToastTimer = null;
let drawerFeedbackTimer = null;
const showToast = (message, isError = false) => {
  const drawer = byId("scenario-drawer");
  const drawerFeedback = byId("drawer-action-feedback");
  const container = byId("toast-container");
  clearTimeout(globalToastTimer);
  clearTimeout(drawerFeedbackTimer);
  container?.replaceChildren();
  if (drawerFeedback) {
    drawerFeedback.hidden = true;
    drawerFeedback.textContent = "";
    drawerFeedback.classList.remove("error");
  }
  if (drawer?.open && drawerFeedback) {
    drawerFeedback.textContent = message;
    drawerFeedback.classList.toggle("error", isError);
    drawerFeedback.hidden = false;
    drawerFeedbackTimer = setTimeout(() => {
      drawerFeedback.hidden = true;
      drawerFeedback.textContent = "";
      drawerFeedback.classList.remove("error");
    }, 3600);
    return;
  }
  if (!container) return;
  const toast = element("div", message);
  toast.className = `toast${isError ? " error" : ""}`;
  container.replaceChildren(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  globalToastTimer = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 3600);
};

// One engine worker channel: its own Worker thread, pending-request map, and
// failure state. The comparison and sensitivity sweeps get SEPARATE channels so
// a long ~80-run sensitivity sweep runs on its own thread and never queues
// behind — or delays — the interactive comparison the verdict depends on.
const createEngineChannel = () => {
  let worker = null;
  let failed = false;
  let requestId = 0;
  const pending = new Map();
  const ensure = () => {
    if (worker) return worker;
    const created = new Worker(versioned("./engine-worker.js"), { type: "module" });
    created.addEventListener("message", (event) => {
      const { id } = event.data ?? {};
      const entry = pending.get(id);
      if (!entry) return;
      if (event.data?.progress) {
        entry.onProgress?.(event.data.progress);
        return;
      }
      pending.delete(id);
      entry.respond(event.data);
    });
    created.addEventListener("error", () => {
      created.terminate();
      // A late error from an already-replaced worker must not drain the
      // replacement's pending requests.
      if (worker !== created) return;
      worker = null;
      failed = true;
      const waiting = [...pending.values()];
      pending.clear();
      waiting.forEach(({ respond }) => respond({ ok: false, workerFailed: true }));
    });
    worker = created;
    return created;
  };
  return {
    hasFailed: () => failed,
    warm: () => ensure(),
    run: (request, mode, options, onProgress) =>
      new Promise((resolve) => {
        requestId += 1;
        pending.set(requestId, { respond: resolve, onProgress });
        ensure().postMessage({ id: requestId, request, mode, options });
      }),
    cancelAll: () => {
      const active = worker;
      worker = null;
      failed = false;
      active?.terminate();
      const waiting = [...pending.values()];
      pending.clear();
      waiting.forEach(({ respond }) => respond({ ok: false, cancelled: true }));
    },
  };
};

const comparisonChannel = createEngineChannel();
const sensitivityChannel = createEngineChannel();
const uncertaintyChannel = createEngineChannel();

const runOnMainThread = async (request, mode = "compare", options, onProgress) => {
  if (mode === "uncertainty") {
    throw new Error(
      "Joint uncertainty requires a browser worker, which is unavailable in this browser.",
    );
  }
  const engine = await import(versioned("./engine/browser/engine.js"));
  return mode === "sensitivity"
    ? engine.analyzeSensitivity(request)
    : engine.compareScenarios(request);
};

const runLocalScenario = async (request, mode = "compare", options, onProgress) => {
  const channel = mode === "sensitivity"
    ? sensitivityChannel
    : mode === "uncertainty"
      ? uncertaintyChannel
      : comparisonChannel;
  const useWorker = typeof Worker !== "undefined" && !channel.hasFailed();
  let response = useWorker
    ? await channel.run(request, mode, options, onProgress)
    : await runOnMainThread(request, mode, options, onProgress);
  // Module workers can fail where Worker itself exists (older Firefox,
  // blocked worker loading) — retry the same request on the main thread.
  if (response?.workerFailed) {
    if (mode === "uncertainty") {
      // The failure may be a transient static-asset load error. Clear the
      // channel's failed state so the next explicit click constructs a fresh
      // worker instead of permanently falling into the unsupported main-thread
      // path until the page is reloaded.
      channel.cancelAll();
      throw new Error(
        "Joint uncertainty could not start its browser worker. Check static asset access and try again.",
      );
    }
    response = await runOnMainThread(request, mode, options, onProgress);
  }
  if (response?.cancelled) throw new DOMException("Uncertainty analysis cancelled.", "AbortError");
  if (!response?.ok) {
    throw new Error(response?.details?.join(" ") || response?.error || "Scenario failed.");
  }
  return response.result;
};

const runServerScenario = async (request) => {
  const response = await fetch("/api/scenarios/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.details?.join(" ") || payload.error || "Scenario failed.");
  }
  return payload;
};

const runServerSensitivity = async (request) => {
  const response = await fetch("/api/scenarios/sensitivity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.details?.join(" ") || payload.error || "Sensitivity run failed.");
  }
  return payload;
};

const runSensitivity = async (request) =>
  isStaticSnapshot
    ? runLocalScenario(request, "sensitivity")
    : runServerSensitivity(request);

let uncertaintyAbortController = null;

const runServerUncertainty = async (request, options, onProgress) => {
  uncertaintyAbortController = new AbortController();
  const response = await fetch("/api/scenarios/uncertainty", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({ request, options }),
    signal: uncertaintyAbortController.signal,
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.details?.join(" ") || payload.error || "Uncertainty run failed.");
  }
  if (!response.body) throw new Error("Uncertainty progress stream unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  const handleMessage = (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.error) throw new Error(message.error);
    if (message.progress) onProgress(message.progress);
    if (message.result) result = message.result;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleMessage(line);
      if (chunk.done) break;
    }
    handleMessage(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("Uncertainty run ended without a result.");
  return result;
};

const runUncertainty = (request, options, onProgress) =>
  isStaticSnapshot
    ? runLocalScenario(request, "uncertainty", options, onProgress)
    : runServerUncertainty(request, options, onProgress);

const cancelUncertainty = () => {
  uncertaintyAbortController?.abort();
  uncertaintyAbortController = null;
  uncertaintyChannel.cancelAll();
};

// The tornado sweep runs many scenarios (2N endpoints plus a bounded flip
// search), so it is computed on its own worker after the main verdict renders
// rather than blocking it. A monotonically increasing token guarantees a slower
// earlier run can never overwrite a newer scenario's chart.
let sensitivityToken = 0;
// Mark the panel stale the moment a new sweep begins: the previously rendered
// bars and tipping-point button describe the OLD scenario, so leaving them live
// would let a click apply a value computed for a scenario that no longer matches
// the form. The `is-stale` class disables pointer/keyboard interaction until the
// fresh results render (or an error clears it).
const setSensitivityStale = (stale) => {
  byId("sensitivity").classList.toggle("is-stale", stale);
  const apply = byId("sensitivity-flip-apply");
  if (apply) apply.disabled = stale;
};
// A sweep requested while the dashboard panel is hidden (the guided walkthrough)
// is stashed, not run, so repeated story-dial exploration doesn't burn ~80 runs
// per change on a panel nobody can see; enterDashboard flushes the latest one.
let pendingSensitivityRequest = null;
const refreshSensitivity = async (request) => {
  if (document.body.dataset.view !== "dashboard") {
    pendingSensitivityRequest = request;
    return;
  }
  const token = (sensitivityToken += 1);
  setSensitivityStale(true);
  byId("sensitivity-note").textContent = "Sweeping every assumption across its range…";
  try {
    const analysis = await runSensitivity(request);
    if (token !== sensitivityToken) return;
    renderSensitivity(analysis);
    setSensitivityStale(false);
  } catch (error) {
    if (token !== sensitivityToken) return;
    // Leave the panel stale on failure: the previously rendered bars/flip belong
    // to the old scenario, so they must not become interactive again just because
    // the new sweep errored (e.g. a 503 from the server queue).
    byId("sensitivity-note").textContent =
      error instanceof Error ? error.message : "Sensitivity analysis unavailable.";
  }
};

const flushPendingSensitivity = () => {
  if (!pendingSensitivityRequest) return;
  const request = pendingSensitivityRequest;
  pendingSensitivityRequest = null;
  void refreshSensitivity(request);
};

// `auto` marks a slider-driven rerun: keep the button enabled (so keyboard users
// never lose it mid-drag) and let the coordinator's subtle "recalculating…"
// indicator carry the feedback instead of the button's busy label.
const runScenario = async ({ auto = false } = {}) => {
  const request = formRequest();
  if (request.wealthTax.brackets) {
    const bracketError = validateBrackets(request.wealthTax.brackets);
    if (bracketError) {
      setBracketError(bracketError);
      setFormStatus(bracketError, true);
      return false;
    }
  }
  setBracketError(null);
  invalidateUncertainty();
  const button = byId("run-button");
  if (!auto) {
    button.disabled = true;
    button.textContent = "Running the model…";
    setFormStatus("Running the U.S. distribution and ten-year projection…");
  }
  try {
    const payload = isStaticSnapshot
      ? await runLocalScenario(request)
      : await runServerScenario(request);
    latestResult = payload;
    render(payload);
    setScenarioSummary(scenarioSummary(request, payload));
    updateScenarioUrl();
    setFormStatus(`Updated from ${integer.format(payload.population.sampledHouseholds)} weighted household agents${isStaticSnapshot ? ", computed in your browser" : ""}.`);
    // Rank the assumptions behind this verdict without blocking the main render.
    void refreshSensitivity(request);
    return true;
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : "Scenario failed.", true);
    return false;
  } finally {
    if (!auto) {
      button.disabled = false;
      button.textContent = "Recalculate now";
    }
  }
};

// --- Debounced, coalescing auto-run --------------------------------------
// A single in-flight run at a time; the newest field values are picked up when
// it settles, so rapid slider drags can never pile up requests (last-wins).
const dashState = { running: false, pending: false, promise: null };

const setRecalculating = (on, succeeded = true) => {
  const indicator = byId("recalc-indicator");
  if (indicator) indicator.hidden = !on;
  byId("scenario-form")?.classList.toggle("is-recalculating", on);
  const trigger = byId("scenario-drawer-trigger");
  const triggerStatus = byId("scenario-drawer-trigger-status");
  const liveStatus = byId("scenario-recalc-status");
  if (trigger) {
    trigger.classList.toggle("is-recalculating", on);
    trigger.classList.toggle("has-recalc-error", !on && !succeeded);
    trigger.setAttribute("aria-busy", String(on));
  }
  if (triggerStatus) {
    triggerStatus.textContent = on ? "Recalculating…" : "Update failed — open to resolve";
    triggerStatus.hidden = !on && succeeded;
  }
  if (liveStatus) {
    liveStatus.textContent = on
      ? "Scenario results are recalculating."
      : succeeded
        ? "Scenario results updated."
        : "Scenario update failed. Open the scenario editor to resolve the error.";
  }
};

const dashboardRerun = () => {
  if (dashState.running) {
    dashState.pending = true;
    return dashState.promise;
  }
  dashState.promise = (async () => {
    dashState.running = true;
    setRecalculating(true);
    let ok = true;
    do {
      dashState.pending = false;
      ok = await runScenario({ auto: true });
    } while (dashState.pending);
    dashState.running = false;
    setRecalculating(false, ok);
    return ok;
  })();
  return dashState.promise;
};

// 300ms per the acceptance criteria: fast enough to feel live, slow enough to
// coalesce a drag into one run.
let autoRunTimer = null;
const scheduleAutoRun = () => {
  clearTimeout(autoRunTimer);
  autoRunTimer = setTimeout(() => {
    autoRunTimer = null;
    void dashboardRerun();
  }, 300);
};

// --- Persistent scenario drawer -----------------------------------------
// Keep the dashboard frozen at the user's current reading position while the
// native dialog owns focus. Drawer state is deliberately presentation-only:
// it never enters scenario URLs or the model request.
const drawerState = {
  scrollY: 0,
  returnFocus: null,
  restoreFocus: true,
  highlightTimer: null,
};
const drawerScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ? "auto"
  : "smooth";

const unlockDashboardScroll = () => {
  if (!document.body.classList.contains("scenario-drawer-open")) return;
  document.body.classList.remove("scenario-drawer-open");
  document.body.style.top = "";
  // The site globally uses smooth scrolling. Override it for this one restore
  // so closing the drawer cannot visibly glide away from the result the user
  // was reading or report an intermediate scroll position to focus handling.
  const previousScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = "auto";
  window.scrollTo(0, drawerState.scrollY);
  document.documentElement.style.scrollBehavior = previousScrollBehavior;
};

const finishDrawerClose = () => {
  const trigger = byId("scenario-drawer-trigger");
  const returnFocus = drawerState.returnFocus;
  const drawerFeedback = byId("drawer-action-feedback");
  trigger?.setAttribute("aria-expanded", "false");
  unlockDashboardScroll();
  if (drawerFeedback) {
    clearTimeout(drawerFeedbackTimer);
    drawerFeedback.hidden = true;
    drawerFeedback.textContent = "";
    drawerFeedback.classList.remove("error");
  }
  if (drawerState.restoreFocus) {
    const canReceiveFocus =
      returnFocus?.isConnected &&
      returnFocus !== document.body &&
      typeof returnFocus.focus === "function" &&
      returnFocus.tabIndex >= 0;
    const focusTarget = canReceiveFocus ? returnFocus : trigger;
    requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
  }
  drawerState.returnFocus = null;
  drawerState.restoreFocus = true;
};

const closeScenarioDrawer = ({ restoreFocus = true } = {}) => {
  const drawer = byId("scenario-drawer");
  drawerState.restoreFocus = restoreFocus;
  if (drawer?.open) drawer.close();
  else finishDrawerClose();
};

const focusDrawerField = (focusId) => {
  const field = byId(focusId);
  if (!field) return;
  const section = field.closest("details");
  if (section instanceof HTMLDetailsElement) section.open = true;
  clearTimeout(drawerState.highlightTimer);
  requestAnimationFrame(() => {
    field.focus({ preventScroll: true });
    field.scrollIntoView({ behavior: drawerScrollBehavior, block: "center" });
    field.classList.add("scenario-focus-target");
    drawerState.highlightTimer = setTimeout(
      () => field.classList.remove("scenario-focus-target"),
      1800,
    );
  });
};

const openScenarioDrawer = ({ focusId = null, trigger = null } = {}) => {
  if (document.body.dataset.view === "story") return;
  const drawer = byId("scenario-drawer");
  if (!drawer) return;
  if (!drawer.open) {
    drawerState.scrollY = window.scrollY;
    drawerState.returnFocus = trigger ?? document.activeElement;
    drawerState.restoreFocus = true;
    document.body.style.top = `-${drawerState.scrollY}px`;
    document.body.classList.add("scenario-drawer-open");
    drawer.showModal();
    byId("scenario-drawer-trigger")?.setAttribute("aria-expanded", "true");
  }
  if (focusId) focusDrawerField(focusId);
  else requestAnimationFrame(() => byId("scenario-drawer-close")?.focus({ preventScroll: true }));
};

const finishScenarioEdits = async () => {
  const button = byId("scenario-drawer-done");
  clearTimeout(autoRunTimer);
  autoRunTimer = null;
  button.disabled = true;
  button.textContent = "Updating results…";
  try {
    // Always validate/run once, even when an incomplete bracket row cancelled
    // the normal debounce. Invalid edits stay visible in the open drawer rather
    // than closing over stale results.
    const ok = await dashboardRerun();
    if (ok) closeScenarioDrawer();
  } finally {
    button.disabled = false;
    button.textContent = "Done — view results";
  }
};

// Compute one scenario without disturbing the live form: snapshot the fields and
// bracket schedule, apply the requested (preset + field + bracket) state, run,
// then restore. Used to reconstruct a URL-restored pinned Scenario A at load.
const computeScenario = async ({ preset, fields, brackets, strategy: _strategy } = {}) => {
  const savedFields = readFieldValues();
  const savedBrackets = encodeBracketsParam();
  try {
    // Reset to the fetched defaults first: the pin encodes only its non-default
    // overrides, so reconstructing it on top of the live form would let the live
    // scenario's edits leak into Scenario A (every field the pin didn't set).
    applyFieldValues(defaultFieldValues);
    renderBrackets([]);
    if (preset && PRESETS[preset]) setPresetFields(preset);
    if (fields) {
      for (const id of Object.keys(fields)) {
        if (byId(id)) byId(id).value = fields[id];
      }
    }
    const bracketRows = bracketsFromParam(brackets);
    if (bracketRows.length > 0) renderBrackets(bracketRows);
    syncTargetControls();
    const request = formRequest();
    if (request.wealthTax.brackets) {
      if (validateBrackets(request.wealthTax.brackets)) return null;
    }
    return isStaticSnapshot
      ? await runLocalScenario(request)
      : await runServerScenario(request);
  } catch {
    return null;
  } finally {
    applyFieldValues(savedFields);
    renderBrackets(bracketsFromParam(savedBrackets));
    syncTargetControls();
    syncAllSliders();
  }
};

const restorePinnedFromUrl = async () => {
  if (!urlPinString) return;
  const decoded = decodeScenarioParams(`?${urlPinString}`);
  const result = await computeScenario({
    preset: decoded.preset,
    fields: decoded.fields,
    brackets: decoded.brackets,
    strategy: decoded.strategy,
  });
  if (!result) {
    urlPinString = null;
    return;
  }
  pinnedResult = result;
  pinnedFromUrl = urlPinString;
  pinnedStrategy = decoded.strategy ?? DEFAULT_STRATEGY;
  pinnedBrackets = decoded.brackets ?? null;
  updatePinUi();
};

// --- Range sliders paired with the numeric fields -------------------------
// Each bounded number input gains a redundant range slider. The number input
// stays the labeled, keyboard-accessible control; the slider is an aria-hidden
// pointer affordance that mirrors it two-way. Fields whose HTML max is
// impractically large (or absent) opt in with data-slider-min/max.
const fieldSliders = new Map();

// Map a field's string value onto its slider, guarding against `Number(x) || min`
// eating a legitimate 0 (e.g. asset-return has min -50, so 0 || -50 would park
// the slider hard-left at -50%). Only genuinely non-numeric input falls back.
const clampFieldValue = (raw, min, max) => {
  const value = Number(raw);
  return clamp(Number.isFinite(value) ? value : min, min, max);
};

const attachSlider = (input) => {
  if (fieldSliders.has(input.id)) return;
  const min = Number(input.dataset.sliderMin ?? input.getAttribute("min") ?? 0);
  const max = Number(input.dataset.sliderMax ?? input.getAttribute("max"));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
  const step = input.dataset.sliderStep ?? input.getAttribute("step") ?? "any";
  const range = document.createElement("input");
  range.type = "range";
  range.className = "field-slider";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(clampFieldValue(input.value, min, max));
  range.tabIndex = -1;
  range.setAttribute("aria-hidden", "true");
  range.dataset.for = input.id;
  input.insertAdjacentElement("afterend", range);
  fieldSliders.set(input.id, range);
  // Slider → number, plus the joint borrow/sell clamp. The bubbling form
  // listener drives activePreset reset + debounced auto-run.
  range.addEventListener("input", () => {
    input.value = range.value;
    applyJointConstraint(input);
  });
};

const initSliders = () => {
  const form = byId("scenario-form");
  if (!form) return;
  const inputs = [...form.querySelectorAll('input[type="number"]')].filter(
    (input) =>
      (input.getAttribute("min") !== null && input.getAttribute("max") !== null) ||
      input.dataset.sliderMax !== undefined,
  );
  inputs.forEach(attachSlider);
};

const syncSlider = (id) => {
  const range = fieldSliders.get(id);
  const input = byId(id);
  if (!range || !input) return;
  const min = Number(range.min);
  const max = Number(range.max);
  // When the field holds a value the slider can't represent (e.g. the Billionaire
  // preset's $1B exemption on a slider capped at $100M), disable the slider rather
  // than parking it at an endpoint — a stray drag would otherwise yank the field
  // from $1B down to $100M. It re-enables once the value returns to range.
  const raw = Number(input.value);
  range.disabled = Number.isFinite(raw) && (raw < min || raw > max);
  range.value = String(clampFieldValue(input.value, min, max));
};

const syncAllSliders = () => {
  for (const id of fieldSliders.keys()) syncSlider(id);
};

const applyFieldValues = (values) => {
  for (const id of Object.keys(values)) {
    if (byId(id)) byId(id).value = values[id];
  }
  syncAllSliders();
};

// The server already rejects borrow + sell > 100; mirror that client-side so the
// paired sliders can never be dragged into an invalid combined split — the field
// the user is not touching gives way.
const applyJointConstraint = (target) => {
  if (!target || (target.id !== "borrow-share" && target.id !== "sell-share")) return;
  const borrow = Number(byId("borrow-share").value) || 0;
  const sell = Number(byId("sell-share").value) || 0;
  if (borrow + sell <= 100) return;
  const otherId = target.id === "borrow-share" ? "sell-share" : "borrow-share";
  const keep = target.id === "borrow-share" ? borrow : sell;
  byId(otherId).value = String(Math.max(0, 100 - keep));
  syncSlider(otherId);
};

// --- Pin / A-B compare ----------------------------------------------------
const updatePinUi = () => {
  const pinned = Boolean(pinnedResult);
  const pinButton = byId("pin-button");
  const clearButton = byId("clear-pin-button");
  if (pinButton) {
    pinButton.setAttribute("aria-pressed", String(pinned));
    pinButton.textContent = pinned ? "Update pin (A)" : "Pin this scenario (A)";
  }
  if (clearButton) clearButton.hidden = !pinned;
};

const pinCurrentScenario = async () => {
  // Flush any debounced/in-flight run first so latestResult reflects exactly the
  // fields we're about to capture — otherwise a pin mid-debounce would freeze a
  // stale result next to freshly-edited fields, and the URL would serialize a
  // Scenario A that differs from the one shown.
  clearTimeout(autoRunTimer);
  const ok = await dashboardRerun();
  if (!ok || !latestResult) {
    showToast("Couldn't pin — resolve the current scenario first.", true);
    return;
  }
  pinnedResult = latestResult;
  pinnedFieldValues = readFieldValues();
  pinnedBrackets = encodeBracketsParam();
  pinnedStrategy = currentStrategy();
  pinnedFromUrl = null;
  updatePinUi();
  render(latestResult);
  updateScenarioUrl();
  showToast("Scenario A pinned — ghosted lines now trace it on every chart.");
};

const clearPin = () => {
  pinnedResult = null;
  pinnedFieldValues = null;
  pinnedBrackets = null;
  pinnedStrategy = null;
  pinnedFromUrl = null;
  updatePinUi();
  if (latestResult) render(latestResult);
  updateScenarioUrl();
  showToast("Scenario A cleared.");
};

const PIN_METRICS = [
  { label: "Tax revenue (year one)", get: (r) => r.projection.annualFlows.taxCollected, kind: "money" },
  { label: "Taxpayers reached (year ten)", get: (r) => r.projection.years.at(-1)?.taxpayerHouseholds ?? 0, kind: "number" },
  { label: "Effective tax rate (year ten)", get: (r) => r.projection.years.at(-1)?.effectiveTaxRate ?? 0, kind: "pct" },
  { label: "Cash delivered (year one)", get: (r) => r.projection.annualFlows.ubiReceived, kind: "money" },
  { label: "Public services (year one)", get: (r) => r.projection.annualFlows.publicServicesSpending, kind: "money" },
  { label: "Administration (year one)", get: (r) => r.projection.annualFlows.administrativeCost, kind: "money" },
  { label: "Bottom 50% buying power", get: (r) => r.projection.summary.bottom50PurchasingPowerChange, kind: "pct" },
  { label: "Gap to beneficial buying-power guardrail", get: (r) => r.projection.verdict.margins.beneficialPurchasingPower, kind: "points" },
  { label: "Top 1% real wealth", get: (r) => r.projection.summary.top1RealWealthChange, kind: "pct" },
  { label: "GDP per worker", get: (r) => r.projection.summary.gdpChange, kind: "pct" },
  { label: "Peak annual inflation", get: (r) => r.projection.summary.peakAnnualInflation, kind: "rate" },
  { label: "M2 money stock", get: (r) => r.projection.summary.cumulativeM2Change, kind: "pct" },
  { label: "Private tax debt (year ten)", get: (r) => r.projection.summary.privateTaxDebt, kind: "money" },
  // housingPriceChange lives on the theory-test summary, not the top-level one.
  { label: "Housing price", get: (r) => r.projection.theoryTest.summary.housingPriceChange, kind: "pct" },
  { label: "Wealth Gini (after)", get: (r) => r.strategies["cash-first"].distribution.wealthGiniAfter, kind: "gini" },
];

const fmtMetric = (kind, value) =>
  kind === "money" ? compactMoney.format(value) : kind === "number" ? integer.format(value) : kind === "gini" ? value.toFixed(3) : kind === "rate" ? formatRate(value) : kind === "points" ? signedPoints(value) : signedPercent(value);
const fmtDelta = (kind, delta) =>
  kind === "money" ? compactMoney.format(delta) : kind === "number" ? integer.format(delta) : kind === "gini" ? `${delta > 0 ? "+" : ""}${delta.toFixed(3)}` : signedPoints(delta);

const renderPinComparison = () => {
  const wrap = byId("pin-comparison");
  if (!wrap) return;
  if (!pinnedResult || !latestResult) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const pinnedVerdict = pinnedResult.projection.verdict;
  const liveVerdict = latestResult.projection.verdict;
  byId("pin-comparison-note").textContent =
    pinnedVerdict.rating === liveVerdict.rating
      ? `Both scenarios are rated ${liveVerdict.rating}, but their continuous outcomes and guardrail distances below can still differ materially.`
      : `Scenario A is rated ${pinnedVerdict.rating}; the live scenario is rated ${liveVerdict.rating}. The table decomposes the drivers of that change.`;
  byId("pin-comparison-body").replaceChildren(
    ...PIN_METRICS.map((metric) => {
      const liveValue = metric.get(latestResult);
      const pinnedValue = metric.get(pinnedResult);
      const delta = liveValue - pinnedValue;
      const row = document.createElement("tr");
      row.append(element("td", metric.label));
      row.append(element("td", fmtMetric(metric.kind, pinnedValue)));
      row.append(element("td", fmtMetric(metric.kind, liveValue)));
      const deltaCell = element("td", fmtDelta(metric.kind, delta));
      if (delta > 1e-9) deltaCell.classList.add("delta-up");
      else if (delta < -1e-9) deltaCell.classList.add("delta-down");
      row.append(deltaCell);
      return row;
    }),
  );
};

const render = (result) => {
  renderVerdict(result.projection);
  renderCharts(result.projection);
  renderWinners(result.projection);
  renderFlow(result.projection);
  renderTheory(result.projection.theoryTest, result.projection);
  renderOpenEconomy(result.projection.openEconomy);
  renderStress(result.projection.stressTest);
  renderReasons(result.projection);
  renderDetails(result);
  renderPersona(result);
  renderPinComparison();
  updatePresetBenchmark(result);
};

// Renders the audited definition of a named real-world proposal into the drawer:
// filing unit, tax schedule, spending linkage, enforcement, the plan components
// the model does not yet capture (with the direction each biases revenue), and a
// table of published revenue benchmarks. Hidden for generic scenarios and the
// baseline, which carry no proposal metadata. Function declaration (not a const)
// so it is safe to call from setActivePreset regardless of evaluation order.
function renderPresetDefinition(name) {
  const panel = byId("preset-definition");
  if (!panel) return;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const diagnostic = DIAGNOSTIC_PRESETS?.[name];
  if (diagnostic) {
    panel.hidden = false;
    panel.replaceChildren(
      el("h4", "preset-def-title", diagnostic.label),
      el("span", "preset-badge preset-badge-amb", diagnostic.nonForecast ? "Diagnostic corner · not a forecast" : "Diagnostic mechanism"),
      el("p", "preset-def-line", diagnostic.mechanism),
      el("p", "preset-def-line preset-def-muted", "This preset is immutable and shareable through its scenario URL. It exists to expose one modeled mechanism at a time, not to estimate likelihood."),
    );
    return;
  }
  const def = POLICY_PRESETS?.[name];
  if (!def || def.kind === "baseline") {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const section = (heading, ...children) => {
    const wrap = el("div", "preset-def-section");
    wrap.append(el("h5", "preset-def-heading", heading));
    wrap.append(...children);
    return wrap;
  };

  const nodes = [el("h4", "preset-def-title", def.label)];

  nodes.push(
    section(
      "Filing unit",
      el("p", "preset-def-line", `${def.filingUnit} — ${def.filingNote}`),
    ),
  );
  nodes.push(
    section("Tax schedule", el("p", "preset-def-line", def.scheduleNote)),
  );

  if (def.assetInclusions.length > 0) {
    const list = el("ul", "preset-unmodeled");
    for (const asset of def.assetInclusions) {
      const li = el("li", "preset-unmodeled-item");
      li.append(
        el("strong", null, asset.class),
        el("span", "preset-unmodeled-note", asset.note ? ` — ${asset.note}` : ""),
      );
      list.append(li);
    }
    nodes.push(section("Modeled tax base", list));
  }

  const spending = el("div", "preset-def-section");
  spending.append(el("span", "preset-badge preset-badge-scope", "Tax side only"));
  spending.append(el("p", "preset-def-line", def.spending.note));
  nodes.push(spending);

  if (def.enforcement) {
    nodes.push(
      section(
        "Compliance & enforcement",
        el("p", "preset-def-line", def.enforcement.planned),
        el("p", "preset-def-line preset-def-muted", def.enforcement.modeled),
      ),
    );
  }

  if (def.unmodeled.length > 0) {
    const list = el("ul", "preset-unmodeled");
    for (const item of def.unmodeled) {
      const li = el("li", "preset-unmodeled-item");
      const badgeKind =
        item.direction === "understates-revenue"
          ? "preset-badge-low"
          : item.direction === "overstates-revenue"
            ? "preset-badge-high"
            : "preset-badge-amb";
      const badge = el("span", `preset-badge ${badgeKind}`);
      badge.title = BIAS_DIRECTION[item.direction] ?? item.direction;
      badge.textContent = item.component;
      li.append(badge, el("span", "preset-unmodeled-note", ` — ${item.note}`));
      list.append(li);
    }
    nodes.push(
      section(
        "Not yet modeled (definitional gaps)",
        el(
          "p",
          "preset-def-line preset-def-muted",
          "The engine's base does not capture these plan components; each label shows the direction it biases modeled revenue.",
        ),
        list,
      ),
    );
  }

  if (def.benchmarks.length > 0) {
    const table = el("table", "preset-benchmarks");
    const thead = el("thead");
    const headRow = el("tr");
    for (const label of ["Benchmark", "Published 10-yr", "Model 10-yr", "Deviation"]) {
      headRow.append(el("th", null, label));
    }
    thead.append(headRow);
    const tbody = el("tbody");
    for (const bench of def.benchmarks) {
      const row = el("tr");
      row.dataset.basis = bench.basis;
      const nameCell = el("td");
      const link = bench.url ? el("a", null, bench.label) : el("span", null, bench.label);
      if (bench.url) {
        link.href = bench.url;
        link.target = "_blank";
        link.rel = "noreferrer";
      }
      nameCell.append(link);
      nameCell.append(
        el("small", "preset-benchmark-meta", ` ${REVENUE_BASIS[bench.basis] ?? bench.basis} · ${bench.vintage}`),
      );
      row.append(nameCell);
      row.append(el("td", "preset-benchmark-published", compactMoney.format(bench.tenYearRevenue)));
      row.append(el("td", "preset-benchmark-model", "—"));
      row.append(el("td", "preset-benchmark-deviation", "—"));
      tbody.append(row);
    }
    table.append(thead, tbody);
    nodes.push(
      section(
        "Model vs. published revenue",
        el(
          "p",
          "preset-def-line preset-def-muted",
          "Benchmarks are for validation, not tuning targets. The model column fills after the scenario runs.",
        ),
        table,
      ),
    );
  }

  if (def.citations.length > 0) {
    const sources = el("div", "preset-def-section preset-def-sources");
    sources.append(el("h5", "preset-def-heading", "Sources"));
    def.citations.forEach((cite, index) => {
      if (index > 0) sources.append(document.createTextNode(" · "));
      const link = el("a", null, cite.label);
      link.href = cite.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      sources.append(link);
    });
    nodes.push(sources);
  }

  panel.replaceChildren(...nodes);
  panel.hidden = false;
  // The model column intentionally stays "—" until the run for THIS preset
  // completes (render() -> updatePresetBenchmark). Filling it from latestResult
  // here would show the previously-selected preset's revenue against the new
  // preset's benchmarks until the debounced rerun lands.
}

// Fills the benchmark table's model column with the just-computed revenue when a
// named tax-schedule proposal is active. Year-one revenue is the response-adjusted
// assessment; ten-year revenue is summed from the fiscal projection.
function updatePresetBenchmark(result) {
  const def = POLICY_PRESETS?.[activePreset];
  const panel = byId("preset-definition");
  if (!panel || panel.hidden || !def || def.kind === "baseline") return;
  const tenYear = modelTenYearRevenue(result.projection);
  for (const row of panel.querySelectorAll("tbody tr")) {
    const bench = def.benchmarks.find((b) => b.basis === row.dataset.basis);
    if (!bench) continue;
    const modelCell = row.querySelector(".preset-benchmark-model");
    const deviationCell = row.querySelector(".preset-benchmark-deviation");
    if (modelCell) modelCell.textContent = compactMoney.format(tenYear);
    const deviation = benchmarkDeviation(tenYear, bench.tenYearRevenue);
    if (deviationCell) {
      deviationCell.textContent =
        deviation === null ? "—" : `${deviation > 0 ? "+" : ""}${(deviation * 100).toFixed(0)}%`;
    }
  }
}

const RATING_LABEL = {
  "better-off": "Better off",
  "worse-off": "Worse off",
  mixed: "About even",
};

const renderWinners = (projection) => {
  byId("winners-grid").replaceChildren(
    ...projection.groupOutcomes.map((group) => winnerCard(group)),
  );
};

const groupChange = (group) =>
  group.primaryMetric === "real-wealth"
    ? group.realWealthChange
    : group.purchasingPowerChange;

const groupMetricLabel = (group) =>
  group.primaryMetric === "real-wealth" ? "real net worth" : "buying power";

const winnerCard = (group) => {
  const change = groupChange(group) ?? 0;
  const card = document.createElement("article");
  card.className = "winner-card";
  card.dataset.rating = group.rating;
  const head = document.createElement("div");
  head.className = "winner-head";
  head.append(element("h3", group.label));
  const badge = element("span", RATING_LABEL[group.rating] ?? group.rating);
  badge.className = "winner-badge";
  head.append(badge);
  card.append(head);
  card.append(divergingBar(change));
  const value = element("strong", `${signedPercent(change)} ${groupMetricLabel(group)}`);
  value.className = "winner-value";
  card.append(value);
  const drivers = document.createElement("p");
  drivers.className = "winner-drivers";
  const taxText = group.annualTaxPaid > 0
    ? `Pays ~${compactMoney.format(group.annualTaxPaid)}/yr tax`
    : "Pays ~$0 tax";
  drivers.textContent = `${taxText} · gets ~${money.format(group.annualUbiReceived)}/yr UBI · rent ${signedPercent(group.rentPremiumChange)}`;
  card.append(drivers);
  return card;
};

const divergingBar = (change) => {
  const wrap = document.createElement("div");
  wrap.className = "diverging-bar";
  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = `bar-fill ${change >= 0 ? "positive" : "negative"}`;
  const magnitude = Math.min(1, Math.abs(change) / 0.25);
  fill.style.width = `${(magnitude * 50).toFixed(1)}%`;
  if (change >= 0) fill.style.left = "50%";
  else fill.style.right = "50%";
  track.append(fill);
  wrap.append(track);
  return wrap;
};

const personaGroupId = (netWorth, tenure) => {
  const groups = baseline?.wealthGroups ?? [];
  if (groups.length === 0) return tenure === "owner" ? "bottom-50-owner" : "bottom-50-renter";
  const averages = groups.map((group) => group.netWorth / Math.max(1, group.households));
  let index = 0;
  for (let position = 0; position < averages.length - 1; position += 1) {
    const cutoff = Math.sqrt(Math.max(1, averages[position]) * Math.max(1, averages[position + 1]));
    if (netWorth >= cutoff) index = position + 1;
  }
  const idByBand = ["bottom-50", "middle-40", "top-10", "top-1", "top-0.1"];
  const id = idByBand[Math.min(index, idByBand.length - 1)];
  if (id === "bottom-50") return tenure === "owner" ? "bottom-50-owner" : "bottom-50-renter";
  return id;
};

const renderPersona = (result) => {
  if (!result) return;
  const netWorth = Number(byId("persona-net-worth").value) || 0;
  const adults = Math.max(1, Number(byId("persona-adults").value) || 1);
  const children = Math.max(0, Number(byId("persona-children").value) || 0);
  const tenure = byId("persona-tenure").value === "owner" ? "owner" : "renter";
  persistPersona(netWorth, adults, children, tenure);
  const outcomes = result.projection.groupOutcomes;
  const targetId = personaGroupId(netWorth, tenure);
  const group = outcomes.find((candidate) => candidate.id === targetId) ?? outcomes[0];
  if (!group) return;
  const request = result.assumptions;
  const grossUbi =
    12 * (adults * request.ubi.adultMonthlyBenefit + children * request.ubi.childMonthlyBenefit);
  // Scale the household's gross benefit by the engine's cash-delivery ratio
  // (funding scale, administration, leakage, cash-vs-services split) so the
  // persona shows delivered cash, matching the per-cohort cards, not the gross
  // schedule.
  const requestedUbi = result.strategies?.["cash-first"]?.fiscal?.requestedUbi ?? 0;
  const annualCashBenefit = calculatePersonaCashBenefit({
    grossScheduledBenefit: grossUbi,
    aggregateRequestedBenefit: requestedUbi,
    aggregateCashDelivered: result.projection.annualFlows.ubiReceived,
    aggregateRebate: result.projection.annualFlows.rebate ?? 0,
    representedHouseholds: result.population.representedHouseholds,
  });
  const annualTax = calculatePersonaWealthTax({
    netWorth,
    brackets:
      result.wealthTaxAssessment?.brackets ?? personaScheduleFromRequest(request.wealthTax),
  });
  const change = groupChange(group) ?? 0;
  const rentNote = Math.abs(group.rentPremiumChange) >= 0.0005
    ? `, with modeled rent about ${signedPercent(group.rentPremiumChange)}`
    : "";
  const node = byId("persona-result");
  node.dataset.rating = group.rating;
  node.replaceChildren();
  node.append(element("strong", `Nearest modeled cohort: ${group.label}.`));
  node.append(
    element(
      "span",
      `You'd pay about ${money.format(annualTax)} in wealth tax and receive about ${money.format(annualCashBenefit)} per year in cash benefits. Over ten years you'd end with about ${signedPercent(change)} ${groupMetricLabel(group)} versus the no-policy path${rentNote}.`,
    ),
  );
  const note = document.createElement("small");
  note.append(document.createTextNode(
    "The tax figure is a net-worth-only estimate using the model's active schedule; it cannot infer your asset mix, deductions, or filing status. Your outcome maps to the nearest synthetic cohort — a conditional scenario, not personal advice. ",
  ));
  const link = document.createElement("a");
  link.href = "#caveats";
  link.className = "caveat-link";
  link.textContent = "Model limits.";
  note.append(link);
  node.append(note);
};

const PERSONA_PARAMS = {
  netWorth: "persona_nw",
  adults: "persona_adults",
  children: "persona_children",
  tenure: "persona_tenure",
};

const persistPersona = (netWorth, adults, children, tenure) => {
  const params = new URLSearchParams(window.location.search);
  params.set(PERSONA_PARAMS.netWorth, String(netWorth));
  params.set(PERSONA_PARAMS.adults, String(adults));
  params.set(PERSONA_PARAMS.children, String(children));
  params.set(PERSONA_PARAMS.tenure, tenure);
  history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
};

const restorePersona = () => {
  const params = new URLSearchParams(window.location.search);
  const set = (key, id) => {
    const value = params.get(PERSONA_PARAMS[key]);
    if (value !== null && value !== "") byId(id).value = value;
  };
  set("netWorth", "persona-net-worth");
  set("adults", "persona-adults");
  set("children", "persona-children");
  set("tenure", "persona-tenure");
};

const renderVerdict = (projection) => {
  const { verdict, summary } = projection;
  document.body.dataset.verdict = verdict.rating;
  byId("verdict-badge").textContent = `${verdict.scope === "cash-only" ? "cash-only · " : "cash + service estimate · "}${verdict.rating}`;
  byId("verdict-headline").textContent = verdict.headline;
  byId("verdict-explanation").textContent = verdict.explanation;
  byId("metric-buying-power").textContent = signedPercent(summary.bottom50PurchasingPowerChange);
  byId("metric-inflation").textContent = formatRate(summary.peakAnnualInflation);
  byId("metric-inflation-context").textContent = `${capitalize(regimeFor(summary.peakAnnualInflation))} · baseline ${formatRate(baseline?.baselineInflation ?? 0.026)}`;
  byId("metric-m2").textContent = signedPercent(summary.cumulativeM2Change);
};

const powerChartOptions = (projection) => {
  const years = projection.years;
  return {
    description: `Bottom-half purchasing power ends at ${years.at(-1).bottom50PurchasingPowerIndex.toFixed(1)} and top-one-percent real wealth at ${years.at(-1).top1RealWealthIndex.toFixed(1)}, with 100 representing the no-policy path.`,
    series: [
      { label: "Bottom 50% buying power", values: years.map((year) => year.bottom50PurchasingPowerIndex), tone: "series-a" },
      { label: "Top 1% real wealth", values: years.map((year) => year.top1RealWealthIndex), tone: "series-b" },
    ],
    baseline: 100,
    valueSuffix: "",
  };
};

const moneyChartOptions = (projection) => {
  const years = projection.years;
  // gdpIndex is a newer field; tolerate a stale cached snapshot / engine that
  // predates it (its no-policy path is a flat 100) so the chart never throws.
  const gdp = (year) => year.gdpIndex ?? 100;
  return {
    description: `M2 ends at index ${years.at(-1).m2Index.toFixed(1)}, the price level at ${(years.at(-1).priceLevel * 100).toFixed(1)}, and real GDP per worker at ${gdp(years.at(-1)).toFixed(1)} (100 = the no-policy path, which itself grows on trend).`,
    series: [
      { label: "M2 money stock", values: years.map((year) => year.m2Index), tone: "series-c" },
      { label: "Price level", values: years.map((year) => year.priceLevel * 100), tone: "series-d" },
      { label: "Real GDP / worker vs no policy", values: years.map(gdp), tone: "series-a" },
    ],
    baseline: 100,
    valueSuffix: "",
  };
};

const renderCharts = (projection) => {
  renderLineChart("power-chart", {
    ...powerChartOptions(projection),
    ghost: pinnedResult ? powerChartOptions(pinnedResult.projection).series : null,
    syncGroup: "trajectory",
  });
  renderLineChart("money-chart", {
    ...moneyChartOptions(projection),
    ghost: pinnedResult ? moneyChartOptions(pinnedResult.projection).series : null,
    syncGroup: "trajectory",
  });
  byId("money-chart-caption").textContent = `M2 and prices, indexed to 100 · peak inflation ${formatRate(projection.summary.peakAnnualInflation)}`;
};

// Shared per-chart state: previous live values (for transition tweening),
// running animation handles (to cancel), and hover-sync registrations keyed by
// chart id so small multiples can highlight the same year together.
const chartPrev = new Map();
const chartAnim = new Map();
const chartHover = new Map();
const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const setChartReadout = (text) => {
  const node = byId("chart-readout");
  if (node) node.textContent = text;
};

// Shape-equal series (same series count and lengths) can be tweened point-for-point.
const sameSeriesShape = (from, to) =>
  Array.isArray(from) &&
  from.length === to.length &&
  from.every((values, index) => values.length === to[index].length);

// Interpolate each live line/point from its previous values to the new ones,
// mapping through the current y-scale each frame. A hand-rolled rAF tween keeps
// the "no charting dependency" constraint while animating between runs.
const animateChart = (id, drawn, fromValues, toValues, x, y, duration = 380) => {
  const existing = chartAnim.get(id);
  if (existing) cancelAnimationFrame(existing);
  const start = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = ease(t);
    drawn.forEach((entry, seriesIndex) => {
      const from = fromValues[seriesIndex];
      const to = toValues[seriesIndex];
      const current = to.map((value, index) => {
        const base = from[index] ?? value;
        return base + (value - base) * eased;
      });
      entry.poly.setAttribute(
        "points",
        current.map((value, index) => `${x(index, current.length)},${y(value)}`).join(" "),
      );
      entry.circles.forEach((circle, index) => circle.setAttribute("cy", String(y(current[index]))));
    });
    if (t < 1) chartAnim.set(id, requestAnimationFrame(step));
    else chartAnim.delete(id);
  };
  chartAnim.set(id, requestAnimationFrame(step));
};

// Crosshair + shared tooltip + keyboard/touch interaction, shared by the
// scenario line charts and the backtest chart. Returns { setHover } so peers in
// the same sync group can be driven from a sibling chart.
const buildChartInteraction = (ctx) => {
  const { svg, id, series, ghost, x, y, count, margin, width, height, valueSuffix = "", xLabel, syncGroup } = ctx;
  const plotLeft = margin.left;
  const plotRight = width - margin.right;

  const crosshair = svgNode("line", {
    class: "crosshair",
    x1: plotLeft, y1: margin.top, x2: plotLeft, y2: height - margin.bottom,
    visibility: "hidden",
  });
  svg.append(crosshair);
  const hoverPoints = series.map((s) => {
    const circle = svgNode("circle", { r: 4.5, class: `hover-point ${s.tone}`, visibility: "hidden" });
    svg.append(circle);
    return circle;
  });
  const tip = svgNode("g", { class: "tooltip", visibility: "hidden" });
  svg.append(tip);

  const rowsFor = (index) => {
    const rows = series.map((s) => ({ label: s.label, tone: s.tone, value: s.values[index], ghost: false }));
    if (ghost) {
      ghost.forEach((s) => rows.push({ label: `${s.label} (A)`, tone: s.tone, value: s.values[index], ghost: true }));
    }
    return rows;
  };

  const renderTip = (index) => {
    tip.replaceChildren();
    const rows = rowsFor(index);
    const lineHeight = 16;
    const boxWidth = 184;
    const boxHeight = 22 + rows.length * lineHeight + 6;
    const cx = x(index);
    let boxX = cx + 12;
    if (boxX + boxWidth > plotRight) boxX = cx - 12 - boxWidth;
    if (boxX < plotLeft) boxX = plotLeft;
    const boxY = margin.top + 4;
    tip.append(svgNode("rect", { x: boxX, y: boxY, width: boxWidth, height: boxHeight, rx: 6, class: "tooltip-box" }));
    tip.append(svgNode("text", { x: boxX + 12, y: boxY + 18, class: "tooltip-title" }, xLabel(index)));
    rows.forEach((row, rowIndex) => {
      const rowY = boxY + 22 + (rowIndex + 1) * lineHeight;
      tip.append(
        svgNode("rect", {
          x: boxX + 12, y: rowY - 8, width: 9, height: 9,
          class: `tooltip-swatch ${row.tone}${row.ghost ? " ghost" : ""}`,
        }),
      );
      tip.append(
        svgNode(
          "text",
          { x: boxX + 27, y: rowY, class: `tooltip-row${row.ghost ? " ghost" : ""}` },
          `${row.label}: ${row.value.toFixed(1)}${valueSuffix}`,
        ),
      );
    });
  };

  let current = null;

  const broadcast = (index) => {
    if (!syncGroup) return;
    for (const [otherId, entry] of chartHover) {
      if (otherId === id || entry.group !== syncGroup) continue;
      entry.setHover(index, true);
    }
  };

  const hide = (silent) => {
    current = null;
    crosshair.setAttribute("visibility", "hidden");
    tip.setAttribute("visibility", "hidden");
    hoverPoints.forEach((circle) => circle.setAttribute("visibility", "hidden"));
    if (!silent) broadcast(null);
  };

  const setHover = (index, silent = false) => {
    if (index == null) {
      hide(silent);
      return;
    }
    const i = clamp(Math.round(index), 0, count - 1);
    current = i;
    const cx = x(i);
    crosshair.setAttribute("x1", String(cx));
    crosshair.setAttribute("x2", String(cx));
    crosshair.setAttribute("visibility", "visible");
    hoverPoints.forEach((circle, seriesIndex) => {
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(y(series[seriesIndex].values[i])));
      circle.setAttribute("visibility", "visible");
    });
    renderTip(i);
    tip.setAttribute("visibility", "visible");
    if (!silent) {
      const readoutRows = rowsFor(i).map((row) => `${row.label} ${row.value.toFixed(1)}${valueSuffix}`);
      setChartReadout(`${xLabel(i)}: ${readoutRows.join(", ")}`);
      broadcast(i);
    }
  };

  const indexFromEvent = (event) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const local = point.matrixTransform(matrix.inverse());
    const ratio = (local.x - plotLeft) / Math.max(1, plotRight - plotLeft);
    return clamp(Math.round(ratio * (count - 1)), 0, count - 1);
  };

  const hit = svgNode("rect", {
    x: plotLeft, y: margin.top,
    width: plotRight - plotLeft, height: height - margin.top - margin.bottom,
    class: "chart-hit",
  });
  const onPointer = (event) => {
    const index = indexFromEvent(event);
    if (index != null) setHover(index);
  };
  // pointer* unifies mouse, touch, and pen.
  hit.addEventListener("pointermove", onPointer);
  hit.addEventListener("pointerdown", onPointer);
  hit.addEventListener("pointerleave", () => setHover(null));
  svg.append(hit);

  svg.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const base = current ?? -1;
      setHover(clamp(base + (event.key === "ArrowRight" ? 1 : -1), 0, count - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHover(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHover(count - 1);
    } else if (event.key === "Escape") {
      setHover(null);
    }
  });
  svg.addEventListener("blur", () => setHover(null));

  if (syncGroup) chartHover.set(id, { group: syncGroup, setHover });
  else chartHover.delete(id);

  return { setHover };
};

const renderLineChart = (id, options) => {
  const root = byId(id);
  const running = chartAnim.get(id);
  if (running) {
    cancelAnimationFrame(running);
    chartAnim.delete(id);
  }
  root.replaceChildren();
  const width = 720;
  const height = 300;
  const margin = { top: 24, right: 148, bottom: 38, left: 48 };
  const ghost = options.ghost ?? null;
  const allValues = [
    ...options.series.flatMap((series) => series.values),
    ...(ghost ? ghost.flatMap((series) => series.values) : []),
  ];
  const low = Math.min(options.baseline, ...allValues);
  const high = Math.max(options.baseline, ...allValues);
  const padding = Math.max(4, (high - low) * 0.18);
  const yMin = Math.floor((low - padding) / 5) * 5;
  const yMax = Math.ceil((high + padding) / 5) * 5;
  const count = options.series[0].values.length;
  const x = (index, seriesLength = count) => margin.left + (index / Math.max(1, seriesLength - 1)) * (width - margin.left - margin.right);
  const y = (value) => margin.top + ((yMax - value) / Math.max(1, yMax - yMin)) * (height - margin.top - margin.bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", tabindex: "0", "aria-label": options.description });
  svg.append(svgNode("title", {}, options.description));

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = yMin + ((yMax - yMin) * tick) / 4;
    const yPos = y(value);
    svg.append(svgNode("line", { x1: margin.left, y1: yPos, x2: width - margin.right, y2: yPos, class: "grid-line" }));
    svg.append(svgNode("text", { x: margin.left - 9, y: yPos + 4, class: "axis-label", "text-anchor": "end" }, value.toFixed(0)));
  }
  [0, 5, 10].forEach((year) => {
    const xPos = x(year, options.series[0].values.length);
    svg.append(svgNode("text", { x: xPos, y: height - 10, class: "axis-label", "text-anchor": year === 0 ? "start" : year === 10 ? "end" : "middle" }, `Year ${year}`));
  });
  svg.append(svgNode("line", { x1: margin.left, y1: y(options.baseline), x2: width - margin.right, y2: y(options.baseline), class: "baseline-line" }));

  // Ghost (pinned Scenario A) lines sit behind the live lines, dashed and faded.
  if (ghost) {
    ghost.forEach((series) => {
      const points = series.values.map((value, index) => `${x(index, series.values.length)},${y(value)}`).join(" ");
      svg.append(svgNode("polyline", { points, class: `data-line ghost ${series.tone}`, fill: "none" }));
    });
  }

  const labelPositions = options.series
    .map((series, index) => ({ index, y: y(series.values.at(-1)) }))
    .sort((left, right) => left.y - right.y);
  for (let index = 1; index < labelPositions.length; index += 1) {
    labelPositions[index].y = Math.max(labelPositions[index].y, labelPositions[index - 1].y + 28);
  }
  const bottomOverflow = (labelPositions.at(-1)?.y ?? 0) - (height - margin.bottom - 12);
  if (bottomOverflow > 0) labelPositions.forEach((position) => { position.y -= bottomOverflow; });
  const topOverflow = margin.top + 8 - (labelPositions[0]?.y ?? margin.top + 8);
  if (topOverflow > 0) labelPositions.forEach((position) => { position.y += topOverflow; });
  const labelY = new Map(labelPositions.map((position) => [position.index, position.y]));

  const drawn = options.series.map((series, seriesIndex) => {
    const points = series.values.map((value, index) => `${x(index, series.values.length)},${y(value)}`).join(" ");
    const poly = svgNode("polyline", { points, class: `data-line ${series.tone}`, fill: "none" });
    svg.append(poly);
    const circles = series.values.map((value, index) => {
      const circle = svgNode("circle", { cx: x(index, series.values.length), cy: y(value), r: index === series.values.length - 1 ? 4 : 2.5, class: `data-point ${series.tone}` });
      circle.append(svgNode("title", {}, `${series.label}, year ${index}: ${value.toFixed(1)}${options.valueSuffix}`));
      svg.append(circle);
      return circle;
    });
    const finalValue = series.values.at(-1);
    const finalLabelY = labelY.get(seriesIndex) ?? y(finalValue);
    svg.append(svgNode("text", { x: width - margin.right + 12, y: finalLabelY - 5, class: `series-label ${series.tone}` }, series.label));
    svg.append(svgNode("text", { x: width - margin.right + 12, y: finalLabelY + 13, class: "series-value" }, `${finalValue.toFixed(1)}${options.valueSuffix}`));
    return { poly, circles };
  });

  buildChartInteraction({
    svg, id, series: options.series, ghost,
    x, y, count, margin, width, height,
    valueSuffix: options.valueSuffix ?? "",
    xLabel: (index) => `Year ${index}`,
    syncGroup: options.syncGroup ?? null,
  });

  root.append(svg);

  // Tween line positions from the previous run when the shape matches.
  const previous = chartPrev.get(id);
  const toValues = options.series.map((series) => series.values.slice());
  if (previous && !prefersReducedMotion() && sameSeriesShape(previous, toValues)) {
    animateChart(id, drawn, previous, toValues, x, y);
  }
  chartPrev.set(id, toValues);
};

const renderFlow = (projection) => {
  const { behaviorMix, annualFlows, summary, fiscal } = projection;
  const finalYear = annualFlows.finalYear;
  const firstFiscal = fiscal?.years?.[0];
  byId("flow-tax").textContent = compactMoney.format(annualFlows.taxCollected);
  const baseTrend = finalYear && finalYear.taxCollected < annualFlows.taxCollected
    ? "erodes"
    : finalYear && finalYear.taxCollected > annualFlows.taxCollected
      ? "grows"
      : "holds steady";
  byId("flow-tax-detail").textContent = finalYear
    ? `${compactMoney.format(finalYear.taxCollected)} from ${integer.format(finalYear.taxpayerHouseholds)} modeled taxpayers at a ${percent.format(finalYear.effectiveTaxRate)} effective rate by year ten as the taxed base ${baseTrend}`
    : "on net worth above the exemption";
  byId("flow-mix").textContent = `${percent.format(behaviorMix.borrowShare)} borrow · ${percent.format(behaviorMix.sellShare)} sell`;
  const resolutionDetail = summary.taxLoanDefaults > 1
    ? ` · ${compactMoney.format(summary.taxLoanDefaults)} defaults resolved over 10 years (${compactMoney.format(summary.collateralSeized)} collateral seized)`
    : "";
  byId("flow-loans").textContent = `${compactMoney.format(annualFlows.newPrivateLoans)} in new bank loans in year one${finalYear ? ` · ${compactMoney.format(finalYear.newPrivateLoans)} newly underwritten by year ten${finalYear.deferredTax > 1 ? ` · ${compactMoney.format(finalYear.deferredTax)} tax deferred after funding limits` : ""}${resolutionDetail}` : ""}`;
  byId("flow-ubi").textContent = `${compactMoney.format(annualFlows.ubiReceived)} cash · ${compactMoney.format(annualFlows.publicServicesSpending)} services`;
  const fiscalAction = firstFiscal?.debtIssued > 1
    ? `${compactMoney.format(firstFiscal.debtIssued)} debt issued`
    : firstFiscal?.debtRepaid > 1
      ? `${compactMoney.format(firstFiscal.debtRepaid)} debt repaid`
      : firstFiscal?.treasuryBalance > 1
        ? `${compactMoney.format(firstFiscal.treasuryBalance)} Treasury balance`
        : "no modeled deficit";
  byId("flow-balance").textContent = `${compactMoney.format(annualFlows.administrativeCost)} administration · ${fiscalAction}`;
  const finalServiceValue = finalYear?.serviceValue?.selected ?? 0;
  const hasSelectedFinalService =
    (finalYear?.publicServicesSpending ?? 0) > 0 && finalServiceValue > 0;
  byId("flow-result").textContent = hasSelectedFinalService
    ? `${signedPercent(summary.bottom50PurchasingPowerChange)} buying power · ${compactMoney.format((finalYear?.ubiReceived ?? 0) + finalServiceValue)} cash + selected services`
    : `${signedPercent(summary.bottom50PurchasingPowerChange)} cash-only buying power`;
  const resolutionCost = summary.governmentGuarantees > 1
    ? ` · ${compactMoney.format(summary.governmentGuarantees)} public guarantee`
    : summary.centralBankFacilities > 1
      ? ` · ${compactMoney.format(summary.centralBankFacilities)} central-bank facility`
      : summary.privateBankLosses > 1
        ? ` · ${compactMoney.format(summary.privateBankLosses)} bank loss`
        : "";
  byId("flow-debt").textContent = `${compactMoney.format(summary.privateTaxDebt)} private tax debt${finalYear?.privateTaxLoanInterestPaid > 1 ? ` · ${compactMoney.format(finalYear.privateTaxLoanInterestPaid)} annual interest paid` : ""}${resolutionCost} · ${compactMoney.format(fiscal?.endingProgramDebt ?? 0)} program debt`;
  const m2Sentence = annualFlows.m2Injection >= 0
    ? `The selected borrowing behavior adds ${compactMoney.format(annualFlows.m2Injection)} to M2 in year one`
    : `The selected Treasury-balance closure parks enough revenue to drain ${compactMoney.format(Math.abs(annualFlows.m2Injection))} from M2 in year one, outweighing loan-created deposits`;
  byId("money-answer").innerHTML = `<strong>What this means:</strong><span>The tax-and-spending cycle itself reshuffles deposits. ${m2Sentence}; selling assets does not create deposits economy-wide.</span>`;
};

const renderTheory = (theory, projection) => {
  const { verdict, summary, assumptions, years } = theory;
  byId("theory-badge").textContent = verdict.rating;
  byId("theory-badge").dataset.rating = verdict.rating;
  byId("theory-heading").textContent = verdict.headline;
  byId("theory-explanation").textContent = verdict.explanation;
  byId("theory-credit").textContent = signedPercent(projection.summary.cumulativeM2Change);
  byId("theory-hedge").textContent = `${percent.format(assumptions.assetHedgeShare)} · ${compactMoney.format(summary.annualLiquiditySeekingAssets)}/yr`;
  byId("theory-housing").textContent = signedPercent(summary.housingPriceChange);
  byId("theory-rent").textContent = signedPercent(summary.bottomRenterHousingBurdenChange);
  byId("theory-gap").textContent = signedPoints(summary.housingPositionGapChange);
  byId("theory-renter-result").textContent = `After cash transfers, administration, prices, and rent, modeled bottom-half renters end with ${signedPercent(summary.bottomRenterDisposableIncomeChange)} disposable buying power relative to the no-policy path.`;
  renderLineChart("theory-chart", {
    ...theoryChartOptions(theory),
    ghost: pinnedResult ? theoryChartOptions(pinnedResult.projection.theoryTest).series : null,
    syncGroup: "theory",
  });
};

const renderOpenEconomy = (openEconomy) => {
  const { summary, accounting, closure } = openEconomy;
  byId("open-economy-badge").textContent = closure.replace("-", " ");
  byId("open-economy-foreign-claims").textContent = compactMoney.format(summary.foreignOwnedDomesticClaims);
  byId("open-economy-foreign-debt").textContent = compactMoney.format(summary.foreignHeldTreasuryDebt);
  byId("open-economy-resident-claims").textContent = compactMoney.format(summary.residentForeignClaims);
  byId("open-economy-nfa").textContent = compactMoney.format(summary.netForeignAssetPosition);
  byId("open-economy-fx").textContent = signedPercent(summary.peakExchangeRatePressure);
  byId("open-economy-explanation").textContent = closure === "closed"
    ? "Closed mode keeps the rest-of-world channels at zero, so the domestic-only path remains directly comparable to prior runs."
    : "The aggregate rest-of-world sector distinguishes foreign asset buyers, foreign Treasury holders, and U.S. residents' foreign claims without treating a tax-base change as cash disappearing.";
  byId("open-economy-accounting").textContent = accounting.passed
    ? `All ${accounting.events} aggregate cross-border journal events balance; domestic and foreign claims reconcile in one consolidated ledger.`
    : `Cross-border accounting needs attention: ${accounting.failures.join(" ")}`;
};

const theoryChartOptions = (theory) => {
  const { years } = theory;
  return {
    description: `The middle-homeowner wealth index ends at ${years.at(-1).middleHomeownerWealthIndex.toFixed(1)}, renter housing burden at ${years.at(-1).bottomRenterHousingBurdenIndex.toFixed(1)}, and renter disposable income at ${years.at(-1).bottomRenterDisposableIncomeIndex.toFixed(1)}, with 100 representing no policy.`,
    series: [
      { label: "Middle homeowner wealth", values: years.map((year) => year.middleHomeownerWealthIndex), tone: "series-a" },
      { label: "Renter housing burden", values: years.map((year) => year.bottomRenterHousingBurdenIndex), tone: "series-b" },
      { label: "Renter disposable income", values: years.map((year) => year.bottomRenterDisposableIncomeIndex), tone: "series-c" },
    ],
    baseline: 100,
    valueSuffix: "",
  };
};

const renderStress = (stress) => {
  const ruleLabel = stress.fundingRule === "fixed"
    ? "fixed benefits"
    : stress.fundingRule === "smoothed"
      ? "trailing-three-year smoothed revenue"
      : "current revenue";
  byId("stress-description").textContent = `Each cell holds peak annual inflation in a ten-year run. Rows scale the requested benefit; the ${ruleLabel} rule determines actual outlays, and columns monetize the debt that rule issues. Surpluses use ${stress.surplusUse.replaceAll("-", " ")}.`;
  const headRow = document.createElement("tr");
  headRow.append(element("th", "Benefit scale"));
  stress.monetizationShares.forEach((share) => headRow.append(element("th", `${percent.format(share)} monetized`)));
  byId("stress-head").replaceChildren(headRow);
  byId("stress-body").replaceChildren(...stress.ubiMultipliers.map((multiplier) => {
    const row = document.createElement("tr");
    row.append(element("th", `${multiplier}×`));
    stress.monetizationShares.forEach((share) => {
      const cellData = stress.cells.find((cell) => cell.ubiMultiplier === multiplier && cell.monetizationShare === share);
      const cell = element("td", stressInflationLabel(cellData.peakAnnualInflation));
      cell.className = cellData.regime;
      cell.setAttribute("aria-label", `${multiplier} times requested benefit, ${percent.format(share)} issued debt monetized: peak annual inflation ${formatRate(cellData.peakAnnualInflation)}, ${cellData.regime}`);
      row.append(cell);
    });
    return row;
  }));
  byId("hyper-threshold").textContent = stress.threshold.firstUbiMultiplierAtFullMonetization === null
    ? stress.threshold.explanation
    : `First modeled breach: about ${integer.format(stress.threshold.firstUbiMultiplierAtFullMonetization)}× this benefit with issued debt fully monetized. This is an extreme boundary, not a forecast.`;
};

// Load a swept assumption's value into its form field and recompute. The write
// is programmatic, so the form's input listener won't fire — clear the active
// preset here so the URL falls back to explicit field params. `snap` controls
// how the value is rounded onto the field's step grid: verdict-flip values snap
// "up"/"down" AWAY from the base so the rounded value stays past the tipping
// point (rounding to nearest could land just short and not actually flip);
// tornado endpoints are exact dial bounds, so they snap to the nearest step.
const applyDialValue = (formId, formValue, snap = "nearest") => {
  // While the panel is stale (a newer sweep is running), the bars/flip describe
  // the old scenario — ignore activation from any source, including keyboard
  // Enter/Space on a focused bar, which `pointer-events: none` does not block.
  if (byId("sensitivity")?.classList.contains("is-stale")) return;
  const field = byId(formId);
  if (!field) return;
  const step = Number(field.step) || 0.01;
  const decimals = step >= 1 ? 0 : String(step).split(".")[1]?.length ?? 2;
  const min = field.min !== "" ? Number(field.min) : -Infinity;
  let max = field.max !== "" ? Number(field.max) : Infinity;
  // Borrow and sell shares are jointly capped at 100% (borrowShare + sellShare
  // <= 1); the static field max is 100, so cap dynamically against the current
  // complementary share or a step-rounded value could submit an infeasible total
  // and make recalculation fail.
  if (formId === "borrow-share" || formId === "sell-share") {
    const otherId = formId === "borrow-share" ? "sell-share" : "borrow-share";
    max = Math.min(max, 100 - (Number(byId(otherId)?.value) || 0));
  }
  const rounder = snap === "up" ? Math.ceil : snap === "down" ? Math.floor : Math.round;
  let snapped = rounder(Number(formValue) / step) * step;
  // Step-rounding can overshoot a dynamic max; floor back onto the grid so the
  // applied value never exceeds the feasible ceiling.
  if (snapped > max) snapped = Math.floor(max / step) * step;
  field.value = clamp(snapped, min, max).toFixed(decimals);
  setActivePreset(null);
  syncSlider(formId);
  updateScenarioUrl();
  openScenarioDrawer({ focusId: formId });
  void dashboardRerun();
};

const TORNADO_TONE = {
  beneficial: "bar-beneficial",
  harmful: "bar-harmful",
  flat: "bar-flat",
};

const renderSensitivity = (analysis) => {
  renderVerdictFlip(analysis.verdictFlip);
  const base = analysis.base.bottom50PurchasingPowerChange;
  byId("sensitivity-note").textContent =
    `Ranked across ${analysis.dials.length} assumptions in ${integer.format(analysis.runs)} model runs. ` +
    `Baseline bottom-half buying power: ${signedPercent(base)}.`;

  const root = byId("tornado-chart");
  root.replaceChildren();
  const dials = analysis.dials;
  if (dials.length === 0) return;
  const rowHeight = 34;
  const width = 720;
  const margin = { top: 16, right: 60, bottom: 34, left: 196 };
  const height = margin.top + margin.bottom + dials.length * rowHeight;

  // Domain is the full span of endpoint outcomes (in percentage points off the
  // baseline), symmetric around 0 so the center line reads as "no change".
  const deltas = dials.flatMap((dial) => [dial.low.bottom50Delta, dial.high.bottom50Delta]);
  const extent = Math.max(0.005, ...deltas.map((delta) => Math.abs(delta)));
  const domain = extent * 1.15;
  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const x = (delta) => plotLeft + ((delta + domain) / (2 * domain)) * (plotRight - plotLeft);
  const centerX = x(0);

  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `Assumptions ranked by their impact on bottom-50 buying power. ${dials[0].label} moves it most.`,
  });

  // Axis: percentage-point offsets from the baseline outcome.
  for (const tick of [-domain, 0, domain]) {
    const xPos = x(tick);
    svg.append(svgNode("line", { x1: xPos, y1: margin.top, x2: xPos, y2: height - margin.bottom, class: tick === 0 ? "tornado-center" : "grid-line" }));
    svg.append(svgNode("text", { x: xPos, y: height - margin.bottom + 18, class: "tornado-axis", "text-anchor": "middle" }, `${tick > 0 ? "+" : ""}${(tick * 100).toFixed(1)} pp`));
  }

  dials.forEach((dial, index) => {
    const rowY = margin.top + index * rowHeight;
    const barY = rowY + 6;
    const barHeight = rowHeight - 16;
    const lowX = x(dial.low.bottom50Delta);
    const highX = x(dial.high.bottom50Delta);
    const left = Math.min(lowX, highX);
    const right = Math.max(lowX, highX);
    const group = svgNode("g", { class: "tornado-bar", tabindex: "0", role: "button" });
    const barTitle =
      `${dial.label}: low end → ${signedPercent(dial.low.bottom50PurchasingPowerChange)} buying power, ` +
      `high end → ${signedPercent(dial.high.bottom50PurchasingPowerChange)}. Click to load the stronger end into the form.`;
    group.append(svgNode("title", {}, barTitle));
    group.append(svgNode("rect", { x: left, y: barY, width: Math.max(1.5, right - left), height: barHeight, class: TORNADO_TONE[dial.direction] ?? "bar-flat", rx: 2 }));

    // The endpoint with the larger absolute swing is the informative extreme;
    // clicking the bar loads it into the form.
    const strongEnd = Math.abs(dial.high.bottom50Delta) >= Math.abs(dial.low.bottom50Delta) ? dial.high : dial.low;
    const activate = () => applyDialValue(dial.formId, strongEnd.formValue);
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });

    svg.append(svgNode("text", { x: plotLeft - 12, y: barY + barHeight / 2 + 4, class: "tornado-label", "text-anchor": "end" }, dial.label));
    const valueX = right + 8 > plotRight - 4 ? left - 8 : right + 8;
    const valueAnchor = right + 8 > plotRight - 4 ? "end" : "start";
    svg.append(svgNode("text", { x: valueX, y: barY + barHeight / 2 + 4, class: "tornado-value", "text-anchor": valueAnchor }, `${(dial.impact * 100).toFixed(1)} pp`));
    svg.append(group);
  });

  root.append(svg);
};

const uncertaintyState = { running: false, token: 0 };

const setUncertaintyBusy = (busy) => {
  uncertaintyState.running = busy;
  byId("uncertainty-run").disabled = busy;
  byId("uncertainty-cancel").hidden = !busy;
  byId("uncertainty-draws").disabled = busy;
  byId("uncertainty-population-mode").disabled = busy;
  byId("uncertainty-seed").disabled = busy;
};

const formatUncertaintyValue = (value, unit) => {
  if (unit === "dollars") return compactMoney.format(value);
  if (unit === "index") return value.toFixed(1);
  return signedPercent(value);
};

const renderUncertainty = (analysis) => {
  const verdictRoot = byId("uncertainty-verdicts");
  verdictRoot.replaceChildren();
  for (const rating of ["beneficial", "mixed", "harmful"]) {
    const frequency = analysis.verdictFrequencies[rating];
    const card = document.createElement("article");
    const label = document.createElement("span");
    label.textContent = rating;
    const value = document.createElement("strong");
    value.textContent = percent.format(frequency.share);
    const count = document.createElement("small");
    count.textContent = `${integer.format(frequency.count)} of ${integer.format(analysis.runs)} draws`;
    card.append(label, value, count);
    verdictRoot.append(card);
  }

  const table = document.createElement("table");
  table.className = "uncertainty-table";
  const header = document.createElement("tr");
  for (const text of ["Outcome", "p10", "p50", "p90"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = text;
    header.append(cell);
  }
  const head = document.createElement("thead");
  head.append(header);
  const body = document.createElement("tbody");
  for (const metric of analysis.metrics) {
    const row = document.createElement("tr");
    const label = document.createElement("td");
    label.textContent = metric.label;
    row.append(label);
    for (const key of ["p10", "p50", "p90"]) {
      const cell = document.createElement("td");
      cell.textContent = formatUncertaintyValue(metric.band[key], metric.unit);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  byId("uncertainty-metrics").replaceChildren(table);

  const influences = analysis.influences.map((influence) => {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = influence.label;
    const direction = influence.direction === "positive"
      ? "raises"
      : influence.direction === "negative"
        ? "lowers"
        : "barely moves";
    item.append(label, ` — ${direction} bottom-half buying power; influence ${influence.score.toFixed(2)}`);
    return item;
  });
  byId("uncertainty-influences").replaceChildren(...influences);
  const populationEffect = byId("uncertainty-population-effect");
  if (analysis.populationInfluence) {
    populationEffect.textContent =
      `Population replicate effect: ${analysis.populationInfluence.score.toFixed(2)} ` +
      "matched-draw categorical correlation ratio. This bounded effect size is reported separately because it is not comparable to the regression coefficients above.";
    populationEffect.hidden = false;
  } else {
    populationEffect.textContent = "";
    populationEffect.hidden = true;
  }

  const interactions = analysis.interactions.map((interaction) => {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = `${interaction.leftLabel} × ${interaction.rightLabel}`;
    item.append(label, ` — interaction ${interaction.score.toFixed(2)}`);
    return item;
  });
  byId("uncertainty-interactions").replaceChildren(...interactions);
  const populationDesign = analysis.populationDesign === "matched-parameter-draws"
    ? `${analysis.parameterDraws} matched parameter rows replayed across ${analysis.populationSeeds.length} population seeds. `
    : "The synthetic population stays fixed across all parameter draws. ";
  byId("uncertainty-note").textContent =
    `${analysis.note} Seed ${analysis.options.seed}; ${analysis.sampledParameters.length} sampled assumptions; ` +
    `${analysis.fixedAssumptions.length} policy or judgment choices held fixed. ` +
    populationDesign +
    "Declared dependency groups use rank-factor loadings with sampled direction checks; borrowing and sales use triangular proposals with proportional closure at their joint boundary. " +
    "Countermonotonic borrowing and sales are ranked as one financing-mix axis. Influence scores are standardized regression coefficients; the separately reported population effect is a matched-draw categorical correlation ratio. Interaction scores partial out linear main effects from both the outcome and each parameter pair.";
  byId("uncertainty-results").hidden = false;
};

const invalidateUncertainty = () => {
  uncertaintyState.token += 1;
  if (uncertaintyState.running) cancelUncertainty();
  setUncertaintyBusy(false);
  byId("uncertainty-results").hidden = true;
  byId("uncertainty-progress").value = 0;
  byId("uncertainty-status").textContent =
    "Scenario changed. Run joint uncertainty again when the current scenario is settled.";
};

const startUncertainty = async () => {
  if (uncertaintyState.running) return;
  const draws = Number(byId("uncertainty-draws").value);
  const options = {
    draws,
    seed: Number(byId("uncertainty-seed").value),
    populationMode: byId("uncertainty-population-mode").value,
    populationReplicates: 8,
  };
  const token = (uncertaintyState.token += 1);
  const progress = byId("uncertainty-progress");
  progress.max = draws;
  progress.value = 0;
  byId("uncertainty-results").hidden = true;
  setUncertaintyBusy(true);
  byId("uncertainty-status").textContent = `Starting ${integer.format(draws)} seeded model draws…`;
  try {
    const analysis = await runUncertainty(formRequest(), options, (update) => {
      if (token !== uncertaintyState.token) return;
      progress.value = update.completed;
      const phase = update.phase === "summarizing" ? "Summarizing" : "Running";
      byId("uncertainty-status").textContent =
        `${phase} ${integer.format(update.completed)} of ${integer.format(update.total)} draws (${percent.format(update.percent)}).`;
    });
    if (token !== uncertaintyState.token) return;
    renderUncertainty(analysis);
    byId("uncertainty-status").textContent =
      `Complete: ${integer.format(analysis.runs)} deterministic draws. Reuse seed ${analysis.options.seed} to replay exactly.`;
  } catch (error) {
    if (token !== uncertaintyState.token) return;
    const cancelled = error?.name === "AbortError";
    byId("uncertainty-status").textContent = cancelled
      ? "Joint uncertainty run cancelled."
      : error instanceof Error
        ? error.message
        : "Joint uncertainty analysis unavailable.";
  } finally {
    if (token === uncertaintyState.token) {
      setUncertaintyBusy(false);
      uncertaintyAbortController = null;
    }
  }
};

const renderVerdictFlip = (flip) => {
  const panel = byId("sensitivity-flip");
  const text = byId("sensitivity-flip-text");
  const apply = byId("sensitivity-flip-apply");
  if (!flip) {
    panel.hidden = true;
    apply.hidden = true;
    return;
  }
  panel.hidden = false;
  text.textContent = flip.sentence;
  apply.hidden = false;
  apply.textContent = `Apply ${flip.label.toLowerCase()} and recalculate`;
  // Snap away from the base value so the step-rounded field stays past the flip.
  const snap = flip.value >= flip.fromValue ? "up" : "down";
  apply.onclick = () => applyDialValue(flip.formId, flip.formValue, snap);
};

const renderReasons = (projection) => {
  const { annualFlows, summary, behaviorMix } = projection;
  const services = annualFlows.serviceValue;
  const serviceSentence = annualFlows.publicServicesSpending <= 0
    ? "No year-one services are funded in this scenario."
    : services.selected === null
      ? `Services are unscored, so this is a cash-only result. The transparent zero/base/high resource-equivalent cases are ${compactMoney.format(services.zero)}, ${compactMoney.format(services.base)}, and ${compactMoney.format(services.high)}; none is spendable cash.`
      : `The selected ${services.mode} service assumption values delivery at ${compactMoney.format(services.selected)} resource-equivalent, within the explicit ${compactMoney.format(services.zero)} to ${compactMoney.format(services.high)} range; it is not spendable cash.`;
  byId("reason-benefit").textContent = `${compactMoney.format(annualFlows.ubiReceived)} reaches households as cash and ${compactMoney.format(annualFlows.publicServicesSpending)} funds services in year one, after ${compactMoney.format(annualFlows.administrativeCost)} in modeled administration${annualFlows.finalYear ? `; modeled year-ten flows deliver ${compactMoney.format(annualFlows.finalYear.ubiReceived)} in cash` : ""}. Cash buying power for the bottom half ends ${plainDirection(summary.bottom50PurchasingPowerChange)} relative to a no-policy path. ${serviceSentence}`;
  byId("reason-risk").textContent = `${percent.format(behaviorMix.borrowShare)} of wealthy households’ payment behavior is represented by the borrow-first path. That leaves ${compactMoney.format(summary.privateTaxDebt)} of private tax debt after ten years and lifts M2 ${signedPercent(summary.cumulativeM2Change)}.`;
};

const renderDetails = (result) => {
  byId("population-households").textContent = integer.format(result.population.representedHouseholds);
  byId("population-people").textContent = integer.format(result.population.representedAdults + result.population.representedChildren);
  byId("population-income").textContent = compactMoney.format(result.population.aggregateAnnualIncome);
  byId("population-pce").textContent = compactMoney.format(result.population.baselineAnnualConsumption);
  byId("population-wealth").textContent = compactMoney.format(result.population.aggregateNetWorth);
  byId("population-sample").textContent = integer.format(result.population.sampledHouseholds);
  renderCalibrationSummary(baseline?.calibration, result.population.calibration);
  renderStrategyCards(result.strategies);
  renderComparison(result.strategies);
  renderDistribution();
  renderSectors(result.strategies);
  byId("caveat-list").replaceChildren(...result.caveats.map((caveat) => element("li", caveat)));
};

// The documented model constants (issue #8) power the table in the Model
// boundaries panel. Loaded once from the server endpoint or the static
// snapshot; a failed load is non-fatal and simply leaves the table empty.
const loadModelConstants = () => {
  const url = isStaticSnapshot ? versioned("data/model-constants.json") : "/api/model/constants";
  return fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (payload?.constants) renderModelConstants(payload.constants);
    })
    .catch(() => {});
};

const renderModelConstants = (constants) => {
  const body = byId("model-constants-body");
  if (!body) return;
  body.replaceChildren(
    ...constants.map((constant) => {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.className = "constant-name";
      name.append(document.createTextNode(constant.label));
      if (constant.tunable) {
        const badge = element("span", "Tunable");
        badge.className = "constant-tunable-badge";
        name.append(document.createTextNode(" "), badge);
      }
      const value = element("td", constant.value);
      value.className = "constant-value";
      const why = element("td", `${constant.rationale} ${constant.source}`);
      why.className = "constant-why";
      row.append(name, value, why);
      return row;
    }),
  );
};

const renderStrategyCards = (strategies) => {
  byId("strategy-grid").replaceChildren(...STRATEGIES.map((strategy) => {
    const outcome = strategies[strategy];
    const card = document.createElement("article");
    card.className = "strategy-card";
    card.append(element("h3", LABELS[strategy]));
    const primary = element("strong", compactMoney.format(outcome.moneyAndCredit.bankDepositsChange));
    primary.className = "strategy-primary";
    card.append(primary, element("span", "Bank deposit change"));
    const list = document.createElement("dl");
    [["New loans", compactMoney.format(outcome.funding.newCollateralizedLoans)], ["Assets sold", compactMoney.format(outcome.markets.totalEquitySales + outcome.markets.housingSold)], ["Inflation Δ", signedPoints(outcome.macro.estimatedInflationChange)]].forEach(([term, value]) => {
      list.append(element("dt", term), element("dd", value));
    });
    card.append(list);
    return card;
  }));
};

const renderComparison = (strategies) => {
  const rows = [
    ["Tax collected", (outcome) => compactMoney.format(outcome.fiscal.taxCollected)],
    ["UBI received", (outcome) => compactMoney.format(outcome.fiscal.ubiReceived)],
    ["Public services", (outcome) => compactMoney.format(outcome.fiscal.publicServicesSpending)],
    ["Administration", (outcome) => compactMoney.format(outcome.fiscal.administrativeCost)],
    ["Program operating balance", (outcome) => compactMoney.format(outcome.fiscal.governmentBalance)],
    ["Bank deposits Δ", (outcome) => compactMoney.format(outcome.moneyAndCredit.bankDepositsChange)],
    ["Bank loans Δ", (outcome) => compactMoney.format(outcome.moneyAndCredit.bankLoansChange)],
    ["Equity price Δ", (outcome) => signedPercent(outcome.markets.equityPriceChange)],
    ["Estimated inflation Δ", (outcome) => signedPoints(outcome.macro.estimatedInflationChange)],
    ["Wealth Gini after", (outcome) => outcome.distribution.wealthGiniAfter.toFixed(3)],
  ];
  byId("comparison-body").replaceChildren(...rows.map(([label, format]) => {
    const row = document.createElement("tr");
    row.append(element("td", label));
    STRATEGIES.forEach((strategy) => row.append(element("td", format(strategies[strategy]))));
    return row;
  }));
};

const renderDistribution = () => {
  if (!latestResult) return;
  const deciles = latestResult.strategies[byId("distribution-strategy").value].distribution.deciles;
  byId("distribution-body").replaceChildren(...deciles.map((decile) => {
    const row = document.createElement("tr");
    row.append(element("td", `D${decile.decile}`), element("td", money.format(decile.averageNetWorthBefore)), element("td", money.format(decile.averageNetWorthAfter)), element("td", money.format(decile.averageTaxPaid)), element("td", money.format(decile.averageUbiReceived)), element("td", money.format(decile.averageConsumptionChange)));
    return row;
  }));
};

const renderSectors = (strategies) => {
  byId("sector-body").replaceChildren(...strategies["cash-first"].macro.sectors.map((sector, index) => {
    const row = document.createElement("tr");
    row.append(element("td", sector.sector.replace("-", " ")));
    STRATEGIES.forEach((strategy) => {
      const outcome = strategies[strategy].macro.sectors[index];
      row.append(element("td", `${compactMoney.format(outcome.demandChange)} · ${signedPoints(outcome.inflationPressure)}`));
    });
    return row;
  }));
};

const renderSources = (sources) => {
  byId("source-list").replaceChildren(...sources.map((source, index) => {
    const item = document.createElement("a");
    item.href = source.url;
    item.target = "_blank";
    item.rel = "noreferrer";
    item.append(element("span", `0${index + 1}`), element("strong", source.label), element("small", `${source.organization} · ${source.vintage}`));
    return item;
  }));
};

const renderCalibrationSummary = (calibration, diagnostics = []) => {
  const summary = byId("calibration-summary");
  if (!summary || !calibration) return;
  const residual = calibration.residualAssetClass;
  const flows = calibration.populationAndFlows;
  const maximumResidual = diagnostics.length
    ? Math.max(...diagnostics.map((entry) => entry.relativeError))
    : null;
  const residualText = maximumResidual === null
    ? "Scenario residuals appear after the model runs."
    : `Maximum displayed population/flow residual: ${(maximumResidual * 100).toExponential(1)}%.`;
  summary.textContent = `${calibration.vintage} DFA instrument calibration · ${(calibration.tolerance * 100).toFixed(0)}% reconciliation tolerance. July 2025 resident target: ${integer.format(flows.residentPopulation)} people (${integer.format(flows.adults)} adults and ${integer.format(flows.children)} children); calendar-year 2025 PCE target: ${compactMoney.format(flows.annualPce)}. Group-quarters residents are included in benefit counts and nonresidents are excluded. ${residualText} ${residual.label} remains an explicit ${residual.modelClass} balance-sheet class.`;
};

const renderValidation = (backtest) => {
  if (!backtest || !Array.isArray(backtest.years) || backtest.years.length === 0) return;
  byId("backtest-modeled-peak").textContent = `${formatRate(backtest.modeledPeak.inflation)} in ${backtest.modeledPeak.year}`;
  byId("backtest-actual-peak").textContent = `actual peak ${formatRate(backtest.actualPeak.inflation)} (${backtest.actualPeak.year}); headline ${formatRate(backtest.actualHeadlinePeak.inflation)}`;
  byId("backtest-mae").textContent = `${(backtest.meanAbsoluteErrorPoints * 100).toFixed(1)} pp`;
  byId("backtest-caption").textContent = `Modeled vs. actual CPI, ${backtest.years[0].year}–${backtest.years.at(-1).year} · one-year money→price lag`;

  byId("backtest-body").replaceChildren(...backtest.years.map((year) => {
    const row = document.createElement("tr");
    row.append(
      element("td", String(year.year)),
      element("td", signedPercent(year.drivingM2Growth)),
      element("td", formatRate(year.modeledInflation)),
      element("td", formatRate(year.actualInflation)),
    );
    if (!year.withinTolerance) row.classList.add("out-of-band");
    return row;
  }));
  byId("backtest-caveats").replaceChildren(...backtest.caveats.map((caveat) => element("li", caveat)));
  byId("backtest-sources").replaceChildren(...backtest.sources.map((source) => {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.append(element("strong", source.label), element("small", `${source.organization} · ${source.vintage}`));
    return link;
  }));

  renderBacktestChart("backtest-chart", backtest);
};

const renderBacktestChart = (id, backtest) => {
  const root = byId(id);
  root.replaceChildren();
  const years = backtest.years;
  const width = 720;
  const height = 300;
  const margin = { top: 24, right: 148, bottom: 38, left: 48 };
  const series = [
    { label: "Modeled", values: years.map((year) => year.modeledInflation * 100), tone: "series-d" },
    { label: "Actual CPI", values: years.map((year) => year.actualInflation * 100), tone: "series-a" },
  ];
  const allValues = series.flatMap((entry) => entry.values);
  const low = Math.min(0, ...allValues);
  const high = Math.max(...allValues);
  const padding = Math.max(2, (high - low) * 0.18);
  const yMin = Math.floor((low - padding) / 2) * 2;
  const yMax = Math.ceil((high + padding) / 2) * 2;
  const x = (index) => margin.left + (index / Math.max(1, years.length - 1)) * (width - margin.left - margin.right);
  const y = (value) => margin.top + ((yMax - value) / Math.max(1, yMax - yMin)) * (height - margin.top - margin.bottom);
  const description = `Modeled inflation tracks actual CPI from ${years[0].year} to ${years.at(-1).year}; the modeled peak of ${series[0].values[years.findIndex((year) => year.year === backtest.modeledPeak.year)]?.toFixed(1)}% lands near the realized surge.`;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", tabindex: "0", "aria-label": description });
  svg.append(svgNode("title", {}, description));

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = yMin + ((yMax - yMin) * tick) / 4;
    const yPos = y(value);
    svg.append(svgNode("line", { x1: margin.left, y1: yPos, x2: width - margin.right, y2: yPos, class: "grid-line" }));
    svg.append(svgNode("text", { x: margin.left - 9, y: yPos + 4, class: "axis-label", "text-anchor": "end" }, `${value.toFixed(0)}%`));
  }
  years.forEach((year, index) => {
    svg.append(svgNode("text", { x: x(index), y: height - 10, class: "axis-label", "text-anchor": index === 0 ? "start" : index === years.length - 1 ? "end" : "middle" }, String(year.year)));
  });
  if (yMin < 0) {
    svg.append(svgNode("line", { x1: margin.left, y1: y(0), x2: width - margin.right, y2: y(0), class: "baseline-line" }));
  }

  const labelPositions = series
    .map((entry, index) => ({ index, y: y(entry.values.at(-1)) }))
    .sort((left, right) => left.y - right.y);
  for (let index = 1; index < labelPositions.length; index += 1) {
    labelPositions[index].y = Math.max(labelPositions[index].y, labelPositions[index - 1].y + 28);
  }
  const labelY = new Map(labelPositions.map((position) => [position.index, position.y]));

  series.forEach((entry, seriesIndex) => {
    const points = entry.values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
    svg.append(svgNode("polyline", { points, class: `data-line ${entry.tone}`, fill: "none" }));
    entry.values.forEach((value, index) => {
      const circle = svgNode("circle", { cx: x(index), cy: y(value), r: index === entry.values.length - 1 ? 4 : 2.5, class: `data-point ${entry.tone}` });
      circle.append(svgNode("title", {}, `${entry.label}, ${years[index].year}: ${value.toFixed(1)}%`));
      svg.append(circle);
    });
    const finalValue = entry.values.at(-1);
    const finalLabelY = labelY.get(seriesIndex) ?? y(finalValue);
    svg.append(svgNode("text", { x: width - margin.right + 12, y: finalLabelY - 5, class: `series-label ${entry.tone}` }, entry.label));
    svg.append(svgNode("text", { x: width - margin.right + 12, y: finalLabelY + 13, class: "series-value" }, `${finalValue.toFixed(1)}%`));
  });

  buildChartInteraction({
    svg, id, series, ghost: null,
    x: (index) => x(index), y, count: years.length, margin, width, height,
    valueSuffix: "%",
    xLabel: (index) => String(years[index].year),
    syncGroup: null,
  });

  root.append(svg);
};

const svgNode = (tag, attributes = {}, text) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const element = (tag, text) => {
  const node = document.createElement(tag);
  node.textContent = String(text);
  return node;
};
const compactNumber = (value) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const signedPercent = (value) => `${value > 0 ? "+" : ""}${percent.format(value)}`;
const formatRate = (value) => percent.format(value);
const signedPoints = (value) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)} pp`;
const stressInflationLabel = (value) => value >= 10 ? `${integer.format(value * 100)}%` : formatRate(value);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const regimeFor = (inflation) => inflation >= 5 ? "extreme" : inflation >= 0.5 ? "crisis" : inflation >= 0.1 ? "high" : inflation >= 0.05 ? "elevated" : "stable";
const plainDirection = (value) => value >= 0 ? `${percent.format(value)} better off` : `${percent.format(Math.abs(value))} worse off`;
const scenarioSummary = (request, result) => {
  const monthly = `${money.format(request.ubi.adultMonthlyBenefit)}/mo equivalent`;
  const brackets = request.wealthTax.brackets;
  if (brackets && brackets.length > 0) {
    const rates = brackets.map((bracket) => bracket.rate);
    const low = Math.min(...rates);
    const high = Math.max(...rates);
    const band = low === high ? formatRate(low) : `${formatRate(low)}–${formatRate(high)}`;
    const floor = Math.min(...brackets.map((bracket) => bracket.threshold));
    return `Graduated ${band} above ${compactMoney.format(floor)} · ${monthly}`;
  }
  const target = request.wealthTax.targetMode === "top-share"
    ? `top ${percent.format(request.wealthTax.topShare)}`
    : `wealth above ${compactMoney.format(result?.wealthTaxTarget?.effectiveExemption ?? request.wealthTax.exemption)}`;
  return `${formatRate(request.wealthTax.rate)} on ${target} · ${monthly}`;
};

const syncTargetControls = () => {
  // While a graduated schedule is active it owns targeting, the exemption, and
  // the flat rate, so those inputs are inert — disable the whole targeting row.
  const bracketsActive = byId("bracket-rows").children.length > 0;
  const topShareMode = !bracketsActive && byId("target-mode").value === "top-share";
  byId("target-mode").disabled = bracketsActive;
  byId("top-share").disabled = bracketsActive || !topShareMode;
  byId("top-share-label").classList.toggle("is-disabled", bracketsActive || !topShareMode);
  byId("exemption").disabled = bracketsActive || topShareMode;
  byId("exemption-label").classList.toggle("is-disabled", bracketsActive || topShareMode);
};

// Real-world proposals (Warren/Sanders/current-law) derive their compact form
// fields from the audited definitions in policy-presets.js so the schedule the
// UI applies can never drift from the definition the reference panel and
// validation harness describe. Generic invented scenarios stay inline — they are
// illustrative dials, not published proposals, so they carry no proposal metadata.
const PRESETS = {
  "top-one": { targetMode: "top-share", topShare: 1, exemption: 10, rate: 1 },
  billionaire: { targetMode: "exemption", topShare: 1, exemption: 1000, rate: 10 },
  "ten-million": { targetMode: "exemption", topShare: 1, exemption: 10, rate: 5 },
  universal: { targetMode: "exemption", topShare: 100, exemption: 0, rate: 1, adultBenefit: 1000, childBenefit: 500, directCashShare: 100 },
  ...Object.fromEntries(
    Object.entries(POLICY_PRESETS).map(([name, def]) => [name, presetFormFields(def)]),
  ),
  ...Object.fromEntries(
    Object.entries(DIAGNOSTIC_PRESETS).map(([name, def]) => [name, def.form]),
  ),
};

const setPresetFields = (name) => {
  const preset = PRESETS[name];
  if (!preset) return;
  // A preset is a complete starting scenario. Reset every dial to its default
  // first so a dial the preset doesn't touch (e.g. an earlier loan-rate edit)
  // can't linger and make the shareable `?preset=name` link irreproducible.
  if (defaultsReady()) {
    for (const spec of SCENARIO_FIELD_SPECS) byId(spec.id).value = defaultFieldValues[spec.id];
  }
  byId("target-mode").value = preset.targetMode;
  if (preset.topShare !== undefined) byId("top-share").value = preset.topShare;
  byId("exemption").value = preset.exemption;
  byId("tax-rate").value = preset.rate;
  renderBrackets(
    (preset.brackets ?? []).map(([threshold, rate]) => ({
      threshold: threshold * 1_000_000,
      rate: rate / 100,
    })),
  );
  if (preset.adultBenefit !== undefined) byId("adult-benefit").value = preset.adultBenefit;
  if (preset.childBenefit !== undefined) byId("child-benefit").value = preset.childBenefit;
  if (preset.directCashShare !== undefined) byId("direct-cash-share").value = preset.directCashShare;
  const fieldMap = {
    administrativeShare: "administrative-share", borrowShare: "borrow-share",
    sellShare: "sell-share", surplusUse: "surplus-use", assetHedgeShare: "asset-hedge-share",
    housingHedgeShare: "housing-hedge-share", housingSupply: "housing-supply",
    rentPassThrough: "rent-pass-through", buyerDepth: "buyer-depth",
    priceImpact: "price-impact", serviceEffectiveness: "service-effectiveness",
  };
  for (const [key, id] of Object.entries(fieldMap)) {
    if (preset[key] !== undefined) byId(id).value = preset[key];
  }
  syncTargetControls();
  syncAllSliders();
};

const applyPreset = (name) => {
  if (!PRESETS[name]) return;
  setPresetFields(name);
  setActivePreset(name);
  void dashboardRerun();
};

const applyBehaviorPreset = (name) => {
  // Reduced-form literature anchors (issue #6): full compliance captures the
  // model's 100%-remittance assumption, the Scandinavian case reflects the low
  // avoidance elasticities in Seim (2017), and the French ISF case reflects the
  // heavier avoidance and expatriation documented by Pichet (2007).
  const presets = {
    "full-compliance": { avoidance: 0, expatriation: 0, inclusion: 100 },
    scandinavian: { avoidance: 7, expatriation: 4, inclusion: 85 },
    "french-isf": { avoidance: 20, expatriation: 15, inclusion: 60 },
  };
  const preset = presets[name];
  if (!preset) return;
  byId("avoidance-elasticity").value = preset.avoidance;
  byId("expatriation-share").value = preset.expatriation;
  byId("private-business-inclusion").value = preset.inclusion;
  syncAllSliders();
  setActivePreset(null);
  void dashboardRerun();
};

const applyEconomyPreset = (name) => {
  const presets = {
    closed: { foreignBuyers: 0, foreignDebt: 0, outflow: 0, repatriation: 0 },
    "partially-open": { foreignBuyers: 35, foreignDebt: 40, outflow: 30, repatriation: 15 },
    "open-stress": { foreignBuyers: 70, foreignDebt: 60, outflow: 80, repatriation: 10 },
  };
  const preset = presets[name];
  if (!preset) return;
  byId("economy-closure").value = name;
  byId("foreign-buyer-share").value = preset.foreignBuyers;
  byId("foreign-treasury-share").value = preset.foreignDebt;
  byId("capital-outflow-response").value = preset.outflow;
  byId("repatriation-fx-pass-through").value = preset.repatriation;
  syncAllSliders();
  setActivePreset(null);
  void dashboardRerun();
};

const setFormStatus = (message, isError = false) => {
  const status = byId("form-status");
  status.textContent = message;
  status.classList.toggle("error", isError);
};

byId("scenario-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void dashboardRerun();
});
byId("run-button").addEventListener("click", (event) => {
  event.preventDefault();
  void dashboardRerun();
});
// Sliders are built in initialize() (after the module fully evaluates, so `clamp`
// and friends are defined) and once the fetched defaults have populated the form.
// Any manual edit means the form no longer matches a named preset, so the URL
// falls back to explicit field params, and the model auto-runs (debounced).
// Programmatic .value writes don't fire this.
// A graduated schedule mid-entry (threshold typed, rate still blank) would fail
// validateBrackets and flash a red error on every keystroke; only auto-run once
// every present bracket row is complete (an empty schedule is trivially complete).
const bracketRowsComplete = () =>
  readBracketRows().every(
    (bracket) => !Number.isNaN(bracket.threshold) && !Number.isNaN(bracket.rate),
  );
byId("scenario-form").addEventListener("input", (event) => {
  const target = event.target;
  setActivePreset(null);
  // Direct typing into a number field mirrors onto its slider (the slider's own
  // handler covers the reverse); also enforce the joint borrow/sell clamp.
  if (target instanceof HTMLInputElement && target.type === "number") {
    applyJointConstraint(target);
    syncSlider(target.id);
  }
  updateScenarioUrl();
  // Clearing a cell of an already-scheduled complete bracket must also cancel the
  // pending run, or it fires with the now-incomplete row and flashes the error.
  if (bracketRowsComplete()) scheduleAutoRun();
  else clearTimeout(autoRunTimer);
});
// Selects fire change (not reliably input across browsers); auto-run on those too.
byId("scenario-form").addEventListener("change", (event) => {
  if (event.target instanceof HTMLSelectElement) {
    setActivePreset(null);
    if (bracketRowsComplete()) scheduleAutoRun();
    else clearTimeout(autoRunTimer);
  }
});
byId("pin-button").addEventListener("click", () => void pinCurrentScenario());
byId("clear-pin-button").addEventListener("click", () => clearPin());
byId("copy-link-button").addEventListener("click", () => void copyScenarioLink());
byId("scenario-drawer-trigger").addEventListener("click", (event) =>
  openScenarioDrawer({ trigger: event.currentTarget }),
);
byId("scenario-drawer-close").addEventListener("click", () => closeScenarioDrawer());
byId("scenario-drawer-done").addEventListener("click", () => void finishScenarioEdits());
byId("scenario-drawer").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeScenarioDrawer();
});
byId("scenario-drawer").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeScenarioDrawer();
});
byId("scenario-drawer").addEventListener("close", finishDrawerClose);
byId("scenario-drawer").addEventListener("click", (event) => {
  const drawer = event.currentTarget;
  if (event.target === drawer) {
    closeScenarioDrawer();
    return;
  }
  const link = event.target.closest?.('a[href^="#"]');
  if (!link) return;
  const targetId = decodeURIComponent(link.hash.slice(1));
  const target = byId(targetId);
  if (!target) return;
  event.preventDefault();
  closeScenarioDrawer({ restoreFocus: false });
  requestAnimationFrame(() => {
    const details = target.closest("details");
    if (details instanceof HTMLDetailsElement) details.open = true;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${link.hash}`,
    );
    target.scrollIntoView({ behavior: drawerScrollBehavior, block: "start" });
  });
});
byId("distribution-strategy").addEventListener("change", () => {
  renderDistribution();
  updateScenarioUrl();
});
byId("target-mode").addEventListener("change", syncTargetControls);
byId("add-bracket").addEventListener("click", () => {
  byId("bracket-rows").append(makeBracketRow());
  setActivePreset(null);
  syncBracketMode();
  updateScenarioUrl();
});
byId("clear-brackets").addEventListener("click", () => {
  renderBrackets([]);
  setActivePreset(null);
  updateScenarioUrl();
});
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});
byId("persona-form").addEventListener("input", () => {
  renderPersona(latestResult);
  updateScenarioUrl();
});
byId("persona-form").addEventListener("submit", (event) => event.preventDefault());
// Caveat links open the collapsed model-details panel so "see the limits"
// always lands on the boundaries list rather than an unopened <details>.
document.addEventListener("click", (event) => {
  const scenarioLink = event.target.closest?.('a[href="#assumptions-anchor"]');
  if (scenarioLink && !byId("scenario-drawer").contains(scenarioLink)) {
    event.preventDefault();
    if (document.body.dataset.view === "story") enterDashboard();
    openScenarioDrawer({ trigger: scenarioLink });
    return;
  }
  const link = event.target.closest?.(".caveat-link");
  if (!link) return;
  const details = byId("caveats")?.closest("details");
  if (details) details.open = true;
});
restorePersona();

// ---------------------------------------------------------------------------
// Story mode — a guided, step-driven narrative that builds the argument one
// dial at a time before revealing the full dashboard. Every step reuses the
// existing scenario engine and form fields, so a dial moved here re-runs the
// same model the dashboard does. Deep-linkable via ?step=N.
// ---------------------------------------------------------------------------

const STORY_SEEN_KEY = "macroscope-story-seen";

// A step `setup` runs ONCE when the reader enters the step, establishing a
// coherent, in-range baseline for the single dial that step exposes. Doing it on
// entry (not per dial move) keeps the lone dial the only thing that changes
// while it's dragged — so moves are reversible and history-independent, and a
// companion field is never silently rewritten mid-interaction.
const setupExemptionStep = (result) => {
  // Start the dollar-exemption exploration from the current effective cutoff
  // (works whether the chosen preset used top-share or a dollar exemption),
  // rounded into the dial's range so control, copy, chart, and model all agree
  // the moment the step opens.
  const effectiveMillions = result.wealthTaxTarget.effectiveExemption / 1_000_000;
  byId("exemption").value = String(clamp(Math.round(effectiveMillions), 0, 50));
  byId("target-mode").value = "exemption";
  syncTargetControls();
};
// The borrow dial is the only payment control the story exposes; fix the sell
// share at zero so the dial spans the full 0–100% (cash = 100 − borrow) without
// tripping the borrow+sell ≤ 100 rule, and so equal dial positions always model
// the same split regardless of drag history.
const setupBorrowStep = () => {
  byId("sell-share").value = "0";
};
// The default revenue-constrained rule caps spending at tax receipts, so the
// deficit — and thus monetization — is zero. Establish fixed-benefit funding on
// entry so the monetization dial (and only it) drives the inflation response.
const setupMonetizationStep = () => {
  byId("funding-rule").value = "fixed";
  // The dial monetizes a deficit, so one must exist. A benefit fully covered by
  // tax receipts (e.g. a near-zero benefit carried in from the dashboard) runs
  // no deficit even under fixed funding, leaving the dial inert; $1k/mo adult
  // reliably exceeds tax receipts for the U.S. population, so floor it there.
  if (Number(byId("adult-benefit").value) < 1000) byId("adult-benefit").value = "1000";
};

// Each step reads live values off `latestResult`, so its copy adapts to the
// reader's current settings. `dial` binds a range input to an existing form
// field (values are in the field's own units).
const STORY_STEPS = [
  {
    id: "question",
    kicker: "Start with the question",
    title: "Tax the richest, send everyone a check. Who ends up better off?",
    body: () =>
      "You are about to build that answer yourself — one mechanism at a time. Pick a headline policy to begin; every dial you move re-runs the same U.S. model behind the full dashboard.",
    presets: true,
  },
  {
    id: "who-pays",
    kicker: "Who the tax touches",
    title: "The tax hits only a sliver of households.",
    setup: setupExemptionStep,
    body: (r) =>
      `With the line at ${compactMoney.format(r.wealthTaxTarget.effectiveExemption)} of net worth, wealth stacks up in the top decile — that is where the tax bites. Drag the exemption and watch which deciles fall above the line.`,
    dial: { field: "exemption", label: "Exemption ($M net worth)", min: 0, max: 50, step: 1 },
    viz: (host, r) => renderWealthStrip(host, r),
    readout: (r) =>
      `${compactMoney.format(r.projection.annualFlows.taxCollected)} collected in year one on wealth above the line.`,
  },
  {
    id: "how-they-pay",
    kicker: "How the wealthy pay",
    title: "They rarely sell. They borrow against their wealth.",
    setup: setupBorrowStep,
    body: (r) =>
      `A wealth-tax bill can be paid with cash or by borrowing against assets. The more the reader assumes is borrowed, the more new bank lending the policy triggers. Right now ${percent.format(r.projection.behaviorMix.borrowShare)} is borrowed.`,
    dial: { field: "borrow-share", label: "Share paid by borrowing (%)", min: 0, max: 100, step: 5 },
    viz: (host, r) => renderPaymentSplit(host, r),
    readout: (r) =>
      `${compactMoney.format(r.projection.annualFlows.newPrivateLoans)} in new bank loans in year one — deposits created out of nothing.`,
  },
  {
    id: "loans-make-money",
    kicker: "Bank loans create money",
    title: "New loans expand the money supply.",
    setup: setupBorrowStep,
    body: () =>
      "Taxing and transferring existing deposits just reshuffles money. New bank loans are different: they create fresh deposits. Keep moving the borrow dial and watch M2 respond over ten years.",
    dial: { field: "borrow-share", label: "Share paid by borrowing (%)", min: 0, max: 100, step: 5 },
    viz: (host, r) => renderStoryChart(host, "story-money-chart", moneyChartOptions(r.projection)),
    readout: (r) =>
      `M2 ends ${signedPercent(r.projection.summary.cumulativeM2Change)} versus the no-policy path.`,
  },
  {
    id: "prices-respond",
    kicker: "Prices respond",
    title: "More money chasing goods can lift prices.",
    setup: setupMonetizationStep,
    body: (r) =>
      `With a benefit funded partly by deficit, whether it shows up as inflation depends on how much the central bank monetizes. Peak annual inflation in this run is ${formatRate(r.projection.summary.peakAnnualInflation)}. Turn the monetization dial to test it.`,
    dial: { field: "monetization", label: "Deficit monetized (%)", min: 0, max: 100, step: 5 },
    viz: (host, r) => renderStoryChart(host, "story-price-chart", moneyChartOptions(r.projection)),
    readout: (r) =>
      `Peak annual inflation ${formatRate(r.projection.summary.peakAnnualInflation)} — ${regimeFor(r.projection.summary.peakAnnualInflation)} regime.`,
  },
  {
    id: "who-wins",
    kicker: "Who wins after prices",
    title: "After inflation, does the bottom half keep more?",
    body: (r) =>
      `This is the payoff. The check helps first; prices and financing decide whether it lasts. Adjust the monthly benefit and read the bottom-half line — currently ${signedPercent(r.projection.summary.bottom50PurchasingPowerChange)} of buying power versus no policy.`,
    dial: { field: "adult-benefit", label: "Adult monthly benefit ($)", min: 0, max: 3000, step: 100 },
    viz: (host, r) => renderStoryChart(host, "story-power-chart", powerChartOptions(r.projection)),
    readout: (r) =>
      `Bottom 50% buying power ends ${signedPercent(r.projection.summary.bottom50PurchasingPowerChange)}; top 1% real wealth ${signedPercent(r.projection.years?.at(-1)?.top1RealWealthIndex != null ? r.projection.years.at(-1).top1RealWealthIndex / 100 - 1 : 0)}.`,
  },
  {
    id: "verdict",
    kicker: "The verdict, now earned",
    title: "You built the argument. Here is where it lands.",
    body: (r) =>
      `${r.projection.verdict.explanation} Every dial you touched is unlocked in the full dashboard, alongside the funding-path comparison, decile table, and inflation stress test.`,
    verdict: true,
  },
];

const storyState = { index: 0, running: false, pending: false, dynamic: null, runPromise: null };

const debounce = (fn, wait) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

const renderStoryChart = (host, id, options) => {
  const chart = document.createElement("div");
  chart.className = "chart";
  chart.id = id;
  host.append(chart);
  renderLineChart(id, options);
};

// A log-scaled decile strip: bars are per-decile average net worth, the dashed
// line is the exemption, and any decile whose households actually paid tax is
// highlighted as "above the line".
const renderWealthStrip = (host, result) => {
  const deciles = result.strategies["cash-first"].distribution.deciles;
  const exemption = result.wealthTaxTarget.effectiveExemption;
  const safeLog = (value) => Math.log10(Math.max(1, value));
  const values = deciles.map((decile) => safeLog(decile.averageNetWorthBefore));
  const high = Math.max(safeLog(exemption), ...values) * 1.08;
  const width = 720;
  const height = 260;
  const margin = { top: 18, right: 16, bottom: 30, left: 16 };
  const plotHeight = height - margin.top - margin.bottom;
  const bandWidth = (width - margin.left - margin.right) / deciles.length;
  const yFor = (logValue) => margin.top + (1 - logValue / high) * plotHeight;
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `Average net worth by decile with the ${compactMoney.format(exemption)} exemption line drawn across.`,
  });
  const taxedDeciles = deciles.filter((decile) => decile.averageTaxPaid > 0).length;
  deciles.forEach((decile, index) => {
    const barX = margin.left + index * bandWidth + bandWidth * 0.14;
    const barW = bandWidth * 0.72;
    const top = yFor(values[index]);
    const taxed = decile.averageTaxPaid > 0;
    const rect = svgNode("rect", {
      x: barX,
      y: top,
      width: barW,
      height: margin.top + plotHeight - top,
      class: taxed ? "strip-bar taxed" : "strip-bar",
      rx: 2,
    });
    rect.append(svgNode("title", {}, `Decile ${decile.decile}: ${money.format(decile.averageNetWorthBefore)} average net worth${taxed ? `, ${money.format(decile.averageTaxPaid)} tax paid` : ", untaxed"}`));
    svg.append(rect);
    svg.append(svgNode("text", { x: barX + barW / 2, y: height - 10, class: "axis-label", "text-anchor": "middle" }, `D${decile.decile}`));
  });
  const lineY = yFor(safeLog(exemption));
  svg.append(svgNode("line", { x1: margin.left, y1: lineY, x2: width - margin.right, y2: lineY, class: "baseline-line" }));
  svg.append(svgNode("text", { x: width - margin.right, y: lineY - 7, class: "series-label series-b", "text-anchor": "end" }, `Exemption ${compactMoney.format(exemption)}`));
  const chart = document.createElement("div");
  chart.className = "chart strip-chart";
  chart.append(svg);
  host.append(chart);
  const note = element(
    "p",
    taxedDeciles > 0
      ? `${taxedDeciles} of 10 deciles hold households above the line. Wealth is log-scaled, so the top decile towers over the rest.`
      : "No decile's average sits above the line — the tax lands only on the far tail inside the top decile.",
  );
  note.className = "story-note";
  host.append(note);
};

// A single stacked bar showing how a wealth-tax bill is settled.
const renderPaymentSplit = (host, result) => {
  const mix = result.projection.behaviorMix;
  const cashShare = Math.max(0, 1 - mix.borrowShare - mix.sellShare);
  const segments = [
    { label: "Cash", share: cashShare, tone: "seg-cash" },
    { label: "Borrow", share: mix.borrowShare, tone: "seg-borrow" },
    { label: "Sell assets", share: mix.sellShare, tone: "seg-sell" },
  ].filter((segment) => segment.share > 0.0001);
  const bar = document.createElement("div");
  bar.className = "payment-split";
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", segments.map((segment) => `${segment.label} ${percent.format(segment.share)}`).join(", "));
  segments.forEach((segment) => {
    const cell = document.createElement("span");
    cell.className = `split-seg ${segment.tone}`;
    cell.style.flexGrow = String(Math.max(0.02, segment.share));
    if (segment.share >= 0.12) cell.textContent = `${segment.label} · ${percent.format(segment.share)}`;
    bar.append(cell);
  });
  host.append(bar);
};

const renderStory = () => {
  if (!latestResult) return;
  const step = STORY_STEPS[storyState.index];
  const stage = byId("story-stage");
  stage.replaceChildren();

  // Establish this step's baseline once, on entry (before the dial is built).
  // If setup — or the out-of-range clamp below — changed the form, rerun so
  // copy, chart, and result reflect the baseline the dial now sits on.
  let needsResync = false;
  if (step.setup) {
    const before = JSON.stringify(formRequest());
    step.setup(latestResult);
    if (JSON.stringify(formRequest()) !== before) needsResync = true;
  }

  const copy = document.createElement("div");
  copy.className = "story-copy";
  const kicker = element("p", step.kicker);
  kicker.className = "kicker";
  copy.append(kicker);
  const title = element("h1", step.title);
  title.id = "story-title";
  copy.append(title);
  const bodyNode = element("p", step.body(latestResult));
  bodyNode.className = "story-body";
  copy.append(bodyNode);
  stage.append(copy);

  if (step.presets) {
    const presetWrap = document.createElement("div");
    presetWrap.className = "story-presets";
    [
      ["top-one", "1% on top 1%"],
      ["billionaire", "10% over $1B"],
      ["ten-million", "5% over $10M"],
      ["universal", "Universal 1% + UBI"],
    ].forEach(([preset, label]) => {
      const button = element("button", label);
      button.type = "button";
      button.addEventListener("click", async () => {
        setPresetFields(preset);
        setActivePreset(preset);
        await storyRerun();
      });
      presetWrap.append(button);
    });
    stage.append(presetWrap);
  }

  if (step.dial) {
    const field = byId(step.dial.field);
    const inRange = clamp(Number(field.value), step.dial.min, step.dial.max);
    // Safety net for a dial without a setup (e.g. a benefit above the $3k dial
    // max carried in from the dashboard): snap the field into range so the
    // control can't display a value the model doesn't use.
    if (Number(field.value) !== inRange) {
      field.value = String(inRange);
      needsResync = true;
    }
    stage.append(buildStoryDial(step.dial));
  }

  const viz = document.createElement("div");
  viz.className = "story-viz";
  stage.append(viz);
  if (step.viz) step.viz(viz, latestResult);

  let readout = null;
  if (step.readout) {
    readout = element("p", step.readout(latestResult));
    readout.className = "story-readout";
    stage.append(readout);
  }

  let verdictRefs = null;
  if (step.verdict) {
    const verdict = latestResult.projection.verdict;
    document.body.dataset.verdict = verdict.rating;
    const panel = document.createElement("div");
    panel.className = "story-verdict";
    const badge = element("span", `${verdict.scope === "cash-only" ? "cash-only · " : "cash + service estimate · "}${verdict.rating}`);
    badge.className = "verdict-badge";
    const headline = element("strong", verdict.headline);
    panel.append(badge, headline);
    stage.append(panel);
    verdictRefs = { badge, headline };
    const enter = element("button", "Explore the full dashboard →");
    enter.type = "button";
    enter.className = "run-button story-enter";
    enter.addEventListener("click", () => enterDashboard());
    stage.append(enter);
  }

  // Story-scoped error line: runScenario reports failures only to the hidden
  // dashboard status, so surface them here when a rerun fails.
  const errorNode = element("p", "");
  errorNode.className = "story-error";
  errorNode.hidden = true;
  stage.append(errorNode);

  // Refs the dial-driven rerun refreshes in place, so the live <input> the
  // reader is dragging is never torn down mid-gesture (only these data-bound
  // nodes update).
  storyState.dynamic = { bodyNode, viz: step.viz ? viz : null, readout, verdict: verdictRefs, errorNode };

  // Setup/clamp changed the model inputs — rerun once so copy, chart, and
  // verdict reflect the baseline the dial now sits on.
  if (needsResync) void storyRerun();

  renderStoryProgress();
  byId("story-counter").textContent = `Step ${storyState.index + 1} of ${STORY_STEPS.length}`;
  byId("story-prev").disabled = storyState.index === 0;
  const next = byId("story-next");
  next.hidden = storyState.index === STORY_STEPS.length - 1;
};

const buildStoryDial = (dial) => {
  const field = byId(dial.field);
  const wrap = document.createElement("label");
  wrap.className = "story-dial";
  const header = document.createElement("span");
  header.className = "story-dial-head";
  header.append(element("span", dial.label));
  const valueOut = element("strong", "");
  header.append(valueOut);
  wrap.append(header);
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(dial.min);
  range.max = String(dial.max);
  range.step = String(dial.step);
  const current = clamp(Number(field.value), dial.min, dial.max);
  range.value = String(current);
  valueOut.textContent = String(current);
  // Write the shared field on every input so navigation mid-drag always sees
  // the current value; debounce only the (expensive) model rerun.
  const commit = debounce(() => storyRerun(), 220);
  range.addEventListener("input", () => {
    valueOut.textContent = range.value;
    field.value = range.value;
    commit();
  });
  wrap.append(range);
  return wrap;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const renderStoryProgress = () => {
  const progress = byId("story-progress");
  progress.replaceChildren(
    ...STORY_STEPS.map((step, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "story-dot";
      dot.setAttribute("aria-label", `Go to step ${index + 1}: ${step.kicker}`);
      if (index === storyState.index) dot.setAttribute("aria-current", "step");
      dot.addEventListener("click", () => goToStep(index));
      return dot;
    }),
  );
};

// Refresh only the data-bound nodes of the current step (adaptive copy, viz,
// readout) against the latest result — leaving the dial the reader is dragging
// in place. Full-step rebuilds go through renderStory (navigation/presets).
const refreshStoryDynamic = () => {
  const dynamic = storyState.dynamic;
  if (!dynamic) return;
  const step = STORY_STEPS[storyState.index];
  if (dynamic.errorNode) dynamic.errorNode.hidden = true;
  dynamic.bodyNode.textContent = step.body(latestResult);
  if (dynamic.viz && step.viz) {
    dynamic.viz.replaceChildren();
    step.viz(dynamic.viz, latestResult);
  }
  if (dynamic.readout && step.readout) {
    dynamic.readout.textContent = step.readout(latestResult);
  }
  // The verdict panel is not a plain text node; refresh its badge + headline so
  // navigating to the verdict step before an in-flight rerun settles can't leave
  // it showing the previous run's rating.
  if (dynamic.verdict) {
    const verdict = latestResult.projection.verdict;
    document.body.dataset.verdict = verdict.rating;
    dynamic.verdict.badge.textContent = `${verdict.scope === "cash-only" ? "cash-only · " : "cash + service estimate · "}${verdict.rating}`;
    dynamic.verdict.headline.textContent = verdict.headline;
  }
};

// Returns a promise that settles when the model (including any coalesced
// trailing reruns) is idle, so navigation can wait on an in-flight run.
const storyRerun = () => {
  // Coalesce concurrent dial moves: if a run is in flight, mark a rerun pending
  // and let the active loop pick up the newest field values when it finishes,
  // so the final dial position is never dropped (slider ↔ model stay in sync).
  if (storyState.running) {
    storyState.pending = true;
    return storyState.runPromise;
  }
  storyState.runPromise = (async () => {
    storyState.running = true;
    byId("story-stage").classList.add("is-busy");
    let ok = true;
    do {
      storyState.pending = false;
      ok = await runScenario();
    } while (storyState.pending);
    storyState.running = false;
    byId("story-stage").classList.remove("is-busy");
    if (ok) {
      refreshStoryDynamic();
    } else if (storyState.dynamic?.errorNode) {
      // Keep the visible view honest: the model rejected this setting, so don't
      // silently leave stale results next to the moved dial.
      storyState.dynamic.errorNode.textContent = "That setting couldn't be modeled. Adjust the dial and try again.";
      storyState.dynamic.errorNode.hidden = false;
    }
  })();
  return storyState.runPromise;
};

const goToStep = async (index) => {
  const target = clamp(index, 0, STORY_STEPS.length - 1);
  // Let an in-flight run (e.g. a just-clicked preset) settle first, so the next
  // step's setup derives its baseline from the selected scenario, not the prior
  // one, and the queued rerun can't overwrite the selection.
  if (storyState.running && storyState.runPromise) await storyState.runPromise;
  storyState.index = target;
  syncStoryUrl();
  renderStory();
  byId("story").scrollIntoView({ behavior: "smooth", block: "start" });
};

const syncStoryUrl = () => {
  const url = new URL(window.location.href);
  url.searchParams.set("step", String(storyState.index + 1));
  url.searchParams.delete("view");
  window.history.replaceState(null, "", url);
};

const enterStory = (index = 0) => {
  closeScenarioDrawer({ restoreFocus: false });
  storyState.index = clamp(index, 0, STORY_STEPS.length - 1);
  document.body.dataset.view = "story";
  syncStoryUrl();
  renderStory();
  window.scrollTo({ top: 0, behavior: "auto" });
};

const enterDashboard = () => {
  document.body.dataset.view = "dashboard";
  // The panel is now visible — run the sweep deferred during the walkthrough.
  flushPendingSensitivity();
  try {
    window.localStorage.setItem(STORY_SEEN_KEY, "1");
  } catch {
    // Private-mode storage failures must not break navigation.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("step");
  url.searchParams.set("view", "dashboard");
  window.history.replaceState(null, "", url);
  byId("story-launch").hidden = false;
  // The story wrote form fields programmatically; realign the dashboard sliders.
  syncAllSliders();
  window.scrollTo({ top: 0, behavior: "auto" });
};

const initStory = () => {
  byId("story-prev").addEventListener("click", () => goToStep(storyState.index - 1));
  byId("story-next").addEventListener("click", () => goToStep(storyState.index + 1));
  byId("story-skip").addEventListener("click", () => enterDashboard());
  byId("story-launch").addEventListener("click", () => enterStory(0));

  // If the model never loaded, there is nothing to narrate — show the dashboard
  // shell so its error status is visible. Do NOT persist the seen flag here: a
  // transient outage must not skip the walkthrough on the next successful visit.
  if (!latestResult) {
    document.body.dataset.view = "dashboard";
    byId("story-launch").hidden = true;
    return;
  }

  if (window.location.hash === "#assumptions-anchor") {
    enterDashboard();
    requestAnimationFrame(() => openScenarioDrawer());
    return;
  }

  const params = new URLSearchParams(window.location.search);
  // Floor so a fractional ?step=2.5 can't produce a fractional array index
  // (STORY_STEPS[1.5] is undefined → renderStory would throw).
  const stepParam = Math.floor(Number(params.get("step")));
  let seen = false;
  try {
    seen = window.localStorage.getItem(STORY_SEEN_KEY) === "1";
  } catch {
    seen = false;
  }
  if (Number.isFinite(stepParam) && stepParam >= 1) {
    enterStory(stepParam - 1);
  } else if (params.get("view") === "dashboard" || seen) {
    enterDashboard();
  } else {
    enterStory(0);
  }
};

document.querySelectorAll("[data-behavior-preset]").forEach((button) => {
  button.addEventListener("click", () => applyBehaviorPreset(button.dataset.behaviorPreset));
});
document.querySelectorAll("[data-economy-preset]").forEach((button) => {
  button.addEventListener("click", () => applyEconomyPreset(button.dataset.economyPreset));
});
byId("uncertainty-run").addEventListener("click", () => void startUncertainty());
byId("uncertainty-cancel").addEventListener("click", () => {
  uncertaintyState.token += 1;
  cancelUncertainty();
  setUncertaintyBusy(false);
  byId("uncertainty-status").textContent = "Joint uncertainty run cancelled.";
});
window.addEventListener("hashchange", () => {
  if (window.location.hash !== "#assumptions-anchor") return;
  if (document.body.dataset.view === "story") enterDashboard();
  openScenarioDrawer();
});
void initialize().then(initStory);
