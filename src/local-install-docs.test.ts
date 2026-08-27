import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");

describe("local checkout install documentation (issue #126)", () => {
  it("documents the supported-version split instead of claiming one command works everywhere", () => {
    expect(readme).toContain(
      "openclaw plugins install --link --force ~/github_repos/openclaw-cliq",
    );
    expect(readme).toContain(
      "openclaw plugins install --link ~/github_repos/openclaw-cliq",
    );
    expect(readme).toMatch(/2026\.8\.1-beta\.3[\s\S]*outside ClawHub review and trust metadata/i);
    expect(readme).toMatch(/2026\.7\.1-2[\s\S]*rejected[\s\S]*--link/i);
  });

  it("states that --force is an explicit trust acknowledgement", () => {
    expect(readme).toMatch(/--force[\s\S]*acknowledgement of the warning/i);
    expect(readme).toMatch(/not a way to skip a real safety check/i);
  });

  it("documents the expected manifest-id message and cliq config key", () => {
    expect(readme).toContain(
      'Plugin manifest id "cliq" differs from npm package name "@sprintcx/openclaw-cliq"; using manifest id as the config key.',
    );
    expect(readme).toMatch(/config key is `cliq`/i);
  });

  it("requires a rebuild and gateway restart after every pull for a linked checkout", () => {
    expect(readme).toMatch(/every later `git pull` needs a rebuild plus a gateway restart/i);
    expect(readme).toContain("npm ci && npx tsc --noEmit && npm test && npm run build");
    expect(readme).toContain("systemctl --user restart openclaw-gateway.service");
    expect(contributing).toMatch(/every later `git pull` needs a rebuild[\s\S]*gateway restart/i);
  });
});
