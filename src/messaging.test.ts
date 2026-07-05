import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  parseCliqTarget,
  normalizeCliqMessagingTarget,
  resolveCliqInboundConversation,
  resolveCliqDeliveryTarget,
  resolveCliqSessionConversation,
  resolveCliqSessionTarget,
  inferCliqTargetChatType,
  resolveCliqOutboundSessionRoute,
  formatCliqTargetDisplay,
  looksLikeCliqTargetId,
  cliqMessagingAdapter,
} from "./messaging.js";

const baseCfg: OpenClawConfig = {
  channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } },
} as unknown as OpenClawConfig;

describe("parseCliqTarget", () => {
  it("parses DM targets (user/dm kinds)", () => {
    expect(parseCliqTarget("cliq:user:12345")).toEqual({ kind: "direct", id: "12345", explicit: true });
    expect(parseCliqTarget("cliq:dm:12345")).toEqual({ kind: "direct", id: "12345", explicit: true });
    expect(parseCliqTarget("CLIQ:USER:abc")).toEqual({ kind: "direct", id: "abc", explicit: true });
  });

  it("parses group targets (channel/chat/group kinds)", () => {
    expect(parseCliqTarget("cliq:channel:dev-team")).toEqual({ kind: "group", id: "dev-team", explicit: true });
    expect(parseCliqTarget("cliq:chat:CT_123")).toEqual({ kind: "group", id: "CT_123", explicit: true });
    expect(parseCliqTarget("cliq:group:dev-team")).toEqual({ kind: "group", id: "dev-team", explicit: true });
  });

  it("treats a bare cliq:<id> as a group target (backward compat)", () => {
    expect(parseCliqTarget("cliq:dev-team")).toEqual({ kind: "group", id: "dev-team", explicit: false });
    expect(parseCliqTarget("cliq:12345")).toEqual({ kind: "group", id: "12345", explicit: false });
  });

  it("treats a bare id with no cliq: prefix as a group target", () => {
    expect(parseCliqTarget("dev-team")).toEqual({ kind: "group", id: "dev-team", explicit: false });
  });

  it("treats an unknown kind prefix as group", () => {
    expect(parseCliqTarget("cliq:futurekind:foo")).toEqual({ kind: "group", id: "foo", explicit: true });
  });

  it("returns null for empty / malformed input", () => {
    expect(parseCliqTarget("")).toBeNull();
    expect(parseCliqTarget(undefined)).toBeNull();
    expect(parseCliqTarget(null)).toBeNull();
    expect(parseCliqTarget("   ")).toBeNull();
    expect(parseCliqTarget("cliq:user:")).toBeNull();
    expect(parseCliqTarget("cliq:user")).toBeNull();
    expect(parseCliqTarget("cliq:channel")).toBeNull();
  });
});

describe("normalizeCliqMessagingTarget", () => {
  it("canonicalizes DM and group targets", () => {
    expect(normalizeCliqMessagingTarget("cliq:dm:12345")).toBe("cliq:user:12345");
    expect(normalizeCliqMessagingTarget("cliq:group:dev-team")).toBe("cliq:channel:dev-team");
    expect(normalizeCliqMessagingTarget("cliq:chat:CT_1")).toBe("cliq:channel:CT_1");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeCliqMessagingTarget("")).toBeUndefined();
    expect(normalizeCliqMessagingTarget(undefined)).toBeUndefined();
  });
});

