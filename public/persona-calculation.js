/**
 * Scheduled benefits scale with household composition; a surplus rebate does
 * not. Keep those legs separate so zero-benefit scenarios and larger families
 * receive the same per-household rebate.
 */
export const calculatePersonaCashBenefit = ({
  grossScheduledBenefit,
  aggregateRequestedBenefit,
  aggregateCashDelivered,
  aggregateRebate,
  representedHouseholds,
}) => {
  const scheduledCash = Math.max(0, aggregateCashDelivered - aggregateRebate);
  const deliveryRatio = aggregateRequestedBenefit > 0
    ? scheduledCash / aggregateRequestedBenefit
    : 0;
  return (
    grossScheduledBenefit * deliveryRatio +
    aggregateRebate / Math.max(1, representedHouseholds)
  );
};

// The comparison response supplies these absolute, canonical thresholds. This
// intentionally does not consult wealthTax.rate: that headline field is only a
// flat-policy fallback and is stale metadata for a graduated proposal.
export const calculatePersonaWealthTax = ({ netWorth, brackets }) =>
  (brackets ?? []).reduce((total, bracket) => {
    const threshold = Number(bracket?.threshold);
    const upperThreshold = bracket?.upperThreshold;
    const rate = Number(bracket?.rate);
    if (!Number.isFinite(threshold) || !Number.isFinite(rate)) return total;
    const upper = upperThreshold == null ? Infinity : Number(upperThreshold);
    const taxableAmount = Math.max(
      0,
      Math.min(Math.max(0, netWorth), upper) - threshold,
    );
    return total + taxableAmount * rate;
  }, 0);

// A fresh comparison response always carries wealthTaxAssessment.brackets. Keep
// this narrow fallback for an old saved/static response while its matching
// engine asset is refreshed; it derives a schedule, never trusts a graduated
// policy's stale headline rate as the whole calculation.
export const personaScheduleFromRequest = (wealthTax) => {
  const source = Array.isArray(wealthTax?.brackets) && wealthTax.brackets.length > 0
    ? [...wealthTax.brackets].sort((left, right) => left.threshold - right.threshold)
    : [{ threshold: wealthTax?.exemption ?? 0, rate: wealthTax?.rate ?? 0 }];
  return source.map((bracket, index) => ({
    threshold: bracket.threshold,
    upperThreshold: source[index + 1]?.threshold ?? null,
    rate: bracket.rate,
  }));
};
