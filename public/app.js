const STRATEGIES = ["cash-first", "borrow-first", "sell-first"];
const LABELS = {
  "cash-first": "Cash first",
  "borrow-first": "Borrow first",
  "sell-first": "Sell first",
};

let latestResult = null;
let baseline = null;
let representedHouseholds = 0;
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
      const [defaultResponse, baselineResponse, snapshotResponse] = await Promise.all([
        fetch("data/default-request.json"),
        fetch("data/us-baseline.json"),
        fetch("data/default-scenario.json"),
      ]);
      if (!defaultResponse.ok || !baselineResponse.ok || !snapshotResponse.ok) {
        throw new Error("The published policy snapshot is unavailable.");
      }
      const defaults = await defaultResponse.json();
      baseline = await baselineResponse.json();
      const snapshot = await snapshotResponse.json();
      byId("service-status").classList.add("online");
      byId("service-status-text").textContent = "In-browser model";
      byId("baseline-label").textContent = `${baseline.label} · ${baseline.vintage} Fed wealth data · ${compactNumber(baseline.households)} households`;
      renderSources(baseline.sources);
      const urlState = readStateFromUrl();
      populateForm(urlState ? mergeRequest(defaults, urlState) : defaults);
      if (typeof Worker !== "undefined") ensureEngineWorker();
      if (urlState) {
        // A shared link carries a specific scenario — compute it rather than
        // showing the generic published snapshot.
        await runScenario();
        return;
      }
      latestResult = snapshot;
      render(snapshot);
      byId("scenario-summary").textContent = scenarioSummary(defaults, snapshot);
      setFormStatus("Default scenario shown. Change any assumption and recalculate — the model runs in your browser.");
      return;
    }
    const [healthResponse, defaultResponse, baselineResponse] = await Promise.all([
      fetch("/health"),
      fetch("/api/scenarios/default"),
      fetch("/api/baseline/us"),
    ]);
    if (!healthResponse.ok || !defaultResponse.ok || !baselineResponse.ok) {
      throw new Error("MacroScope service is unavailable.");
    }
    const health = await healthResponse.json();
    const defaults = await defaultResponse.json();
    baseline = await baselineResponse.json();
    byId("service-status").classList.add("online");
    byId("service-status-text").textContent = health.status;
    byId("baseline-label").textContent = `${baseline.label} · ${baseline.vintage} Fed wealth data · ${compactNumber(baseline.households)} households`;
    renderSources(baseline.sources);
    const urlState = readStateFromUrl();
    populateForm(urlState ? mergeRequest(defaults, urlState) : defaults);
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
    syncBracketMode();
  });
  row.append(element("span", "$"), threshold, element("span", "M →"), rate, element("span", "%"), remove);
  return row;
};

const renderBrackets = (brackets) => {
  // Tolerate anything a stale or hand-edited ?s= link can decode to: a non-array,
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

// --- Deep-linkable URL state --------------------------------------------------
// The full request is encoded as base64url JSON in ?s= so any scenario — bracket
// schedules included — round-trips through a shared link.
const encodeState = (request) => {
  const json = JSON.stringify(request);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_");
};

const decodeState = (encoded) => {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(escape(atob(normalized)));
  const parsed = JSON.parse(json);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
};

const readStateFromUrl = () => {
  const encoded = new URLSearchParams(window.location.search).get("s");
  if (!encoded) return null;
  try {
    return decodeState(encoded);
  } catch {
    return null;
  }
};

const writeStateToUrl = (request) => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("s", encodeState(request));
    window.history.replaceState(null, "", url);
  } catch {
    // A serialization failure must never block the model from rendering.
  }
};

const mergeRequest = (base, override) => ({
  ...base,
  ...override,
  wealthTax: { ...base.wealthTax, ...(override.wealthTax ?? {}) },
  ubi: { ...base.ubi, ...(override.ubi ?? {}) },
  market: { ...base.market, ...(override.market ?? {}) },
  behavior: { ...base.behavior, ...(override.behavior ?? {}) },
});

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

const runInWorker = (request) =>
  new Promise((resolve) => {
    engineRequestId += 1;
    enginePending.set(engineRequestId, resolve);
    ensureEngineWorker().postMessage({ id: engineRequestId, request });
  });

const runOnMainThread = async (request) =>
  (await import("./engine/browser/engine.js")).compareScenarios(request);

const runLocalScenario = async (request) => {
  const useWorker = typeof Worker !== "undefined" && !engineWorkerFailed;
  let response = useWorker ? await runInWorker(request) : await runOnMainThread(request);
  // Module workers can fail where Worker itself exists (older Firefox,
  // blocked worker loading) — retry the same request on the main thread.
  if (response?.workerFailed) response = await runOnMainThread(request);
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
    writeStateToUrl(request);
    setFormStatus(`Updated from ${integer.format(payload.population.sampledHouseholds)} weighted household agents${isStaticSnapshot ? ", computed in your browser" : ""}.`);
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : "Scenario failed.", true);
  } finally {
    button.disabled = false;
    button.textContent = "Recalculate verdict";
  }
};

const render = (result) => {
  renderVerdict(result.projection);
  renderCharts(result.projection);
  renderFlow(result.projection);
  renderTheory(result.projection.theoryTest, result.projection);
  renderStress(result.projection.stressTest);
  renderReasons(result.projection);
  renderDetails(result);
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

const renderCharts = (projection) => {
  const years = projection.years;
  renderLineChart("power-chart", {
    description: `Over ten years, bottom-half purchasing power ends at ${years.at(-1).bottom50PurchasingPowerIndex.toFixed(1)} and top-one-percent real wealth ends at ${years.at(-1).top1RealWealthIndex.toFixed(1)}, with 100 representing the no-policy path.`,
    series: [
      { label: "Bottom 50% buying power", values: years.map((year) => year.bottom50PurchasingPowerIndex), tone: "series-a" },
      { label: "Top 1% real wealth", values: years.map((year) => year.top1RealWealthIndex), tone: "series-b" },
    ],
    baseline: 100,
    valueSuffix: "",
  });
  renderLineChart("money-chart", {
    description: `M2 ends at index ${years.at(-1).m2Index.toFixed(1)} and the price level at ${(years.at(-1).priceLevel * 100).toFixed(1)}, with 100 before policy.`,
    series: [
      { label: "M2 money stock", values: years.map((year) => year.m2Index), tone: "series-c" },
      { label: "Price level", values: years.map((year) => year.priceLevel * 100), tone: "series-d" },
    ],
    baseline: 100,
    valueSuffix: "",
  });
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

const applyPreset = (name) => {
  // Single-rate presets omit `brackets`; graduated proposals list [thresholdM, ratePct]
  // rows. Every preset resets the bracket editor so switching is unambiguous.
  const presets = {
    "top-one": { targetMode: "top-share", topShare: 1, exemption: 10, rate: 1 },
    billionaire: { targetMode: "exemption", topShare: 1, exemption: 1000, rate: 10 },
    "ten-million": { targetMode: "exemption", topShare: 1, exemption: 10, rate: 5 },
    universal: { targetMode: "exemption", topShare: 100, exemption: 0, rate: 1, adultBenefit: 1000, childBenefit: 500, directCashShare: 100 },
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
  const preset = presets[name];
  if (!preset) return;
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
byId("distribution-strategy").addEventListener("change", renderDistribution);
byId("target-mode").addEventListener("change", syncTargetControls);
byId("add-bracket").addEventListener("click", () => {
  byId("bracket-rows").append(makeBracketRow());
  syncBracketMode();
});
byId("clear-brackets").addEventListener("click", () => renderBrackets([]));
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});
void initialize();
