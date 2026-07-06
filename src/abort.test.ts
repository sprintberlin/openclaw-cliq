import { describe, it, expect } from "vitest";
import { isCliqAbortIntent, cliqAbortCtxFields } from "./abort.js";

describe("isCliqAbortIntent", () => {
  it("detects the canonical `stop` intent", () => {
    expect(isCliqAbortIntent("stop")).toBe(true);
  });

  it("detects the slash form `/stop`", () => {
    expect(isCliqAbortIntent("/stop")).toBe(true);
  });

  it("detects `/stop` with a trailing bot handle (Cliq mention suffix)", () => {
    expect(isCliqAbortIntent("/stop@openclaw-bot", "openclaw-bot")).toBe(true);
  });

  it("detects `/stop` even without a bot handle when no botName is given", () => {
    expect(isCliqAbortIntent("/stop")).toBe(true);
  });

  it("detects the `esc` intent", () => {
    expect(isCliqAbortIntent("esc")).toBe(true);
  });

  it("detects localized equivalents", () => {
    expect(isCliqAbortIntent("arrête")).toBe(true);
    expect(isCliqAbortIntent("停止")).toBe(true);
    expect(isCliqAbortIntent("стоп")).toBe(true);
    expect(isCliqAbortIntent("halt")).toBe(true);
    expect(isCliqAbortIntent("please stop")).toBe(true);
  });

  it("is case-insensitive and tolerates trailing punctuation", () => {
    expect(isCliqAbortIntent("STOP!")).toBe(true);
    expect(isCliqAbortIntent("Stop.")).toBe(true);
    expect(isCliqAbortIntent("  stop  ")).toBe(true);
  });

  it("does not fire on a normal conversational message", () => {
    expect(isCliqAbortIntent("hello bot")).toBe(false);
    expect(isCliqAbortIntent("can you stop adding comments?")).toBe(false);
    expect(isCliqAbortIntent("stopped by the rain")).toBe(false);
  });

  it("does not fire on a stop embedded in a longer sentence", () => {
    // `stop` must be the whole (normalized) message — a sentence containing
    // the word is NOT an abort intent.
    expect(isCliqAbortIntent("please don't stop me now")).toBe(false);
  });

  it("returns false for empty / undefined / null input", () => {
    expect(isCliqAbortIntent("")).toBe(false);
    expect(isCliqAbortIntent(undefined)).toBe(false);
    expect(isCliqAbortIntent(null)).toBe(false);
  });
});

describe("cliqAbortCtxFields", () => {
  it("marks the turn as an authorized text command", () => {
    expect(cliqAbortCtxFields()).toEqual({
      CommandSource: "text",
      CommandAuthorized: true,
    });
  });

  it("returns a fresh object each call (no shared mutation)", () => {
    const a = cliqAbortCtxFields();
    const b = cliqAbortCtxFields();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
