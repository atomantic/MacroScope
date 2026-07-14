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
import {
  parseUncertaintyOptions,
  runUncertaintyAnalysis,
  UncertaintyCancelledError,
  type UncertaintyAnalysis,
  type UncertaintyOptions,
  type UncertaintyProgress,
} from "../simulation/uncertainty.js";
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
const uncertaintyWorkerPath = fileURLToPath(
  new URL("./uncertaintyWorker.js", import.meta.url),
);
const canOffloadUncertainty = existsSync(uncertaintyWorkerPath);

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

interface UncertaintyJob {
  readonly result: Promise<UncertaintyAnalysis>;
  readonly cancel: () => void;
}

const analyzeUncertainty = (
  request: ComparisonRequestV1,
  options: UncertaintyOptions,
  onProgress: (progress: UncertaintyProgress) => void,
): UncertaintyJob => {
  if (!canOffloadUncertainty) {
    let cancelled = false;
    return {
      result: Promise.resolve().then(() =>
        runUncertaintyAnalysis(request, options, {
          onProgress,
          shouldCancel: () => cancelled,
        })),
      cancel: () => {
        cancelled = true;
      },
    };
  }
  const worker = new Worker(uncertaintyWorkerPath, { workerData: { request, options } });
  let settled = false;
  let rejectJob: (reason: Error) => void = () => undefined;
  const result = new Promise<UncertaintyAnalysis>((resolvePromise, reject) => {
    rejectJob = reject;
    worker.on("message", (message: {
      readonly progress?: UncertaintyProgress;
      readonly result?: UncertaintyAnalysis;
    }) => {
      if (message.progress) onProgress(message.progress);
      if (!message.result) return;
      settled = true;
      void worker.terminate();
      resolvePromise(message.result);
    });
    worker.once("error", (error) => {
      settled = true;
      void worker.terminate();
      reject(error);
    });
  });
  return {
    result,
    cancel: () => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      rejectJob(new UncertaintyCancelledError());
    },
  };
};

// Each sweep is a CPU-bound worker running ~80 comparisons, so an unbounded
// burst of requests could spawn unbounded native threads and exhaust the box.
// Admit at most MAX concurrently; queue a bounded backlog; shed load past that
// with a 503 rather than piling on more threads. Cheap on the fast inline path
// too — inline runs release the slot almost immediately.
const MAX_SENSITIVITY_WORKERS = 2;
const MAX_SENSITIVITY_QUEUE = 16;
let activeSensitivity = 0;
interface SensitivityWaiter {
  readonly admit: () => void;
  readonly cancel: () => void;
}
const sensitivityWaiters: SensitivityWaiter[] = [];

const acquireSensitivitySlot = (signal?: AbortSignal): Promise<boolean> => {
  if (signal?.aborted) return Promise.resolve(false);
  if (activeSensitivity < MAX_SENSITIVITY_WORKERS) {
    activeSensitivity += 1;
    return Promise.resolve(true);
  }
  if (sensitivityWaiters.length >= MAX_SENSITIVITY_QUEUE) return Promise.resolve(false);
  return new Promise<boolean>((resolveAdmission) => {
    const waiter: SensitivityWaiter = {
      admit: () => {
        signal?.removeEventListener("abort", waiter.cancel);
        activeSensitivity += 1;
        resolveAdmission(true);
      },
      cancel: () => {
        const index = sensitivityWaiters.indexOf(waiter);
        if (index >= 0) sensitivityWaiters.splice(index, 1);
        resolveAdmission(false);
      },
    };
    signal?.addEventListener("abort", waiter.cancel, { once: true });
    if (signal?.aborted) {
      waiter.cancel();
    } else {
      sensitivityWaiters.push(waiter);
    }
  });
};

const releaseSensitivitySlot = (): void => {
  activeSensitivity -= 1;
  sensitivityWaiters.shift()?.admit();
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
        "one-at-a-time-sensitivity-tornado",
        "joint-uncertainty-bands-and-interactions",
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
    const queuedDisconnect = new AbortController();
    const cancelQueued = () => queuedDisconnect.abort();
    request.once("aborted", cancelQueued);
    response.once("close", cancelQueued);
    const admitted = await acquireSensitivitySlot(queuedDisconnect.signal);
    request.off("aborted", cancelQueued);
    response.off("close", cancelQueued);
    if (!admitted) {
      if (!queuedDisconnect.signal.aborted) {
        response.status(503).json({ error: "Sensitivity analysis is busy; retry shortly." });
      }
      return;
    }
    if (queuedDisconnect.signal.aborted) {
      releaseSensitivitySlot();
      return;
    }
    try {
      response.json(await analyzeSensitivity(parsed.value));
    } finally {
      releaseSensitivitySlot();
    }
  });

  app.post("/api/scenarios/uncertainty", async (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const parsed = parseComparisonRequest(body.request);
    const parsedOptions = parseUncertaintyOptions(body.options);
    if (!parsed.value || !parsedOptions.value) {
      response.status(400).json({
        error: "Invalid uncertainty request.",
        details: [...parsed.errors, ...parsedOptions.errors],
      });
      return;
    }
    const disconnect = new AbortController();
    let job: UncertaintyJob | undefined;
    const cancelIfDisconnected = () => {
      if (response.writableEnded) return;
      disconnect.abort();
      job?.cancel();
    };
    request.once("aborted", cancelIfDisconnected);
    response.once("close", cancelIfDisconnected);
    const admitted = await acquireSensitivitySlot(disconnect.signal);
    if (!admitted) {
      request.off("aborted", cancelIfDisconnected);
      response.off("close", cancelIfDisconnected);
      if (!disconnect.signal.aborted) {
        response.status(503).json({ error: "Uncertainty analysis is busy; retry shortly." });
      }
      return;
    }
    if (disconnect.signal.aborted) {
      request.off("aborted", cancelIfDisconnected);
      response.off("close", cancelIfDisconnected);
      releaseSensitivitySlot();
      return;
    }
    const streaming =
      request.get("accept")?.toLowerCase().includes("application/x-ndjson") ?? false;
    if (streaming) {
      response.status(200);
      response.type("application/x-ndjson");
      response.flushHeaders();
    }
    job = analyzeUncertainty(parsed.value, parsedOptions.value, (progress) => {
      if (streaming && !response.writableEnded) {
        response.write(`${JSON.stringify({ progress })}\n`);
      }
    });
    if (disconnect.signal.aborted) job.cancel();
    try {
      const result = await job.result;
      if (response.writableEnded) return;
      if (streaming) {
        response.end(`${JSON.stringify({ result })}\n`);
      } else {
        response.json(result);
      }
    } catch (error) {
      if (error instanceof UncertaintyCancelledError || response.destroyed) return;
      if (streaming) {
        response.end(`${JSON.stringify({
          error: "Uncertainty analysis failed.",
        })}\n`);
        return;
      }
      throw error;
    } finally {
      request.off("aborted", cancelIfDisconnected);
      response.off("close", cancelIfDisconnected);
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
