import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCliqWebhookPayload,
  readJsonBody,
  resolveCliqMentionDecision,
  resolveCliqMentionFacts,
  dispatchCliqInbound,
  type CliqWebhookPayload,
  type ParsedCliqInbound,
  type CliqRuntime,
} from "./inbound.js";
import { verifyWebhookSecret } from "./webhook-security.js";
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
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    blockStreaming: false,
    thinking: { mode: "off", text: "💭 …" },
    welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
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

  it("rejects non-canonical headers (single-header enforcement)", () => {
    // Only `x-cliq-webhook-secret` is honored; Authorization / x-webhook-secret
    // must NOT bypass the secret check even when they carry the right value.
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ authorization: `Bearer s3cr3t` }),
        "s3cr3t",
      ),
    ).toBe(false);
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ "x-webhook-secret": "s3cr3t" }),
        "s3cr3t",
      ),
    ).toBe(false);
  });

  it("uses constant-time comparison (does not short-circuit on length)", () => {
    // A mismatched-length secret should still be rejected, and a matching
    // secret accepted. The exact timing is not asserted here (that would be
    // flaky in CI), only correctness.
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ "x-cliq-webhook-secret": "s3cr" }),
        "s3cr3t-longer",
      ),
    ).toBe(false);
    expect(
      verifyWebhookSecret(
        reqWithHeaders({ "x-cliq-webhook-secret": "s3cr3t-longer" }),
        "s3cr3t-longer",
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

  describe("Cliq Form submissions (Phase 3)", () => {
    it("synthesizes the body from form values + surfaces structured fields", () => {
      const parsed = parseCliqWebhookPayload({
        handler: "form",
        form: { name: "approval_request" },
        values: {
          approver: "alice@corp.com",
          priority: { label: "High", value: "high" },
          reason: "prod deploy gate",
        },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.text).toBe(
        [
          "Form: approval_request",
          "approver: alice@corp.com",
          "priority: High",
          "reason: prod deploy gate",
        ].join("\n"),
      );
      expect(parsed!.formName).toBe("approval_request");
      expect(parsed!.formValues).toEqual({
        approver: "alice@corp.com",
        priority: { label: "High", value: "high" },
        reason: "prod deploy gate",
      });
      // A form submission is a directed action at the bot → implicit mention.
      expect(parsed!.isMention).toBe(true);
      expect(parsed!.handler).toBe("form");
    });

    it("recognizes a form submission via values-only payload (no handler marker)", () => {
      const parsed = parseCliqWebhookPayload({
        values: { x: "1", y: "2" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm" },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.text).toBe("x: 1\ny: 2");
      expect(parsed!.formValues).toEqual({ x: "1", y: "2" });
      expect(parsed!.isMention).toBe(true);
    });

    it("marks a group form submission as an implicit mention (admitted without @mention)", () => {
      const parsed = parseCliqWebhookPayload({
        handler: "form",
        form: { name: "param_capture" },
        values: { model: "gpt-4" },
        user: { id: "u2", name: "Bob" },
        chat: {
          id: "CT_channel_chat",
          type: "channel",
          chat_type: "channel",
          channel_unique_name: "dev-team",
          title: "#dev-team",
        },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.isGroup).toBe(true);
      expect(parsed!.channelUniqueName).toBe("dev-team");
      expect(parsed!.isMention).toBe(true);
      expect(parsed!.formValues).toEqual({ model: "gpt-4" });
    });

    it("unwraps a params-wrapped form payload", () => {
      const parsed = parseCliqWebhookPayload({
        params: {
          form: { name: "wrapped" },
          values: { a: "1" },
          user: { id: "u1", name: "Alice" },
          chat: { id: "CT_dm" },
        },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.text).toBe("Form: wrapped\na: 1");
      expect(parsed!.formName).toBe("wrapped");
    });

    it("returns null when a form payload carries no values", () => {
      expect(
        parseCliqWebhookPayload({
          handler: "form",
          form: { name: "empty" },
          user: { id: "u1", name: "Alice" },
          chat: { id: "CT_dm" },
        } as CliqWebhookPayload),
      ).toBeNull();
    });

    it("returns null when a form has only empty field values", () => {
      expect(
        parseCliqWebhookPayload({
          handler: "form",
          form: { name: "f" },
          values: { a: "", b: null },
          user: { id: "u1", name: "Alice" },
          chat: { id: "CT_dm" },
        } as CliqWebhookPayload),
      ).toBeNull();
    });

    it("still requires a user id for a form submission", () => {
      expect(
        parseCliqWebhookPayload({
          handler: "form",
          values: { a: "1" },
          user: {},
          chat: { id: "CT_dm" },
        } as CliqWebhookPayload),
      ).toBeNull();
    });
  });

  describe("Agent-rendered form button-click response (Phase 3, sub-part c)", () => {
    it("parses a __cliq_form__ sentinel payload into structured FormValues", () => {
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        message: { text: "__cliq_form__ priority=high", id: "m1" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm" },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      // The sentinel is stripped from the agent-visible body; the
      // human-readable `<field>: <value>` rendering remains.
      expect(parsed!.text).toBe("priority: high");
      // The structured field/value is surfaced for a tool call.
      expect(parsed!.formValues).toEqual({ priority: "high" });
      // No form name on the agent-rendered path (the agent knows its form).
      expect(parsed!.formName).toBeUndefined();
      // A button click is a directed action at the bot → implicit mention.
      expect(parsed!.isMention).toBe(true);
    });

    it("preserves spaces and = in the button-click value", () => {
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        message: { text: "__cliq_form__ reason=deploy the prod=build", id: "m2" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm" },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.formValues).toEqual({ reason: "deploy the prod=build" });
      expect(parsed!.text).toBe("reason: deploy the prod=build");
    });

    it("marks a group button-click response as an implicit mention", () => {
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        message: { text: "__cliq_form__ env=prod", id: "m3" },
        user: { id: "u2", name: "Bob" },
        chat: {
          id: "CT_channel_chat",
          type: "channel",
          chat_type: "channel",
          channel_unique_name: "dev-team",
          title: "#dev-team",
        },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.isGroup).toBe(true);
      // Admitted without a separate @mention (directed action at the bot).
      expect(parsed!.isMention).toBe(true);
      expect(parsed!.formValues).toEqual({ env: "prod" });
    });

    it("treats a free-text `field: value` reply as an ordinary message (no FormValues)", () => {
      // A summary-card text-field reply is NOT sentinel-prefixed → it stays
      // plain text. Only prompt-card button clicks are structured.
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        message: { text: "version: 1.2.3", id: "m4" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm" },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.text).toBe("version: 1.2.3");
      expect(parsed!.formValues).toBeUndefined();
      expect(parsed!.isMention).toBe(false);
    });

    it("a malformed sentinel payload (no =) still dispatches with empty FormValues", () => {
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        message: { text: "__cliq_form__ bogus", id: "m5" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm" },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      expect(parsed!.text).toBe("bogus");
      expect(parsed!.formValues).toBeUndefined();
      expect(parsed!.isMention).toBe(true);
    });
  });

  it("parses a file attachment (type=file) with caption and synthesizes text", () => {
    const parsed = parseCliqWebhookPayload({
      handler: "message",
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm_chat-B1" },
      message: { id: "m-file-1", time: "1700000000000" },
      content: {
        file: {
          id: "fileid-abc",
          name: "report.pdf",
          type: "application/pdf",
        },
        comment: "here is the report",
      },
    } as CliqWebhookPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments).toEqual([
      {
        fileId: "fileid-abc",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        caption: "here is the report",
      },
    ]);
    // The comment surfaces as text when the message body is empty.
    expect(parsed!.text).toBe("here is the report");
    expect(parsed!.messageId).toBe("m-file-1");
  });

  it("synthesizes a <media> placeholder when a file has no caption or text", () => {
    const parsed = parseCliqWebhookPayload({
      handler: "message",
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm_chat-B1" },
      message: { id: "m-file-2" },
      content: {
        file: { id: "img-1", name: "photo.png", type: "image/png" },
      },
    } as CliqWebhookPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("<media:image>");
    expect(parsed!.attachments).toHaveLength(1);
    expect(parsed!.attachments[0].caption).toBeUndefined();
  });

  it("parses an attachments array fallback", () => {
    const parsed = parseCliqWebhookPayload({
      handler: "message",
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm_chat-B1" },
      message: "see this",
      attachments: [
        { id: "att-1", name: "slide.png", type: "image/png" },
        { id: "att-2", name: "voice.mp3", type: "audio/mpeg" },
      ],
    } as CliqWebhookPayload);
    expect(parsed!.attachments).toHaveLength(2);
    expect(parsed!.attachments[0].fileId).toBe("att-1");
    expect(parsed!.attachments[1].fileId).toBe("att-2");
  });

  it("returns null when a file payload carries no resolvable file id", () => {
    // A bare `file` string is the file NAME only — no id — so it is not
    // downloadable and there is no text/caption to dispatch → drop the event.
    expect(
      parseCliqWebhookPayload({
        handler: "message",
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
        file: "some-file.txt",
      } as CliqWebhookPayload),
    ).toBeNull();
  });

  it("parses replyTo from message.reply_to (string id)", () => {
    const parsed = parseCliqWebhookPayload(
      dmPayload({
        message: { text: "agreed", id: "m2", time: "" },
      }),
    );
    // No reply_to → undefined.
    expect(parsed?.replyTo).toBeUndefined();
    const withReply = parseCliqWebhookPayload(
      dmPayload({
        message: { text: "agreed", id: "m2", time: "" },
      }) as CliqWebhookPayload,
    );
    expect(withReply?.replyTo).toBeUndefined();
    // Now with reply_to string id.
    const r = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "agreed", id: "m2", reply_to: "m1" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
      } as CliqWebhookPayload,
    )!;
    expect(r.replyTo).toEqual({ messageId: "m1" });
  });

  it("parses replyTo from a root-level parent object", () => {
    const parsed = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "yes", id: "m2" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
        parent: {
          id: "m1",
          text: "the original",
          sender: { id: "u2", name: "Bob" },
        },
      } as CliqWebhookPayload,
    )!;
    expect(parsed.replyTo).toEqual({
      messageId: "m1",
      text: "the original",
      senderId: "u2",
      senderName: "Bob",
    });
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
      attachments: [],
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
      attachments: [],
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

/** Minimal request shape that readJsonBody needs (EventEmitter + headers). */
function makeBodyReq(
  raw: string,
  headers: Record<string, string | string[] | undefined> = {},
): Pick<IncomingMessage, "on" | "removeAllListeners" | "destroy"> & {
  headers: IncomingMessage["headers"];
} {
  const ee = new EventEmitter() as unknown as IncomingMessage & {
    headers: IncomingMessage["headers"];
  };
  ee.destroy = (() => {
    /* no-op */
  }) as IncomingMessage["destroy"];
  ee.headers = headers as IncomingMessage["headers"];
  queueMicrotask(() => {
    ee.emit("data", Buffer.from(raw, "utf8"));
    ee.emit("end");
  });
  return ee as Pick<IncomingMessage, "on" | "removeAllListeners" | "destroy"> & {
    headers: IncomingMessage["headers"];
  };
}

describe("readJsonBody (issue #10)", () => {
  it("parses a raw JSON body", async () => {
    const req = makeBodyReq(
      JSON.stringify({ handler: "message", message: "hi" }),
      { "content-type": "application/json" },
    );
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    expect((result as { value: unknown }).value).toEqual({
      handler: "message",
      message: "hi",
    });
  });

  it("rejects an empty body", async () => {
    const req = makeBodyReq("");
    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe("empty payload");
  });

  it("rejects a payload larger than maxBytes", async () => {
    const req = makeBodyReq("x".repeat(100));
    const result = await readJsonBody(req, 50);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe("payload too large");
  });

  it("rejects non-JSON, non-form bodies with a helpful error", async () => {
    const req = makeBodyReq("plain text not json at all", {
      "content-type": "text/plain",
    });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not valid JSON/);
  });

  it("normalizes a Deluge form-urlencoded body (parameters:) with form content-type", async () => {
    // Simulates `parameters: payload.toString()` in Deluge — each Map entry
    // becomes a form field. Nested values are URL-encoded JSON.
    const raw = new URLSearchParams({
      handler: "message",
      message: JSON.stringify({ text: "hi from deluge", id: "m1" }),
      user: JSON.stringify({ id: "u1", name: "Alice" }),
    }).toString();
    const req = makeBodyReq(raw, {
      "content-type": "application/x-www-form-urlencoded",
    });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    const value = (result as { value: unknown }).value as Record<string, unknown>;
    expect(value.handler).toBe("message");
    expect(value.message).toEqual({ text: "hi from deluge", id: "m1" });
    expect(value.user).toEqual({ id: "u1", name: "Alice" });
    // The normalized value must round-trip through parseCliqWebhookPayload.
    expect(parseCliqWebhookPayload(value as CliqWebhookPayload)).not.toBeNull();
  });

  it("normalizes a Deluge form-urlencoded body without explicit content-type (looks like form)", async () => {
    // Some gateways strip/lose the content-type header; the body still
    // looks form-encoded (key=value&key=value), so the fallback kicks in.
    const raw = new URLSearchParams({
      handler: "mention",
      message: "plain string message",
    }).toString();
    const req = makeBodyReq(raw);
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    const value = (result as { value: unknown }).value as Record<string, unknown>;
    expect(value.handler).toBe("mention");
    expect(value.message).toBe("plain string message");
  });

  it("does not misinterpret a raw JSON object as form-urlencoded", async () => {
    const raw = JSON.stringify({ handler: "message" });
    const req = makeBodyReq(raw);
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    expect((result as { value: unknown }).value).toEqual({ handler: "message" });
  });
});

describe("normalizeFormUrlencodedBody (issue #10)", () => {
  it("is exported and normalizes a form-urlencoded string", async () => {
    const { normalizeFormUrlencodedBody } = await import("./inbound.js");
    const raw = new URLSearchParams({
      handler: "message",
      message: JSON.stringify({ text: "hi" }),
    }).toString();
    const out = normalizeFormUrlencodedBody(raw, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(out).toEqual({
      handler: "message",
      message: { text: "hi" },
    });
  });

  it("returns undefined for a raw JSON body", async () => {
    const { normalizeFormUrlencodedBody } = await import("./inbound.js");
    expect(
      normalizeFormUrlencodedBody('{"handler":"message"}', {
        "content-type": "application/json",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a body with no key=value pairs", async () => {
    const { normalizeFormUrlencodedBody } = await import("./inbound.js");
    expect(
      normalizeFormUrlencodedBody("plain text not json", {
        "content-type": "text/plain",
      }),
    ).toBeUndefined();
  });
});

describe("dispatchCliqInbound context fields", () => {
  function mockRuntime(capture: { ctxPayload?: Record<string, unknown> }): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => {
            capture.ctxPayload = fields;
            return fields;
          },
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async () => undefined,
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  it("sets From to cliq:group:<uniqueName> and fills GroupChannel for group messages", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(groupPayload());
    expect(parsed).not.toBeNull();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed: parsed!,
    });
    expect(capture.ctxPayload?.From).toBe("cliq:group:dev-team");
    expect(capture.ctxPayload?.GroupChannel).toBe("dev-team");
    expect(capture.ctxPayload?.GroupSubject).toBe("dev-team");
    expect(capture.ctxPayload?.ChatType).toBe("channel");
    expect(capture.ctxPayload?.To).toBe("cliq:channel:dev-team");
  });

  it("sets From to cliq:<senderId> for DMs and leaves GroupChannel unset", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(dmPayload());
    expect(parsed).not.toBeNull();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed: parsed!,
    });
    expect(capture.ctxPayload?.From).toBe("cliq:u1");
    expect(capture.ctxPayload?.GroupChannel).toBeUndefined();
    expect(capture.ctxPayload?.GroupSubject).toBeUndefined();
    expect(capture.ctxPayload?.ChatType).toBe("direct");
  });

  it("falls back to chatId in From when channel unique name is absent", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(
      groupPayload({
        chat: { id: "CT_channel_chat", type: "channel", chat_type: "channel", title: "#ops" },
      }),
    );
    expect(parsed).not.toBeNull();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed: parsed!,
    });
    expect(capture.ctxPayload?.From).toBe("cliq:group:CT_channel_chat");
  });

  it("surfaces FormValues / FormName on the context for a form submission (Phase 3)", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload({
      handler: "form",
      form: { name: "approval_request" },
      values: {
        approver: "alice@corp.com",
        priority: "high",
      },
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm" },
    } as CliqWebhookPayload);
    expect(parsed).not.toBeNull();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed: parsed!,
    });
    expect(capture.ctxPayload?.FormName).toBe("approval_request");
    expect(capture.ctxPayload?.FormValues).toEqual({
      approver: "alice@corp.com",
      priority: "high",
    });
    // The synthesized body is what the agent envelope receives.
    expect(String(capture.ctxPayload?.Body)).toContain("Form: approval_request");
    expect(String(capture.ctxPayload?.Body)).toContain("approver: alice@corp.com");
  });

  it("omits FormValues / FormName for an ordinary message", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(dmPayload());
    expect(parsed).not.toBeNull();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed: parsed!,
    });
    expect(capture.ctxPayload?.FormValues).toBeUndefined();
    expect(capture.ctxPayload?.FormName).toBeUndefined();
  });

  it("surfaces FormValues on the context for an agent-rendered form button-click (Phase 3, sub-part c)", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload({
      handler: "message",
      message: { text: "__cliq_form__ priority=high", id: "m-form-1" },
      user: { id: "u1", name: "Alice" },
      chat: { id: "CT_dm" },
    } as CliqWebhookPayload);
    expect(parsed).not.toBeNull();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed: parsed!,
    });
    // Structured params surfaced for a tool call.
    expect(capture.ctxPayload?.FormValues).toEqual({ priority: "high" });
    // No form name on the agent-rendered button-click path.
    expect(capture.ctxPayload?.FormName).toBeUndefined();
    // The agent envelope body is the clean `<field>: <value>` rendering
    // (sentinel stripped), so the agent also sees a readable answer.
    expect(String(capture.ctxPayload?.Body)).toContain("priority: high");
    expect(String(capture.ctxPayload?.Body)).not.toContain("__cliq_form__");
  });
});

