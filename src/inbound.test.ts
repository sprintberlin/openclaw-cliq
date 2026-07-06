import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
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
    const edits: { chatId: string; messageId: string; text: string }[] = [];
    const deletes: { chatId: string; messageId: string }[] = [];
    const client = {
      sends,
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
});
