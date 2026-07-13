import {
  FIELD_SPECS,
  encodeScenarioParams,
  decodeScenarioParams,
} from "./scenario-params.js";

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

const initialize = async () => {
  try {
    if (isStaticSnapshot) {
      const [defaultResponse, baselineResponse, snapshotResponse, backtestResponse] = await Promise.all([
        fetch("data/default-request.json"),
        fetch("data/us-baseline.json"),
        fetch("data/default-scenario.json"),
        fetch("data/historical-backtest.json"),
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
      renderSources(baseline.sources);
      populateForm(defaults);
      captureDefaultFieldValues();
      const hasScenarioParams = hydrateFormFromUrl();
      if (typeof Worker !== "undefined") ensureEngineWorker();
      if (hasScenarioParams) {
        // A shared URL carries its own assumptions — recompute rather than
        // showing the prebuilt default snapshot.
        await runScenario();
      } else {
        latestResult = snapshot;
        render(snapshot);
        byId("scenario-summary").textContent = scenarioSummary(defaults, snapshot);
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
    renderSources(baseline.sources);
    populateForm(defaults);
    captureDefaultFieldValues();
    hydrateFormFromUrl();
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
  byId("benefit-indexation").value = request.ubi.benefitIndexation ?? "none";
  byId("direct-cash-share").value = request.ubi.directCashShare * 100;
  byId("administrative-share").value = request.ubi.administrativeShare * 100;
  byId("buyer-depth").value = request.market.buyerDepthRatio * 100;
  byId("price-impact").value = request.market.priceImpactCoefficient;
  byId("maximum-ltv").value = request.market.maximumCollateralLtv * 100;
  byId("housing-supply").value = request.market.housingSupplyElasticity;
  byId("borrow-share").value = request.behavior.borrowShare * 100;
  byId("sell-share").value = request.behavior.sellShare * 100;
  byId("asset-return").value = request.behavior.annualAssetReturn * 100;
  byId("loan-rate").value = request.behavior.loanInterestRate * 100;
  byId("monetization").value = request.behavior.deficitMonetizationShare * 100;
  byId("asset-hedge-share").value = request.behavior.assetHedgeShare * 100;
  byId("housing-hedge-share").value = request.behavior.housingHedgeShare * 100;
  byId("rent-pass-through").value = request.behavior.rentPassThrough * 100;
  byId("avoidance-elasticity").value = request.behavior.avoidanceElasticity * 100;
  byId("expatriation-share").value = request.behavior.expatriationShare * 100;
  byId("private-business-inclusion").value =
    request.behavior.privateBusinessInclusionRate * 100;
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
      benefitIndexation: byId("benefit-indexation").value,
      directCashShare: Number(byId("direct-cash-share").value) / 100,
      administrativeShare: Number(byId("administrative-share").value) / 100,
    },
    market: {
      buyerDepthRatio: Number(byId("buyer-depth").value) / 100,
      priceImpactCoefficient: Number(byId("price-impact").value),
      maximumCollateralLtv: Number(byId("maximum-ltv").value) / 100,
      housingSupplyElasticity: Number(byId("housing-supply").value),
    },
    behavior: {
      borrowShare: Number(byId("borrow-share").value) / 100,
      sellShare: Number(byId("sell-share").value) / 100,
      annualAssetReturn: Number(byId("asset-return").value) / 100,
      loanInterestRate: Number(byId("loan-rate").value) / 100,
      deficitMonetizationShare: Number(byId("monetization").value) / 100,
      assetHedgeShare: Number(byId("asset-hedge-share").value) / 100,
      housingHedgeShare: Number(byId("housing-hedge-share").value) / 100,
      rentPassThrough: Number(byId("rent-pass-through").value) / 100,
      avoidanceElasticity: Number(byId("avoidance-elasticity").value) / 100,
      expatriationShare: Number(byId("expatriation-share").value) / 100,
      privateBusinessInclusionRate:
        Number(byId("private-business-inclusion").value) / 100,
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
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", "Remove this bracket");
  remove.addEventListener("click", () => {
    row.remove();
    // A structural bracket change no longer matches a named preset.
    activePreset = null;
    syncBracketMode();
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
  });

const scenarioLink = () => {
  const query = scenarioQuery();
  return `${location.origin}${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
};

// Reflect the live form state in the address bar without adding history
// entries, so a reload or copied URL reproduces the current scenario.
const updateScenarioUrl = () => {
  if (!defaultsReady()) return;
  let query = scenarioQuery();
  // Preserve the walkthrough's ?step alongside the scenario params so a story
  // dial (which reruns the model, calling this) can't strip the step position —
  // enterDashboard is the only place that intentionally drops it.
  const step = new URLSearchParams(location.search).get("step");
  if (step) query = query ? `${query}&step=${step}` : `step=${step}`;
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
};

// Apply any scenario encoded in the current URL to the form. Returns true when
// the URL carried scenario state, so callers know to recompute.
const hydrateFormFromUrl = () => {
  const decoded = decodeScenarioParams(location.search);
  const appliedPreset = Boolean(decoded.preset && PRESETS[decoded.preset]);
  if (appliedPreset) {
    setPresetFields(decoded.preset);
    activePreset = decoded.preset;
  }
  const fieldIds = Object.keys(decoded.fields);
  for (const id of fieldIds) byId(id).value = decoded.fields[id];
  // A custom graduated schedule (br) overrides any preset-supplied brackets,
  // exactly as explicit field params override preset fields.
  const bracketRows = bracketsFromParam(decoded.brackets);
  const appliedBrackets = bracketRows.length > 0;
  if (appliedBrackets) renderBrackets(bracketRows);
  // Explicit field or bracket overrides make the state no longer a pristine preset.
  if (fieldIds.length > 0 || appliedBrackets) activePreset = null;
  // A stale/unknown strategy would blank the <select> and later crash
  // renderDistribution (strategies[""]); ignore anything not in STRATEGIES.
  const appliedStrategy = Boolean(decoded.strategy && STRATEGIES.includes(decoded.strategy));
  if (appliedStrategy) byId("distribution-strategy").value = decoded.strategy;
  syncTargetControls();
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

let toastTimer = null;
const showToast = (message, isError = false) => {
  const container = byId("toast-container");
  if (!container) return;
  const toast = element("div", message);
  toast.className = `toast${isError ? " error" : ""}`;
  container.replaceChildren(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 3600);
};

let engineWorker = null;
let engineWorkerFailed = false;
let engineRequestId = 0;
const enginePending = new Map();

const ensureEngineWorker = () => {
  if (engineWorker) return engineWorker;
  const worker = new Worker("./engine-worker.js", { type: "module" });
  worker.addEventListener("message", (event) => {
    const { id } = event.data ?? {};
    const respond = enginePending.get(id);
    if (!respond) return;
    enginePending.delete(id);
    respond(event.data);
  });
  worker.addEventListener("error", () => {
    worker.terminate();
    // A late error from an already-replaced worker must not drain the
    // replacement's pending requests.
    if (engineWorker !== worker) return;
    engineWorker = null;
    engineWorkerFailed = true;
    const waiting = [...enginePending.values()];
    enginePending.clear();
    waiting.forEach((respond) => respond({ ok: false, workerFailed: true }));
  });
  engineWorker = worker;
  return worker;
};

const runInWorker = (request, mode = "compare") =>
  new Promise((resolve) => {
    engineRequestId += 1;
    enginePending.set(engineRequestId, resolve);
    ensureEngineWorker().postMessage({ id: engineRequestId, request, mode });
  });

const runOnMainThread = async (request, mode = "compare") => {
  const engine = await import("./engine/browser/engine.js");
  return mode === "sensitivity"
    ? engine.analyzeSensitivity(request)
    : engine.compareScenarios(request);
};

const runLocalScenario = async (request, mode = "compare") => {
  const useWorker = typeof Worker !== "undefined" && !engineWorkerFailed;
  let response = useWorker ? await runInWorker(request, mode) : await runOnMainThread(request, mode);
  // Module workers can fail where Worker itself exists (older Firefox,
  // blocked worker loading) — retry the same request on the main thread.
  if (response?.workerFailed) response = await runOnMainThread(request, mode);
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

// The tornado sweep runs ~2N scenarios, so it is computed after the main verdict
// renders rather than blocking it. A monotonically increasing token guarantees a
// slower earlier run can never overwrite a newer scenario's chart.
let sensitivityToken = 0;
const refreshSensitivity = async (request) => {
  const token = (sensitivityToken += 1);
  byId("sensitivity-note").textContent = "Sweeping every assumption across its range…";
  try {
    const analysis = await runSensitivity(request);
    if (token !== sensitivityToken) return;
    renderSensitivity(analysis);
  } catch (error) {
    if (token !== sensitivityToken) return;
    byId("sensitivity-note").textContent =
      error instanceof Error ? error.message : "Sensitivity analysis unavailable.";
  }
};

const runScenario = async () => {
  const request = formRequest();
  if (request.wealthTax.brackets) {
    const bracketError = validateBrackets(request.wealthTax.brackets);
    if (bracketError) {
      setBracketError(bracketError);
      setFormStatus(bracketError, true);
      return;
    }
  }
  setBracketError(null);
  const button = byId("run-button");
  button.disabled = true;
  button.textContent = "Running the model…";
  setFormStatus("Running the U.S. distribution and ten-year projection…");
  try {
    const payload = isStaticSnapshot
      ? await runLocalScenario(request)
      : await runServerScenario(request);
    latestResult = payload;
    render(payload);
    byId("scenario-summary").textContent = scenarioSummary(request, payload);
    updateScenarioUrl();
    setFormStatus(`Updated from ${integer.format(payload.population.sampledHouseholds)} weighted household agents${isStaticSnapshot ? ", computed in your browser" : ""}.`);
    // Rank the assumptions behind this verdict without blocking the main render.
    void refreshSensitivity(request);
    return true;
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : "Scenario failed.", true);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = "Recalculate verdict";
  }
};

const render = (result) => {
  renderVerdict(result.projection);
  renderCharts(result.projection);
  renderWinners(result.projection);
  renderFlow(result.projection);
  renderTheory(result.projection.theoryTest, result.projection);
  renderStress(result.projection.stressTest);
  renderReasons(result.projection);
  renderDetails(result);
  renderPersona(result);
};

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
  const deliveryRatio = requestedUbi > 0
    ? result.projection.annualFlows.ubiReceived / requestedUbi
    : 0;
  const annualUbi = grossUbi * deliveryRatio;
  const exemption = result.wealthTaxTarget?.effectiveExemption ?? request.wealthTax.exemption;
  const annualTax = Math.max(0, netWorth - exemption) * request.wealthTax.rate;
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
      `You'd pay about ${money.format(annualTax)} in wealth tax and receive about ${money.format(annualUbi)} per year in UBI. Over ten years you'd end with about ${signedPercent(change)} ${groupMetricLabel(group)} versus the no-policy path${rentNote}.`,
    ),
  );
  const note = document.createElement("small");
  note.append(document.createTextNode("This maps you to the nearest synthetic cohort — a conditional scenario, not personal advice. "));
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
  byId("verdict-badge").textContent = verdict.rating;
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
  return {
    description: `M2 ends at index ${years.at(-1).m2Index.toFixed(1)} and the price level at ${(years.at(-1).priceLevel * 100).toFixed(1)}, with 100 before policy.`,
    series: [
      { label: "M2 money stock", values: years.map((year) => year.m2Index), tone: "series-c" },
      { label: "Price level", values: years.map((year) => year.priceLevel * 100), tone: "series-d" },
    ],
    baseline: 100,
    valueSuffix: "",
  };
};

const renderCharts = (projection) => {
  renderLineChart("power-chart", powerChartOptions(projection));
  renderLineChart("money-chart", moneyChartOptions(projection));
  byId("money-chart-caption").textContent = `M2 and prices, indexed to 100 · peak inflation ${formatRate(projection.summary.peakAnnualInflation)}`;
};

const renderLineChart = (id, options) => {
  const root = byId(id);
  root.replaceChildren();
  const width = 720;
  const height = 300;
  const margin = { top: 24, right: 148, bottom: 38, left: 48 };
  const allValues = options.series.flatMap((series) => series.values);
  const low = Math.min(options.baseline, ...allValues);
  const high = Math.max(options.baseline, ...allValues);
  const padding = Math.max(4, (high - low) * 0.18);
  const yMin = Math.floor((low - padding) / 5) * 5;
  const yMax = Math.ceil((high + padding) / 5) * 5;
  const x = (index, count) => margin.left + (index / Math.max(1, count - 1)) * (width - margin.left - margin.right);
  const y = (value) => margin.top + ((yMax - value) / Math.max(1, yMax - yMin)) * (height - margin.top - margin.bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": options.description });
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

  options.series.forEach((series, seriesIndex) => {
    const points = series.values.map((value, index) => `${x(index, series.values.length)},${y(value)}`).join(" ");
    svg.append(svgNode("polyline", { points, class: `data-line ${series.tone}`, fill: "none" }));
    series.values.forEach((value, index) => {
      const circle = svgNode("circle", { cx: x(index, series.values.length), cy: y(value), r: index === series.values.length - 1 ? 4 : 2.5, class: `data-point ${series.tone}` });
      circle.append(svgNode("title", {}, `${series.label}, year ${index}: ${value.toFixed(1)}${options.valueSuffix}`));
      svg.append(circle);
    });
    const finalValue = series.values.at(-1);
    const finalLabelY = labelY.get(seriesIndex) ?? y(finalValue);
    svg.append(svgNode("text", { x: width - margin.right + 12, y: finalLabelY - 5, class: `series-label ${series.tone}` }, series.label));
    svg.append(svgNode("text", { x: width - margin.right + 12, y: finalLabelY + 13, class: "series-value" }, `${finalValue.toFixed(1)}${options.valueSuffix}`));
  });
  root.append(svg);
};

const renderFlow = (projection) => {
  const { behaviorMix, annualFlows, summary } = projection;
  const finalYear = annualFlows.finalYear;
  byId("flow-tax").textContent = compactMoney.format(annualFlows.taxCollected);
  const baseTrend = finalYear && finalYear.taxCollected < annualFlows.taxCollected
    ? "erodes"
    : finalYear && finalYear.taxCollected > annualFlows.taxCollected
      ? "grows"
      : "holds steady";
  byId("flow-tax-detail").textContent = finalYear
    ? `${compactMoney.format(finalYear.taxCollected)} by year ten as the taxed base ${baseTrend}`
    : "on net worth above the exemption";
  byId("flow-mix").textContent = `${percent.format(behaviorMix.borrowShare)} borrow · ${percent.format(behaviorMix.sellShare)} sell`;
  byId("flow-loans").textContent = `${compactMoney.format(annualFlows.newPrivateLoans)} in new bank loans in year one${finalYear ? ` · ${compactMoney.format(finalYear.newPrivateLoans)} by year ten` : ""}`;
  byId("flow-ubi").textContent = `${compactMoney.format(annualFlows.ubiReceived)} cash · ${compactMoney.format(annualFlows.publicServicesSpending)} services`;
  byId("flow-balance").textContent = `${compactMoney.format(annualFlows.administrativeCost)} administration${annualFlows.governmentDeficit > 1 ? ` · ${compactMoney.format(annualFlows.governmentDeficit)} deficit` : " · no modeled deficit"}`;
  byId("flow-result").textContent = `${signedPercent(summary.bottom50PurchasingPowerChange)} buying power`;
  byId("flow-debt").textContent = `${compactMoney.format(summary.privateTaxDebt)} in private tax debt`;
  const m2Sentence = annualFlows.m2Injection >= 0
    ? `The selected borrowing behavior adds ${compactMoney.format(annualFlows.m2Injection)} to M2 in year one`
    : `Unspent tax revenue parked at Treasury drains ${compactMoney.format(Math.abs(annualFlows.m2Injection))} from M2 in year one, outweighing loan-created deposits`;
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
    description: `The middle-homeowner wealth index ends at ${years.at(-1).middleHomeownerWealthIndex.toFixed(1)}, renter housing burden at ${years.at(-1).bottomRenterHousingBurdenIndex.toFixed(1)}, and renter disposable income at ${years.at(-1).bottomRenterDisposableIncomeIndex.toFixed(1)}, with 100 representing no policy.`,
    series: [
      { label: "Middle homeowner wealth", values: years.map((year) => year.middleHomeownerWealthIndex), tone: "series-a" },
      { label: "Renter housing burden", values: years.map((year) => year.bottomRenterHousingBurdenIndex), tone: "series-b" },
      { label: "Renter disposable income", values: years.map((year) => year.bottomRenterDisposableIncomeIndex), tone: "series-c" },
    ],
    baseline: 100,
    valueSuffix: "",
  });
};

const renderStress = (stress) => {
  const headRow = document.createElement("tr");
  headRow.append(element("th", "UBI scale"));
  stress.monetizationShares.forEach((share) => headRow.append(element("th", `${percent.format(share)} monetized`)));
  byId("stress-head").replaceChildren(headRow);
  byId("stress-body").replaceChildren(...stress.ubiMultipliers.map((multiplier) => {
    const row = document.createElement("tr");
    row.append(element("th", `${multiplier}×`));
    stress.monetizationShares.forEach((share) => {
      const cellData = stress.cells.find((cell) => cell.ubiMultiplier === multiplier && cell.monetizationShare === share);
      const cell = element("td", stressInflationLabel(cellData.peakAnnualInflation));
      cell.className = cellData.regime;
      cell.setAttribute("aria-label", `${multiplier} times UBI, ${percent.format(share)} deficit monetized: peak annual inflation ${formatRate(cellData.peakAnnualInflation)}, ${cellData.regime}`);
      row.append(cell);
    });
    return row;
  }));
  byId("hyper-threshold").textContent = stress.threshold.firstUbiMultiplierAtFullMonetization === null
    ? stress.threshold.explanation
    : `First modeled breach: about ${integer.format(stress.threshold.firstUbiMultiplierAtFullMonetization)}× this UBI with the unfunded portion fully monetized. This is an extreme boundary, not a forecast.`;
};

// Load a swept assumption's value into its form field and recompute. The write
// is programmatic, so the form's input listener won't fire — clear the active
// preset here so the URL falls back to explicit field params. `snap` controls
// how the value is rounded onto the field's step grid: verdict-flip values snap
// "up"/"down" AWAY from the base so the rounded value stays past the tipping
// point (rounding to nearest could land just short and not actually flip);
// tornado endpoints are exact dial bounds, so they snap to the nearest step.
const applyDialValue = (formId, formValue, snap = "nearest") => {
  const field = byId(formId);
  if (!field) return;
  const step = Number(field.step) || 0.01;
  const decimals = step >= 1 ? 0 : String(step).split(".")[1]?.length ?? 2;
  const min = field.min !== "" ? Number(field.min) : -Infinity;
  const max = field.max !== "" ? Number(field.max) : Infinity;
  const rounder = snap === "up" ? Math.ceil : snap === "down" ? Math.floor : Math.round;
  const snapped = rounder(Number(formValue) / step) * step;
  field.value = clamp(snapped, min, max).toFixed(decimals);
  activePreset = null;
  void runScenario();
  byId("assumptions-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  byId("reason-benefit").textContent = `${compactMoney.format(annualFlows.ubiReceived)} reaches households as cash and ${compactMoney.format(annualFlows.publicServicesSpending)} funds services in year one, after ${compactMoney.format(annualFlows.administrativeCost)} in modeled administration${annualFlows.finalYear ? `; modeled year-ten flows deliver ${compactMoney.format(annualFlows.finalYear.ubiReceived)} in cash` : ""}. Cash buying power for the bottom half ends ${plainDirection(summary.bottom50PurchasingPowerChange)} relative to a no-policy path; in-kind service value is reported separately.`;
  byId("reason-risk").textContent = `${percent.format(behaviorMix.borrowShare)} of wealthy households’ payment behavior is represented by the borrow-first path. That leaves ${compactMoney.format(summary.privateTaxDebt)} of private tax debt after ten years and lifts M2 ${signedPercent(summary.cumulativeM2Change)}.`;
};

const renderDetails = (result) => {
  byId("population-households").textContent = integer.format(result.population.representedHouseholds);
  byId("population-wealth").textContent = compactMoney.format(result.population.aggregateNetWorth);
  byId("population-equity").textContent = compactMoney.format(result.population.aggregatePublicEquity);
  byId("population-sample").textContent = integer.format(result.population.sampledHouseholds);
  renderStrategyCards(result.strategies);
  renderComparison(result.strategies);
  renderDistribution();
  renderSectors(result.strategies);
  byId("caveat-list").replaceChildren(...result.caveats.map((caveat) => element("li", caveat)));
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
    ["Government balance", (outcome) => compactMoney.format(outcome.fiscal.governmentBalance)],
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
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": description });
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

const PRESETS = {
  "top-one": { targetMode: "top-share", topShare: 1, exemption: 10, rate: 1 },
  billionaire: { targetMode: "exemption", topShare: 1, exemption: 1000, rate: 10 },
  "ten-million": { targetMode: "exemption", topShare: 1, exemption: 10, rate: 5 },
  universal: { targetMode: "exemption", topShare: 100, exemption: 0, rate: 1, adultBenefit: 1000, childBenefit: 500, directCashShare: 100 },
  // Graduated proposals list [thresholdM, ratePct] rows; the shared setPresetFields
  // body renders them into the bracket editor. current-law clears the editor.
  "warren-2020": {
    targetMode: "exemption",
    exemption: 50,
    rate: 2,
    brackets: [[50, 2], [1000, 6]],
  },
  "sanders-2020": {
    targetMode: "exemption",
    exemption: 32,
    rate: 1,
    brackets: [[32, 1], [50, 2], [250, 3], [500, 4], [1000, 5], [2500, 6], [5000, 7], [10000, 8]],
  },
  "current-law": { targetMode: "exemption", topShare: 1, exemption: 10, rate: 0, brackets: [] },
};

const setPresetFields = (name) => {
  const preset = PRESETS[name];
  if (!preset) return;
  // A preset is a complete starting scenario. Reset every dial to its default
  // first so a dial the preset doesn't touch (e.g. an earlier loan-rate edit)
  // can't linger and make the shareable `?preset=name` link irreproducible.
  if (defaultsReady()) {
    for (const spec of FIELD_SPECS) byId(spec.id).value = defaultFieldValues[spec.id];
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
  syncTargetControls();
};

const applyPreset = (name) => {
  if (!PRESETS[name]) return;
  setPresetFields(name);
  activePreset = name;
  void runScenario();
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
  void runScenario();
};

const setFormStatus = (message, isError = false) => {
  const status = byId("form-status");
  status.textContent = message;
  status.classList.toggle("error", isError);
};

byId("scenario-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runScenario();
});
byId("run-button").addEventListener("click", (event) => {
  event.preventDefault();
  void runScenario();
});
// Any manual edit means the form no longer matches a named preset, so the URL
// falls back to explicit field params. Programmatic .value writes don't fire this.
byId("scenario-form").addEventListener("input", () => {
  activePreset = null;
});
byId("copy-link-button").addEventListener("click", () => void copyScenarioLink());
byId("distribution-strategy").addEventListener("change", () => {
  renderDistribution();
  updateScenarioUrl();
});
byId("target-mode").addEventListener("change", syncTargetControls);
byId("add-bracket").addEventListener("click", () => {
  byId("bracket-rows").append(makeBracketRow());
  activePreset = null;
  syncBracketMode();
});
byId("clear-brackets").addEventListener("click", () => {
  renderBrackets([]);
  activePreset = null;
});
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});
byId("persona-form").addEventListener("input", () => renderPersona(latestResult));
byId("persona-form").addEventListener("submit", (event) => event.preventDefault());
// Caveat links open the collapsed model-details panel so "see the limits"
// always lands on the boundaries list rather than an unopened <details>.
document.addEventListener("click", (event) => {
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
        activePreset = preset;
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
    const badge = element("span", verdict.rating);
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
    dynamic.verdict.badge.textContent = verdict.rating;
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
  window.history.replaceState(null, "", url);
};

const enterStory = (index = 0) => {
  storyState.index = clamp(index, 0, STORY_STEPS.length - 1);
  document.body.dataset.view = "story";
  syncStoryUrl();
  renderStory();
  window.scrollTo({ top: 0, behavior: "auto" });
};

const enterDashboard = () => {
  document.body.dataset.view = "dashboard";
  try {
    window.localStorage.setItem(STORY_SEEN_KEY, "1");
  } catch {
    // Private-mode storage failures must not break navigation.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("step");
  window.history.replaceState(null, "", url);
  byId("story-launch").hidden = false;
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
void initialize().then(initStory);
