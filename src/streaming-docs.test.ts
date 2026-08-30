import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

describe("README streaming caveats (issues #195 and #203)", () => {
  it("does not promise reliable token-level growth on the pinned runtime", () => {
    expect(readme).toContain(
      "Live DMs therefore usually stay on the placeholder until one final edit",
    );
    expect(readme).toContain("do not expect reliable token-level growth");
  });

  it("documents that snapshots can arrive and guards a tiny first snapshot", () => {
    expect(readme).toContain("the first one can be tiny");
    expect(readme).toContain("starting at `textLen=1`");
    expect(changelog).toContain("issue #203");
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

describe("README streaming caveats (issue #194)", () => {
  it("says default preview is not token streaming", () => {
    expect(readme).toContain("This is **not** Telegram-style token streaming");
    expect(readme).not.toContain(
      "lets the same Cliq message grow in place while the model is writing",
    );
  });

  it("records the Mara placeholder-to-final live miss", () => {
    expect(readme).toContain("textLen=4");
    expect(readme).toContain("textLen=117");
    expect(readme).toContain(
      "#175 and #185 never documented a live Cliq DM round-trip",
    );
  });

  it("warns that HTTP 204 is API acceptance only", () => {
    const streaming = readme.slice(readme.indexOf("- **`streaming`**"));
    expect(streaming).toContain("HTTP 204 is API acceptance only");
    expect(streaming).toContain("until the chat is reopened");
  });

  it("names the opt-out keys for a normal message", () => {
    const streaming = readme.slice(readme.indexOf("- **`streaming`**"));
    expect(streaming).toContain('streaming.preview: "off"');
    expect(streaming).toContain('thinking.mode: "off"');
  });

  it("splits thinking and streaming into operator subsections", () => {
    const thinking = readme.slice(
      readme.indexOf("- **`thinking`**"),
      readme.indexOf("- **`streaming`**"),
    );
    const streaming = readme.slice(
      readme.indexOf("- **`streaming`**"),
      readme.indexOf("- **`welcome`**"),
    );
    expect(thinking).toContain("**What you see.**");
    expect(thinking).toContain("**Turn it off.**");
    expect(streaming).toContain("**What you see on a default install.**");
    expect(streaming).toContain("**Opt out.**");
  });

  it("changelog records the docs honesty fix", () => {
    expect(changelog).toContain("issue #194");
    expect(changelog).toContain("HTTP 204 is API acceptance only");
  });
});
