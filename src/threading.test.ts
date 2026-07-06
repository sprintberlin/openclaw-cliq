import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelThreadingContext,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  cliqThreadingAdapter,
  resolveCliqReplyToMode,
  buildCliqThreadingToolContext,
  resolveCliqReplyTransport,
  resolveCliqCurrentChannelId,
} from "./threading.js";
import { createCliqTestConfig as cfgWith } from "./test-api.js";

const baseCfg = cfgWith({ clientId: "c", clientSecret: "s", botId: "b" });

describe("resolveCliqReplyToMode", () => {
  it("defaults to off when no config is set (Cliq cannot render reply quotes)", () => {
    expect(resolveCliqReplyToMode({ cfg: baseCfg })).toBe("off");
    expect(
      resolveCliqReplyToMode({ cfg: baseCfg, chatType: "group" }),
    ).toBe("off");
    expect(
      resolveCliqReplyToMode({ cfg: baseCfg, chatType: "direct" }),
    ).toBe("off");
  });

  it("defaults to off when the channel section is absent entirely", () => {
    const empty = { channels: {} } as unknown as OpenClawConfig;
    expect(resolveCliqReplyToMode({ cfg: empty })).toBe("off");
  });

  it("honors channels.cliq.replyToMode (channel-wide)", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      replyToMode: "all",
    });
    expect(resolveCliqReplyToMode({ cfg })).toBe("all");
    expect(resolveCliqReplyToMode({ cfg, chatType: "group" })).toBe("all");
  });

  it("honors replyToModeByChatType over the channel-wide setting", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      replyToMode: "all",
      replyToModeByChatType: { group: "first", direct: "off" },
    });
    expect(resolveCliqReplyToMode({ cfg, chatType: "group" })).toBe("first");
    expect(resolveCliqReplyToMode({ cfg, chatType: "direct" })).toBe("off");
    // channel chat-type falls back to channel-wide
    expect(resolveCliqReplyToMode({ cfg, chatType: "channel" })).toBe("all");
  });

  it("ignores an unknown chat type and falls back to channel-wide", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      replyToMode: "batched",
    });
    expect(resolveCliqReplyToMode({ cfg, chatType: "forum" })).toBe("batched");
    expect(resolveCliqReplyToMode({ cfg, chatType: "" })).toBe("batched");
  });

  it("rejects invalid mode values (case-insensitive accept, unknown reject)", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      replyToMode: "always",
      replyToModeByChatType: { group: "FIRST" },
    });
    // invalid channel-wide value ignored → default "off"
    expect(resolveCliqReplyToMode({ cfg, chatType: "direct" })).toBe("off");
    // case-insensitive valid value accepted
    expect(resolveCliqReplyToMode({ cfg, chatType: "group" })).toBe("first");
  });

  it("ignores non-string config values", () => {
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      replyToMode: 42,
      replyToModeByChatType: { group: null },
    });
    expect(resolveCliqReplyToMode({ cfg, chatType: "group" })).toBe("off");
  });
});

describe("cliqThreadingAdapter.resolveReplyToMode", () => {
  it("delegates to resolveCliqReplyToMode", () => {
    const resolver = cliqThreadingAdapter.resolveReplyToMode;
    expect(resolver).toBeDefined();
    expect(resolver!({ cfg: baseCfg, chatType: "group" })).toBe("off");
    const cfg = cfgWith({
      clientId: "c",
      clientSecret: "s",
      botId: "b",
      replyToMode: "all",
    });
    expect(resolver!({ cfg, chatType: "group" })).toBe("all");
  });
});

describe("cliqThreadingAdapter.allowExplicitReplyTagsWhenOff", () => {
  it("is true so explicit reply tags still pass under off mode", () => {
    expect(cliqThreadingAdapter.allowExplicitReplyTagsWhenOff).toBe(true);
  });
});

