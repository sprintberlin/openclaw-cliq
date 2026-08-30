import { describe, expect, it } from "vitest";
import { renderCliqProgressDraftText } from "./progress-render.js";

describe("renderCliqProgressDraftText (issue #209)", () => {
  it("renders Core headline, plan checklist, and rolling lines as Cliq text", () => {
    expect(
      renderCliqProgressDraftText(
        "Working\n\nChecking the docs\n\n• Read docs.md\n▸ Look it up",
        [
          { kind: "tool", text: "📖 Read: docs.md", label: "Read", icon: "📖" },
        ],
      ),
    ).toBe("Working\n\nChecking the docs\n\n• Read docs.md\n▸ Look it up");
  });

  it("preserves the Core-rendered headline, checklist, and rolling line snapshot", () => {
    const snapshot = [
      "Working",
      "",
      "Checking the docs",
      "",
      "- [x] Inspect transport",
      "- [ ] Run tests",
      "",
      "📖 Read: docs.md",
      "🔎 Web Search: for Zoho Cliq edit message",
    ].join("\n");
    expect(renderCliqProgressDraftText(snapshot)).toMatchInlineSnapshot(`
      "Working

      Checking the docs

      - [x] Inspect transport
      - [ ] Run tests

      📖 Read: docs.md
      🔎 Web Search: for Zoho Cliq edit message"
    `);
  });

  it("converts Core markdown with the existing Cliq converter", () => {
    expect(renderCliqProgressDraftText("**Working**\n\n_Checking_")).toBe(
      "*Working*\n\n_Checking_",
    );
  });

  it("does not invent a local tool/icon dictionary", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./progress-render.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/telegram/i);
    expect(source).not.toMatch(/Record<string,\s*string>/);
  });
});
