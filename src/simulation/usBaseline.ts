import type { AssetClass, LiabilityClass } from "../policies/schema.js";
import type { SyntheticHousehold } from "./population.js";

export type UsWealthGroupId =
  | "bottom-50"
  | "next-40"
  | "next-9"
  | "remaining-top-1"
  | "top-0.1";

export interface UsWealthGroupBaseline {
  readonly id: UsWealthGroupId;
  readonly label: string;
  readonly percentileMinimum: number;
  readonly percentileMaximum: number;
  readonly households: number;
  readonly assets: number;
  readonly liabilities: number;
  readonly netWorth: number;
  /** Compatibility aliases retained for existing `/api/baseline/us` clients. */
  readonly deposits: number;
  readonly publicEquity: number;
  readonly realEstate: number;
  readonly assetClasses: Readonly<Record<AssetClass, number>>;
  readonly liabilityClasses: Readonly<Record<LiabilityClass, number>>;
}

export interface DataSource {
  readonly label: string;
  readonly organization: string;
  readonly vintage: string;
  readonly url: string;
}

export interface CalibrationDiagnostic {
  readonly wealthGroup: UsWealthGroupId;
  readonly balanceSheet: "asset" | "liability";
  readonly instrument: AssetClass | LiabilityClass;
  readonly target: number;
  readonly modeled: number;
  readonly residual: number;
  readonly relativeError: number;
}

export type PopulationFlowMetric =
  | "households"
  | "residentPopulation"
  | "adults"
  | "children"
  | "annualPersonalIncome"
  | "annualPce";

export interface PopulationFlowDiagnostic {
  readonly metric: PopulationFlowMetric;
  readonly unit: "people" | "households" | "dollars";
  readonly target: number;
  readonly modeled: number;
  readonly residual: number;
  readonly relativeError: number;
}

export interface PopulationCalibration {
  readonly households: readonly SyntheticHousehold[];
  readonly diagnostics: readonly CalibrationDiagnostic[];
  readonly populationAndFlows: readonly PopulationFlowDiagnostic[];
}

const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/**
 * One national accounting vintage for people, household flows, and PCE.
 *
 * Synthetic household weights continue to represent Census households. Adult
 * and child benefit counts represent the full resident population, including
 * people in group quarters; those residents are distributed over the synthetic
 * tax-household units solely for national transfer costing. Nonresidents are
 * excluded. Income and consumption seeds keep their percentile ordering and
 * are rescaled independently, while balance sheets remain on the DFA track.
 */
export const POPULATION_FLOW_CALIBRATION = {
  populationVintage: "July 1, 2025",
  macroVintage: "calendar year 2025",
  residentPopulation: 341_784_857,
  adults: 269_763_509,
  children: 72_021_348,
  groupQuartersResidents: 8_388_561,
  annualPersonalIncome: 26_099.93 * BILLION,
  annualPce: 20_960.8 * BILLION,
  eligibilityRule:
    "All U.S. residents, including group-quarters residents, are included in adult or child transfer counts; nonresidents are excluded.",
  representationRule:
    "Household weights represent Census households. Group-quarters residents are carried by synthetic tax-household agents only to reconcile national person and benefit totals.",
  calibrationRule:
    "Adult counts, child counts, household income, and household consumption are each proportionally rescaled to their national target, preserving within-series percentile shapes; wealth instruments are calibrated separately to the DFA.",
  consumptionSectors: {
    vintage: "calendar year 2025 BEA PCE; 2024 BLS Consumer Expenditure Survey",
    method:
      "BEA PCE fixes the national total and broad product/service mix; BLS household expenditure categories inform the eight-sector crosswalk and percentile-varying allocation. Shares are normalized to exactly one.",
    shares: {
      housing: 0.18,
      food: 0.13,
      healthcare: 0.17,
      transportation: 0.11,
      energy: 0.04,
      "durable-goods": 0.1,
      discretionary: 0.12,
      services: 0.15,
    },
  },
} as const;

/**
 * Mapping from the downloadable DFA detail file to the model balance sheet.
 * The residual asset bucket is deliberate: those instruments do not behave like
 * government bonds, so preserving them separately prevents a misleading mapping.
 */