describe("dispatchCliqInbound — stop / abort intent (issue #51)", () => {
  function mockRuntime(capture: {
    ctxPayload?: Record<string, unknown>;
    dispatchInput?: unknown;
  }): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => {
            capture.ctxPayload = fields;
            return fields;
          },
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            capture.dispatchInput = params;
            return undefined;
          },
        },
        inbound: {
          run: async () => undefined,
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  function makeClient() {
    return {
      sendMessage: vi.fn(async () => ({ messageId: "out-1" })),
      sendCard: vi.fn(async () => ({ messageId: "out-1" })),
      editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => ({
        messageId: o.messageId,
        chatId: o.chatId,
      })),
      resolveChannelChatId: vi.fn(async () => undefined),
      listChatMessages: vi.fn(async () => []),
      deleteMessage: vi.fn(async () => true),
      downloadAttachment: vi.fn(async () => {
        throw new Error("not mocked");
      }),
    };
  }

  it("marks a DM `stop` turn as an authorized text command so the SDK aborts the run", async () => {
    const capture: { ctxPayload?: Record<string, unknown>; dispatchInput?: unknown } = {};
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "stop" }))!;
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed,
      client: makeClient(),
    });
    expect(capture.ctxPayload?.CommandSource).toBe("text");
    expect(capture.ctxPayload?.CommandAuthorized).toBe(true);
  });

  it("marks a DM `/stop` turn as an authorized text command", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "/stop" }))!;
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed,
      client: makeClient(),
    });
    expect(capture.ctxPayload?.CommandSource).toBe("text");
    expect(capture.ctxPayload?.CommandAuthorized).toBe(true);
  });

  it("marks a group `@bot stop` mention turn as an authorized text command", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(
      groupPayload({ message: "@bot stop" }),
    )!;
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed,
      client: makeClient(),
    });
    expect(capture.ctxPayload?.CommandSource).toBe("text");
    expect(capture.ctxPayload?.CommandAuthorized).toBe(true);
  });

  it("does NOT mark a normal conversational DM as a command", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "hello bot" }))!;
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed,
      client: makeClient(),
    });
    expect(capture.ctxPayload?.CommandSource).toBeUndefined();
    expect(capture.ctxPayload?.CommandAuthorized).toBeUndefined();
  });

  it("does not post a thinking placeholder for an abort intent", async () => {
    const capture: { ctxPayload?: Record<string, unknown> } = {};
    const client = makeClient();
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "stop" }))!;
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({ refreshToken: "rt", thinking: { mode: "placeholder", text: "💭 …" } }),
      parsed,
      client,
    });
    // A stop intent must not post a "thinking" placeholder — the SDK's abort
    // path posts the "Stopped." reply directly via the deliver callback.
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("dispatchCliqInbound — inbound quote / reply context (issue #49)", () => {
  function mockRuntime(capture: {
    ctxPayload?: Record<string, unknown>;
    body?: string;
  }): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => {
            const b = String(p.body ?? "");
            capture.body = b;
            return b;
          },
          finalizeInboundContext: (fields: Record<string, unknown>) => {
            capture.ctxPayload = fields;
            return fields;
          },
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async () => undefined,
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  function makeClient(messages: { messageId: string; chatId: string; text?: string }[] = []) {
    return {
      sendMessage: vi.fn(async (_o: { to: string; text: string; isDm?: boolean }) => ({
        messageId: "out-1",
      })),
      sendCard: vi.fn(async () => ({ messageId: "out-1" })),
      editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => ({
        messageId: o.messageId,
        chatId: o.chatId,
      })),
      resolveChannelChatId: vi.fn(async () => undefined),
      listChatMessages: vi.fn(async () => messages),
      deleteMessage: vi.fn(async () => true),
      downloadAttachment: vi.fn(async () => {
        throw new Error("not mocked");
      }),
    };
  }

  it("carries the parent message id + text + sender into the inbound context", async () => {
    const capture: { ctxPayload?: Record<string, unknown>; body?: string } = {};
    const parsed = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "agreed", id: "m2", reply_to: "m1" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
        parent: {
          id: "m1",
          text: "Let's ship it",
          sender: { id: "u-bot", name: "Bot" },
        },
      } as CliqWebhookPayload,
    )!;
    const client = makeClient();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account(),
      parsed,
      client,
    });
    // No fetch is attempted (no refresh token) but the parsed parent is used.
    expect(client.listChatMessages).not.toHaveBeenCalled();
    expect(capture.ctxPayload?.ReplyToMessageId).toBe("m1");
    expect(capture.ctxPayload?.ReplyToText).toBe("Let's ship it");
    expect(capture.ctxPayload?.ReplyToSenderId).toBe("u-bot");
    expect(capture.ctxPayload?.ReplyToSenderName).toBe("Bot");
    expect(capture.ctxPayload?.ReplyToId).toBe("m1");
    // The agent envelope body prepends the quote block.
    expect(capture.body).toContain("↩ Replying to Bot:");
    expect(capture.body).toContain("> Let's ship it");
    expect(capture.body).toContain("agreed");
  });

  it("fetches the parent text via listChatMessages when only an id is present and a refresh token is configured", async () => {
    const capture: { ctxPayload?: Record<string, unknown>; body?: string } = {};
    const parsed = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "agreed", id: "m2", reply_to: "m1" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
      } as CliqWebhookPayload,
    )!;
    const client = makeClient([
      { messageId: "m1", chatId: "CT_dm_chat-B1", text: "the fetched parent text" },
    ]);
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({ refreshToken: "rt" }),
      parsed,
      client,
    });
    expect(client.listChatMessages).toHaveBeenCalledWith("CT_dm_chat-B1", { limit: 50 });
    expect(capture.ctxPayload?.ReplyToText).toBe("the fetched parent text");
    expect(capture.body).toContain("> the fetched parent text");
  });

  it("degrades gracefully when the fetch returns no match", async () => {
    const capture: { ctxPayload?: Record<string, unknown>; body?: string } = {};
    const parsed = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "agreed", id: "m2", reply_to: "m-missing" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
      } as CliqWebhookPayload,
    )!;
    const client = makeClient([{ messageId: "m-other", chatId: "CT_dm_chat-B1", text: "x" }]);
    const onError = vi.fn();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({ refreshToken: "rt" }),
      parsed,
      client,
      onError,
    });
    // No text resolved → the body has no quote block, just the user message.
    expect(capture.body).toBe("agreed");
    expect(capture.ctxPayload?.ReplyToMessageId).toBe("m-missing");
    expect(capture.ctxPayload?.ReplyToText).toBeUndefined();
  });

  it("swallows a fetch failure and still dispatches", async () => {
    const capture: { ctxPayload?: Record<string, unknown>; body?: string } = {};
    const parsed = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "agreed", id: "m2", reply_to: "m1" },
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
      } as CliqWebhookPayload,
    )!;
    const client = {
      sendMessage: vi.fn(async () => ({ messageId: "out-1" })),
      sendCard: vi.fn(async () => ({ messageId: "out-1" })),
      editMessage: vi.fn(async () => ({ messageId: "x", chatId: "y" })),
      resolveChannelChatId: vi.fn(async () => undefined),
      listChatMessages: vi.fn(async () => {
        throw new Error("api down");
      }),
      deleteMessage: vi.fn(async () => true),
      downloadAttachment: vi.fn(async () => {
        throw new Error("not mocked");
      }),
    };
    const onError = vi.fn();
    await dispatchCliqInbound({
      runtime: mockRuntime(capture),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({ refreshToken: "rt" }),
      parsed,
      client,
      onError,
    });
    expect(capture.body).toBe("agreed");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { kind: "reply-to-fetch" });
  });

  it("a group reply-to-bot is admitted as an implicit mention", async () => {
    // Group message with NO @mention but a reply_to pointing at the bot.
    const parsed = parseCliqWebhookPayload(
      {
        handler: "message",
        message: { text: "yes please", id: "m2", reply_to: "m1" },
        user: { id: "u2", name: "Bob" },
        chat: {
          id: "CT_channel_chat",
          type: "channel",
          chat_type: "channel",
          channel_unique_name: "dev-team",
          title: "#dev-team",
        },
        parent: {
          id: "m1",
          text: "what should I do?",
          sender: { id: "bot", name: "Bot" },
        },
      } as CliqWebhookPayload,
    )!;
    expect(parsed.isGroup).toBe(true);
    expect(parsed.isMention).toBe(false);
    expect(parsed.replyTo?.senderId).toBe("bot");
    // The decision should NOT skip (reply-to-bot counts as implicit mention).
    const decision = resolveCliqMentionDecision(parsed, account({ botId: "bot", botName: "Bot" }));
    expect(decision.shouldSkip).toBe(false);
  });
});

