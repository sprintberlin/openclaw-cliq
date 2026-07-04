import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  parseCliqWebhookPayload,
  resolveCliqMentionDecision,
  resolveCliqMentionFacts,
  verifyWebhookSecret,
  type CliqWebhookPayload,
  type ParsedCliqInbound,
} from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";

function account(overrides: Partial<ResolvedCliqAccount> = {}): ResolvedCliqAccount {
  return {
    accountId: null,
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    botName: "Bot",
    webhookSecret: undefined,
    allowFrom: [],
    dmPolicy: undefined,
    ...overrides,
  };
}

function reqWithHeaders(
  headers: Record<string, string | string[] | undefined>,
): Pick<IncomingMessage, "headers"> {
  return { headers } as Pick<IncomingMessage, "headers">;
}

function dmPayload(overrides: Partial<CliqWebhookPayload> = {}): CliqWebhookPayload {
  return {
    handler: "message",
    message: "hello bot",
    user: { id: "u1", name: "Alice" },
    chat: { id: "CT_dm_chat-B1" },
    ...overrides,
  };
}

function groupPayload(overrides: Partial<CliqWebhookPayload> = {}): CliqWebhookPayload {
  return {
    handler: "mention",
    message: "hey @bot please help",
    user: { id: "u2", name: "Bob" },
    chat: {
      id: "CT_channel_chat",
      type: "channel",
      chat_type: "channel",
      channel_unique_name: "dev-team",
      title: "#dev-team",
    },
    mentions: [{ id: "bot", name: "Bot", type: "bot" }],
    ...overrides,
  };
}

describe("verifyWebhookSecret", () => {
  it("allows when no secret configured", () => {
    expect(verifyWebhookSecret(reqWithHeaders({}), undefined)).toBe(true);
  });

  it("rejects when secret configured but header missing", () => {
    expect(verifyWebhookSecret(reqWithHeaders({}), "s3cr3t")).toBe(false);
  });

  it("matches x-cliq-webhook-secret header", () => {
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ "x-cliq-webhook-secret": "s3cr3t" }),
        "s3cr3t",
      ),
    ).toBe(true);
  });

  it("matches bearer-shaped authorization header", () => {
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ authorization: "Bearer s3cr3t" }),
        "s3cr3t",
      ),
    ).toBe(true);
  });

  it("rejects mismatched secret", () => {
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ "x-cliq-webhook-secret": "wrong" }),
        "s3cr3t",
      ),
    ).toBe(false);
  });
});

