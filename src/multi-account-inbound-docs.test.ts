import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const runningMultipleAgents = readFileSync(
  join(ROOT, "docs/setup/running-multiple-agents.md"),
  "utf8",
);

describe("README multi-account inbound limitation (issue #191)", () => {
  it("states that inbound webhook traffic uses the root account only", () => {
    expect(readme).toContain("**Inbound webhook traffic is resolved against the root account only.**");
    expect(readme).toContain("Named accounts are currently outbound/diagnostics-only");
  });

  it("directs operators to separate gateway deployments for multiple bots", () => {
    expect(readme).toMatch(/Running multiple conversational bots requires \*\*separate gateway deployments\*\*/);
    expect(readme).toContain("docs/setup/running-multiple-agents.md");
  });

  it("keeps the running-multiple-agents guide as the operational procedure", () => {
    expect(runningMultipleAgents).toMatch(/Route each bot to its own gateway deployment/i);
    expect(runningMultipleAgents).toMatch(/Do not direct multiple agents' handlers to one agent's endpoint/i);
  });
});
