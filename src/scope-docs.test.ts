import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FULL_SCOPE_STRING, RUNTIME_SCOPE_STRING } from "./capabilities.js";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

describe("README scope guidance (issue #192)", () => {
  it("publishes both canonical scope strings verbatim", () => {
    expect(readme).toContain(FULL_SCOPE_STRING);
    expect(readme).toContain(RUNTIME_SCOPE_STRING);
  });

  it("recommends the combined profile before the runtime-only alternative", () => {
    const combinedHeading = readme.indexOf("**Combined profile (recommended)**");
    const runtimeHeading = readme.indexOf("**Runtime-only profile (minimal alternative)**");
    expect(combinedHeading).toBeGreaterThan(-1);
    expect(runtimeHeading).toBeGreaterThan(-1);
    expect(combinedHeading).toBeLessThan(runtimeHeading);
  });

  it("presents the combined string before the runtime-only string", () => {
    expect(readme.indexOf(FULL_SCOPE_STRING)).toBeLessThan(
      readme.indexOf(`\n${RUNTIME_SCOPE_STRING}\n`),
    );
  });

  it("warns that Zoho consent is not extended retroactively", () => {
    expect(readme).toMatch(/scopes are not added retroactively/i);
    expect(readme).toMatch(/re-consent[\s\S]{0,400}regenerate the refresh token/i);
  });
});
