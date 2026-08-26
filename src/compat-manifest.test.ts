import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The supported OpenClaw versions must live in exactly ONE file
 * (`.github/openclaw-compat.json`), consumed by both the compat workflow and
 * `scripts/check-sdk-compat.mjs`. These tests fail if that contract drifts —
 * e.g. the pinned devDependency no longer matching the declared build floor,
 * which would make CI typecheck against a version nobody declared.
 */
function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"));
}

describe("OpenClaw compatibility manifest", () => {
  const compat = readJson(".github/openclaw-compat.json") as {
    build: string;
    supported: string[];
  };
  const pkg = readJson("package.json") as {
    devDependencies: Record<string, string>;
    openclaw: { build?: { openclawVersion?: string } };
  };

  it("declares a build floor and at least two supported versions", () => {
    expect(typeof compat.build).toBe("string");
    expect(Array.isArray(compat.supported)).toBe(true);
    expect(compat.supported.length).toBeGreaterThanOrEqual(2);
  });

  it("includes the build floor in the supported set", () => {
    expect(compat.supported).toContain(compat.build);
  });

  it("pins the openclaw devDependency to the exact build floor", () => {
    // Exact, not a range: typecheck and smoke must be reproducible.
    expect(pkg.devDependencies.openclaw).toBe(compat.build);
    expect(pkg.devDependencies.openclaw).not.toMatch(/^[\^~]/);
  });

  it("records the same build version in the plugin build metadata", () => {
    expect(pkg.openclaw.build?.openclawVersion).toBe(compat.build);
  });

  it("keeps the version list free of duplicates", () => {
    expect(new Set(compat.supported).size).toBe(compat.supported.length);
  });

  it("is the only place the version list is enumerated", () => {
    // The workflow must read the matrix from the manifest rather than
    // hard-coding versions, so adding one is a single-file edit.
    const workflow = readFileSync(
      new URL("../.github/workflows/compat.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("openclaw-compat.json");
    expect(workflow).toContain("fromJSON(needs.versions.outputs.supported)");
    for (const version of compat.supported) {
      expect(workflow).not.toContain(`"${version}"`);
    }
  });
});
