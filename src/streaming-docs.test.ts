import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

describe("README streaming caveats (issues #195 and #203)", () => {
  it("does not collapse live evidence into a universal Core claim", () => {
    expect(readme).not.toMatch(
      /openai-completions models with `thinking` do \*\*not\*\* emit those snapshots/,
    );
    expect(readme).not.toContain(
      "Live DMs therefore stay on the placeholder until one final edit",
    );
  });

  it("documents that snapshots can arrive and guards a tiny first snapshot", () => {
    expect(readme).toContain("the first one can be tiny");
    expect(readme).toContain("starting at `textLen=1`");
    expect(changelog).toContain("issue #203");
  });

  it("links the Core partial-reply blocker as a model-specific path, not a universal rule", () => {
    expect(readme).toContain("openclaw/openclaw#132615");
    expect(readme).toContain("openclawDelivery.textPhaseRequiresTerminal");
    expect(readme).toContain("sprintcx/tier-1");
    expect(readme).toContain("sprintcx/tier-2");
  });

  it("preserves the plugin-side capability without inventing events", () => {
    expect(readme).toContain(
      "Coalesced block `deliver()` calls can still edit the same message when Core flushes a block",
    );
  });
});

describe("README streaming switches and live model matrix (issue #205)", () => {
  it("shows a working streaming configuration with both switches", () => {
    expect(readme).toContain("**Working streaming configuration.**");
    expect(readme).toContain('"blockStreamingDefault": "on"');
    expect(readme).toContain('"preview": "on"');
    expect(readme).toContain('"mode": "placeholder"');
    expect(readme).toContain('"animate": "off"');
  });

  it("separates Core block streaming, Cliq live-edit, and thinking animation", () => {
    expect(readme).toContain("agents.defaults.blockStreamingDefault");
    expect(readme).toContain("channels.cliq.streaming.preview");
    expect(readme).toContain("thinking.animate");
    expect(readme).toMatch(/OpenClaw block streaming/);
    expect(readme).toMatch(/Cliq one-message live-edit/);
    expect(readme).toMatch(/thinking placeholder animation/);
  });

  it("records the live tier-1 vs tier-2 matrix instead of a universal Core claim", () => {
    expect(readme).toContain("textLen=4097");
    expect(readme).toContain("textLen=68");
    expect(readme).toContain("textLen=4942");
    expect(readme).toContain("thinking=medium");
  });

  it("states the actual guarantee: same message plus in-place final, growth only when the model emits", () => {
    expect(readme).toMatch(/same message/i);
    expect(readme).toMatch(/progressive intermediate growth only when/i);
  });

  it("changelog and roadmap no longer claim Core never invokes the callback", () => {
    expect(changelog).toContain("issue #205");
    expect(changelog).not.toMatch(
      /Core returns before `emitAssistantStreamData` for openai-completions streams with `thinking`/,
    );
    const roadmap = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
    expect(roadmap).not.toContain("so Core never invokes the callback");
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