export const DFA_INSTRUMENT_CALIBRATION = {
  vintage: "2026:Q1",
  releaseDate: "2026-06-18",
  tolerance: 0.01,
  sourceFile: "dfa-networth-levels-detail.csv",
  assets: {
    deposits: {
      method: "direct",
      sourceInstruments: ["Deposits"],
    },
    governmentBonds: {
      method: "direct",
      sourceInstruments: ["Debt securities"],
    },
    publicEquity: {
      method: "direct",
      sourceInstruments: ["Corporate equities and mutual fund shares"],
    },
    housing: {
      method: "direct",
      sourceInstruments: ["Real estate"],
    },
    privateBusiness: {
      method: "direct",
      sourceInstruments: ["Miscellaneous other equity (unincorporated businesses)"],
    },
    retirementAssets: {
      method: "aggregate",
      sourceInstruments: [
        "Annuities",
        "Defined contribution pension entitlements",
        "Defined benefit pension entitlements",
      ],
    },
    otherAssets: {
      method: "explicit-residual",
      sourceInstruments: [
        "Consumer durables",
        "Money market fund shares",
        "Loans (assets)",
        "Life insurance reserves",
        "Miscellaneous assets",
      ],
    },
  },
  liabilities: {
    mortgage: {
      method: "direct",
      sourceInstruments: ["Home mortgages"],
    },
    consumerDebt: {
      method: "direct",
      sourceInstruments: ["Consumer credit"],
    },
    collateralizedLoan: {
      method: "aggregate-residual",
      sourceInstruments: [
        "Depository institutions loans n.e.c.",
        "Other loans and advances (liabilities)",
        "Deferred and unpaid life insurance premiums",
      ],
    },
  },
  residualAssetClass: {
    modelClass: "otherAssets",
    label: "Other assets",
    includedInModel: true,
    rationale:
      "Preserves DFA instruments without a narrower model analogue instead of relabeling them as government bonds.",
  },
  populationAndFlows: POPULATION_FLOW_CALIBRATION,
} as const;

