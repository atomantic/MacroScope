import type { AssetClass } from "../policies/schema.js";

export interface AssetMarketClearingInput {
  readonly domesticPurchases: number;
  readonly foreignPurchases: number;
  readonly voluntarySales: number;
  readonly forcedSales: number;
  readonly marketValue: number;
  readonly buyerDepthRatio: number;
  readonly priceImpactCoefficient: number;
  readonly supplyElasticity: number;
  readonly maximumAbsolutePriceMove: number;
}

export interface AssetMarketClearingResult {
  readonly grossPurchases: number;
  readonly grossSales: number;
  readonly newSupply: number;
  readonly netOrderFlow: number;
  readonly priceChange: number;
}

/**
 * Clears one annual asset market without creating deposits. Positive excess
 * demand first elicits new construction/issuance; the residual moves prices
 * against finite buyer depth. Sales are transfers of existing claims, while
 * `newSupply` is the only quantity that expands the outstanding asset stock.
 */
export const clearAssetMarket = (
  input: AssetMarketClearingInput,
): AssetMarketClearingResult => {
  const domesticPurchases = nonnegative(input.domesticPurchases);
  const foreignPurchases = nonnegative(input.foreignPurchases);
  const voluntarySales = nonnegative(input.voluntarySales);
  const forcedSales = nonnegative(input.forcedSales);
  const grossPurchases = domesticPurchases + foreignPurchases;
  const grossSales = voluntarySales + forcedSales;
  const preSupplyExcessDemand = Math.max(0, grossPurchases - grossSales);
  const elasticity = nonnegative(input.supplyElasticity);
  const newSupply = preSupplyExcessDemand * (elasticity / (1 + elasticity));
  const netOrderFlow = grossPurchases - grossSales - newSupply;
  const marketDepth =
    Math.max(1, nonnegative(input.marketValue)) *
    Math.max(0.001, nonnegative(input.buyerDepthRatio));
  const unclampedPriceChange =
    nonnegative(input.priceImpactCoefficient) * netOrderFlow / marketDepth;
  const limit = Math.max(0.001, nonnegative(input.maximumAbsolutePriceMove));
  const priceChange = Math.max(-limit, Math.min(limit, unclampedPriceChange));
  return { grossPurchases, grossSales, newSupply, netOrderFlow, priceChange };
};

const nonnegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export const annualAssetClassReturns = (input: {
  readonly annualAssetReturn: number;
  readonly annualInflation: number;
  readonly baselineInflation: number;
  readonly assetPriceInflationPassThrough: number;
}): Readonly<Record<AssetClass, number>> => {
  const inflationReturn =
    Math.max(0, input.annualInflation - input.baselineInflation) *
    input.assetPriceInflationPassThrough;
  return {
    deposits: 0,
    governmentBonds: Math.min(0.04, input.annualAssetReturn * 0.5),
    publicEquity: input.annualAssetReturn + inflationReturn,
    housing: input.annualAssetReturn * 0.6 + inflationReturn,
    privateBusiness: input.annualAssetReturn * 0.9 + inflationReturn,
    retirementAssets: input.annualAssetReturn * 0.75 + inflationReturn,
    otherAssets: input.annualAssetReturn * 0.35 + inflationReturn,
  };
};
