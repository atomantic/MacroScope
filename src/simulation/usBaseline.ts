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
  readonly deposits: number;
  readonly publicEquity: number;
  readonly realEstate: number;
}

export interface DataSource {
  readonly label: string;
  readonly organization: string;
  readonly vintage: string;
  readonly url: string;
}

const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

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
  baselineInflation: 0.026,
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
      label: "Modern Hyper- and High Inflations",
      organization: "International Monetary Fund",
      vintage: "Cagan threshold reference",
      url: "https://www.imf.org/external/pubs/ft/wp/2002/wp02197.pdf",
    },
  ] satisfies readonly DataSource[],
} as const;

export const calibratePopulationToUs = (
  households: readonly SyntheticHousehold[],
  representedHouseholds: number,
): readonly SyntheticHousehold[] => {
  const economyScale = representedHouseholds / US_BASELINE.households;
  const scalars = new Map<UsWealthGroupId, { assets: number; liabilities: number }>();

  for (const group of US_WEALTH_GROUPS) {
    const members = households.filter((household) => inGroup(household.percentile, group));
    const currentAssets = weightedRecordTotal(members, (household) => household.assets);
    const currentLiabilities = weightedRecordTotal(
      members,
      (household) => household.liabilities,
    );
    scalars.set(group.id, {
      assets: (group.assets * economyScale) / Math.max(1, currentAssets),
      liabilities:
        (group.liabilities * economyScale) / Math.max(1, currentLiabilities),
    });
  }

  return households.map((household) => {
    const group = groupForPercentile(household.percentile);
    const scalar = scalars.get(group.id);
    if (!scalar) throw new Error(`Missing U.S. calibration scalar for ${group.id}.`);
    return {
      ...household,
      assets: scaleRecord<AssetClass>(household.assets, scalar.assets),
      liabilities: scaleRecord<LiabilityClass>(household.liabilities, scalar.liabilities),
    };
  });
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

const weightedRecordTotal = <Key extends string>(
  households: readonly SyntheticHousehold[],
  select: (household: SyntheticHousehold) => Readonly<Record<Key, number>>,
): number =>
  households.reduce(
    (total, household) =>
      total +
      Object.values<number>(select(household)).reduce((sum, value) => sum + value, 0) *
        household.weight,
    0,
  );

const scaleRecord = <Key extends string>(
  record: Readonly<Record<Key, number>>,
  scalar: number,
): Record<Key, number> =>
  Object.fromEntries(
    Object.entries<number>(record).map(([key, value]) => [key, value * scalar]),
  ) as Record<Key, number>;
