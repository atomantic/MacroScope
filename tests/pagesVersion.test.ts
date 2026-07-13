import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// The static Pages build shares its cache-busting helpers with app.js's runtime
// derivation; unit-test the pure pieces so a stale engine graph can't slip past
// a page-bundle bump.
import { parseAssetVersion, versionRelativeImports } from "../scripts/asset-version.mjs";

describe("parseAssetVersion", () => {
  it("reads the version from the page bundle's app.js query", () => {
    const html = '<link href="./styles.css?v=15" /><script src="./app.js?v=15"></script>';
    expect(parseAssetVersion(html)).toBe("15");
  });

  it("throws when index.html has no versioned app.js", () => {
    expect(() => parseAssetVersion('<script src="./app.js"></script>')).toThrow(/app\.js\?v=N/);
  });

  it("matches the version the shipped index.html actually declares", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const version = parseAssetVersion(html);
    // styles.css and app.js must share one version so the whole page bundle
    // invalidates together.
    expect(html).toContain(`./styles.css?v=${version}`);
    expect(html).toContain(`./app.js?v=${version}`);
  });
});

describe("versionRelativeImports", () => {
  it("stamps the version onto relative import and re-export specifiers", () => {
    const source = [
      'import { a } from "./engine.js";',
      'export { b } from "../shared/util.js";',
      'import "./side-effect.js";',
    ].join("\n");
    expect(versionRelativeImports(source, "15")).toBe(
      [
        'import { a } from "./engine.js?v=15";',
        'export { b } from "../shared/util.js?v=15";',
        'import "./side-effect.js?v=15";',
      ].join("\n"),
    );
  });

  it("leaves bare (non-relative) specifiers untouched", () => {
    const source = 'import express from "express";';
    expect(versionRelativeImports(source, "15")).toBe(source);
  });

  it("does not double-stamp a specifier that already carries a query", () => {
    const source = 'import { a } from "./engine.js?v=15";';
    expect(versionRelativeImports(source, "16")).toBe(source);
  });

  it("leaves dynamic import() specifiers untouched (app.js versions those itself at runtime)", () => {
    // The paren-vs-quote distinction is load-bearing: app.js derives the
    // version from its own URL and stamps its dynamic engine/worker imports, so
    // the build-time rewrite must NOT also stamp (and mangle) them.
    const source = 'const m = await import("./engine/browser/engine.js");';
    expect(versionRelativeImports(source, "15")).toBe(source);
  });

  it("versions the whole worker-reachable graph so no transitive import is left stale", () => {
    const worker = 'import { compareScenarios } from "./engine/browser/engine.js";';
    expect(versionRelativeImports(worker, "15")).toBe(
      'import { compareScenarios } from "./engine/browser/engine.js?v=15";',
    );
  });
});
