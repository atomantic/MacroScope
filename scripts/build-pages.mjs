import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import {
  DEFAULT_COMPARISON_REQUEST,
  US_BASELINE,
  runComparison,
} from "../dist/index.js";

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

await rm(output, { recursive: true, force: true });
await mkdir(data, { recursive: true });
await cp(resolve(root, "public"), output, { recursive: true });

for (const [moduleId, source] of engineModules) {
  const target = resolve(engine, moduleId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
console.log(`🧠 Published ${engineModules.size} engine modules for the in-browser worker`);

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
  resolve(data, "default-scenario.json"),
  `${JSON.stringify(runComparison(DEFAULT_COMPARISON_REQUEST))}\n`,
);