describe("buildCliqThreadingToolContext", () => {
  function ctx(over: Partial<ChannelThreadingContext> = {}): ChannelThreadingContext {
    return {
      To: "cliq:channel:dev-team",
      ReplyToId: "msg-42",
      ...over,
    } as ChannelThreadingContext;
  }

  it("populates currentChannelId + currentMessagingTarget from To", () => {
    const result = buildCliqThreadingToolContext({
      cfg: baseCfg,
      context: ctx(),
    });
    expect(result?.currentChannelId).toBe("cliq:channel:dev-team");
    expect(result?.currentMessagingTarget).toBe("cliq:channel:dev-team");
  });

  it("carries ReplyToId as currentThreadTs for correlation", () => {
    const result = buildCliqThreadingToolContext({
      cfg: baseCfg,
      context: ctx({ ReplyToId: "msg-99" }),
    });
    expect(result?.currentThreadTs).toBe("msg-99");
  });

  it("returns undefined currentChannelId when To is absent", () => {
    const result = buildCliqThreadingToolContext({
      cfg: baseCfg,
      context: ctx({ To: undefined }),
    });
    expect(result?.currentChannelId).toBeUndefined();
    expect(result?.currentMessagingTarget).toBeUndefined();
  });

  it("returns undefined currentThreadTs when ReplyToId is absent", () => {
    const result = buildCliqThreadingToolContext({
      cfg: baseCfg,
      context: ctx({ ReplyToId: undefined }),
    });
    expect(result?.currentThreadTs).toBeUndefined();
  });

  it("forwards hasRepliedRef", () => {
    const result = buildCliqThreadingToolContext({
      cfg: baseCfg,
      context: ctx(),
      hasRepliedRef: { value: true },
    });
    expect(result?.hasRepliedRef).toEqual({ value: true });
  });

  it("is wired on the adapter", () => {
    expect(cliqThreadingAdapter.buildToolContext).toBeDefined();
    const result = cliqThreadingAdapter.buildToolContext!({
      cfg: baseCfg,
      context: ctx(),
      hasRepliedRef: { value: false },
    });
    expect(result?.currentChannelId).toBe("cliq:channel:dev-team");
  });
});

describe("resolveCliqReplyTransport", () => {
  it("passes the replyToId through", () => {
    const result = resolveCliqReplyTransport({
      cfg: baseCfg,
      replyToId: "msg-7",
    });
    expect(result?.replyToId).toBe("msg-7");
  });

  it("forces threadId to null (Cliq has no threads)", () => {
    const result = resolveCliqReplyTransport({
      cfg: baseCfg,
      threadId: "topic-5",
      replyToId: "msg-7",
    });
    expect(result?.threadId).toBeNull();
  });

  it("returns null replyToId when none was provided", () => {
    const result = resolveCliqReplyTransport({ cfg: baseCfg });
    expect(result?.replyToId).toBeNull();
    expect(result?.threadId).toBeNull();
  });

  it("is wired on the adapter", () => {
    expect(cliqThreadingAdapter.resolveReplyTransport).toBeDefined();
    const result = cliqThreadingAdapter.resolveReplyTransport!({
      cfg: baseCfg,
      threadId: 123,
      replyToId: "msg-7",
      replyToIsExplicit: true,
    });
    expect(result?.replyToId).toBe("msg-7");
    expect(result?.threadId).toBeNull();
  });
});

describe("resolveCliqCurrentChannelId", () => {
  it("returns the routable to as-is", () => {
    expect(
      resolveCliqCurrentChannelId({ to: "cliq:channel:dev-team" }),
    ).toBe("cliq:channel:dev-team");
    expect(resolveCliqCurrentChannelId({ to: "cliq:user:123" })).toBe(
      "cliq:user:123",
    );
  });

  it("ignores a threadId (Cliq would not understand a :topic: suffix)", () => {
    expect(
      resolveCliqCurrentChannelId({
        to: "cliq:channel:dev-team",
        threadId: "topic-9",
      }),
    ).toBe("cliq:channel:dev-team");
  });

  it("returns undefined for an empty to", () => {
    expect(resolveCliqCurrentChannelId({ to: "" })).toBeUndefined();
  });

  it("is wired on the adapter", () => {
    expect(cliqThreadingAdapter.resolveCurrentChannelId).toBeDefined();
    expect(
      cliqThreadingAdapter.resolveCurrentChannelId!({
        to: "cliq:channel:dev-team",
      }),
    ).toBe("cliq:channel:dev-team");
  });
});
