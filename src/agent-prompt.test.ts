import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  cliqAgentPromptAdapter,
  resolveCliqMessageToolHints,
  resolveCliqInboundFormattingHints,
  resolveCliqReactionGuidance,
} from "./agent-prompt.js";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

describe("resolveCliqMessageToolHints", () => {
  it("returns a non-empty array of hint strings", () => {
    const hints = resolveCliqMessageToolHints();
    expect(Array.isArray(hints)).toBe(true);
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(typeof h).toBe("string");
      expect(h.startsWith("- ")).toBe(true);
    }
  });

  it("mentions the Cliq markdown delimiters", () => {
    const hints = resolveCliqMessageToolHints().join("\n");
    expect(hints).toContain("*bold*");
    expect(hints).toContain("_italic_");
  });

  it("documents the 5000-char limit", () => {
    const hints = resolveCliqMessageToolHints().join("\n");
    expect(hints).toContain("5000");
  });

  it("documents targeting prefixes", () => {
    const hints = resolveCliqMessageToolHints().join("\n");
    expect(hints).toContain("user:<zohoUserId>");
    expect(hints).toContain("channel:<channelUniqueName>");
  });
});

describe("resolveCliqInboundFormattingHints", () => {
  it("declares markdown markup", () => {
    const hints = resolveCliqInboundFormattingHints();
    expect(hints.text_markup).toBe("markdown");
    expect(Array.isArray(hints.rules)).toBe(true);
    expect(hints.rules.length).toBeGreaterThan(0);
  });

  it("rules mention the 5000-char chunking", () => {
    const hints = resolveCliqInboundFormattingHints();
    expect(hints.rules.some((r) => r.includes("5000"))).toBe(true);
  });

  it("rules mention Cliq native delimiters", () => {
    const hints = resolveCliqInboundFormattingHints();
    expect(hints.rules.some((r) => r.includes("*bold*"))).toBe(true);
  });
});

describe("resolveCliqReactionGuidance", () => {
  it("defaults to minimal when no reactions config is present", () => {
    const cfg = cfgWith({ clientId: "c", clientSecret: "s", botId: "b" });
    expect(resolveCliqReactionGuidance(cfg)).toEqual({
      level: "minimal",
      channelLabel: "Zoho Cliq",
    });
  });

  it("honors agentGuidance: extensive", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      reactions: { agentGuidance: "extensive" },
    });
    expect(resolveCliqReactionGuidance(cfg)).toEqual({
      level: "extensive",
      channelLabel: "Zoho Cliq",
    });
  });

  it("returns undefined when agentGuidance is off", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      reactions: { agentGuidance: "off" },
    });
    expect(resolveCliqReactionGuidance(cfg)).toBeUndefined();
  });

  it("falls back to minimal for an invalid agentGuidance value", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      reactions: { agentGuidance: "bogus" as unknown as "minimal" },
    });
    expect(resolveCliqReactionGuidance(cfg)).toEqual({
      level: "minimal",
      channelLabel: "Zoho Cliq",
    });
  });

  it("ignores accountId for the top-level cliq section", () => {
    const cfg = cfgWith({ clientId: "c", clientSecret: "s", botId: "b" });
    expect(resolveCliqReactionGuidance(cfg, "default")).toEqual({
      level: "minimal",
      channelLabel: "Zoho Cliq",
    });
    expect(resolveCliqReactionGuidance(cfg, null)).toEqual({
      level: "minimal",
      channelLabel: "Zoho Cliq",
    });
  });
});

describe("cliqAgentPromptAdapter", () => {
  it("exposes all four prompt surfaces", () => {
    expect(typeof cliqAgentPromptAdapter.messageToolHints).toBe("function");
    expect(typeof cliqAgentPromptAdapter.messageToolCapabilities).toBe(
      "function",
    );
    expect(typeof cliqAgentPromptAdapter.inboundFormattingHints).toBe(
      "function",
    );
    expect(typeof cliqAgentPromptAdapter.reactionGuidance).toBe("function");
  });

  it("messageToolHints delegates to the resolver", () => {
    expect(cliqAgentPromptAdapter.messageToolHints!({ cfg: {} as OpenClawConfig }))
      .toEqual(resolveCliqMessageToolHints());
  });

  it("messageToolCapabilities returns an empty list (no inlineButtons/richText)", () => {
    expect(
      cliqAgentPromptAdapter.messageToolCapabilities!({
        cfg: {} as OpenClawConfig,
      }),
    ).toEqual([]);
  });

  it("inboundFormattingHints delegates to the resolver", () => {
    expect(
      cliqAgentPromptAdapter.inboundFormattingHints!({ accountId: null }),
    ).toEqual(resolveCliqInboundFormattingHints());
  });

  it("reactionGuidance delegates to the resolver", () => {
    const cfg = cfgWith({ clientId: "c", clientSecret: "s", botId: "b" });
    expect(cliqAgentPromptAdapter.reactionGuidance!({ cfg })).toEqual({
      level: "minimal",
      channelLabel: "Zoho Cliq",
    });
  });

  it("reactionGuidance returns undefined when disabled", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      reactions: { agentGuidance: "off" },
    });
    expect(cliqAgentPromptAdapter.reactionGuidance!({ cfg })).toBeUndefined();
  });
});
