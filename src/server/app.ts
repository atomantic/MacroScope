import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import { resolve } from "node:path";
import { SCENARIO_SCHEMA_VERSION } from "../policies/schema.js";
import { createDemoComparison } from "./demo.js";
import { DEFAULT_COMPARISON_REQUEST } from "../simulation/contracts.js";
import { runComparison } from "../simulation/scenarioRunner.js";
import { parseComparisonRequest } from "./comparisonInput.js";
import { US_BASELINE } from "../simulation/usBaseline.js";
import { HISTORICAL_BACKTEST } from "../simulation/historicalValidation.js";

export interface AppOptions {
  readonly startedAt?: number;
  readonly publicDirectory?: string;
}

export const createApp = (options: AppOptions = {}): Express => {
  const app = express();
  const startedAt = options.startedAt ?? Date.now();
  const publicDirectory =
    options.publicDirectory ?? resolve(import.meta.dirname, "../../public");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(publicDirectory, { index: "index.html", maxAge: 0 }));

  app.get("/health", (_request, response) => {
    response.json({
      status: "healthy",
      service: "macroscope",
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    });
  });

  app.get("/api/status", (_request, response) => {
    response.json({
      service: "macroscope",
      engine: "stock-flow-consistent",
      deterministic: true,
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      implemented: [
        "double-entry-ledger",
        "wealth-tax-assessment",
        "cash-funded-tax",
        "borrow-funded-tax",
        "asset-sale-funded-tax",
        "ubi-settlement",
        "loan-repayment",
        "weighted-synthetic-population",
        "three-strategy-comparison",
        "reduced-form-equity-cascade",
        "distributional-deciles",
        "federal-reserve-dfa-calibration",
        "ten-year-purchasing-power-projection",
        "inflation-and-monetization-stress-test",
        "owner-renter-asset-feedback-theory-test",
        "percentile-or-dollar-wealth-tax-targeting",
        "cash-services-and-administration-allocation",
        "historical-inflation-backtest-2020-2023",
      ],
    });
  });

  app.get("/api/demo", (_request, response) => {
    response.json(createDemoComparison());
  });

  app.get("/api/scenarios/default", (_request, response) => {
    response.json(DEFAULT_COMPARISON_REQUEST);
  });

  app.get("/api/baseline/us", (_request, response) => {
    response.json(US_BASELINE);
  });

  app.get("/api/validation/historical", (_request, response) => {
    response.json(HISTORICAL_BACKTEST);
  });

  app.post("/api/scenarios/compare", (request, response) => {
    const parsed = parseComparisonRequest(request.body);
    if (!parsed.value) {
      response.status(400).json({
        error: "Invalid comparison request.",
        details: parsed.errors,
      });
      return;
    }
    response.json(runComparison(parsed.value));
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API endpoint not found." });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "Request body contains invalid JSON." });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown server error";
    console.error(`❌ MacroScope request failed: ${message}`);
    response.status(500).json({ error: "MacroScope could not complete the request." });
  };
  app.use(errorHandler);

  return app;
};
