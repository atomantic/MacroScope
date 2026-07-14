import type { AssetClass, LiabilityClass } from "../policies/schema.js";

export interface SyntheticHousehold {
  readonly id: string;
  readonly percentile: number;
  readonly weight: number;
  readonly adults: number;
  readonly children: number;
  readonly annualIncome: number;
  readonly assets: Readonly<Record<AssetClass, number>>;
  readonly liabilities: Readonly<Record<LiabilityClass, number>>;
  readonly marginalPropensityToConsume: number;
}

export interface PopulationConfig {
  readonly seed: number;
  readonly sampleSize: number;
  readonly representedHouseholds: number;
}

interface PopulationStratum {
  readonly lower: number;
  readonly upper: number;
  readonly sampleShare: number;
}

const STRATA: readonly PopulationStratum[] = [
  { lower: 0, upper: 0.99, sampleShare: 0.8 },
  { lower: 0.99, upper: 0.999, sampleShare: 0.15 },
  { lower: 0.999, upper: 0.9999, sampleShare: 0.04 },
  { lower: 0.9999, upper: 1, sampleShare: 0.01 },
];

export const generateSyntheticPopulation = (
  config: PopulationConfig,
): readonly SyntheticHousehold[] => {
  validateConfig(config);
  const random = mulberry32(config.seed);
  const counts = allocateSamples(config.sampleSize);
  const households: SyntheticHousehold[] = [];

  for (let stratumIndex = 0; stratumIndex < STRATA.length; stratumIndex += 1) {
    const stratum = STRATA[stratumIndex];
    const count = counts[stratumIndex];
    if (!stratum || !count) continue;
    const stratumPopulation = config.representedHouseholds * (stratum.upper - stratum.lower);
    const weight = stratumPopulation / count;

    for (let index = 0; index < count; index += 1) {
      const quantile = (index + 0.35 + random() * 0.3) / count;
      const percentile = stratum.lower + quantile * (stratum.upper - stratum.lower);
      households.push(createHousehold(households.length, percentile, weight, random));
    }
  }

  return households.sort((left, right) => left.percentile - right.percentile);
};

export const householdNetWorth = (household: SyntheticHousehold): number =>
  sumRecord(household.assets) - sumRecord(household.liabilities);

const createHousehold = (
  index: number,
  percentile: number,
  weight: number,
  random: () => number,
): SyntheticHousehold => {
  const noise = 0.88 + random() * 0.24;
  const targetNetWorth = wealthAtPercentile(percentile) * noise;
  const debtRatio = Math.max(0.04, 0.38 - percentile * 0.3 + random() * 0.08);
  const grossAssets =
    targetNetWorth >= 0
      ? Math.max(8_000, targetNetWorth / (1 - debtRatio))
      : 12_000 + random() * 18_000;
  const totalDebt = Math.max(0, grossAssets - targetNetWorth);
  const shares = portfolioShares(percentile);
  const assets: Record<AssetClass, number> = {
    deposits: grossAssets * shares.deposits,
    governmentBonds: grossAssets * shares.governmentBonds,
    publicEquity: grossAssets * shares.publicEquity,
    housing: grossAssets * shares.housing,
    privateBusiness: grossAssets * shares.privateBusiness,
    retirementAssets: grossAssets * shares.retirementAssets,
    otherAssets: grossAssets * shares.otherAssets,
  };
  // Keep structural support for every liability instrument in each percentile
  // group so instrument-level calibration can scale a positive seed to the DFA
  // target instead of manufacturing holdings after sampling.
  const consumerDebtReserve = totalDebt * (0.03 + (1 - percentile) * 0.17);
  const financeableDebt = Math.max(0, totalDebt - consumerDebtReserve);
  const mortgage = Math.min(financeableDebt * 0.7, assets.housing * 0.82);
  const collateralizedLoan = Math.min(
    financeableDebt - mortgage,
    assets.publicEquity * (percentile > 0.9 ? 0.24 : 0.08),
  );
  const liabilities: Record<LiabilityClass, number> = {
    mortgage,
    collateralizedLoan,
    consumerDebt: Math.max(0, totalDebt - mortgage - collateralizedLoan),
  };

  return {
    id: `household:${String(index + 1).padStart(5, "0")}`,
    percentile,
    weight,
    adults: random() < 0.38 ? 1 : 2,
    children: percentile < 0.85 && random() < 0.42 ? (random() < 0.7 ? 1 : 2) : 0,
    annualIncome: annualIncomeAtPercentile(percentile) * (0.9 + random() * 0.2),
    assets,
    liabilities,
    marginalPropensityToConsume: 0.86 - percentile * 0.56,
  };
};

const wealthAtPercentile = (percentile: number): number => {
  if (percentile < 0.18) return -35_000 + percentile * 250_000;
  const tail = Math.pow(1 / Math.max(0.000_001, 1 - percentile), 1.03);
  return 28_000 * tail - 42_000;
};

const annualIncomeAtPercentile = (percentile: number): number =>
  Math.min(5_000_000, 24_000 + 48_000 * Math.sqrt(percentile / Math.max(0.000_1, 1 - percentile)));

const portfolioShares = (percentile: number): Record<AssetClass, number> => {
  const raw: Record<AssetClass, number> = {
    deposits: 0.12 - percentile * 0.05,
    governmentBonds: 0.03 + percentile * 0.06,
    publicEquity: 0.04 + percentile * 0.32,
    housing: percentile < 0.8 ? 0.56 : percentile < 0.99 ? 0.36 : 0.15,
    privateBusiness: percentile > 0.95 ? 0.19 : 0.01 + percentile * 0.02,
    retirementAssets: percentile < 0.2 ? 0.08 : 0.17,
    otherAssets: 0.08,
  };
  const total = sumRecord(raw);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, value / total]),
  ) as Record<AssetClass, number>;
};

const allocateSamples = (sampleSize: number): readonly number[] => {
  const counts = STRATA.map((stratum) => Math.max(1, Math.floor(sampleSize * stratum.sampleShare)));
  let assigned = counts.reduce((total, count) => total + count, 0);
  let cursor = 0;
  while (assigned < sampleSize) {
    const current = counts[cursor];
    if (current !== undefined) counts[cursor] = current + 1;
    assigned += 1;
    cursor = (cursor + 1) % counts.length;
  }
  while (assigned > sampleSize) {
    const current = counts[cursor];
    if (current !== undefined && current > 1) {
      counts[cursor] = current - 1;
      assigned -= 1;
    }
    cursor = (cursor + 1) % counts.length;
  }
  return counts;
};

const validateConfig = (config: PopulationConfig): void => {
  if (!Number.isSafeInteger(config.seed)) throw new Error("Population seed must be a safe integer.");
  if (!Number.isInteger(config.sampleSize) || config.sampleSize < 100) {
    throw new Error("Population sample size must be an integer of at least 100.");
  }
  if (!Number.isFinite(config.representedHouseholds) || config.representedHouseholds < config.sampleSize) {
    throw new Error("Represented households must be finite and at least the sample size.");
  }
};

const sumRecord = (record: Readonly<Record<string, number>>): number =>
  Object.values(record).reduce((total, value) => total + value, 0);

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};
