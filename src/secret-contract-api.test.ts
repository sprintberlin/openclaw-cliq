import { describe, it, expect } from "vitest";
// These import names are the point of the test: OpenClaw's contract loader
// only accepts `secretTargetRegistryEntries` / `collectRuntimeConfigAssignments`
// and silently ignores anything else, which reports a plaintext config "clean".
import {
  secretTargetRegistryEntries as apiEntries,
  collectRuntimeConfigAssignments as apiCollector,
} from "../secret-contract-api.js";
import {
  cliqSecretTargetRegistryEntries,
  collectCliqRuntimeConfigAssignments,
} from "./secret-contract.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(resolve(here, "..", "package.json"), "utf8"),
) as { files?: string[] };
const buildConfig = JSON.parse(
  readFileSync(resolve(here, "..", "tsconfig.build.json"), "utf8"),
) as { include?: string[] };

describe("OpenClaw secret-contract-api discovery (issue #95)", () => {
  it("re-exports the canonical registry instead of duplicating it", () => {
    expect(apiEntries).toBe(cliqSecretTargetRegistryEntries);
    expect(apiCollector).toBe(collectCliqRuntimeConfigAssignments);
  });

  it("is included in both build output and the published package", () => {
    expect(buildConfig.include).toContain("secret-contract-api.ts");
    expect(packageJson.files).toContain("secret-contract-api.ts");
  });

  it("exports exactly the names OpenClaw's contract loader looks for", () => {
    // A renamed export loads without error and yields zero targets, so the
    // audit silently passes a config full of plaintext secrets.
    expect(typeof apiCollector).toBe("function");
    expect(Array.isArray(apiEntries)).toBe(true);
  });

  it("keeps every secret target auditable and migratable", () => {
    expect(apiEntries).toHaveLength(6);
    for (const entry of apiEntries) {
      expect(entry.includeInAudit).toBe(true);
      expect(entry.includeInPlan).toBe(true);
      expect(entry.secretShape).toBe("secret_input");
    }
  });
});
