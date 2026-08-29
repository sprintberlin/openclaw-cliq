import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

describe("README streaming caveats (issue #195)", () => {
  it("does not promise token-level growth on the pinned runtime", () => {
    expect(readme).toContain(
      "Live DMs therefore stay on the placeholder until one final edit",
    );
    expect(readme).toContain("do not expect token-level growth");
  });

  it("links the Core partial-reply blocker", () => {
    expect(readme).toContain("openclaw/openclaw#132615");
    expect(readme).toContain("openclawDelivery.textPhaseRequiresTerminal");
  });

  it("preserves the plugin-side capability without inventing events", () => {
    expect(readme).toContain(
      "Coalesced block `deliver()` calls can still edit the same message when Core flushes a block",
    );
  });
});
