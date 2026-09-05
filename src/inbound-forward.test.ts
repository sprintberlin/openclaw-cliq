import { describe, expect, it } from "vitest";
import {
  formatCliqForwardBlock,
  hasCliqForwardMarker,
  parseCliqForwardContext,
} from "./inbound-forward.js";

describe("parseCliqForwardContext", () => {
  it("returns undefined when no forward fields are present", () => {
    expect(parseCliqForwardContext({ message: "hi", user: { id: "u1" } })).toBeUndefined();
    expect(parseCliqForwardContext(null)).toBeUndefined();
    expect(parseCliqForwardContext("nope")).toBeUndefined();
    expect(parseCliqForwardContext([1, 2])).toBeUndefined();
  });

  it("parses a root-level forwarded_message object", () => {
    const out = parseCliqForwardContext({
      message: "",
      forwarded_message: {
        id: "m-orig",
        text: "Hi Gregor\nHier nochmal etwas für die Wand",
        time: "22 Juli 2026, 10:58 AM",
        sender: { id: "u-seb", name: "Sebastian" },
      },
    });
    expect(out).toEqual({
      text: "Hi Gregor\nHier nochmal etwas für die Wand",
      senderName: "Sebastian",
      senderId: "u-seb",
      time: "22 Juli 2026, 10:58 AM",
      messageId: "m-orig",
      sourceTitle: undefined,
    });
  });

  it("parses the forward nested under message", () => {
    const out = parseCliqForwardContext({
      message: { text: "", forwarded: { text: "original body", sender: { name: "Ada" } } },
    });
    expect(out?.text).toBe("original body");
    expect(out?.senderName).toBe("Ada");
  });

  it("unwraps the params-wrapped shape", () => {
    const out = parseCliqForwardContext({
      params: { forwarded_message: { text: "wrapped body", sender: { name: "Bob" } } },
    });
    expect(out?.text).toBe("wrapped body");
    expect(out?.senderName).toBe("Bob");
  });

  it("accepts a bare string forward body", () => {
    expect(parseCliqForwardContext({ forwarded: "just the text" })?.text).toBe("just the text");
  });

  it("joins first_name + last_name for the original author", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { text: "x", sender: { first_name: "Scott", last_name: "Fisher" } },
    });
    expect(out?.senderName).toBe("Scott Fisher");
  });

  it("reads content.text and content.comment variants", () => {
    expect(
      parseCliqForwardContext({ forwarded_message: { content: { text: "via content.text" } } })?.text,
    ).toBe("via content.text");
    expect(
      parseCliqForwardContext({ forwarded_message: { content: { comment: "via comment" } } })?.text,
    ).toBe("via comment");
  });

  it("carries the originating chat title when present", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { text: "x", chat: { title: "#sales" } },
    });
    expect(out?.sourceTitle).toBe("#sales");
  });

  it("merges a sparse and a rich source first-wins", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { text: "body only" },
      original_message: { text: "ignored", sender: { name: "Cara" }, time: "t1" },
    });
    expect(out?.text).toBe("body only");
    expect(out?.senderName).toBe("Cara");
    expect(out?.time).toBe("t1");
  });

  it("ignores an empty marker object that carries neither text nor author", () => {
    expect(parseCliqForwardContext({ forwarded_message: {} })).toBeUndefined();
    expect(parseCliqForwardContext({ forwarded_message: { chat: { title: "#x" } } })).toBeUndefined();
  });
});

describe("hasCliqForwardMarker", () => {
  it("detects a boolean marker at the root and under message", () => {
    expect(hasCliqForwardMarker({ is_forwarded: true })).toBe(true);
    expect(hasCliqForwardMarker({ message: { isForwarded: true } })).toBe(true);
  });

  it("detects an empty forward object the parser cannot use", () => {
    expect(hasCliqForwardMarker({ forwarded_message: {} })).toBe(true);
    expect(parseCliqForwardContext({ forwarded_message: {} })).toBeUndefined();
  });

  it("detects a params-wrapped marker", () => {
    expect(hasCliqForwardMarker({ params: { forwarded_message: {} } })).toBe(true);
  });

  it("is false for an ordinary message", () => {
    expect(hasCliqForwardMarker({ message: "hi", user: { id: "u" } })).toBe(false);
    expect(hasCliqForwardMarker(null)).toBe(false);
  });
});

describe("formatCliqForwardBlock", () => {
  it("renders author, source, time and quoted body", () => {
    const block = formatCliqForwardBlock({
      text: "line one\nline two",
      senderName: "Sebastian",
      sourceTitle: "#sales",
      time: "22 Juli 2026, 10:58 AM",
    });
    expect(block).toBe(
      "⤷ Forwarded message from Sebastian in #sales (22 Juli 2026, 10:58 AM):\n> line one\n> line two",
    );
  });

  it("renders a header-only block when the body was promoted to the turn text", () => {
    expect(formatCliqForwardBlock({ senderName: "Ada" })).toBe("⤷ Forwarded message from Ada:");
  });

  it("degrades to a bare header when nothing but text is known", () => {
    expect(formatCliqForwardBlock({ text: "body" })).toBe("⤷ Forwarded message:\n> body");
  });

  it("truncates a very long forwarded body", () => {
    const block = formatCliqForwardBlock({ text: "x".repeat(2500) });
    expect(block.endsWith("…")).toBe(true);
    expect(block.length).toBeLessThan(2200);
  });
});