export const US_WEALTH_GROUPS: readonly UsWealthGroupBaseline[] = [
  {
    id: "bottom-50",
    label: "Bottom 50%",
    percentileMinimum: 0,
    percentileMaximum: 0.5,
    households: 67_573_814,
    assets: 10_348_948 * MILLION,
    liabilities: 6_082_588 * MILLION,
    netWorth: 4_266_359 * MILLION,
    deposits: 793_232 * MILLION,
    publicEquity: 587_223 * MILLION,
    realEstate: 4_826_745 * MILLION,
    assetClasses: {
      deposits: 793_232 * MILLION,
      governmentBonds: 28_583 * MILLION,
      publicEquity: 587_223 * MILLION,
      housing: 4_826_745 * MILLION,
      privateBusiness: 166_766 * MILLION,
      retirementAssets: 1_233_972 * MILLION,
      otherAssets: 2_712_427 * MILLION,
    },
    liabilityClasses: {
      mortgage: 3_112_114 * MILLION,
      collateralizedLoan: 343_883 * MILLION,
      consumerDebt: 2_626_591 * MILLION,
    },
  },
  {
    id: "next-40",
    label: "50th–90th percentile",
    percentileMinimum: 0.5,
    percentileMaximum: 0.9,
    households: 54_071_475,
    assets: 60_280_257 * MILLION,
    liabilities: 8_795_392 * MILLION,
    netWorth: 51_484_864 * MILLION,
    deposits: 5_185_020 * MILLION,
    publicEquity: 6_400_950 * MILLION,
    realEstate: 22_650_205 * MILLION,
    assetClasses: {
      deposits: 5_185_020 * MILLION,
      governmentBonds: 1_193_186 * MILLION,
      publicEquity: 6_400_950 * MILLION,
      housing: 22_650_205 * MILLION,
      privateBusiness: 2_376_896 * MILLION,
      retirementAssets: 15_880_624 * MILLION,
      otherAssets: 6_593_376 * MILLION,
    },
    liabilityClasses: {
      mortgage: 6_773_937 * MILLION,
      collateralizedLoan: 252_115 * MILLION,
      consumerDebt: 1_769_340 * MILLION,
    },
  },
  {
    id: "next-9",
    label: "90th–99th percentile",
    percentileMinimum: 0.9,
    percentileMaximum: 0.99,
    households: 12_140_540,
    assets: 67_334_132 * MILLION,
    liabilities: 4_108_736 * MILLION,
    netWorth: 63_225_396 * MILLION,
    deposits: 5_054_244 * MILLION,
    publicEquity: 20_514_327 * MILLION,
    realEstate: 14_762_255 * MILLION,
    assetClasses: {
      deposits: 5_054_244 * MILLION,
      governmentBonds: 2_386_708 * MILLION,
      publicEquity: 20_514_327 * MILLION,
      housing: 14_762_255 * MILLION,
      privateBusiness: 5_252_870 * MILLION,
      retirementAssets: 14_082_097 * MILLION,
      otherAssets: 5_281_631 * MILLION,
    },
    liabilityClasses: {
      mortgage: 3_377_823 * MILLION,
      collateralizedLoan: 216_485 * MILLION,
      consumerDebt: 514_428 * MILLION,
    },
  },
  {
    id: "remaining-top-1",
    label: "99th–99.9th percentile",
    percentileMinimum: 0.99,
    percentileMaximum: 0.999,
    households: 1_212_197,
    assets: 30_730_484 * MILLION,
    liabilities: 769_766 * MILLION,
    netWorth: 29_960_718 * MILLION,
    deposits: 1_946_235 * MILLION,
    publicEquity: 14_312_130 * MILLION,
    realEstate: 4_546_853 * MILLION,
    assetClasses: {
      deposits: 1_946_235 * MILLION,
      governmentBonds: 1_150_715 * MILLION,
      publicEquity: 14_312_130 * MILLION,
      housing: 4_546_853 * MILLION,
      privateBusiness: 4_083_440 * MILLION,
      retirementAssets: 2_519_463 * MILLION,
      otherAssets: 2_171_648 * MILLION,
    },
    liabilityClasses: {
      mortgage: 439_570 * MILLION,
      collateralizedLoan: 221_110 * MILLION,
      consumerDebt: 109_086 * MILLION,
    },
  },
  {
    id: "top-0.1",
    label: "Top 0.1%",
    percentileMinimum: 0.999,
    percentileMaximum: 1,
    households: 136_095,
    assets: 25_311_992 * MILLION,
    liabilities: 239_711 * MILLION,
    netWorth: 25_072_282 * MILLION,
    deposits: 1_473_775 * MILLION,
    publicEquity: 13_331_518 * MILLION,
    realEstate: 1_937_284 * MILLION,
    assetClasses: {
      deposits: 1_473_775 * MILLION,
      governmentBonds: 1_104_402 * MILLION,
      publicEquity: 13_331_518 * MILLION,
      housing: 1_937_284 * MILLION,
      privateBusiness: 4_679_452 * MILLION,
      retirementAssets: 524_629 * MILLION,
      otherAssets: 2_260_932 * MILLION,
    },
    liabilityClasses: {
      mortgage: 117_541 * MILLION,
      collateralizedLoan: 68_584 * MILLION,
      consumerDebt: 53_586 * MILLION,
    },
  },
];

