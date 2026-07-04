import { describe, it, expect } from "vitest";
import { markdownToCliq } from "./markdown.js";

describe("markdownToCliq", () => {
  it("returns empty string unchanged", () => {
    expect(markdownToCliq("")).toBe("");
  });

  it("passes plain text through unchanged", () => {
    expect(markdownToCliq("just some words")).toBe("just some words");
  });

  it("converts **bold** to *bold*", () => {
    expect(markdownToCliq("this is **bold** text")).toBe("this is *bold* text");
  });

  it("converts __bold__ to *bold*", () => {
    expect(markdownToCliq("this is __bold__ text")).toBe("this is *bold* text");
  });

  it("converts *italic* to _italic_", () => {
    expect(markdownToCliq("this is *italic* text")).toBe("this is _italic_ text");
  });

  it("handles bold + italic together without cross-interference", () => {
    expect(markdownToCliq("**bold** and *italic*")).toBe("*bold* and _italic_");
  });

  it("converts ~~strikethrough~~ to ~strike~", () => {
    expect(markdownToCliq("~~removed~~")).toBe("~removed~");
  });

  it("converts > blockquote to !blockquote", () => {
    expect(markdownToCliq("> quoted text")).toBe("!quoted text");
  });

  it("converts blockquote without space after >", () => {
    expect(markdownToCliq(">quoted")).toBe("!quoted");
  });

  it("converts blockquotes across multiple lines", () => {
    expect(markdownToCliq("> line one\n> line two")).toBe(
      "!line one\n!line two",
    );
  });

  it("preserves inline code verbatim", () => {
    expect(markdownToCliq("run `npm test` now")).toBe("run `npm test` now");
  });

  it("does not transform markdown inside inline code", () => {
    expect(markdownToCliq("see `**not bold**` here")).toBe(
      "see `**not bold**` here",
    );
  });

  it("preserves fenced code blocks verbatim", () => {
    const block = "```ts\nconst x = **not bold**;\n```";
    expect(markdownToCliq(`before\n${block}\nafter`)).toBe(
      `before\n${block}\nafter`,
    );
  });

  it("does not transform markdown inside fenced code blocks", () => {
    const out = markdownToCliq("```\n**keep**\n```");
    expect(out).toBe("```\n**keep**\n```");
  });

  it("handles multiple inline code spans", () => {
    expect(markdownToCliq("`a` and `b`")).toBe("`a` and `b`");
  });

  it("converts table rows to plain text", () => {
    expect(markdownToCliq("| a | b |")).toBe("a — b");
  });

  it("drops table separator rows", () => {
    const out = markdownToCliq("| a | b |\n| --- | --- |\n| c | d |");
    expect(out).toBe("a — b\n\nc — d");
  });

  it("preserves links in markdown form", () => {
    expect(markdownToCliq("[docs](https://example.com)")).toBe(
      "[docs](https://example.com)",
    );
  });

  it("preserves links adjacent to bold", () => {
    expect(markdownToCliq("**see** [docs](https://example.com)")).toBe(
      "*see* [docs](https://example.com)",
    );
  });

  it("collapses triple newlines from table separator removal", () => {
    const out = markdownToCliq(
      "| a | b |\n| --- | --- |\n| --- | --- |\n| c | d |",
    );
    expect(out).toBe("a — b\n\nc — d");
  });

  it("does not treat a single asterisk inside a word as italic", () => {
    // 1 * 2 should not be treated as italic because there's no closing pair
    // on the same token boundary that the regex matches.
    expect(markdownToCliq("foo * bar")).toBe("foo * bar");
  });

  it("converts single-asterisk italic too (no bold markers present)", () => {
    // `*bold*` in standard Markdown is italic, which maps to Cliq `_bold_`.
    expect(markdownToCliq("already *bold* and _italic_")).toBe(
      "already _bold_ and _italic_",
    );
  });

  it("handles bold inside italic adjacency (greedy edge)", () => {
    expect(markdownToCliq("**a** *b* **c**")).toBe("*a* _b_ *c*");
  });

  it("converts a multi-feature paragraph", () => {
    const input = "**Warning:** ~~old~~ code → run `fix.sh`, see [docs](https://x).";
    const out = markdownToCliq(input);
    expect(out).toBe("*Warning:* ~old~ code → run `fix.sh`, see [docs](https://x).");
  });
});
