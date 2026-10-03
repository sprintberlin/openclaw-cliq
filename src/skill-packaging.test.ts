import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const manifestPath = join(ROOT, "openclaw.plugin.json");
const packageJsonPath = join(ROOT, "package.json");
const skillMdPath = join(ROOT, "skills", "cliq", "SKILL.md");
const reporterScriptPath = join(ROOT, "skills", "cliq", "scripts", "report_plugin_issue.py");

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
    expect(content).toContain("report_plugin_issue.py");
    expect(content).toContain("~/.openclaw/plugin-skills/cliq/scripts/report_plugin_issue.py");
    expect(content).toContain('"config": ["channels.cliq"]');
    expect(content).toContain("Definition of Done");
    expect(content.length).toBeLessThan(12000);
  });

  it("ships a working python issue reporter that dry-runs and redacts sensitive input", () => {
    expect(existsSync(reporterScriptPath)).toBe(true);
    const stdout = execFileSync(
      "python3",
      [
        reporterScriptPath,
        "--kind",
        "parser-bug",
        "--title",
        'Test clientSecret="supersecret" token=1000.abcdef0123456789 user@example.com',
        "--expected",
        "clean output",
        "--actual",
        'JSON {"refreshToken":"1000.zyxwvutsrqponm"} Bearer auth-value https://alice:password@example.com/path?secret=query-secret&token=query-token leaked secret=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        "--repro",
        "--client-secret argv-secret CLIQ_WEBHOOK_SECRET=env-secret password: pass-value",
        "--dry-run",
        "--json",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("dry-run");
    expect(parsed.repo).toBe("sprintberlin/openclaw-cliq");
    expect(parsed.title).toContain('clientSecret="[REDACTED]"');
    expect(parsed.title).toContain("[REDACTED_OAUTH_TOKEN]");
    expect(parsed.title).toContain("[REDACTED_EMAIL]");
    expect(parsed.body).toContain("[REDACTED_HEX_SECRET]");
    expect(parsed.body).toContain("Bearer [REDACTED]");
    expect(parsed.body).toContain("[REDACTED_CREDENTIALS]");
    expect(parsed.body).toContain("--client-secret [REDACTED]");
    for (const secret of [
      "supersecret",
      "auth-value",
      "password@example.com",
      "query-secret",
      "query-token",
      "argv-secret",
      "env-secret",
      "pass-value",
    ]) {
      expect(JSON.stringify(parsed)).not.toContain(secret);
    }
  });

  it("excludes python bytecode caches from the npm tarball", () => {
    const cacheDir = join(ROOT, "skills", "cliq", "scripts", "__pycache__");
    const fixture = join(cacheDir, "report_plugin_issue.cpython-test.pyc");
    const packDir = mkdtempSync(join(tmpdir(), "openclaw-cliq-pack-"));
    try {
      execFileSync("mkdir", ["-p", cacheDir]);
      execFileSync("touch", [fixture]);
      const packed = JSON.parse(
        execFileSync("npm", ["pack", "--dry-run", "--json", "--pack-destination", packDir], {
          cwd: ROOT,
          encoding: "utf8",
        }),
      );
      const files = packed[0]?.files?.map((entry: { path: string }) => entry.path) ?? [];
      expect(files).toContain("skills/cliq/SKILL.md");
      expect(files).toContain("skills/cliq/scripts/report_plugin_issue.py");
      expect(files.some((path: string) => path.includes("__pycache__"))).toBe(false);
      expect(files.some((path: string) => path.endsWith(".pyc"))).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
