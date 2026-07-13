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
      populateForm(defaults);
      latestResult = snapshot;
      render(snapshot);
      byId("scenario-summary").textContent = scenarioSummary(defaults, snapshot);
      setFormStatus("Default scenario shown. Change any assumption and recalculate — the model runs in your browser.");
      if (typeof Worker !== "undefined") ensureEngineWorker();
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
    populateForm(defaults);
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
  syncTargetControls();
};

const formRequest = () => ({
  schemaVersion: 1,
  seed: Number(byId("seed").value),
  sampleSize: Number(byId("sample-size").value),
  representedHouseholds,
  wealthTax: {
    targetMode: byId("target-mode").value,
    exemption: Number(byId("exemption").value) * 1_000_000,
    topShare: Number(byId("top-share").value) / 100,
    rate: Number(byId("tax-rate").value) / 100,
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
  const button = byId("run-button");
  button.disabled = true;
  button.textContent = "Running the model…";
  setFormStatus("Running the U.S. distribution and ten-year projection…");
  try {
    const request = formRequest();
    const payload = isStaticSnapshot
      ? await runLocalScenario(request)
      : await runServerScenario(request);
    latestResult = payload;
    render(payload);
    byId("scenario-summary").textContent = scenarioSummary(request, payload);
    setFormStatus(`Updated from ${integer.format(payload.population.sampledHouseholds)} weighted household agents${isStaticSnapshot ? ", computed in your browser" : ""}.`);
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
  const target = request.wealthTax.targetMode === "top-share"
    ? `top ${percent.format(request.wealthTax.topShare)}`
    : `wealth above ${compactMoney.format(result?.wealthTaxTarget?.effectiveExemption ?? request.wealthTax.exemption)}`;
  return `${formatRate(request.wealthTax.rate)} on ${target} · ${money.format(request.ubi.adultMonthlyBenefit)}/mo equivalent`;
};

const syncTargetControls = () => {
  const topShareMode = byId("target-mode").value === "top-share";
  byId("top-share").disabled = !topShareMode;
  byId("top-share-label").classList.toggle("is-disabled", !topShareMode);
  byId("exemption").disabled = topShareMode;
  byId("exemption-label").classList.toggle("is-disabled", topShareMode);
};

// Writes a named scenario preset into the shared form fields. Both the
// dashboard preset buttons and the story mode reuse this; only the dashboard
// re-runs the scenario immediately afterward.
const applyPresetFields = (name) => {
  const presets = {
    "top-one": { targetMode: "top-share", topShare: 1, exemption: 10, rate: 1 },
    billionaire: { targetMode: "exemption", topShare: 1, exemption: 1000, rate: 10 },
    "ten-million": { targetMode: "exemption", topShare: 1, exemption: 10, rate: 5 },
    universal: { targetMode: "exemption", topShare: 100, exemption: 0, rate: 1, adultBenefit: 1000, childBenefit: 500, directCashShare: 100 },
  };
  const preset = presets[name];
  if (!preset) return false;
  byId("target-mode").value = preset.targetMode;
  byId("top-share").value = preset.topShare;
  byId("exemption").value = preset.exemption;
  byId("tax-rate").value = preset.rate;
  if (preset.adultBenefit !== undefined) byId("adult-benefit").value = preset.adultBenefit;
  if (preset.childBenefit !== undefined) byId("child-benefit").value = preset.childBenefit;
  if (preset.directCashShare !== undefined) byId("direct-cash-share").value = preset.directCashShare;
  syncTargetControls();
  return true;
};

const applyPreset = (name) => {
  if (applyPresetFields(name)) void runScenario();
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
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});

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

const storyState = { index: 0, running: false, pending: false, dynamic: null };

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
        applyPresetFields(preset);
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
  const commit = debounce(async (value) => {
    field.value = String(value);
    await storyRerun();
  }, 220);
  range.addEventListener("input", () => {
    valueOut.textContent = range.value;
    commit(range.value);
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

const storyRerun = async () => {
  // Coalesce concurrent dial moves: if a run is in flight, mark a rerun pending
  // and let the active loop pick up the newest field values when it finishes,
  // so the final dial position is never dropped (slider ↔ model stay in sync).
  if (storyState.running) {
    storyState.pending = true;
    return;
  }
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
};

const goToStep = (index) => {
  storyState.index = clamp(index, 0, STORY_STEPS.length - 1);
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

void initialize().then(initStory);