describe("resolveCliqInboundConversation", () => {
  it("derives a user:<id> conversation id from a DM `to` target", () => {
    expect(
      resolveCliqInboundConversation({
        to: "cliq:user:12345",
        isGroup: false,
      }),
    ).toEqual({ conversationId: "user:12345", parentConversationId: "user:12345" });
  });

  it("derives a channel:<name> conversation id from a group `to` target", () => {
    expect(
      resolveCliqInboundConversation({
        to: "cliq:channel:dev-team",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "channel:dev-team",
      parentConversationId: "channel:dev-team",
    });
  });

  it("uses `to` over `from` when both are present", () => {
    expect(
      resolveCliqInboundConversation({
        from: "cliq:group:dev-team",
        to: "cliq:user:12345",
        isGroup: false,
      }),
    ).toEqual({ conversationId: "user:12345", parentConversationId: "user:12345" });
  });

  it("falls back to conversationId when `to` is absent", () => {
    expect(
      resolveCliqInboundConversation({
        conversationId: "cliq:channel:dev-team",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "channel:dev-team",
      parentConversationId: "channel:dev-team",
    });
  });

  it("falls back to `from` with the isGroup hint when `to` and conversationId are absent (DM)", () => {
    expect(
      resolveCliqInboundConversation({
        from: "cliq:12345",
        isGroup: false,
      }),
    ).toEqual({ conversationId: "user:12345", parentConversationId: "user:12345" });
  });

  it("falls back to `from` with the isGroup hint when `to` and conversationId are absent (group)", () => {
    expect(
      resolveCliqInboundConversation({
        from: "cliq:dev-team",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "channel:dev-team",
      parentConversationId: "channel:dev-team",
    });
  });

  it("returns null when no usable input is present", () => {
    expect(resolveCliqInboundConversation({ isGroup: false })).toBeNull();
    expect(resolveCliqInboundConversation({ isGroup: true, to: "   " })).toBeNull();
  });
});

describe("resolveCliqDeliveryTarget", () => {
  it("rebuilds a DM target from a user:<id> conversation id", () => {
    expect(
      resolveCliqDeliveryTarget({ conversationId: "user:12345" }),
    ).toEqual({ to: "cliq:user:12345" });
  });

  it("rebuilds a group target from a channel:<name> conversation id", () => {
    expect(
      resolveCliqDeliveryTarget({ conversationId: "channel:dev-team" }),
    ).toEqual({ to: "cliq:channel:dev-team" });
  });

  it("falls back to parentConversationId when conversationId is absent", () => {
    expect(
      resolveCliqDeliveryTarget({
        conversationId: "",
        parentConversationId: "channel:dev-team",
      }),
    ).toEqual({ to: "cliq:channel:dev-team" });
  });

  it("treats a bare conversation id as a group target", () => {
    expect(
      resolveCliqDeliveryTarget({ conversationId: "dev-team" }),
    ).toEqual({ to: "cliq:channel:dev-team" });
  });

  it("returns null when no conversation id is present", () => {
    expect(resolveCliqDeliveryTarget({ conversationId: "" })).toBeNull();
    expect(
      resolveCliqDeliveryTarget({ conversationId: "", parentConversationId: "" }),
    ).toBeNull();
  });

  it("round-trips through resolveCliqInboundConversation", () => {
    const inbound = resolveCliqInboundConversation({
      to: "cliq:channel:dev-team",
      isGroup: true,
    })!;
    const delivery = resolveCliqDeliveryTarget({ conversationId: inbound.conversationId })!;
    expect(delivery.to).toBe("cliq:channel:dev-team");
  });
});

describe("resolveCliqSessionConversation", () => {
  it("returns the raw id as the base conversation with no thread", () => {
    expect(resolveCliqSessionConversation({ kind: "group", rawId: "dev-team" })).toEqual({
      id: "dev-team",
      threadId: null,
      baseConversationId: "dev-team",
      parentConversationCandidates: ["dev-team"],
    });
  });

  it("works for the `channel` kind too", () => {
    expect(resolveCliqSessionConversation({ kind: "channel", rawId: "dev-team" })).toEqual({
      id: "dev-team",
      threadId: null,
      baseConversationId: "dev-team",
      parentConversationCandidates: ["dev-team"],
    });
  });

  it("returns null for an empty raw id", () => {
    expect(resolveCliqSessionConversation({ kind: "group", rawId: "" })).toBeNull();
    expect(resolveCliqSessionConversation({ kind: "group", rawId: "   " })).toBeNull();
  });
});

describe("resolveCliqSessionTarget", () => {
  it("builds a cliq:group:<id> target for groups", () => {
    expect(resolveCliqSessionTarget({ kind: "group", id: "dev-team" })).toBe("cliq:group:dev-team");
  });

  it("builds a cliq:group:<id> target for channels (Cliq channels are group chats)", () => {
    expect(resolveCliqSessionTarget({ kind: "channel", id: "dev-team" })).toBe("cliq:group:dev-team");
  });

  it("ignores a threadId (Cliq has no threads)", () => {
    expect(
      resolveCliqSessionTarget({ kind: "group", id: "dev-team", threadId: "abc" }),
    ).toBe("cliq:group:dev-team");
  });

  it("returns undefined for an empty id", () => {
    expect(resolveCliqSessionTarget({ kind: "group", id: "" })).toBeUndefined();
  });
});

describe("inferCliqTargetChatType", () => {
  it("infers direct for DM targets", () => {
    expect(inferCliqTargetChatType({ to: "cliq:user:12345" })).toBe("direct");
    expect(inferCliqTargetChatType({ to: "cliq:dm:12345" })).toBe("direct");
  });

  it("infers group for channel/chat/group targets", () => {
    expect(inferCliqTargetChatType({ to: "cliq:channel:dev-team" })).toBe("group");
    expect(inferCliqTargetChatType({ to: "cliq:chat:CT_1" })).toBe("group");
    expect(inferCliqTargetChatType({ to: "cliq:group:dev-team" })).toBe("group");
  });

  it("returns undefined for unparseable input", () => {
    expect(inferCliqTargetChatType({ to: "" })).toBeUndefined();
    expect(inferCliqTargetChatType({ to: "garbage" })).toBe("group");
  });
});

describe("resolveCliqOutboundSessionRoute", () => {
  it("builds a direct route for a DM target", () => {
    const route = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      accountId: "default",
      target: "cliq:user:12345",
    });
    expect(route).not.toBeNull();
    expect(route!.chatType).toBe("direct");
    expect(route!.peer).toEqual({ kind: "direct", id: "12345" });
    expect(route!.to).toBe("cliq:user:12345");
    expect(route!.from).toBe("cliq:user:12345");
    expect(route!.sessionKey).toBe(route!.baseSessionKey);
    expect(typeof route!.sessionKey).toBe("string");
    expect(route!.sessionKey.length).toBeGreaterThan(0);
  });

  it("builds a group route for a channel target", () => {
    const route = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      target: "cliq:channel:dev-team",
    });
    expect(route).not.toBeNull();
    expect(route!.chatType).toBe("group");
    expect(route!.peer).toEqual({ kind: "group", id: "dev-team" });
    expect(route!.to).toBe("cliq:channel:dev-team");
    expect(route!.from).toBe("cliq:group:dev-team");
  });

  it("uses the directory-resolved kind when the target has no kind prefix", () => {
    const route = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      target: "12345",
      resolvedTarget: { to: "12345", kind: "user", source: "directory" },
    });
    expect(route).not.toBeNull();
    expect(route!.chatType).toBe("direct");
    expect(route!.peer).toEqual({ kind: "direct", id: "12345" });
  });

  it("defaults a bare id with no directory kind to group", () => {
    const route = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      target: "dev-team",
    });
    expect(route).not.toBeNull();
    expect(route!.chatType).toBe("group");
    expect(route!.peer).toEqual({ kind: "group", id: "dev-team" });
  });

  it("never attaches a threadId (Cliq has no threads)", () => {
    const route = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      target: "cliq:channel:dev-team",
      threadId: "should-be-ignored",
    });
    expect(route).not.toBeNull();
    expect(route!.threadId).toBeUndefined();
  });

  it("returns null for an empty target", () => {
    expect(
      resolveCliqOutboundSessionRoute({
        cfg: baseCfg,
        agentId: "agent-1",
        target: "",
      }),
    ).toBeNull();
  });

  it("produces distinct session keys for DM vs group with the same agent", () => {
    const dm = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      target: "cliq:user:12345",
    })!;
    const group = resolveCliqOutboundSessionRoute({
      cfg: baseCfg,
      agentId: "agent-1",
      target: "cliq:channel:12345",
    })!;
    expect(dm.sessionKey).not.toBe(group.sessionKey);
  });
});