describe("dispatchCliqInbound — inbound media (issue #48)", () => {
  function mockRuntime(capture: { ctxPayload?: Record<string, unknown> }): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => {
            capture.ctxPayload = fields;
            return fields;
          },
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: { run: async () => undefined },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  function makeMediaClient(opts: {
    bytes?: Uint8Array;
    contentType?: string;
    fails?: boolean;
  } = {}) {
    const downloads: string[] = [];
    const client = {
      downloads,
      sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => ({
        messageId: o.isDm ? `mid-${o.to}` : undefined,
        chatId: o.isDm ? `chat-${o.to}` : undefined,
      })),
      sendCard: vi.fn(async () => ({ messageId: "out-1" })),
      editMessage: vi.fn(async () => ({ messageId: "x", chatId: "x" })),
      resolveChannelChatId: vi.fn(async () => undefined),
      listChatMessages: vi.fn(async () => []),
      deleteMessage: vi.fn(async () => true),
      downloadAttachment: vi.fn(async (fileId: string) => {
        downloads.push(fileId);
        if (opts.fails) throw new Error("download rejected");
        return {
          bytes: opts.bytes ?? new Uint8Array([1, 2, 3]),
          contentType: opts.contentType ?? "image/png",
        };
      }),
    };
    return client;
  }

  it("downloads an attachment, writes it to disk, and attaches MediaPath/Url/Type to the context", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "cliq-media-"));
    try {
      const capture: { ctxPayload?: Record<string, unknown> } = {};
      const client = makeMediaClient({
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
      });
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
        message: { id: "m-file" },
        content: {
          file: { id: "fileid-1", name: "photo.png", type: "image/png" },
          comment: "look here",
        },
      } as CliqWebhookPayload);
      expect(parsed).not.toBeNull();
      await dispatchCliqInbound({
        runtime: mockRuntime(capture),
        cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
        account: account(),
        parsed: parsed!,
        client,
        mediaDir,
      });
      expect(client.downloads).toEqual(["fileid-1"]);
      const paths = capture.ctxPayload?.MediaPaths as string[];
      expect(Array.isArray(paths)).toBe(true);
      expect(paths).toHaveLength(1);
      expect(typeof paths[0]).toBe("string");
      // The single-item fields mirror the first entry.
      expect(capture.ctxPayload?.MediaPath).toBe(paths[0]);
      expect(capture.ctxPayload?.MediaUrl).toBe(paths[0]);
      expect(capture.ctxPayload?.MediaType).toBe("image/png");
      expect(capture.ctxPayload?.MediaTypes).toEqual(["image/png"]);
      // The file was actually written.
      const { readFile } = await import("node:fs/promises");
      const onDisk = await readFile(paths[0]);
      expect(onDisk.length).toBe(4);
      expect(onDisk[0]).toBe(0x89);
      // The caption surfaces as the agent body.
      expect(capture.ctxPayload?.RawBody).toBe("look here");
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("marks audio attachments as transcribed:false (runtime transcribes via media understanding)", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "cliq-media-"));
    try {
      const capture: { ctxPayload?: Record<string, unknown> } = {};
      const client = makeMediaClient({
        bytes: new Uint8Array([0, 1, 2]),
        contentType: "audio/mpeg",
      });
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
        message: { id: "m-voice" },
        content: { file: { id: "voice-1", name: "voice.mp3", type: "audio/mpeg" } },
      } as CliqWebhookPayload);
      await dispatchCliqInbound({
        runtime: mockRuntime(capture),
        cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
        account: account(),
        parsed: parsed!,
        client,
        mediaDir,
      });
      expect(capture.ctxPayload?.MediaType).toBe("audio/mpeg");
      // Body is the synthesized <media:audio> placeholder.
      expect(capture.ctxPayload?.RawBody).toBe("<media:audio>");
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("swallows a failed download and dispatches with no media (turn never breaks)", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "cliq-media-"));
    try {
      const capture: { ctxPayload?: Record<string, unknown> } = {};
      const client = makeMediaClient({ fails: true });
      let reported = 0;
      const parsed = parseCliqWebhookPayload({
        handler: "message",
        user: { id: "u1", name: "Alice" },
        chat: { id: "CT_dm_chat-B1" },
        message: { id: "m-file" },
        content: { file: { id: "fileid-bad", name: "x.png", type: "image/png" } },
      } as CliqWebhookPayload);
      await dispatchCliqInbound({
        runtime: mockRuntime(capture),
        cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
        account: account(),
        parsed: parsed!,
        client,
        mediaDir,
        onError: () => {
          reported++;
        },
      });
      expect(client.downloads).toEqual(["fileid-bad"]);
      expect(reported).toBe(1);
      // No media fields on the context.
      expect(capture.ctxPayload?.MediaPaths).toBeUndefined();
      expect(capture.ctxPayload?.MediaPath).toBeUndefined();
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("does nothing media-related when the message has no attachments", async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), "cliq-media-"));
    try {
      const capture: { ctxPayload?: Record<string, unknown> } = {};
      const client = makeMediaClient();
      await dispatchCliqInbound({
        runtime: mockRuntime(capture),
        cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
        account: account(),
        parsed: parseCliqWebhookPayload(dmPayload())!,
        client,
        mediaDir,
      });
      expect(client.downloads).toHaveLength(0);
      expect(capture.ctxPayload?.MediaPath).toBeUndefined();
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });
});

