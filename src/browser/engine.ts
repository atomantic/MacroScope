import { parseComparisonRequest } from "../server/comparisonInput.js";
import { runComparison } from "../simulation/scenarioRunner.js";
import {
  runSensitivityAnalysis,
  type SensitivityAnalysis,
} from "../simulation/sensitivity.js";
import type { ComparisonResultV1 } from "../simulation/contracts.js";

export type BrowserCompareResponse =
  | { readonly ok: true; readonly result: ComparisonResultV1 }
  | {
      readonly ok: false;
      readonly error: string;
      readonly details: readonly string[];
    };

export type BrowserSensitivityResponse =
  | { readonly ok: true; readonly result: SensitivityAnalysis }
  | {
      readonly ok: false;
      readonly error: string;
      readonly details: readonly string[];
    };

/**
 * Runs the same validate-then-simulate path as POST /api/scenarios/compare,
 * so the in-browser engine and the server produce identical JSON for
 * identical requests.
 */
export const compareScenarios = (input: unknown): BrowserCompareResponse => {
  const parsed = parseComparisonRequest(input);
  if (!parsed.value) {
    return {
      ok: false,
      error: "Invalid comparison request.",
      details: parsed.errors,
    };
  }
  return { ok: true, result: runComparison(parsed.value) };
};

/**
 * Runs the one-at-a-time sensitivity sweep (issue #11) through the same
 * validate-then-simulate path as POST /api/scenarios/sensitivity, so the
 * in-browser tornado chart and the server produce identical JSON for identical
 * requests.
 */
export const analyzeSensitivity = (input: unknown): BrowserSensitivityResponse => {
  const parsed = parseComparisonRequest(input);
  if (!parsed.value) {
    return {
      ok: false,
      error: "Invalid comparison request.",
      details: parsed.errors,
    };
  }
  return { ok: true, result: runSensitivityAnalysis(parsed.value) };
};
