import { describe, it, expect } from "vitest";
import {
  CLIQ_PROBE_HANDLER,
  buildCliqProbeBody,
  buildCliqProbeResponse,
  isCliqProbePayload,
  parseCliqProbePayload,
} from "./webhook-probe.js";

describe("Cliq webhook probe payload (issue #96)", () => {
  it("builds a probe body that carries the dedicated handler marker and nonce", () => {
    const body = buildCliqProbeBody("nonce-123");
    expect(body.handler).toBe(CLIQ_PROBE_HANDLER);
    expect(body.probe).toBe("nonce-123");
  });

  it("recognizes its own probe body", () => {
    expect(isCliqProbePayload(buildCliqProbeBody("n"))).toBe(true);
  });

  it("does NOT recognize a normal message payload as a probe", () => {
    const message = {
      handler: "message",
      message: { text: "hello" },
      user: { id: "u1" },
      chat: { id: "c1" },
    };
    expect(isCliqProbePayload(message)).toBe(false);
    expect(parseCliqProbePayload(message)).toBeNull();
  });

  it("does NOT recognize a welcome payload as a probe", () => {
    expect(isCliqProbePayload({ handler: "welcome", user: { id: "u1" } })).toBe(false);
  });

  it("rejects non-object payloads", () => {
    for (const raw of [null, undefined, 42, "probe", [], [1, 2]]) {
      expect(isCliqProbePayload(raw)).toBe(false);
      expect(parseCliqProbePayload(raw)).toBeNull();
    }
  });

  it("parses the nonce out of a probe payload", () => {
    expect(parseCliqProbePayload(buildCliqProbeBody("abc"))).toEqual({ nonce: "abc" });
  });

  it("accepts a probe without a nonce and reports an empty nonce", () => {
    expect(parseCliqProbePayload({ handler: CLIQ_PROBE_HANDLER })).toEqual({ nonce: "" });
  });

  it("ignores a non-string nonce rather than echoing attacker-controlled data", () => {
    expect(parseCliqProbePayload({ handler: CLIQ_PROBE_HANDLER, probe: { evil: true } })).toEqual({
      nonce: "",
    });
  });

  it("matches the handler marker case-insensitively with surrounding whitespace", () => {
    expect(isCliqProbePayload({ handler: `  ${CLIQ_PROBE_HANDLER.toUpperCase()}  ` })).toBe(true);
  });

  it("builds a response that echoes the nonce and identifies the channel + bot", () => {
    const res = buildCliqProbeResponse({ nonce: "abc", botId: "laura" });
    expect(res).toEqual({
      ok: true,
      channel: "cliq",
      probe: "abc",
      botId: "laura",
      dispatched: false,
    });
  });

  it("always reports dispatched:false so callers can assert the no-dispatch guarantee", () => {
    expect(buildCliqProbeResponse({ nonce: "", botId: "b" }).dispatched).toBe(false);
  });

  it("never leaks the webhook secret into the probe response", () => {
    const serialized = JSON.stringify(buildCliqProbeResponse({ nonce: "n", botId: "b" }));
    expect(serialized).not.toContain("secret");
  });
});