describe("dispatchCliqInbound — thinking placeholder (issue #47)", () => {
  function mockRuntimeWithDeliver(replyText: string): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => fields,
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          // Drive the delivery ourselves: resolve the turn, then invoke its
          // `delivery.deliver` with the canned reply text — simulating the
          // buffered block dispatcher flushing a single final reply.
          run: async (params) => {
            const adapter = (params as unknown as {
              adapter: {
                resolveTurn: (...args: unknown[]) => unknown;
              };
            }).adapter;
            const turn = adapter.resolveTurn({}, {}, {}) as unknown as {
              delivery: {
                deliver: (payload: { text?: string }) => Promise<void>;
                onError: (err: unknown, info: { kind: string }) => void;
              };
            };
            // Mirror the buffered block dispatcher: route a deliver throw to
            // `delivery.onError` so the turn never propagates an uncaught
            // rejection (production wraps the deliver call the same way).
            try {
              await turn.delivery.deliver({ text: replyText });
            } catch (err) {
              turn.delivery.onError(err, { kind: "deliver" });
            }
          },
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  function makeMockClient(opts: {
    placeholderChatId?: string;
    sendFails?: boolean;
    editFails?: boolean;
    channelChatId?: string;
  } = {}) {
    const sends: { to: string; text: string; isDm?: boolean }[] = [];
    const cardSends: {
      to: string;
      text?: string;
      isDm?: boolean;
      theme?: string;
    }[] = [];
    const edits: { chatId: string; messageId: string; text: string }[] = [];
    const deletes: { chatId: string; messageId: string }[] = [];
    const client = {
      sends,
      cardSends,
      edits,
      deletes,
      sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
        if (opts.sendFails) throw new Error("send rejected");
        sends.push(o);
        // First send is the placeholder; return a placeholder ref.
        return o.isDm
          ? { messageId: "ph-1", chatId: opts.placeholderChatId ?? `chat-${o.to}` }
          : { messageId: "ph-1" };
      }),
      sendCard: vi.fn(async (o: {
        to: string;
        text?: string;
        isDm?: boolean;
        theme?: string;
      }) => {
        if (opts.sendFails) throw new Error("send rejected");
        cardSends.push(o);
        return o.isDm
          ? { messageId: "card-1", chatId: opts.placeholderChatId ?? `chat-${o.to}` }
          : { messageId: "card-1" };
      }),
      editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
        edits.push(o);
        if (opts.editFails) throw new Error("edit rejected");
        return { messageId: o.messageId, chatId: o.chatId };
      }),
      resolveChannelChatId: vi.fn(async () => opts.channelChatId ?? undefined),
      listChatMessages: vi.fn(async () => []),
      deleteMessage: vi.fn(async (o: { chatId: string; messageId: string }) => {
        deletes.push(o);
        return true;
      }),
      downloadAttachment: vi.fn(async () => {
        throw new Error("download attachment not mocked");
      }),
    };
    return client;
  }

  it("posts a placeholder and edits it into the final reply (DM, streaming off, refreshToken set)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("the final reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // One placeholder post + one edit replacing it. No fresh reply send.
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].text).toBe("💭 …");
    expect(client.sends[0].isDm).toBe(true);
    expect(client.edits).toHaveLength(1);
    expect(client.edits[0].messageId).toBe("ph-1");
    expect(client.edits[0].chatId).toBe("chat-u1");
    expect(client.edits[0].text).toBe("the final reply");
    expect(client.deletes).toHaveLength(0);
  });

  it("is a no-op when streaming preview is on (live-edit already shows progress)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: true,
      }),
      parsed: parsed!,
      client,
    });
    // No placeholder posted; the live-edit path sends the reply itself.
    expect(client.sends.every((s) => s.text !== "💭 …")).toBe(true);
    expect(client.edits).toHaveLength(0);
  });

  it("is a no-op when no refreshToken is configured (cannot edit cleanly)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: undefined,
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // No placeholder posted; reply sent as a fresh message.
    expect(client.sends.every((s) => s.text !== "💭 …")).toBe(true);
    expect(client.edits).toHaveLength(0);
  });

  it("is a no-op when thinking.mode is off (default)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "off", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    expect(client.sends.every((s) => s.text !== "💭 …")).toBe(true);
    expect(client.edits).toHaveLength(0);
  });

  it("swallows a failed placeholder post and never breaks the turn", async () => {
    const client = makeMockClient({ sendFails: true, placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    let reportedError = false;
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
      onError: () => {
        reportedError = true;
      },
    });
    // Placeholder post threw → swallowed + reported. The deliver still ran
    // (no initialDraft) → would send the reply as a fresh message, but
    // sendMessage throws on every call so the send also fails (swallowed
    // by the live-edit onError in production). The turn must not throw.
    expect(reportedError).toBe(true);
    expect(client.edits).toHaveLength(0);
  });

  it("supports group/channel placeholder (chat id resolved lazily on edit)", async () => {
    const client = makeMockClient({ channelChatId: "CT_dev_team" });
    const parsed = parseCliqWebhookPayload(groupPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Placeholder posted to the channel (no chatId in the send response);
    // the edit resolves the channel chat id lazily.
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].text).toBe("💭 …");
    expect(client.sends[0].isDm).toBe(false);
    expect(client.edits).toHaveLength(1);
    expect(client.edits[0].chatId).toBe("CT_dev_team");
    expect(client.edits[0].messageId).toBe("ph-1");
    expect(client.edits[0].text).toBe("reply");
  });

  it("posts a Message Card status indicator in card mode (DM, v3-style sendCard)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("the final reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Card posted with the "thinking" phase title (default `💭 thinking…`),
    // then edited to the "generating" phase title (`text`), then edited into
    // the final reply. No fresh reply send, no delete.
    expect(client.sends).toHaveLength(0);
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].text).toBe("💭 thinking…");
    expect(client.cardSends[0].isDm).toBe(true);
    expect(client.cardSends[0].theme).toBe("modern-inline");
    expect(client.edits).toHaveLength(2);
    expect(client.edits[0].messageId).toBe("card-1");
    expect(client.edits[0].chatId).toBe("chat-u1");
    expect(client.edits[0].text).toBe("Generating…");
    expect(client.edits[1].messageId).toBe("card-1");
    expect(client.edits[1].chatId).toBe("chat-u1");
    expect(client.edits[1].text).toBe("the final reply");
    expect(client.deletes).toHaveLength(0);
  });

  it("card mode is a no-op when streaming preview is on", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: true,
      }),
      parsed: parsed!,
      client,
    });
    expect(client.cardSends).toHaveLength(0);
    expect(client.edits).toHaveLength(0);
  });

  it("card mode is a no-op without a refreshToken (edits need a user-context token)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: undefined,
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    expect(client.cardSends).toHaveLength(0);
    expect(client.edits).toHaveLength(0);
  });

  it("card mode does not post for an abort intent", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "stop" }));
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    expect(client.cardSends).toHaveLength(0);
  });

  it("card mode supports group/channel posts (chat id resolved lazily on edit)", async () => {
    const client = makeMockClient({ channelChatId: "CT_dev_team" });
    const parsed = parseCliqWebhookPayload(groupPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithDeliver("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].text).toBe("💭 thinking…");
    expect(client.cardSends[0].isDm).toBe(false);
    expect(client.edits).toHaveLength(2);
    expect(client.edits[0].chatId).toBe("CT_dev_team");
    expect(client.edits[0].messageId).toBe("card-1");
    expect(client.edits[0].text).toBe("Generating…");
    expect(client.edits[1].chatId).toBe("CT_dev_team");
    expect(client.edits[1].messageId).toBe("card-1");
    expect(client.edits[1].text).toBe("reply");
  });
});