describe("parseCliqWebhookPayload", () => {
  it("parses a DM message-handler payload with string message", () => {
    const parsed = parseCliqWebhookPayload(dmPayload());
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("hello bot");
    expect(parsed!.senderId).toBe("u1");
    expect(parsed!.senderName).toBe("Alice");
    expect(parsed!.chatId).toBe("CT_dm_chat-B1");
    expect(parsed!.isGroup).toBe(false);
    expect(parsed!.isMention).toBe(false);
    expect(parsed!.handler).toBe("message");
  });

  it("parses a group mention payload with object message", () => {
    const parsed = parseCliqWebhookPayload(
      groupPayload({ message: { text: "  hi @bot  ", id: "m1", time: "2024-01-01" } }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("hi @bot");
    expect(parsed!.messageId).toBe("m1");
    expect(parsed!.timestamp).toBe("2024-01-01");
    expect(parsed!.isGroup).toBe(true);
    expect(parsed!.channelUniqueName).toBe("dev-team");
    expect(parsed!.channelName).toBe("dev-team");
    expect(parsed!.isMention).toBe(true);
    expect(parsed!.mentionIds).toEqual(["bot"]);
  });

  it("extracts channel name from chat.title when channel object absent", () => {
    const parsed = parseCliqWebhookPayload(
      groupPayload({
        channel: undefined,
        chat: {
          id: "CT_x_y",
          type: "channel",
          chat_type: "channel",
          title: "#announcements",
        },
      }),
    );
    expect(parsed!.channelName).toBe("announcements");
    expect(parsed!.isGroup).toBe(true);
  });

  it("unwraps a wrapped params payload", () => {
    const parsed = parseCliqWebhookPayload({
      handler: "mention",
      params: {
        message: { text: "via params" },
        user: { id: "u3", name: "Carol" },
        chat: { id: "CT_p" },
      },
    } as CliqWebhookPayload);
    expect(parsed!.text).toBe("via params");
    expect(parsed!.senderId).toBe("u3");
    expect(parsed!.chatId).toBe("CT_p");
  });

  it("falls back to payload.text when message missing", () => {
    const parsed = parseCliqWebhookPayload({
      handler: "message",
      text: "fallback text",
      user: { id: "u4" },
      chat: { id: "CT_fb" },
    } as CliqWebhookPayload);
    expect(parsed!.text).toBe("fallback text");
  });

  it("returns null when text missing", () => {
    expect(parseCliqWebhookPayload({ user: { id: "u" } })).toBeNull();
  });

  it("returns null when user id missing", () => {
    expect(
      parseCliqWebhookPayload({ message: "hi", user: {} } as CliqWebhookPayload),
    ).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(parseCliqWebhookPayload("nope")).toBeNull();
    expect(parseCliqWebhookPayload(null)).toBeNull();
    expect(parseCliqWebhookPayload([1, 2])).toBeNull();
  });
});

describe("resolveCliqMentionFacts", () => {
  it("always reports mentioned=true for DMs", () => {
    const parsed: ParsedCliqInbound = {
      text: "hi",
      messageId: "m",
      timestamp: "",
      senderId: "u",
      senderName: "U",
      chatId: "c",
      isGroup: false,
      isMention: false,
      mentionIds: [],
      handler: "message",
    };
    const facts = resolveCliqMentionFacts(parsed, account());
    expect(facts.wasMentioned).toBe(true);
    expect(facts.canDetectMention).toBe(true);
  });

  it("reports wasMentioned from parsed.isMention for groups", () => {
    const parsed: ParsedCliqInbound = {
      text: "hi",
      messageId: "m",
      timestamp: "",
      senderId: "u",
      senderName: "U",
      chatId: "c",
      isGroup: true,
      isMention: true,
      mentionIds: ["bot"],
      handler: "mention",
    };
    const facts = resolveCliqMentionFacts(parsed, account());
    expect(facts.wasMentioned).toBe(true);
    expect(facts.hasAnyMention).toBe(true);
  });
});

describe("resolveCliqMentionDecision", () => {
  it("allows DMs without mention requirement", () => {
    const parsed = parseCliqWebhookPayload(dmPayload())!;
    const decision = resolveCliqMentionDecision(parsed, account(), {
      requireMention: false,
    });
    expect(decision.shouldSkip).toBe(false);
    expect(decision.effectiveWasMentioned).toBe(true);
  });

  it("proceeds for group message with explicit mention", () => {
    const parsed = parseCliqWebhookPayload(groupPayload())!;
    const decision = resolveCliqMentionDecision(parsed, account(), {
      requireMention: true,
    });
    expect(decision.shouldSkip).toBe(false);
    expect(decision.effectiveWasMentioned).toBe(true);
  });

  it("skips group messages without mention when requireMention is true", () => {
    const parsed = parseCliqWebhookPayload(
      groupPayload({
        handler: "message",
        mentions: undefined,
        message: "just chatting",
      }),
    )!;
    expect(parsed.isMention).toBe(false);
    const decision = resolveCliqMentionDecision(parsed, account(), {
      requireMention: true,
    });
    expect(decision.shouldSkip).toBe(true);
  });

  it("proceeds for group messages when requireMention is false", () => {
    const parsed = parseCliqWebhookPayload(
      groupPayload({
        handler: "message",
        mentions: undefined,
        message: "just chatting",
      }),
    )!;
    const decision = resolveCliqMentionDecision(parsed, account(), {
      requireMention: false,
    });
    expect(decision.shouldSkip).toBe(false);
  });
});
