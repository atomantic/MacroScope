import {
  DEFAULT_COMPARISON_REQUEST,
  type ComparisonRequestV1,
} from "../simulation/contracts.js";

export interface ParsedComparisonRequest {
  readonly value?: ComparisonRequestV1;
  readonly errors: readonly string[];
}

export const parseComparisonRequest = (input: unknown): ParsedComparisonRequest => {
  if (!isRecord(input)) return { errors: ["Request body must be a JSON object."] };
  const errors: string[] = [];
  const wealthTax = isRecord(input.wealthTax) ? input.wealthTax : {};
  const ubi = isRecord(input.ubi) ? input.ubi : {};
  const market = isRecord(input.market) ? input.market : {};
  const behavior = isRecord(input.behavior) ? input.behavior : {};

  const schemaVersion = readNumber(
    input,
    "schemaVersion",
    DEFAULT_COMPARISON_REQUEST.schemaVersion,
    1,
    1,
    errors,
    true,
  );
  const seed = readNumber(
    input,
    "seed",
    DEFAULT_COMPARISON_REQUEST.seed,
    -2_147_483_648,
    2_147_483_647,
    errors,
    true,
  );
  const sampleSize = readNumber(
    input,
    "sampleSize",
    DEFAULT_COMPARISON_REQUEST.sampleSize,
    100,
    10_000,
    errors,
    true,
  );
  const representedHouseholds = readNumber(
    input,
    "representedHouseholds",
    DEFAULT_COMPARISON_REQUEST.representedHouseholds,
    100,
    200_000_000,
    errors,
    true,
  );
  if (representedHouseholds < sampleSize) {
    errors.push("representedHouseholds must be at least sampleSize.");
  }

  const targetMode = readTargetMode(wealthTax.targetMode, errors);
  const exemption = readNumber(
    wealthTax,
    "exemption",
    DEFAULT_COMPARISON_REQUEST.wealthTax.exemption,
    0,
    1_000_000_000_000,
    errors,
  );
  const topShare = readNumber(
    wealthTax,
    "topShare",
    DEFAULT_COMPARISON_REQUEST.wealthTax.topShare,
    0.0001,
    1,
    errors,
  );
  const rate = readNumber(
    wealthTax,
    "rate",
    DEFAULT_COMPARISON_REQUEST.wealthTax.rate,
    0,
    0.2,
    errors,
  );
  const adultMonthlyBenefit = readNumber(
    ubi,
    "adultMonthlyBenefit",
    DEFAULT_COMPARISON_REQUEST.ubi.adultMonthlyBenefit,
    0,
    100_000,
    errors,
  );
  const childMonthlyBenefit = readNumber(
    ubi,
    "childMonthlyBenefit",
    DEFAULT_COMPARISON_REQUEST.ubi.childMonthlyBenefit,
    0,
    100_000,
    errors,
  );
  const fundingRule = readFundingRule(ubi.fundingRule, errors);
  const directCashShare = readNumber(
    ubi,
    "directCashShare",
    DEFAULT_COMPARISON_REQUEST.ubi.directCashShare,
    0,
    1,
    errors,
  );
  const administrativeShare = readNumber(
    ubi,
    "administrativeShare",
    DEFAULT_COMPARISON_REQUEST.ubi.administrativeShare,
    0,
    0.5,
    errors,
  );
  const buyerDepthRatio = readNumber(
    market,
    "buyerDepthRatio",
    DEFAULT_COMPARISON_REQUEST.market.buyerDepthRatio,
    0.001,
    2,
    errors,
  );
  const priceImpactCoefficient = readNumber(
    market,
    "priceImpactCoefficient",
    DEFAULT_COMPARISON_REQUEST.market.priceImpactCoefficient,
    0,
    2,
    errors,
  );
  const maximumCollateralLtv = readNumber(
    market,
    "maximumCollateralLtv",
    DEFAULT_COMPARISON_REQUEST.market.maximumCollateralLtv,
    0.1,
    0.9,
    errors,
  );
  const housingSupplyElasticity = readNumber(
    market,
    "housingSupplyElasticity",
    DEFAULT_COMPARISON_REQUEST.market.housingSupplyElasticity,
    0,
    2,
    errors,
  );
  const borrowShare = readNumber(
    behavior,
    "borrowShare",
    DEFAULT_COMPARISON_REQUEST.behavior.borrowShare,
    0,
    1,
    errors,
  );
  const sellShare = readNumber(
    behavior,
    "sellShare",
    DEFAULT_COMPARISON_REQUEST.behavior.sellShare,
    0,
    1,
    errors,
  );
  const annualAssetReturn = readNumber(
    behavior,
    "annualAssetReturn",
    DEFAULT_COMPARISON_REQUEST.behavior.annualAssetReturn,
    -0.5,
    0.5,
    errors,
  );
  const loanInterestRate = readNumber(
    behavior,
    "loanInterestRate",
    DEFAULT_COMPARISON_REQUEST.behavior.loanInterestRate,
    0,
    0.5,
    errors,
  );
  const deficitMonetizationShare = readNumber(
    behavior,
    "deficitMonetizationShare",
    DEFAULT_COMPARISON_REQUEST.behavior.deficitMonetizationShare,
    0,
    1,
    errors,
  );
  const assetHedgeShare = readNumber(
    behavior,
    "assetHedgeShare",
    DEFAULT_COMPARISON_REQUEST.behavior.assetHedgeShare,
    0,
    1,
    errors,
  );
  const housingHedgeShare = readNumber(
    behavior,
    "housingHedgeShare",
    DEFAULT_COMPARISON_REQUEST.behavior.housingHedgeShare,
    0,
    1,
    errors,
  );
  const rentPassThrough = readNumber(
    behavior,
    "rentPassThrough",
    DEFAULT_COMPARISON_REQUEST.behavior.rentPassThrough,
    0,
    1,
    errors,
  );
  if (borrowShare + sellShare > 1) {
    errors.push("borrowShare plus sellShare must not exceed 1.");
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    value: {
      schemaVersion: schemaVersion as 1,
      seed,
      sampleSize,
      representedHouseholds,
      wealthTax: { targetMode, exemption, topShare, rate },
      ubi: {
        adultMonthlyBenefit,
        childMonthlyBenefit,
        fundingRule,
        directCashShare,
        administrativeShare,
      },
      market: {
        buyerDepthRatio,
        priceImpactCoefficient,
        maximumCollateralLtv,
        housingSupplyElasticity,
      },
      behavior: {
        borrowShare,
        sellShare,
        annualAssetReturn,
        loanInterestRate,
        deficitMonetizationShare,
        assetHedgeShare,
        housingHedgeShare,
        rentPassThrough,
      },
    },
  };
};