export const US_BASELINE = {
  id: "us-2026-q1",
  label: "United States",
  vintage: "2026:Q1",
  households: US_WEALTH_GROUPS.reduce((total, group) => total + group.households, 0),
  householdNetWorth: US_WEALTH_GROUPS.reduce(
    (total, group) => total + group.netWorth,
    0,
  ),
  m2: 23_052.3 * BILLION,
  nominalGdp: 30_779 * BILLION,
  annualPce: 20_960.8 * BILLION,
  annualPersonalIncome: POPULATION_FLOW_CALIBRATION.annualPersonalIncome,
  publicDebtHeldByPublic: 31_431_182_280_136.26,
  baselineInflation: 0.026,
  calibration: DFA_INSTRUMENT_CALIBRATION,
  wealthGroups: US_WEALTH_GROUPS,
  sources: [
    {
      label: "Distributional Financial Accounts",
      organization: "Federal Reserve Board",
      vintage: "2026:Q1; updated June 18, 2026",
      url: "https://www.federalreserve.gov/releases/z1/dataviz/dfa/",
    },
    {
      label: "M2 Money Stock (M2SL)",
      organization: "Federal Reserve Board via FRED",
      vintage: "May 2026; updated June 23, 2026",
      url: "https://fred.stlouisfed.org/series/M2SL",
    },
    {
      label: "GDP and personal consumption expenditures",
      organization: "U.S. Bureau of Economic Analysis",
      vintage: "Calendar year 2025",
      url: "https://www.bea.gov/news/2026/gdp-second-estimate-4th-quarter-and-year-2025",
    },
    {
      label: "National population by age 18 and over",
      organization: "U.S. Census Bureau",
      vintage: "July 1, 2025 population estimates",
      url: "https://www.census.gov/data/datasets/time-series/demo/popest/2020s-national-detail.html",
    },
    {
      label: "Group quarters population",
      organization: "U.S. Census Bureau",
      vintage: "2024 American Community Survey 1-year estimate, table B26001",
      url: "https://data.census.gov/table/ACSDT1Y2024.B26001",
    },
    {
      label: "National income and product accounts",
      organization: "U.S. Bureau of Economic Analysis",
      vintage: "Calendar year 2025 personal income",
      url: "https://www.bea.gov/itable/national-gdp-and-personal-income",
    },
    {
      label: "Consumer Expenditures — 2024",
      organization: "U.S. Bureau of Labor Statistics",
      vintage: "Calendar year 2024",
      url: "https://www.bls.gov/news.release/archives/cesan_12192025.pdf",
    },
    {
      label: "Debt Held by the Public",
      organization: "U.S. Department of the Treasury",
      vintage: "March 31, 2026",
      url: "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/",
    },
    {
      label: "Modern Hyper- and High Inflations",
      organization: "International Monetary Fund",
      vintage: "Cagan threshold reference",
      url: "https://www.imf.org/external/pubs/ft/wp/2002/wp02197.pdf",
    },
    {
      label: "The Role and Design of Net Wealth Taxes",
      organization: "OECD",
      vintage: "2018; behavioral responses, debt deductibility, and tax-base design",
      url: "https://www.oecd.org/en/publications/the-role-and-design-of-net-wealth-taxes-in-the-oecd_9789264290303-en.html",
    },
    {
      label: "Behavioral Responses to Wealth Taxes: Evidence from Sweden",
      organization: "David Seim, American Economic Journal: Economic Policy",
      vintage: "2017; low Scandinavian avoidance elasticity",
      url: "https://www.aeaweb.org/articles?id=10.1257/pol.20150290",
    },
    {
      label: "The Economic Consequences of the French Wealth Tax (ISF)",
      organization: "Éric Pichet, La Revue de Droit Fiscal / SSRN",
      vintage: "2007; ISF avoidance and expatriation experience",
      url: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1268381",
    },
    {
      label: "Housing costs and renter burden",
      organization: "U.S. Census Bureau",
      vintage: "2024 American Community Survey",
      url: "https://www.census.gov/newsroom/press-releases/2025/acs-1-year-estimates.html",
    },
    {
      label: "Homeowner Balance Sheets and Monetary Policy",
      organization: "Federal Reserve Board",
      vintage: "FEDS 2014-98; collateral and constrained housing supply",
      url: "https://www.federalreserve.gov/econres/feds/homeowner-balance-sheets-and-monetary-policy.htm",
    },
    {
      label: "Senator Warren's Wealth Tax: Budgetary and Economic Effects",
      organization: "Penn Wharton Budget Model",
      vintage: "2019; dynamic capital, wage, and GDP response to a wealth tax",
      url: "https://budgetmodel.wharton.upenn.edu/issues/2019/12/12/senator-warren-wealth-tax",
    },
    {
      label: "The Economic Effects of Wealth Taxes",
      organization: "Tax Foundation",
      vintage: "2019–2020; savings/investment response and long-run capital-stock drag",
      url: "https://taxfoundation.org/research/all/federal/wealth-tax/",
    },
  ] satisfies readonly DataSource[],
} as const;

export const calibratePopulationToUs = (
  households: readonly SyntheticHousehold[],
  representedHouseholds: number,
): readonly SyntheticHousehold[] =>
  calibratePopulationToUsWithDiagnostics(households, representedHouseholds).households;

