import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import {
  DEFAULT_COMPARISON_REQUEST,
  HISTORICAL_BACKTEST,
  MODEL_CONSTANT_DOCS,
  US_BASELINE,
  runComparison,
} from "../dist/index.js";
import { parseAssetVersion, versionRelativeImports } from "./asset-version.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const output = resolve(root, "dist-pages");
const data = resolve(output, "data");
const engine = resolve(output, "engine");

// The module the web worker (public/engine-worker.js) imports; every compiled
// module it reaches through static ESM imports is published alongside it.
const ENGINE_ENTRY = "browser/engine.js";
const IMPORT_PATTERN = /(?:from|import)\s*"([^"]+)"/g;

const collectEngineModules = async () => {
  const modules = new Map();
  const queue = [ENGINE_ENTRY];
  while (queue.length > 0) {
    const moduleId = queue.pop();
    if (modules.has(moduleId)) continue;
    if (moduleId.startsWith("..")) {
      throw new Error(`Engine import escapes dist/: ${moduleId}`);
    }
    const source = await readFile(resolve(dist, moduleId), "utf8");
    modules.set(moduleId, source);
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(
          `Engine module ${moduleId} imports "${specifier}", which a browser cannot resolve; the in-browser engine graph must stay relative and dependency-free.`,
        );
      }
      queue.push(posix.join(posix.dirname(moduleId), specifier));
    }
  }
  return modules;
};

const engineModules = await collectEngineModules();

// One asset version, read from the page bundle's own `app.js?v=N`, cache-busts
// the whole static graph together: the engine modules and worker entry get it
// stamped onto their import specifiers here, and app.js re-derives it at runtime
// for the worker load and data-snapshot fetches.
const ASSET_VERSION = parseAssetVersion(
  await readFile(resolve(root, "public", "index.html"), "utf8"),
);

await rm(output, { recursive: true, force: true });
await mkdir(data, { recursive: true });
await cp(resolve(root, "public"), output, { recursive: true });

for (const [moduleId, source] of engineModules) {
  const target = resolve(engine, moduleId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, versionRelativeImports(source, ASSET_VERSION));
}
console.log(
  `🧠 Published ${engineModules.size} engine modules (v=${ASSET_VERSION}) for the in-browser worker`,
);

// The worker entry statically imports the engine graph; version that specifier
// too so `engine-worker.js?v=N` and its imports invalidate as one unit.
const workerPath = resolve(output, "engine-worker.js");
await writeFile(
  workerPath,
  versionRelativeImports(await readFile(workerPath, "utf8"), ASSET_VERSION),
);

const indexPath = resolve(output, "index.html");
const index = await readFile(indexPath, "utf8");
await writeFile(
  indexPath,
  index.replace('<html lang="en">', '<html lang="en" data-mode="static">'),
);
await writeFile(
  resolve(data, "default-request.json"),
  `${JSON.stringify(DEFAULT_COMPARISON_REQUEST)}\n`,
);
await writeFile(resolve(data, "us-baseline.json"), `${JSON.stringify(US_BASELINE)}\n`);
await writeFile(
  resolve(data, "historical-backtest.json"),
  `${JSON.stringify(HISTORICAL_BACKTEST)}\n`,
);
await writeFile(
  resolve(data, "default-scenario.json"),
  `${JSON.stringify(runComparison(DEFAULT_COMPARISON_REQUEST))}\n`,
);
await writeFile(
  resolve(data, "model-constants.json"),
  `${JSON.stringify({ constants: MODEL_CONSTANT_DOCS })}\n`,
);
