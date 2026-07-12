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
      byId("service-status-text").textContent = "Published snapshot";
      byId("baseline-label").textContent = `${baseline.label} · ${baseline.vintage} Fed wealth data · ${compactNumber(baseline.households)} households`;
      renderSources(baseline.sources);
      populateForm(defaults);
      latestResult = snapshot;
      render(snapshot);
      byId("scenario-summary").textContent = `${formatRate(defaults.wealthTax.rate)} above ${compactMoney.format(defaults.wealthTax.exemption)} · ${money.format(defaults.ubi.adultMonthlyBenefit)}/mo adult UBI`;
      byId("run-button").textContent = "Interactive model runs locally";
      byId("run-button").disabled = true;
      setFormStatus("Published default scenario. Run the PortOS/PM2 app to change assumptions.");
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
  }
};

const populateForm = (request) => {
  representedHouseholds = request.representedHouseholds;
  byId("seed").value = request.seed;
  byId("sample-size").value = request.sampleSize;
  byId("exemption").value = request.wealthTax.exemption / 1_000_000;
  byId("tax-rate").value = request.wealthTax.rate * 100;
  byId("adult-benefit").value = request.ubi.adultMonthlyBenefit;
  byId("child-benefit").value = request.ubi.childMonthlyBenefit;
  byId("funding-rule").value = request.ubi.fundingRule;
  byId("buyer-depth").value = request.market.buyerDepthRatio * 100;
  byId("price-impact").value = request.market.priceImpactCoefficient;
  byId("maximum-ltv").value = request.market.maximumCollateralLtv * 100;
  byId("borrow-share").value = request.behavior.borrowShare * 100;
  byId("sell-share").value = request.behavior.sellShare * 100;
  byId("asset-return").value = request.behavior.annualAssetReturn * 100;
  byId("loan-rate").value = request.behavior.loanInterestRate * 100;
  byId("monetization").value = request.behavior.deficitMonetizationShare * 100;
};

const formRequest = () => ({
  schemaVersion: 1,
  seed: Number(byId("seed").value),
  sampleSize: Number(byId("sample-size").value),
  representedHouseholds,
  wealthTax: {
    exemption: Number(byId("exemption").value) * 1_000_000,
    rate: Number(byId("tax-rate").value) / 100,
  },
  ubi: {
    adultMonthlyBenefit: Number(byId("adult-benefit").value),
    childMonthlyBenefit: Number(byId("child-benefit").value),
    fundingRule: byId("funding-rule").value,
  },
  market: {
    buyerDepthRatio: Number(byId("buyer-depth").value) / 100,
    priceImpactCoefficient: Number(byId("price-impact").value),
    maximumCollateralLtv: Number(byId("maximum-ltv").value) / 100,
  },
  behavior: {
    borrowShare: Number(byId("borrow-share").value) / 100,
    sellShare: Number(byId("sell-share").value) / 100,
    annualAssetReturn: Number(byId("asset-return").value) / 100,
    loanInterestRate: Number(byId("loan-rate").value) / 100,
    deficitMonetizationShare: Number(byId("monetization").value) / 100,
  },
});

const runScenario = async () => {
  if (isStaticSnapshot) return;
  const button = byId("run-button");
  button.disabled = true;
  setFormStatus("Running the U.S. distribution and ten-year projection…");
  try {
    const request = formRequest();
    const response = await fetch("/api/scenarios/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.details?.join(" ") || payload.error || "Scenario failed.");
    }
    latestResult = payload;
    render(payload);
    byId("scenario-summary").textContent = `${formatRate(request.wealthTax.rate)} above ${compactMoney.format(request.wealthTax.exemption)} · ${money.format(request.ubi.adultMonthlyBenefit)}/mo adult UBI`;
    setFormStatus(`Updated from ${integer.format(payload.population.sampledHouseholds)} weighted household agents.`);
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : "Scenario failed.", true);
  } finally {
    button.disabled = false;
  }
};

const render = (result) => {
  renderVerdict(result.projection);
  renderCharts(result.projection);
  renderFlow(result.projection);
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

  options.series.forEach((series) => {
    const points = series.values.map((value, index) => `${x(index, series.values.length)},${y(value)}`).join(" ");
    svg.append(svgNode("polyline", { points, class: `data-line ${series.tone}`, fill: "none" }));
    series.values.forEach((value, index) => {
      const circle = svgNode("circle", { cx: x(index, series.values.length), cy: y(value), r: index === series.values.length - 1 ? 4 : 2.5, class: `data-point ${series.tone}` });
      circle.append(svgNode("title", {}, `${series.label}, year ${index}: ${value.toFixed(1)}${options.valueSuffix}`));
      svg.append(circle);
    });
    const finalValue = series.values.at(-1);
    svg.append(svgNode("text", { x: width - margin.right + 12, y: y(finalValue) - 5, class: `series-label ${series.tone}` }, series.label));
    svg.append(svgNode("text", { x: width - margin.right + 12, y: y(finalValue) + 13, class: "series-value" }, `${finalValue.toFixed(1)}${options.valueSuffix}`));
  });
  root.append(svg);
};

const renderFlow = (projection) => {
  const { behaviorMix, annualFlows, summary } = projection;
  byId("flow-tax").textContent = compactMoney.format(annualFlows.taxCollected);
  byId("flow-mix").textContent = `${percent.format(behaviorMix.borrowShare)} borrow · ${percent.format(behaviorMix.sellShare)} sell`;
  byId("flow-loans").textContent = `${compactMoney.format(annualFlows.newPrivateLoans)} in new bank loans each year`;
  byId("flow-ubi").textContent = compactMoney.format(annualFlows.ubiReceived);
  byId("flow-balance").textContent = annualFlows.governmentDeficit > 1
    ? `${compactMoney.format(annualFlows.governmentDeficit)} annual federal deficit`
    : "Revenue-constrained: no modeled federal deficit";
  byId("flow-result").textContent = `${signedPercent(summary.bottom50PurchasingPowerChange)} buying power`;
  byId("flow-debt").textContent = `${compactMoney.format(summary.privateTaxDebt)} in private tax debt`;
  byId("money-answer").innerHTML = `<strong>What this means:</strong><span>The tax-and-UBI transfer itself reshuffles deposits. The selected borrowing behavior adds ${compactMoney.format(annualFlows.m2Injection)} to M2 in year one; selling assets does not create deposits economy-wide.</span>`;
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
  byId("reason-benefit").textContent = `${compactMoney.format(annualFlows.ubiReceived)} reaches households each year. After modeled price changes, the bottom half ends ${plainDirection(summary.bottom50PurchasingPowerChange)} relative to a no-policy path.`;
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
void initialize();