export const calibratePopulationToUsWithDiagnostics = (
  households: readonly SyntheticHousehold[],
  representedHouseholds: number,
): PopulationCalibration => {
  const economyScale = representedHouseholds / US_BASELINE.households;
  const weightScalars = new Map<UsWealthGroupId, number>();
  for (const group of US_WEALTH_GROUPS) {
    const members = households.filter((household) => inGroup(household.percentile, group));
    weightScalars.set(
      group.id,
      calibrationScalar(
        weightedInstrumentTotal(members, () => 1),
        group.households * economyScale,
        `${group.id} household weight`,
      ),
    );
  }
  const reweighted = households.map((household) => {
    const group = groupForPercentile(household.percentile);
    const scalar = weightScalars.get(group.id);
    if (scalar === undefined) throw new Error(`Missing U.S. weight scalar for ${group.id}.`);
    return { ...household, weight: household.weight * scalar };
  });
  const scalars = new Map<
    UsWealthGroupId,
    {
      assets: Record<AssetClass, number>;
      liabilities: Record<LiabilityClass, number>;
    }
  >();

  for (const group of US_WEALTH_GROUPS) {
    const members = reweighted.filter((household) => inGroup(household.percentile, group));
    const assetScalars = mapTargets(group.assetClasses, (assetClass, target) =>
      calibrationScalar(
        weightedInstrumentTotal(members, (household) => household.assets[assetClass]),
        target * economyScale,
        `${group.id} asset ${assetClass}`,
      ),
    );
    const liabilityScalars = mapTargets(
      group.liabilityClasses,
      (liabilityClass, target) =>
        calibrationScalar(
          weightedInstrumentTotal(
            members,
            (household) => household.liabilities[liabilityClass],
          ),
          target * economyScale,
          `${group.id} liability ${liabilityClass}`,
        ),
    );
    scalars.set(group.id, { assets: assetScalars, liabilities: liabilityScalars });
  }

  const calibrated = reweighted.map((household) => {
    const group = groupForPercentile(household.percentile);
    const groupScalars = scalars.get(group.id);
    if (!groupScalars) throw new Error(`Missing U.S. calibration scalars for ${group.id}.`);
    return {
      ...household,
      assets: scaleRecord(household.assets, groupScalars.assets),
      liabilities: scaleRecord(household.liabilities, groupScalars.liabilities),
    };
  });

  const populationTargets = scaledPopulationFlowTargets(economyScale);
  const adultScalar = calibrationScalar(
    weightedInstrumentTotal(calibrated, (household) => household.adults),
    populationTargets.adults,
    "resident adults",
  );
  const childScalar = calibrationScalar(
    weightedInstrumentTotal(calibrated, (household) => household.children),
    populationTargets.children,
    "resident children",
  );
  const incomeScalar = calibrationScalar(
    weightedInstrumentTotal(calibrated, (household) => household.annualIncome),
    populationTargets.annualPersonalIncome,
    "annual personal income",
  );
  const consumptionScalar = calibrationScalar(
    weightedInstrumentTotal(calibrated, (household) => household.annualConsumption),
    populationTargets.annualPce,
    "annual PCE",
  );
  const flowCalibrated = calibrated.map((household) => ({
    ...household,
    adults: household.adults * adultScalar,
    children: household.children * childScalar,
    annualIncome: household.annualIncome * incomeScalar,
    annualConsumption: household.annualConsumption * consumptionScalar,
  }));

  return {
    households: flowCalibrated,
    diagnostics: buildDiagnostics(flowCalibrated, economyScale),
    populationAndFlows: buildPopulationFlowDiagnostics(
      flowCalibrated,
      populationTargets,
    ),
  };
};

const scaledPopulationFlowTargets = (
  economyScale: number,
): Readonly<Record<PopulationFlowMetric, number>> => ({
  households: US_BASELINE.households * economyScale,
  residentPopulation: POPULATION_FLOW_CALIBRATION.residentPopulation * economyScale,
  adults: POPULATION_FLOW_CALIBRATION.adults * economyScale,
  children: POPULATION_FLOW_CALIBRATION.children * economyScale,
  annualPersonalIncome: POPULATION_FLOW_CALIBRATION.annualPersonalIncome * economyScale,
  annualPce: POPULATION_FLOW_CALIBRATION.annualPce * economyScale,
});