describe("dispatchCliqInbound — card status phase transitions (issue #78)", () => {
  // Reuse the thinking-placeholder mock client + runtime helpers (they are
  // declared inside the `thinking placeholder (issue #47)` describe block
  // above; the phase-transition behavior under test is a strict superset of
  // the #76 card surface). Each test opts into `thinking.mode === "card"`.

  function makeClient(opts: {
    placeholderChatId?: string;
    channelChatId?: string;
    editFails?: boolean;
    resolveFails?: boolean;
  } = {}) {
    const sends: { to: string; text: string; isDm?: boolean }[] = [];
    const cardSends: {
      to: string;
      text?: string;
      isDm?: boolean;
      theme?: string;
    }[] = [];
    const edits: { chatId: string; messageId: string; text: string }[] = [];
    const deletes: { chatId: string; messageId: string }[] = [];
    const client = {
      sends,
      cardSends,
      edits,
      deletes,
      sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
        sends.push(o);
        return o.isDm
          ? { messageId: "card-1", chatId: opts.placeholderChatId ?? `chat-${o.to}` }
          : { messageId: "card-1" };
      }),
      sendCard: vi.fn(async (o: {
        to: string;
        text?: string;
        isDm?: boolean;
        theme?: string;
      }) => {
        cardSends.push(o);
        return o.isDm
          ? { messageId: "card-1", chatId: opts.placeholderChatId ?? `chat-${o.to}` }
          : { messageId: "card-1" };
      }),
      editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
        edits.push(o);
        if (opts.editFails) throw new Error("edit rejected");
        return { messageId: o.messageId, chatId: o.chatId };
      }),
      resolveChannelChatId: vi.fn(async () => {
        if (opts.resolveFails) throw new Error("resolve failed");
        return opts.channelChatId ?? undefined;
      }),
      listChatMessages: vi.fn(async () => []),
      deleteMessage: vi.fn(async (o: { chatId: string; messageId: string }) => {
        deletes.push(o);
        return true;
      }),
      downloadAttachment: vi.fn(async () => {
        throw new Error("download attachment not mocked");
      }),
    };
    return client;
  }

  function replyRuntime(replyText: string): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => fields,
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async (params) => {
            const adapter = (params as unknown as {
              adapter: { resolveTurn: (...args: unknown[]) => unknown };
            }).adapter;
            const turn = adapter.resolveTurn({}, {}, {}) as unknown as {
              delivery: {
                deliver: (payload: { text?: string }) => Promise<void>;
                onError: (err: unknown, info: { kind: string }) => void;
              };
            };
            try {
              await turn.delivery.deliver({ text: replyText });
            } catch (err) {
              turn.delivery.onError(err, { kind: "deliver" });
            }
          },
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  function noReplyRuntime(): CliqRuntime {
    return {
      ...replyRuntime(""),
      channel: {
        ...replyRuntime("").channel,
        inbound: { run: async () => undefined },
      },
    };
  }

  it("transitions the card title thinking → generating → reply (DM)", async () => {
    const client = makeClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: replyRuntime("the final reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Defaults: card posted with `💭 thinking…`, edited to `Generating…`,
    // then edited into the reply text.
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].text).toBe("💭 thinking…");
    expect(client.edits).toHaveLength(2);
    expect(client.edits[0].text).toBe("Generating…");
    expect(client.edits[1].text).toBe("the final reply");
    expect(client.deletes).toHaveLength(0);
  });

  it("honors custom thinkingText and text (generating) phase titles", async () => {
    const client = makeClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: replyRuntime("answer"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: {
          mode: "card",
          thinkingText: "🤔 Pondering…",
          text: "⚙️ Working…",
        },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    expect(client.cardSends[0].text).toBe("🤔 Pondering…");
    expect(client.edits[0].text).toBe("⚙️ Working…");
    expect(client.edits[1].text).toBe("answer");
  });

  it("resolves the group chat id lazily for the thinking→generating edit", async () => {
    const client = makeClient({ channelChatId: "CT_dev_team" });
    const parsed = parseCliqWebhookPayload(groupPayload());
    await dispatchCliqInbound({
      runtime: replyRuntime("reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Group card send carries no chatId → resolved for the phase edit (and
    // re-resolved by the live-edit deliver's lazy resolve; the real client
    // caches it).
    expect(client.resolveChannelChatId).toHaveBeenCalled();
    expect(client.edits[0].chatId).toBe("CT_dev_team");
    expect(client.edits[0].text).toBe("Generating…");
    expect(client.edits[1].chatId).toBe("CT_dev_team");
    expect(client.edits[1].text).toBe("reply");
  });

  it("swallows a failed thinking→generating edit (the reply still sends)", async () => {
    const client = makeClient({
      placeholderChatId: "chat-u1",
      editFails: true,
    });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: replyRuntime("the reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // The phase edit threw (swallowed). The live-edit deliver then tried to
    // edit the card into the reply and that edit also failed → it deleted
    // the stray card and sent the reply fresh. The turn never broke.
    expect(client.edits.length).toBeGreaterThanOrEqual(1);
    expect(client.deletes).toHaveLength(1);
    expect(client.sends.length).toBeGreaterThanOrEqual(1);
    expect(client.sends.some((s) => s.text === "the reply")).toBe(true);
  });

  it("does not advance phases when the chat id is unresolvable (group)", async () => {
    const client = makeClient({ channelChatId: undefined });
    const parsed = parseCliqWebhookPayload(groupPayload());
    await dispatchCliqInbound({
      runtime: noReplyRuntime(),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Card posted with the thinking title; no phase edit (no chat id); no
    // reply → cleanup deletes the still-thinking card.
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].text).toBe("💭 thinking…");
    expect(client.edits).toHaveLength(0);
    expect(client.deletes).toHaveLength(0);
  });
});

describe("dispatchCliqInbound — confirm gate (Phase 3 confirmation buttons)", () => {
  // Mock client + runtime for the confirm-gate flow. The client records every
  // send / sendCard / edit / delete so the tests can assert the exact surface
  // the gate produces. `inboundRunCalled` lets a test assert that the agent
  // turn was (or was not) dispatched.
  function makeClient(opts: { sendCardFails?: boolean; sendFails?: boolean } = {}) {
    const sends: { to: string; text: string; isDm?: boolean }[] = [];
    const cardSends: {
      to: string;
      text?: string;
      isDm?: boolean;
      theme?: string;
      buttons?: unknown[];
    }[] = [];
    const edits: { chatId: string; messageId: string; text: string }[] = [];
    const deletes: { chatId: string; messageId: string }[] = [];
    const client = {
      sends,
      cardSends,
      edits,
      deletes,
      sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
        if (opts.sendFails) throw new Error("send rejected");
        sends.push(o);
        return { messageId: "msg-1", chatId: `chat-${o.to}` };
      }),
      sendCard: vi.fn(async (o: {
        to: string;
        text?: string;
        isDm?: boolean;
        theme?: string;
        buttons?: unknown[];
      }) => {
        if (opts.sendCardFails) throw new Error("sendCard rejected");
        cardSends.push(o);
        return { messageId: "prompt-1", chatId: `chat-${o.to}` };
      }),
      editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
        edits.push(o);
        return { messageId: o.messageId, chatId: o.chatId };
      }),
      resolveChannelChatId: vi.fn(async () => "CT_dev_team"),
      listChatMessages: vi.fn(async () => []),
      deleteMessage: vi.fn(async (o: { chatId: string; messageId: string }) => {
        deletes.push(o);
        return true;
      }),
      downloadAttachment: vi.fn(async () => {
        throw new Error("download attachment not mocked");
      }),
    };
    return client;
  }

  function runtimeTracking(replyText: string): {
    runtime: CliqRuntime;
    inboundRunCalled: () => boolean;
  } {
    let called = false;
    const runtime: CliqRuntime = {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => fields,
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async (params) => {
            called = true;
            const adapter = (params as unknown as {
              adapter: { resolveTurn: (...args: unknown[]) => unknown };
            }).adapter;
            const turn = adapter.resolveTurn({}, {}, {}) as unknown as {
              delivery: {
                deliver: (payload: { text?: string }) => Promise<void>;
                onError: (err: unknown, info: { kind: string }) => void;
              };
            };
            try {
              await turn.delivery.deliver({ text: replyText });
            } catch (err) {
              turn.delivery.onError(err, { kind: "deliver" });
            }
          },
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
    return { runtime, inboundRunCalled: () => called };
  }

  const confirmAccount = account({
    thinking: {
      mode: "card",
      text: "Generating…",
      confirm: "sensitive",
    },
    refreshToken: "rt",
    blockStreaming: false,
  });

  it("posts a confirm prompt card (not the agent turn) for a sensitive DM", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "please delete the prod database" }))!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: confirmAccount,
      parsed,
      client,
    });
    // A prompt card with Confirm + Cancel buttons was posted; no agent turn.
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].theme).toBe("prompt");
    expect(client.cardSends[0].text).toBe("⚠️ Confirm action?");
    expect(client.cardSends[0].isDm).toBe(true);
    const buttons = client.cardSends[0].buttons as Array<{ data?: string }>;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].data).toBe("__cliq_confirm__ please delete the prod database");
    expect(buttons[1].data).toBe("__cliq_cancel__");
    expect(inboundRunCalled()).toBe(false);
    expect(client.sends).toHaveLength(0);
  });

  it("does NOT gate a benign message (dispatches normally)", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "what is the weather" }))!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: confirmAccount,
      parsed,
      client,
    });
    // No prompt card; the agent turn ran and posted the thinking card.
    expect(client.cardSends.some((c) => c.theme === "prompt")).toBe(false);
    expect(inboundRunCalled()).toBe(true);
  });

  it("gates a sensitive channel post too (isDm=false)", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(
      groupPayload({ message: "drop the users table" }),
    )!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: confirmAccount,
      parsed,
      client,
    });
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].theme).toBe("prompt");
    expect(client.cardSends[0].isDm).toBe(false);
    expect(inboundRunCalled()).toBe(false);
  });

  it("a Cancel button click posts the cancelled reply and does NOT dispatch", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(
      dmPayload({ message: "__cliq_cancel__" }),
    )!;
    expect(parsed.confirmAction).toBe("cancel");
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: confirmAccount,
      parsed,
      client,
    });
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].text).toBe("🚫 Cancelled.");
    expect(client.sends[0].isDm).toBe(true);
    expect(client.cardSends).toHaveLength(0);
    expect(inboundRunCalled()).toBe(false);
  });

  it("a Confirm button click re-dispatches the original text WITHOUT re-gating", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(
      dmPayload({ message: "__cliq_confirm__ drop the prod database" }),
    )!;
    expect(parsed.confirmAction).toBe("confirm");
    expect(parsed.text).toBe("drop the prod database");
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: confirmAccount,
      parsed,
      client,
    });
    // The agent turn ran (no re-prompt loop); the thinking card flow posted
    // a modern-inline card (NOT a prompt card).
    expect(inboundRunCalled()).toBe(true);
    expect(client.cardSends.some((c) => c.theme === "prompt")).toBe(false);
    expect(client.cardSends.some((c) => c.theme === "modern-inline")).toBe(true);
  });

  it("does not gate when thinking.mode is not card (confirm is a no-op)", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "delete everything" }))!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …", confirm: "always" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed,
      client,
    });
    expect(client.cardSends.some((c) => c.theme === "prompt")).toBe(false);
    expect(inboundRunCalled()).toBe(true);
  });

  it("gates every turn when confirm is always (even benign text)", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "hello there" }))!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…", confirm: "always" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed,
      client,
    });
    expect(client.cardSends).toHaveLength(1);
    expect(client.cardSends[0].theme).toBe("prompt");
    expect(inboundRunCalled()).toBe(false);
  });

  it("does not gate an abort intent even when confirm is always", async () => {
    const client = makeClient();
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "stop" }))!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…", confirm: "always" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed,
      client,
    });
    // Abort intents skip the gate (no prompt card); the dispatch proceeded.
    expect(client.cardSends.some((c) => c.theme === "prompt")).toBe(false);
    expect(inboundRunCalled()).toBe(true);
  });

  it("swallows a failed confirm-card post and falls through to dispatch", async () => {
    const client = makeClient({ sendCardFails: true });
    const { runtime, inboundRunCalled } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "delete everything" }))!;
    let reported = false;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: confirmAccount,
      parsed,
      client,
      onError: () => {
        reported = true;
      },
    });
    // The prompt post failed → reported + the agent turn ran (best-effort).
    expect(reported).toBe(true);
    expect(inboundRunCalled()).toBe(true);
  });

  it("honors custom confirmText / labels / cancelledText", async () => {
    const client = makeClient();
    const { runtime } = runtimeTracking("the reply");
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "delete the table" }))!;
    await dispatchCliqInbound({
      runtime,
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: {
          mode: "card",
          text: "Generating…",
          confirm: "sensitive",
          confirmText: "Really?",
          confirmLabel: "Yes",
          cancelLabel: "No",
          cancelledText: "Nope.",
        },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed,
      client,
    });
    expect(client.cardSends[0].text).toBe("Really?");
    const buttons = client.cardSends[0].buttons as Array<{ label: string }>;
    expect(buttons[0].label).toBe("Yes");
    expect(buttons[1].label).toBe("No");
  });
});

