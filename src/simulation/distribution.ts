import type { DistributionOutcome } from "./contracts.js";

export interface DistributionRecord {
  readonly weight: number;
  readonly netWorthBefore: number;
  readonly netWorthAfter: number;
  readonly taxAssessed: number;
  readonly taxPaid: number;
  readonly ubiReceived: number;
  readonly debtChange: number;
  readonly consumptionChange: number;
}

interface MutableDecile {
  households: number;
  netWorthBefore: number;
  netWorthAfter: number;
  taxAssessed: number;
  taxPaid: number;
  ubiReceived: number;
  debtChange: number;
  consumptionChange: number;
}

export const weightedGini = (
  records: readonly DistributionRecord[],
  select: (record: DistributionRecord) => number,
): number => {
  const sorted = [...records]
    .map((record) => ({ value: Math.max(0, select(record)), weight: record.weight }))
    .sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((total, item) => total + item.weight, 0);
  const weightedTotal = sorted.reduce(
    (total, item) => total + item.value * item.weight,
    0,
  );
  if (totalWeight === 0 || weightedTotal === 0) return 0;

  let cumulativeWeight = 0;
  let numerator = 0;
  for (const item of sorted) {
    numerator +=
      item.weight *
      (2 * cumulativeWeight + item.weight - totalWeight) *
      item.value;
    cumulativeWeight += item.weight;
  }
  return Math.max(0, Math.min(1, numerator / (totalWeight * weightedTotal)));
};

export const buildDeciles = (
  records: readonly DistributionRecord[],
): readonly DistributionOutcome[] => {
  const sorted = [...records].sort(
    (left, right) => left.netWorthBefore - right.netWorthBefore,
  );
  const totalWeight = sorted.reduce((total, record) => total + record.weight, 0);
  const targetWeight = totalWeight / 10;
  const buckets: MutableDecile[] = Array.from({ length: 10 }, () => emptyBucket());
  let bucketIndex = 0;

  for (const record of sorted) {
    let remaining = record.weight;
    while (remaining > 1e-9 && bucketIndex < buckets.length) {
      const bucket = buckets[bucketIndex];
      if (!bucket) break;
      const available = targetWeight - bucket.households;
      const allocated = Math.min(remaining, available);
      addToBucket(bucket, record, allocated);
      remaining -= allocated;
      if (bucket.households >= targetWeight - 1e-9) bucketIndex += 1;
    }
  }

  return buckets.map((bucket, index) => ({
    decile: index + 1,
    households: bucket.households,
    averageNetWorthBefore: average(bucket.netWorthBefore, bucket.households),
    averageNetWorthAfter: average(bucket.netWorthAfter, bucket.households),
    averageTaxAssessed: average(bucket.taxAssessed, bucket.households),
    averageTaxPaid: average(bucket.taxPaid, bucket.households),
    averageUbiReceived: average(bucket.ubiReceived, bucket.households),
    averageDebtChange: average(bucket.debtChange, bucket.households),
    averageConsumptionChange: average(bucket.consumptionChange, bucket.households),
  }));
};

const emptyBucket = (): MutableDecile => ({
  households: 0,
  netWorthBefore: 0,
  netWorthAfter: 0,
  taxAssessed: 0,
  taxPaid: 0,
  ubiReceived: 0,
  debtChange: 0,
  consumptionChange: 0,
});

const addToBucket = (
  bucket: MutableDecile,
  record: DistributionRecord,
  weight: number,
): void => {
  bucket.households += weight;
  bucket.netWorthBefore += record.netWorthBefore * weight;
  bucket.netWorthAfter += record.netWorthAfter * weight;
  bucket.taxAssessed += record.taxAssessed * weight;
  bucket.taxPaid += record.taxPaid * weight;
  bucket.ubiReceived += record.ubiReceived * weight;
  bucket.debtChange += record.debtChange * weight;
  bucket.consumptionChange += record.consumptionChange * weight;
};

const average = (total: number, weight: number): number =>
  weight === 0 ? 0 : total / weight;