export const buildPopulationFlowDiagnostics = (
  households: readonly SyntheticHousehold[],
  targets: Readonly<Record<PopulationFlowMetric, number>> =
    scaledPopulationFlowTargets(
      weightedInstrumentTotal(households, () => 1) / US_BASELINE.households,
    ),
): readonly PopulationFlowDiagnostic[] => {
  const modeled: Readonly<Record<PopulationFlowMetric, number>> = {
    households: weightedInstrumentTotal(households, () => 1),
    adults: weightedInstrumentTotal(households, (household) => household.adults),
    children: weightedInstrumentTotal(households, (household) => household.children),
    residentPopulation: weightedInstrumentTotal(
      households,
      (household) => household.adults + household.children,
    ),
    annualPersonalIncome: weightedInstrumentTotal(
      households,
      (household) => household.annualIncome,
    ),
    annualPce: weightedInstrumentTotal(
      households,
      (household) => household.annualConsumption,
    ),
  };
  const units: Readonly<Record<PopulationFlowMetric, PopulationFlowDiagnostic["unit"]>> = {
    households: "households",
    residentPopulation: "people",
    adults: "people",
    children: "people",
    annualPersonalIncome: "dollars",
    annualPce: "dollars",
  };
  const metrics: readonly PopulationFlowMetric[] = [
    "households",
    "residentPopulation",
    "adults",
    "children",
    "annualPersonalIncome",
    "annualPce",
  ];
  return metrics.map((metric) => {
    const target = targets[metric];
    const value = modeled[metric];
    const residual = value - target;
    return {
      metric,
      unit: units[metric],
      target,
      modeled: value,
      residual,
      relativeError:
        target === 0 ? (value === 0 ? 0 : 1) : Math.abs(residual) / target,
    };
  });
};

const buildDiagnostics = (
  households: readonly SyntheticHousehold[],
  economyScale: number,
): readonly CalibrationDiagnostic[] =>
  US_WEALTH_GROUPS.flatMap((group) => {
    const members = households.filter((household) => inGroup(household.percentile, group));
    const assets = entriesOf(group.assetClasses).map(([instrument, value]) =>
      diagnostic(
        group.id,
        "asset",
        instrument,
        value * economyScale,
        weightedInstrumentTotal(members, (household) => household.assets[instrument]),
      ),
    );
    const liabilities = entriesOf(group.liabilityClasses).map(([instrument, value]) =>
      diagnostic(
        group.id,
        "liability",
        instrument,
        value * economyScale,
        weightedInstrumentTotal(
          members,
          (household) => household.liabilities[instrument],
        ),
      ),
    );
    return [...assets, ...liabilities];
  });

const diagnostic = (
  wealthGroup: UsWealthGroupId,
  balanceSheet: "asset" | "liability",
  instrument: AssetClass | LiabilityClass,
  target: number,
  modeled: number,
): CalibrationDiagnostic => {
  const residual = modeled - target;
  return {
    wealthGroup,
    balanceSheet,
    instrument,
    target,
    modeled,
    residual,
    relativeError: target === 0 ? (modeled === 0 ? 0 : 1) : Math.abs(residual) / target,
  };
};

const calibrationScalar = (current: number, target: number, label: string): number => {
  if (target === 0) return 0;
  if (!Number.isFinite(current) || current <= 0) {
    throw new Error(`Cannot calibrate ${label}: positive target has no modeled holdings.`);
  }
  return target / current;
};

const groupForPercentile = (percentile: number): UsWealthGroupBaseline => {
  const group = US_WEALTH_GROUPS.find((candidate) => inGroup(percentile, candidate));
  if (!group) throw new Error(`No U.S. wealth group for percentile ${percentile}.`);
  return group;
};

const inGroup = (
  percentile: number,
  group: UsWealthGroupBaseline,
): boolean =>
  percentile >= group.percentileMinimum &&
  (percentile < group.percentileMaximum || group.percentileMaximum === 1);

const weightedInstrumentTotal = (
  households: readonly SyntheticHousehold[],
  select: (household: SyntheticHousehold) => number,
): number =>
  households.reduce(
    (total, household) => total + select(household) * household.weight,
    0,
  );

const mapTargets = <Key extends string>(
  targets: Readonly<Record<Key, number>>,
  map: (key: Key, value: number) => number,
): Record<Key, number> =>
  Object.fromEntries(entriesOf(targets).map(([key, value]) => [key, map(key, value)])) as Record<
    Key,
    number
  >;

const entriesOf = <Key extends string>(
  record: Readonly<Record<Key, number>>,
): readonly (readonly [Key, number])[] => Object.entries(record) as [Key, number][];

const scaleRecord = <Key extends string>(
  record: Readonly<Record<Key, number>>,
  scalars: Readonly<Record<Key, number>>,
): Record<Key, number> =>
  mapTargets(record, (key, value) => value * scalars[key]);
