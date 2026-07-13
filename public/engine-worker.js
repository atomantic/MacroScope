// Module worker that runs the MacroScope comparison engine off the main
// thread. The compiled engine graph is published to ./engine/ by
// scripts/build-pages.mjs; this file is only loaded on the static build.
import { compareScenarios } from "./engine/browser/engine.js";

addEventListener("message", (event) => {
  const { id, request } = event.data ?? {};
  try {
    postMessage({ id, ...compareScenarios(request) });
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
