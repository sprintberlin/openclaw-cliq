import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const manifestPath = join(ROOT, "openclaw.plugin.json");
const packageJsonPath = join(ROOT, "package.json");
const skillMdPath = join(ROOT, "skills", "cliq", "SKILL.md");

describe("bundled cliq companion skill packaging and manifest (issue #274)", () => {
  it("declares skills root in openclaw.plugin.json", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.skills).toEqual(["./skills"]);
  });

  it("includes skills directory in package.json files array", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    expect(pkg.files).toContain("skills");
  });

  it("ships a valid SKILL.md under skills/cliq/", () => {
    expect(existsSync(skillMdPath)).toBe(true);
    const content = readFileSync(skillMdPath, "utf8");
    expect(content).toMatch(/^---\nname: cliq\n/);
    expect(content).toContain("Zoho Cliq Channel Operations");
    expect(content).toContain("sprintberlin/openclaw-cliq");
    expect(content).toContain("gh issue create");
    expect(content).toContain('"config": ["channels.cliq"]');
    expect(content).toContain("Definition of Done");
    expect(content).not.toContain("report_plugin_issue.py");
    expect(content.length).toBeLessThan(12000);
  });
});

