#!/usr/bin/env node
/**
 * Static SDK compatibility guard.
 *
 * A **static named import** of an SDK symbol is validated by Node at module
 * evaluation time, so an SDK export withdrawal does not degrade one feature —
 * it prevents the whole plugin from loading. This script fails CI for that
 * class of break before a gateway ever sees it.
 *
 * It scans the BUILT `dist/**\/*.js` (not `src`), because:
 *   - type-only imports are erased by `tsc` and therefore cannot break
 *     loading; scanning `dist` excludes them for free;
 *   - `dist` is what actually ships and what a gateway loads.
 *
 * Every built file is scanned, not only the graph reachable from the entry
 * points: a lazily imported module that breaks on load is still a break, just
 * a later one.
 *
 * Dynamic `import()` is intentionally ignored: a missing export on a namespace
 * object yields `undefined` rather than a load-time `SyntaxError`, which is
 * exactly the compatibility escape hatch `src/sdk-compat.ts` uses.
 *
 * Supported versions come from `.github/openclaw-compat.json` — the single
 * source of truth shared with the compat workflow.
 *
 * Usage:  npm run check:sdk-compat  [--json]
 * Exit:   0 = every runtime import resolves on every supported version.
 *         1 = at least one problem (module or symbol missing somewhere).
 *         2 = the check could not run (missing dist, unfetchable version).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

await init;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const COMPAT_MANIFEST = join(ROOT, ".github", "openclaw-compat.json");
const JSON_OUTPUT = process.argv.includes("--json");

/**
 * Abort the run with exit code 2 ("could not check"). Thrown rather than
 * exiting directly so `main`'s `finally` still removes the temp dir — an
 * unfetchable version must not leak a few hundred MB into /tmp.
 */
class CheckAbortedError extends Error {}

function fail(message) {
  throw new CheckAbortedError(message);
}

function readSupportedVersions() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(COMPAT_MANIFEST, "utf8"));
  } catch (err) {
    fail(`cannot read ${relative(ROOT, COMPAT_MANIFEST)}: ${err}`);
  }
  const versions = manifest?.supported;
  if (!Array.isArray(versions) || versions.length === 0) {
    fail(`${relative(ROOT, COMPAT_MANIFEST)} has no non-empty "supported" array`);
  }
  return versions;
}

function listJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Collect every static runtime import/re-export of `openclaw/plugin-sdk/*`
 * from one built file. `es-module-lexer` handles regex literals, templates,
 * comments and minified syntax correctly; a regex scanner can silently miss
 * an import when source before it contains `/.../` with quote-like content.
 *
 * Dynamic `import()` records have `d >= 0` and are intentionally skipped: a
 * compatibility module uses namespace property access precisely so a missing
 * named export becomes `undefined` instead of a module-evaluation error.
 */
function collectImports(file) {
  const source = readFileSync(file, "utf8");
  let imports;
  try {
    [imports] = parse(source);
  } catch (err) {
    fail(`cannot parse built module ${relative(ROOT, file)}: ${err}`);
  }
  const found = [];
  for (const entry of imports) {
    if (entry.d >= 0 || !entry.n?.startsWith("openclaw/plugin-sdk/")) continue;
    const rawStatement = source.slice(entry.ss, entry.se);
    // The lexer has already isolated an import declaration (whose grammar
    // cannot contain regex literals), so removing comments here is safe and
    // prevents explanatory comments inside `{ ... }` from becoming symbols.
    const statement = rawStatement
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n\r]*/g, "");
    const module = entry.n;

    // `import { a, b as c } from` / `export { a, b as c } from`.
    const named = statement.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const raw of named[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) found.push({ module, symbol: name });
      }
    }

    // Namespace, default, and bare side-effect imports.
    if (/^\s*import\s+\*\s+as\s+/m.test(statement)) {
      found.push({ module, symbol: "*" });
    } else if (/^\s*import\s+[A-Za-z_$][\w$]*\s*(?:,|from)/m.test(statement)) {
      found.push({ module, symbol: "default" });
    } else if (!named) {
      // Bare import (`import "module"`) or wildcard re-export — only module
      // presence is validated; no named export is requested by the artifact.
      found.push({ module, symbol: "*" });
    }
  }
  return found.map((entry) => ({ ...entry, file: relative(ROOT, file) }));
}

