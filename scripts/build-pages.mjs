import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_COMPARISON_REQUEST,
  US_BASELINE,
  runComparison,
} from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist-pages");
const data = resolve(output, "data");

await rm(output, { recursive: true, force: true });
await mkdir(data, { recursive: true });
await cp(resolve(root, "public"), output, { recursive: true });

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