describe("formatCliqTargetDisplay", () => {
  it("renders a DM target as @<user>", () => {
    expect(formatCliqTargetDisplay({ target: "cliq:user:12345" })).toBe("@12345");
    expect(formatCliqTargetDisplay({ target: "cliq:dm:12345" })).toBe("@12345");
  });

  it("renders a channel target as #<channel>", () => {
    expect(formatCliqTargetDisplay({ target: "cliq:channel:dev-team" })).toBe("#dev-team");
  });

  it("prefers an explicit display name when provided", () => {
    expect(
      formatCliqTargetDisplay({ target: "cliq:user:12345", display: "Alice" }),
    ).toBe("Alice");
  });

  it("uses the explicit kind when the target lacks a kind prefix", () => {
    expect(
      formatCliqTargetDisplay({ target: "cliq:12345", kind: "user" }),
    ).toBe("@12345");
    expect(
      formatCliqTargetDisplay({ target: "12345", kind: "channel" }),
    ).toBe("#12345");
  });

  it("handles empty input", () => {
    expect(formatCliqTargetDisplay({ target: "" })).toBe("");
  });
});

describe("looksLikeCliqTargetId", () => {
  it("recognizes kind-prefixed targets", () => {
    expect(looksLikeCliqTargetId("cliq:user:12345")).toBe(true);
    expect(looksLikeCliqTargetId("cliq:channel:dev-team")).toBe(true);
  });

  it("recognizes bare ids", () => {
    expect(looksLikeCliqTargetId("dev-team")).toBe(true);
    expect(looksLikeCliqTargetId("cliq:dev-team")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(looksLikeCliqTargetId("")).toBe(false);
    expect(looksLikeCliqTargetId("   ")).toBe(false);
  });
});

describe("cliqMessagingAdapter (adapter surface)", () => {
  it("declares the cliq provider prefix", () => {
    expect(cliqMessagingAdapter.targetPrefixes).toEqual(["cliq"]);
  });

  it("exposes all session-binding hooks", () => {
    expect(typeof cliqMessagingAdapter.normalizeTarget).toBe("function");
    expect(typeof cliqMessagingAdapter.resolveInboundConversation).toBe("function");
    expect(typeof cliqMessagingAdapter.resolveDeliveryTarget).toBe("function");
    expect(typeof cliqMessagingAdapter.resolveSessionConversation).toBe("function");
    expect(typeof cliqMessagingAdapter.resolveSessionTarget).toBe("function");
    expect(typeof cliqMessagingAdapter.inferTargetChatType).toBe("function");
    expect(typeof cliqMessagingAdapter.resolveOutboundSessionRoute).toBe("function");
    expect(typeof cliqMessagingAdapter.formatTargetDisplay).toBe("function");
    expect(cliqMessagingAdapter.targetResolver?.hint).toBe("<channelUniqueName|userId>");
  });

  it("the adapter functions are the same as the exported helpers", () => {
    expect(cliqMessagingAdapter.normalizeTarget).toBe(normalizeCliqMessagingTarget);
    expect(cliqMessagingAdapter.resolveInboundConversation).toBe(resolveCliqInboundConversation);
    expect(cliqMessagingAdapter.resolveDeliveryTarget).toBe(resolveCliqDeliveryTarget);
  });
});
