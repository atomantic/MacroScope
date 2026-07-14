import { parentPort, workerData } from "node:worker_threads";
import type { ComparisonRequestV1 } from "../simulation/contracts.js";
import {
  runUncertaintyAnalysis,
  type UncertaintyOptions,
} from "../simulation/uncertainty.js";

const input = workerData as {
  readonly request: ComparisonRequestV1;
  readonly options: UncertaintyOptions;
};

const result = runUncertaintyAnalysis(input.request, input.options, {
  onProgress: (progress) => parentPort?.postMessage({ progress }),
});
parentPort?.postMessage({ result });
