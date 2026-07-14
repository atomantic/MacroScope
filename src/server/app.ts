import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { SCENARIO_SCHEMA_VERSION } from "../policies/schema.js";
import { createDemoComparison } from "./demo.js";
import {
  DEFAULT_COMPARISON_REQUEST,
  type ComparisonRequestV1,
} from "../simulation/contracts.js";
import { runComparison } from "../simulation/scenarioRunner.js";
import {
  runSensitivityAnalysis,
  type SensitivityAnalysis,
} from "../simulation/sensitivity.js";
import { parseComparisonRequest } from "./comparisonInput.js";

// The sensitivity sweep runs ~80 full comparisons — ~1.7s at 4,000 agents — so
// running it inline would block the Express event loop (and /health, and every
// other request) for that whole time. Offload it to a worker thread. The
// compiled worker only exists in dist/, so under the vitest TS-source runner
// (where a raw node:worker Worker can't load an un-transpiled .ts) we fall back
// to running the same deterministic function inline; production always offloads.
const sensitivityWorkerPath = fileURLToPath(
  new URL("./sensitivityWorker.js", import.meta.url),
);
const canOffloadSensitivity = existsSync(sensitivityWorkerPath);

const analyzeSensitivity = (
  request: ComparisonRequestV1,
): Promise<SensitivityAnalysis> => {
  if (!canOffloadSensitivity) return Promise.resolve(runSensitivityAnalysis(request));
  return new Promise<SensitivityAnalysis>((resolvePromise, reject) => {
    const worker = new Worker(sensitivityWorkerPath, { workerData: request });
    worker.once("message", (message: { result: SensitivityAnalysis }) => {
      void worker.terminate();
      resolvePromise(message.result);
    });
    worker.once("error", (error) => {
      void worker.terminate();
      reject(error);
    });
  });
};

// Each sweep is a CPU-bound worker running ~80 comparisons, so an unbounded
// burst of requests could spawn unbounded native threads and exhaust the box.
// Admit at most MAX concurrently; queue a bounded backlog; shed load past that
// with a 503 rather than piling on more threads. Cheap on the fast inline path
// too — inline runs release the slot almost immediately.
const MAX_SENSITIVITY_WORKERS = 2;
const MAX_SENSITIVITY_QUEUE = 16;
let activeSensitivity = 0;
const sensitivityWaiters: Array<() => void> = [];

const acquireSensitivitySlot = (): Promise<boolean> => {
  if (activeSensitivity < MAX_SENSITIVITY_WORKERS) {
    activeSensitivity += 1;
    return Promise.resolve(true);
  }
  if (sensitivityWaiters.length >= MAX_SENSITIVITY_QUEUE) return Promise.resolve(false);
  return new Promise<boolean>((admit) => {
    sensitivityWaiters.push(() => {
      activeSensitivity += 1;
      admit(true);
    });
  });
};

const releaseSensitivitySlot = (): void => {
  activeSensitivity -= 1;
  sensitivityWaiters.shift()?.();
};
import { US_BASELINE } from "../simulation/usBaseline.js";
import { HISTORICAL_BACKTEST } from "../simulation/historicalValidation.js";
import { MODEL_CONSTANT_DOCS } from "../simulation/modelConstants.js";

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
      calibration: US_BASELINE.calibration,
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
        "instrument-level-federal-reserve-dfa-calibration",
        "ten-year-purchasing-power-projection",
        "inflation-and-monetization-stress-test",
        "owner-renter-asset-feedback-theory-test",
        "one-at-a-time-sensitivity-tornado",
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

  app.get("/api/model/constants", (_request, response) => {
    response.json({ constants: MODEL_CONSTANT_DOCS });
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

  app.post("/api/scenarios/sensitivity", async (request, response) => {
    const parsed = parseComparisonRequest(request.body);
    if (!parsed.value) {
      response.status(400).json({
        error: "Invalid comparison request.",
        details: parsed.errors,
      });
      return;
    }
    const admitted = await acquireSensitivitySlot();
    if (!admitted) {
      response.status(503).json({ error: "Sensitivity analysis is busy; retry shortly." });
      return;
    }
    try {
      response.json(await analyzeSensitivity(parsed.value));
    } finally {
      releaseSensitivitySlot();
    }
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
