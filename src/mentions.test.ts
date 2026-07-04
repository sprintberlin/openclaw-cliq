import { describe, it, expect } from "vitest";
import {
  buildCliqMentionRegexes,
  stripCliqMentions,
} from "./mentions.js";
import { cliqPlugin } from "./channel.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { cliq: section } } as unknown as OpenClawConfig;
}

describe("buildCliqMentionRegexes", () => {
  it("returns no regexes when bot identity is missing", () => {
    expect(buildCliqMentionRegexes({})).toEqual([]);
    expect(buildCliqMentionRegexes({ botId: "", botName: "" })).toEqual([]);
  });

  it("builds a case-insensitive @botName regex", () => {
    const re = buildCliqMentionRegexes({ botName: "Zora" });
    expect(re.length).toBe(1);
    // Reset lastIndex between assertions: a `g`-flagged RegExp is stateful.
    re[0].lastIndex = 0;
    expect(re[0].test("@Zora hello")).toBe(true);
    re[0].lastIndex = 0;
    expect(re[0].test("@zora hello")).toBe(true);
    re[0].lastIndex = 0;
    expect(re[0].test("@Zorahello")).toBe(false);
  });

  it("dedupes when botName and botId match (case-insensitive)", () => {
    const re = buildCliqMentionRegexes({ botId: "zora", botName: "Zora" });
    expect(re.length).toBe(1);
  });

  it("emits separate regexes for distinct botId and botName", () => {
    const re = buildCliqMentionRegexes({ botId: "cliq-bot-1", botName: "Zora" });
    expect(re.length).toBe(2);
  });
});

describe("stripCliqMentions", () => {
  it("returns empty string for empty input", () => {
    expect(stripCliqMentions("", { botName: "Zora" })).toBe("");
  });

  it("returns trimmed text when no bot identity is configured", () => {
    expect(stripCliqMentions("@anyone hi there", {})).toBe("@anyone hi there");
  });

  it("strips a single @botName mention", () => {
    expect(
      stripCliqMentions("@Zora please summarize this", { botName: "Zora" }),
    ).toBe("please summarize this");
  });

  it("strips case-insensitively", () => {
    expect(
      stripCliqMentions("@zora do the thing", { botName: "Zora" }),
    ).toBe("do the thing");
  });

  it("strips multiple mentions and collapses whitespace", () => {
    expect(
      stripCliqMentions("@Zora hi @Zora again", { botName: "Zora" }),
    ).toBe("hi again");
  });

  it("preserves other @mentions that are not the bot", () => {
    expect(
      stripCliqMentions("@Zora ping @alice please", { botName: "Zora" }),
    ).toBe("ping @alice please");
  });

  it("does not strip a substring of a longer token", () => {
    expect(
      stripCliqMentions("@Zorascript @Zora run", { botName: "Zora" }),
    ).toBe("@Zorascript run");
  });
});

describe("cliqPlugin.mentions adapter", () => {
  it("stripRegexes returns account-specific regexes", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "Zora",
    });
    const regexes = cliqPlugin.mentions!.stripRegexes!({
      ctx: { AccountId: undefined } as any,
      cfg,
      agentId: undefined,
    });
    expect(regexes.length).toBe(2);
    expect(regexes.some((re) => re.test("@Zora hi"))).toBe(true);
  });

  it("stripRegexes returns empty when channel unconfigured", () => {
    const regexes = cliqPlugin.mentions!.stripRegexes!({
      ctx: { AccountId: undefined } as any,
      cfg: undefined,
      agentId: undefined,
    });
    expect(regexes).toEqual([]);
  });

  it("stripPatterns returns the @botName literal", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "Zora",
    });
    const patterns = cliqPlugin.mentions!.stripPatterns!({
      ctx: { AccountId: undefined } as any,
      cfg,
      agentId: undefined,
    });
    expect(patterns).toEqual(["@Zora"]);
  });

  it("stripMentions removes the bot handle via the shared helper", () => {
    const cfg = cfgWith({
      clientId: "id",
      clientSecret: "secret",
      botId: "bot",
      botName: "Zora",
    });
    const out = cliqPlugin.mentions!.stripMentions!({
      text: "@Zora hello world",
      ctx: { AccountId: undefined } as any,
      cfg,
      agentId: undefined,
    });
    expect(out).toBe("hello world");
  });

  it("stripMentions passes text through when channel unconfigured", () => {
    const out = cliqPlugin.mentions!.stripMentions!({
      text: "@Zora hello",
      ctx: { AccountId: undefined } as any,
      cfg: undefined,
      agentId: undefined,
    });
    expect(out).toBe("@Zora hello");
  });
});
