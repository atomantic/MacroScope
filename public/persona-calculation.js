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
