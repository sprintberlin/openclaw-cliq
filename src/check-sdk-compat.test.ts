import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const LOCAL_OPENCLAW = join(ROOT, "node_modules", "openclaw");
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Run the real guard against a fixture dist and the locally installed SDK (no network). */
function runGuard(files: Record<string, string>) {
  const dist = mkdtempSync(join(tmpdir(), "cliq-guard-"));
  dirs.push(dist);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "export {};\n");
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dist, name), source);
  return spawnSync("node", ["scripts/check-sdk-compat.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_COMPAT_DIST: dist,
      OPENCLAW_COMPAT_LOCAL_PACKAGE: LOCAL_OPENCLAW,
      OPENCLAW_COMPAT_VERSIONS: "local",
    },
  });
}

describe("scripts/check-sdk-compat.mjs negative cases (#301)", () => {
  it("passes a fixture that imports an existing SDK export", () => {
    const result = runGuard({
      "a.js": 'import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";\nexport { defineChannelPluginEntry };\n',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("checked: 1");
  });

  it("fails when a fixture imports a non-existent SDK subpath", () => {
    const result = runGuard({
      "a.js": 'import { anything } from "openclaw/plugin-sdk/removed-subpath-xyz";\nexport { anything };\n',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("MODULE-MISSING");
    expect(result.stdout).toContain("removed-subpath-xyz");
  });

  it("fails when a fixture imports a missing symbol from an existing subpath", () => {
    const result = runGuard({
      "a.js": 'import { definitelyNotExported } from "openclaw/plugin-sdk/channel-core";\nexport { definitelyNotExported };\n',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("EXPORT-MISSING");
  });

  it("refuses a vacuous pass when it scans zero runtime SDK imports", () => {
    const result = runGuard({ "a.js": 'export const x = 1;\n' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no runtime SDK imports");
  });

  it("rejects an unknown lexer record instead of assuming an empty scan", () => {
    const test = `import { readStaticSdkImport } from "./scripts/sdk-import-record.mjs";\nreadStaticSdkImport({ specifier: "openclaw/plugin-sdk/channel-core", unknown: true });`;
    const result = spawnSync("node", ["--input-type=module", "-e", test], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown es-module-lexer import record shape");
  });

  it("recognizes the static record shapes from es-module-lexer 2.x and 3.x", () => {
    const test = `import { readStaticSdkImport } from "./scripts/sdk-import-record.mjs";\nconst a=readStaticSdkImport({n:"openclaw/plugin-sdk/channel-core",d:-1,ss:0,se:12});\nconst b=readStaticSdkImport({type:"static",specifier:"openclaw/plugin-sdk/channel-core",importStart:0,importEnd:12});\nif(a.module!==b.module || a.start!==b.start || a.end!==b.end) process.exit(1);`;
    const result = spawnSync("node", ["--input-type=module", "-e", test], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("ignores dynamic imports of missing subpaths (documented escape hatch) but still needs one static import", () => {
    const result = runGuard({
      "a.js": 'import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";\nexport const lazy = () => import("openclaw/plugin-sdk/removed-subpath-xyz");\nexport { defineChannelPluginEntry };\n',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
