// Module worker that runs the MacroScope comparison engine off the main
// thread. The compiled engine graph is published to ./engine/ by
// scripts/build-pages.mjs; this file is only loaded on the static build.
import { analyzeSensitivity, compareScenarios } from "./engine/browser/engine.js";

addEventListener("message", (event) => {
  const { id, request, mode } = event.data ?? {};
  try {
    const run = mode === "sensitivity" ? analyzeSensitivity : compareScenarios;
    postMessage({ id, ...run(request) });
  } catch (error) {
    // Mirrors the server's error handler: report instead of crashing the worker.
    postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "The in-browser model failed.",
      details: [],
    });
  }
});
