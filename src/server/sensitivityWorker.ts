import { parentPort, workerData } from "node:worker_threads";
import { runSensitivityAnalysis } from "../simulation/sensitivity.js";
import type { ComparisonRequestV1 } from "../simulation/contracts.js";

// Runs the CPU-bound sensitivity sweep off the Express event loop (issue #11).
// The request has already passed parseComparisonRequest in the handler, so the
// worker trusts it and runs once at load, posting the result back. A throw here
// surfaces as the Worker's "error" event, which the handler maps to a 500.
const request = workerData as ComparisonRequestV1;
parentPort?.postMessage({ result: runSensitivityAnalysis(request) });
