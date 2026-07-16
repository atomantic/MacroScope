import { describe, expect, it } from "vitest";
import { annualAssetClassReturns, clearAssetMarket } from "../src/index.js";

describe("annual asset-market clearing", () => {
  it("lets a liquid market absorb a sale with less price movement", () => {
    const clearAtDepth = (buyerDepthRatio: number) =>
      clearAssetMarket({
        domesticPurchases: 0,
        foreignPurchases: 0,
        voluntarySales: 100,
        forcedSales: 0,
        marketValue: 1_000,
        buyerDepthRatio,
        priceImpactCoefficient: 0.2,
        supplyElasticity: 0,
        maximumAbsolutePriceMove: 0.25,
      });
    const thin = clearAtDepth(0.1);
    const liquid = clearAtDepth(1);
    expect(thin.priceChange).toBeLessThan(0);
    expect(Math.abs(liquid.priceChange)).toBeLessThan(
      Math.abs(thin.priceChange),
    );
  });

  it("uses new supply to absorb part of excess demand", () => {
    const result = clearAssetMarket({
      domesticPurchases: 200,
      foreignPurchases: 0,
      voluntarySales: 50,
      forcedSales: 0,
      marketValue: 1_000,
      buyerDepthRatio: 1,
      priceImpactCoefficient: 0.2,
      supplyElasticity: 1,
      maximumAbsolutePriceMove: 0.25,
    });
    expect(result.newSupply).toBe(75);
    expect(result.netOrderFlow).toBe(75);
    expect(result.priceChange).toBeGreaterThan(0);
  });

  it("lets forced sales amplify an initial decline", () => {
    const clearWithForcedSales = (forcedSales: number) =>
      clearAssetMarket({
        domesticPurchases: 25,
        foreignPurchases: 0,
        voluntarySales: 100,
        forcedSales,
        marketValue: 1_000,
        buyerDepthRatio: 0.5,
        priceImpactCoefficient: 0.2,
        supplyElasticity: 0,
        maximumAbsolutePriceMove: 0.25,
      });
    expect(clearWithForcedSales(50).priceChange).toBeLessThan(
      clearWithForcedSales(0).priceChange,
    );
  });

  it("does not give deposits, bonds, housing, and equities one blanket return", () => {
    const returns = annualAssetClassReturns({
      annualAssetReturn: 0.08,
      annualInflation: 0.05,
      baselineInflation: 0.02,
      assetPriceInflationPassThrough: 0.5,
    });
    expect(returns.deposits).toBe(0);
    expect(returns.governmentBonds).toBe(0.04);
    expect(returns.housing).not.toBe(returns.publicEquity);
    expect(returns.retirementAssets).not.toBe(returns.privateBusiness);
  });
});