describe("dispatchCliqInbound — thinking placeholder cleanup on no reply", () => {
  // A runtime whose `inbound.run` resolves the turn but never calls
  // `delivery.deliver` — simulating an agent turn that produced no reply
  // (turn threw upstream, or the dispatcher flushed zero blocks).
  function mockRuntimeNoReply(): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => fields,
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async (params) => {
            const adapter = (params as unknown as {
              adapter: { resolveTurn: (...args: unknown[]) => unknown };
            }).adapter;
            // Resolve the turn (exercises the same path the SDK walks) but
            // never invoke its `delivery.deliver` → placeholder untouched.
            adapter.resolveTurn({}, {}, {});
          },
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  // A runtime that drives a single canned reply through `delivery.deliver`
  // (mirrors the buffered block dispatcher flushing one final block).
  function mockRuntimeWithReply(replyText: string): CliqRuntime {
    return {
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            sessionKey: "sess-1",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: (p: Record<string, unknown>) => String(p.body ?? ""),
          finalizeInboundContext: (fields: Record<string, unknown>) => fields,
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
        inbound: {
          run: async (params) => {
            const adapter = (params as unknown as {
              adapter: { resolveTurn: (...args: unknown[]) => unknown };
            }).adapter;
            const turn = adapter.resolveTurn({}, {}, {}) as unknown as {
              delivery: {
                deliver: (payload: { text?: string }) => Promise<void>;
                onError: (err: unknown, info: { kind: string }) => void;
              };
            };
            try {
              await turn.delivery.deliver({ text: replyText });
            } catch (err) {
              turn.delivery.onError(err, { kind: "deliver" });
            }
          },
        },
        pairing: {
          buildPairingReply: () => "",
          upsertPairingRequest: async () => ({ code: "CODE", created: true }),
        },
      },
    };
  }

  function makeMockClient(opts: {
    placeholderChatId?: string;
    editFails?: boolean;
    channelChatId?: string;
  } = {}) {
    const sends: { to: string; text: string; isDm?: boolean }[] = [];
    const cardSends: {
      to: string;
      text?: string;
      isDm?: boolean;
      theme?: string;
    }[] = [];
    const edits: { chatId: string; messageId: string; text: string }[] = [];
    const deletes: { chatId: string; messageId: string }[] = [];
    const client = {
      sends,
      cardSends,
      edits,
      deletes,
      sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
        sends.push(o);
        return o.isDm
          ? { messageId: "ph-1", chatId: opts.placeholderChatId ?? `chat-${o.to}` }
          : { messageId: "ph-1" };
      }),
      sendCard: vi.fn(async (o: {
        to: string;
        text?: string;
        isDm?: boolean;
        theme?: string;
      }) => {
        cardSends.push(o);
        return o.isDm
          ? { messageId: "card-1", chatId: opts.placeholderChatId ?? `chat-${o.to}` }
          : { messageId: "card-1" };
      }),
      editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
        edits.push(o);
        if (opts.editFails) throw new Error("edit rejected");
        return { messageId: o.messageId, chatId: o.chatId };
      }),
      resolveChannelChatId: vi.fn(async () => opts.channelChatId ?? undefined),
      listChatMessages: vi.fn(async () => []),
      deleteMessage: vi.fn(async (o: { chatId: string; messageId: string }) => {
        deletes.push(o);
        return true;
      }),
      downloadAttachment: vi.fn(async () => {
        throw new Error("download attachment not mocked");
      }),
    };
    return client;
  }

  it("deletes the untouched placeholder when no reply is produced (default, no failureText)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeNoReply(),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Placeholder posted, never edited → deleted on turn end.
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].text).toBe("💭 …");
    expect(client.edits).toHaveLength(0);
    expect(client.deletes).toHaveLength(1);
    expect(client.deletes[0].messageId).toBe("ph-1");
    expect(client.deletes[0].chatId).toBe("chat-u1");
  });

  it("edits the untouched placeholder to failureText when no reply is produced", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeNoReply(),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …", failureText: "⚠️ No reply generated." },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Placeholder posted, never edited into a reply → edited to failureText.
    expect(client.sends).toHaveLength(1);
    expect(client.edits).toHaveLength(1);
    expect(client.edits[0].messageId).toBe("ph-1");
    expect(client.edits[0].text).toBe("⚠️ No reply generated.");
    expect(client.deletes).toHaveLength(0);
  });

  it("falls back to deleting the placeholder when failureText edit fails", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1", editFails: true });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeNoReply(),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …", failureText: "⚠️ No reply generated." },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // failureText edit rejected → fallback delete so no stray placeholder.
    expect(client.edits).toHaveLength(1);
    expect(client.deletes).toHaveLength(1);
    expect(client.deletes[0].messageId).toBe("ph-1");
  });

  it("does not clean up when a reply was produced (placeholder consumed)", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeWithReply("the reply"),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …", failureText: "⚠️ No reply generated." },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Reply produced → placeholder edited into the reply; no cleanup delete.
    expect(client.edits).toHaveLength(1);
    expect(client.edits[0].text).toBe("the reply");
    expect(client.deletes).toHaveLength(0);
  });

  it("cleans up the placeholder even when inbound.run throws", async () => {
    const runtime = mockRuntimeNoReply();
    // Make inbound.run throw after resolving the turn.
    (runtime.channel.inbound as unknown as { run: unknown }).run = vi.fn(async () => {
      throw new Error("agent turn crashed");
    });
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await expect(
      dispatchCliqInbound({
        runtime,
        cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
        account: account({
          thinking: { mode: "placeholder", text: "💭 …" },
          refreshToken: "rt",
          blockStreaming: false,
        }),
        parsed: parsed!,
        client,
      }),
    ).rejects.toThrow("agent turn crashed");
    // The throw propagated, but the finally still deleted the stray placeholder.
    expect(client.deletes).toHaveLength(1);
    expect(client.deletes[0].messageId).toBe("ph-1");
  });

  it("resolves the group chat id lazily before cleaning up a channel placeholder", async () => {
    const client = makeMockClient({ channelChatId: "CT_dev_team" });
    const parsed = parseCliqWebhookPayload(groupPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeNoReply(),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "placeholder", text: "💭 …" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Group send response carries no chatId → resolved lazily for the cleanup.
    expect(client.resolveChannelChatId).toHaveBeenCalled();
    expect(client.deletes).toHaveLength(1);
    expect(client.deletes[0].chatId).toBe("CT_dev_team");
    expect(client.deletes[0].messageId).toBe("ph-1");
  });

  it("card mode: deletes the untouched status card when no reply is produced", async () => {
    const client = makeMockClient({ placeholderChatId: "chat-u1" });
    const parsed = parseCliqWebhookPayload(dmPayload());
    await dispatchCliqInbound({
      runtime: mockRuntimeNoReply(),
      cfg: { channels: { cliq: { clientId: "c", clientSecret: "s", botId: "b" } } } as never,
      account: account({
        thinking: { mode: "card", text: "Generating…" },
        refreshToken: "rt",
        blockStreaming: false,
      }),
      parsed: parsed!,
      client,
    });
    // Card posted (with the "thinking" phase title), transitioned to the
    // "generating" phase title, never edited into a reply → deleted on turn end.
    expect(client.cardSends).toHaveLength(1);
    expect(client.edits).toHaveLength(1);
    expect(client.edits[0].text).toBe("Generating…");
    expect(client.deletes).toHaveLength(1);
    expect(client.deletes[0].messageId).toBe("card-1");
    expect(client.deletes[0].chatId).toBe("chat-u1");
  });
});

