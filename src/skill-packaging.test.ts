import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const manifestPath = join(ROOT, "openclaw.plugin.json");
const packageJsonPath = join(ROOT, "package.json");
const skillMdPath = join(ROOT, "skills", "cliq", "SKILL.md");
const iconPath = join(ROOT, "assets", "icon.png");

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
    expect(content).toContain("## Issue Rule");
    expect(content).not.toContain("report_plugin_issue.py");
    expect(content.length).toBeLessThan(12000);
  });
});

describe("catalog distribution metadata (issue #263)", () => {
  it("ships assets/icon.png so the ClawHub catalog shows custom artwork", () => {
    expect(existsSync(iconPath)).toBe(true);
    const raw = readFileSync(iconPath);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.length).toBeLessThanOrEqual(512 * 1024);
    expect(raw.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("includes the icon in the npm files allowlist so it ships in the tarball", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    expect(pkg.files).toContain("assets");
  });

  it("does not self-assert official trust anywhere in the README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/## Distribution & trust status/);
    expect(readme).toMatch(/This is a \*\*community\*\* channel plugin/);
    expect(readme).toMatch(/Not conferrable by config/i);
    expect(readme).toMatch(/openclaw\/openclaw#175516/);
  });
});

