// Shared cache-busting helpers for the static Pages build. ONE asset version —
// parsed from public/index.html's `app.js?v=N` — busts the whole static graph
// in a single bump: the page bundle (styles.css/app.js), the published engine
// module graph, and the web-worker entry. app.js re-derives the same version at
// runtime from its own URL, so its scenario-params import, worker load,
// main-thread engine import, and data-snapshot fetches all move together with
// the page bundle instead of pinning to whatever a returning client cached.

// Matches `from "spec"` and `import "spec"` (static + re-export forms) while
// keeping the surrounding tokens so they can be re-emitted verbatim. Dynamic
// `import("spec")` uses a paren, not a quote, so it is intentionally skipped.
const IMPORT_SPECIFIER_PATTERN = /((?:from|import)\s*")([^"]+)(")/g;

// Pull the canonical asset version from the page bundle's own query string so
// the whole build shares one source of truth (the `app.js?v=N` in index.html).
export const parseAssetVersion = (html) => {
  const match = html.match(/app\.js\?v=(\d+)/);
  if (!match) {
    throw new Error(
      "Could not find `app.js?v=N` in index.html; the static build needs one asset version to cache-bust the engine graph.",
    );
  }
  return match[1];
};

// Append `?v=<version>` to every relative import specifier in a published
// module so a returning client can never pair a fresh entry point with a stale
// transitive dependency. Bare specifiers (a browser can't resolve them) and
// specifiers that already carry a query are left untouched.
export const versionRelativeImports = (source, version) =>
  source.replace(IMPORT_SPECIFIER_PATTERN, (whole, prefix, specifier, suffix) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return whole;
    if (specifier.includes("?")) return whole;
    return `${prefix}${specifier}?v=${version}${suffix}`;
  });