describe("parseCliqWebhookPayload — pairing approval sentinel (Phase 3, sub-part b)", () => {
  it("parses an approve sentinel + code into pairingAction", () => {
    const parsed = parseCliqWebhookPayload(
      dmPayload({ message: "__cliq_pairing_approve__ ABC123" }),
    )!;
    expect(parsed.pairingAction).toEqual({ kind: "approve", code: "ABC123" });
    // text stripped of the sentinel + code
    expect(parsed.text).toBe("");
  });
  it("parses a deny sentinel + code into pairingAction", () => {
    const parsed = parseCliqWebhookPayload(
      dmPayload({ message: "__cliq_pairing_deny__ XYZ" }),
    )!;
    expect(parsed.pairingAction).toEqual({ kind: "deny", code: "XYZ" });
  });
  it("uppercases the recovered code", () => {
    const parsed = parseCliqWebhookPayload(
      dmPayload({ message: "__cliq_pairing_approve__ abc" }),
    )!;
    expect(parsed.pairingAction?.code).toBe("ABC");
  });
  it("leaves pairingAction undefined for an ordinary message", () => {
    const parsed = parseCliqWebhookPayload(dmPayload({ message: "hello" }))!;
    expect(parsed.pairingAction).toBeUndefined();
  });
  it("a pairing sentinel does not collide with the confirm sentinel", () => {
    const parsed = parseCliqWebhookPayload(
      dmPayload({ message: "__cliq_pairing_approve__ CODE1" }),
    )!;
    expect(parsed.confirmAction).toBeUndefined();
    expect(parsed.pairingAction?.kind).toBe("approve");
  });
});