const readNumber = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  errors: string[],
  integer = false,
): number => {
  const raw = source[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    errors.push(`${key} must be a finite number.`);
    return fallback;
  }
  if (integer && !Number.isInteger(raw)) errors.push(`${key} must be an integer.`);
  if (raw < minimum || raw > maximum) {
    errors.push(`${key} must be between ${minimum} and ${maximum}.`);
  }
  return raw;
};

const readFundingRule = (
  raw: unknown,
  errors: string[],
): ComparisonRequestV1["ubi"]["fundingRule"] => {
  if (raw === undefined) return DEFAULT_COMPARISON_REQUEST.ubi.fundingRule;
  if (raw === "fixed" || raw === "revenue-constrained" || raw === "smoothed") {
    return raw;
  }
  errors.push("fundingRule must be fixed, revenue-constrained, or smoothed.");
  return DEFAULT_COMPARISON_REQUEST.ubi.fundingRule;
};

const readTargetMode = (
  raw: unknown,
  errors: string[],
): ComparisonRequestV1["wealthTax"]["targetMode"] => {
  if (raw === undefined) return DEFAULT_COMPARISON_REQUEST.wealthTax.targetMode;
  if (raw === "exemption" || raw === "top-share") return raw;
  errors.push("targetMode must be exemption or top-share.");
  return DEFAULT_COMPARISON_REQUEST.wealthTax.targetMode;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