/** Download one published OpenClaw tarball and return its unpacked root. */
function materializeVersion(version, workDir) {
  const dir = join(workDir, version.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync("npm", ["pack", `openclaw@${version}`, "--pack-destination", dir, "--silent"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    fail(`cannot fetch openclaw@${version}: ${err}`);
  }
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tarball) fail(`no tarball produced for openclaw@${version}`);
  execFileSync("tar", ["xzf", join(dir, tarball), "-C", dir], { stdio: "ignore" });
  return join(dir, "package");
}

/**
 * Read the exported names of one built SDK module WITHOUT evaluating it.
 *
 * Importing the module is not viable: a published tarball's transitive
 * runtime dependencies are not installed, so evaluation fails with
 * `ERR_MODULE_NOT_FOUND` for most modules. The export list is therefore taken
 * from `es-module-lexer`, which reports the module's static export names.
 *
 * Returns `null` only when the surface genuinely cannot be determined (parse
 * failure, or a wildcard re-export whose names live in another module). A
 * `null` is treated as UNKNOWN by the checker, never as "ok".
 */
function readModuleExports(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let exports;
  try {
    [, exports] = parse(source);
  } catch {
    return null;
  }
  // `export * from "./x.js"` re-exports names this module never states, so a
  // symbol absent from the local list may still be exported.
  if (/(^|[;\s])export\s*\*\s*from\s*["']/.test(source)) return null;
  const names = new Set();
  for (const entry of exports) {
    if (entry.n) names.add(entry.n);
  }
  return names.size > 0 ? names : null;
}

/**
 * Resolve one `exports` entry to a file path. Handles the flat string form,
 * condition objects, and nested conditions; returns `null` for anything that
 * cannot be resolved (which the caller reports as UNKNOWN rather than ok).
 */
function resolveExportTarget(target, depth = 0) {
  if (typeof target === "string") return target;
  if (depth > 4 || target === null || typeof target !== "object") return null;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveExportTarget(entry, depth + 1);
      if (resolved) return resolved;
    }
    return null;
  }
  for (const condition of ["node", "import", "module", "default"]) {
    if (condition in target) {
      const resolved = resolveExportTarget(target[condition], depth + 1);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Build the export table for one version: which `plugin-sdk` subpaths exist,
 * and which symbols each exports. Symbols come from the built `.js`, so the
 * check reflects the actual runtime surface rather than the shipped `.d.ts`
 * (which differs between releases).
 */
function buildExportTable(packageRoot) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const table = new Map();
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (!subpath.startsWith("./plugin-sdk/")) continue;
    const specifier = `openclaw${subpath.slice(1)}`;
    const file = resolveExportTarget(target);
    if (!file) {
      table.set(specifier, null);
      continue;
    }
    const abs = join(packageRoot, file);
    try {
      statSync(abs);
    } catch {
      table.set(specifier, null);
      continue;
    }
    table.set(specifier, readModuleExports(abs));
  }
  return table;
}

async function main() {
  try {
    statSync(join(DIST, "index.js"));
  } catch {
    fail("dist/index.js not found — run `npm run build` first");
  }

  const versions = readSupportedVersions();
  const imports = listJsFiles(DIST).flatMap(collectImports);
  const unique = new Map();
  for (const entry of imports) {
    unique.set(`${entry.module}\u0000${entry.symbol}\u0000${entry.file}`, entry);
  }
  const checked = [...unique.values()].sort(
    (a, b) => a.module.localeCompare(b.module) || a.symbol.localeCompare(b.symbol),
  );

  const workDir = mkdtempSync(join(tmpdir(), "openclaw-compat-"));
  const tables = new Map();
  try {
    for (const version of versions) {
      tables.set(version, buildExportTable(materializeVersion(version, workDir)));
    }

    const problems = [];
    for (const entry of checked) {
      const perVersion = {};
      for (const version of versions) {
        const table = tables.get(version);
        if (!table.has(entry.module)) {
          perVersion[version] = "MODULE-MISSING";
          continue;
        }
        const symbols = table.get(entry.module);
        if (entry.symbol === "*") {
          // Only module presence matters for a namespace/bare import.
          perVersion[version] = "ok";
        } else if (symbols === null) {
          // The module exists but its export surface could not be determined.
          // Reporting "ok" here would let a real withdrawal pass unnoticed,
          // which is exactly the failure this guard exists to prevent.
          perVersion[version] = "EXPORTS-UNKNOWN";
        } else {
          perVersion[version] = symbols.has(entry.symbol) ? "ok" : "EXPORT-MISSING";
        }
      }
      if (Object.values(perVersion).some((v) => v !== "ok")) {
        problems.push({ ...entry, perVersion });
      }
    }

    if (JSON_OUTPUT) {
      console.log(
        JSON.stringify(
          { versions, checked: checked.length, problems: problems.length, details: problems },
          null,
          2,
        ),
      );
    } else {
      const compatible = checked.length - problems.length;
      console.log(
        `checked: ${checked.length}   compatible with all: ${compatible}   PROBLEMS: ${problems.length}`,
      );
      console.log(`versions: ${versions.join(", ")}`);
      for (const problem of problems) {
        const states = versions.map((v) => `${v}=${problem.perVersion[v]}`).join(" | ");
        console.log(`\n  [${states}]  ${problem.module}`);
        console.log(`        ${problem.symbol}   <- ${problem.file}`);
      }
    }
    // `process.exit` here would skip the `finally` cleanup and leak a
    // several-hundred-MB temp dir per run; set the code and return instead.
    process.exitCode = problems.length === 0 ? 0 : 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof CheckAbortedError) {
    console.error(`check-sdk-compat: ${err.message}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
