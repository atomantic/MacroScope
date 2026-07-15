import {
  DEFAULT_COMPARISON_REQUEST,
  type BenefitIndexation,
  type ComparisonRequestV1,
  type ModelTunables,
  type ServiceEffectiveness,
} from "../simulation/contracts.js";
import { MODEL_TUNABLES } from "../simulation/modelConstants.js";
import type { TaxBracket } from "../policies/schema.js";

const MAX_BRACKETS = 12;
const MAX_BRACKET_THRESHOLD = 1_000_000_000_000;
const MAX_BRACKET_RATE = 0.2;

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
  const brackets = readBrackets(wealthTax.brackets, errors);
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
  const surplusUse = readSurplusUse(ubi.surplusUse, errors);
  const benefitIndexation = readBenefitIndexation(ubi.benefitIndexation, errors);
  const serviceEffectiveness = readServiceEffectiveness(ubi.serviceEffectiveness, errors);
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
  const avoidanceElasticity = readNumber(
    behavior,
    "avoidanceElasticity",
    DEFAULT_COMPARISON_REQUEST.behavior.avoidanceElasticity,
    0,
    0.5,
    errors,
  );
  const expatriationShare = readNumber(
    behavior,
    "expatriationShare",
    DEFAULT_COMPARISON_REQUEST.behavior.expatriationShare,
    0,
    0.9,
    errors,
  );
  const privateBusinessInclusionRate = readNumber(
    behavior,
    "privateBusinessInclusionRate",
    DEFAULT_COMPARISON_REQUEST.behavior.privateBusinessInclusionRate,
    0,
    1,
    errors,
  );
  const savingsResponseElasticity = readNumber(
    behavior,
    "savingsResponseElasticity",
    DEFAULT_COMPARISON_REQUEST.behavior.savingsResponseElasticity,
    0,
    3,
    errors,
  );
  const demandGrowthOffset = readNumber(
    behavior,
    "demandGrowthOffset",
    DEFAULT_COMPARISON_REQUEST.behavior.demandGrowthOffset,
    0,
    3,
    errors,
  );
  if (borrowShare + sellShare > 1) {
    errors.push("borrowShare plus sellShare must not exceed 1.");
  }

  const model = readModelTunables(input.model, errors);

  if (errors.length > 0) return { errors };
  return {
    errors,
    value: {
      schemaVersion: schemaVersion as 1,
      seed,
      sampleSize,
      representedHouseholds,
      wealthTax: {
        targetMode,
        exemption,
        topShare,
        rate,
        ...(brackets ? { brackets } : {}),
      },
      ubi: {
        adultMonthlyBenefit,
        childMonthlyBenefit,
        fundingRule,
        surplusUse,
        benefitIndexation,
        serviceEffectiveness,
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
        avoidanceElasticity,
        expatriationShare,
        privateBusinessInclusionRate,
        savingsResponseElasticity,
        demandGrowthOffset,
      },
      model,
    },
  };
};

// Validate the promoted, tunable model constants against the ranges declared in
// MODEL_TUNABLES (single source of truth shared with the UI). An omitted `model`
// block, or any omitted field within it, falls back to the calibrated default so
// a default request stays numerically identical to the pre-issue-#8 engine.
const readModelTunables = (
  raw: unknown,
  errors: string[],
): ModelTunables => {
  const source = isRecord(raw) ? raw : {};
  const model: Record<keyof ModelTunables, number> = {
    ...DEFAULT_COMPARISON_REQUEST.model,
  };
  for (const spec of MODEL_TUNABLES) {
    model[spec.key] = readNumber(
      source,
      spec.key,
      DEFAULT_COMPARISON_REQUEST.model[spec.key],
      spec.min,
      spec.max,
      errors,
    );
  }
  return model;
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

const readBrackets = (
  raw: unknown,
  errors: string[],
): readonly TaxBracket[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push("brackets must be an array of { threshold, rate } rows.");
    return undefined;
  }
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_BRACKETS) {
    errors.push(`brackets must not exceed ${MAX_BRACKETS} rows.`);
    return undefined;
  }
  const parsed: TaxBracket[] = [];
  let previousThreshold = -Infinity;
  let previousRate = -Infinity;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      errors.push("Each bracket must be an object with threshold and rate.");
      continue;
    }
    const threshold = readNumber(
      entry,
      "threshold",
      Number.NaN,
      0,
      MAX_BRACKET_THRESHOLD,
      errors,
    );
    const rate = readNumber(entry, "rate", Number.NaN, 0, MAX_BRACKET_RATE, errors);
    if (!Number.isFinite(threshold) || !Number.isFinite(rate)) {
      errors.push("Each bracket requires a finite threshold and rate.");
      continue;
    }
    if (threshold <= previousThreshold) {
      errors.push("Bracket thresholds must be strictly increasing.");
    }
    if (rate < previousRate) {
      errors.push("Bracket rates must be nondecreasing across thresholds.");
    }
    previousThreshold = threshold;
    previousRate = rate;
    parsed.push({ threshold, rate });
  }
  return parsed.length > 0 ? parsed : undefined;
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

const readBenefitIndexation = (
  raw: unknown,
  errors: string[],
): BenefitIndexation => {
  if (raw === undefined) return DEFAULT_COMPARISON_REQUEST.ubi.benefitIndexation ?? "none";
  if (raw === "none" || raw === "cpi") return raw;
  errors.push("benefitIndexation must be none or cpi.");
  return DEFAULT_COMPARISON_REQUEST.ubi.benefitIndexation ?? "none";
};

const readServiceEffectiveness = (
  raw: unknown,
  errors: string[],
): ServiceEffectiveness => {
  if (raw === undefined) return DEFAULT_COMPARISON_REQUEST.ubi.serviceEffectiveness ?? "unscored";
  if (raw === "unscored" || raw === "zero" || raw === "base" || raw === "high") return raw;
  errors.push("serviceEffectiveness must be unscored, zero, base, or high.");
  return DEFAULT_COMPARISON_REQUEST.ubi.serviceEffectiveness ?? "unscored";
};

const readSurplusUse = (
  raw: unknown,
  errors: string[],
): NonNullable<ComparisonRequestV1["ubi"]["surplusUse"]> => {
  if (raw === undefined) {
    return DEFAULT_COMPARISON_REQUEST.ubi.surplusUse ?? "debt-reduction";
  }
  if (
    raw === "debt-reduction" ||
    raw === "additional-services" ||
    raw === "rebate" ||
    raw === "treasury-balance"
  ) {
    return raw;
  }
  errors.push(
    "surplusUse must be debt-reduction, additional-services, rebate, or treasury-balance.",
  );
  return DEFAULT_COMPARISON_REQUEST.ubi.surplusUse ?? "debt-reduction";
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
