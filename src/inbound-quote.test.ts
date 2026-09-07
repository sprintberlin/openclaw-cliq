import { describe, it, expect, vi } from "vitest";
import {
  parseCliqReplyToContext,
  resolveCliqReplyToContext,
  recoverCliqInboundContextFromHistory,
  formatCliqReplyToBlock,
  type CliqReplyToContext,
} from "./inbound-quote.js";

describe("parseCliqReplyToContext with Cliq's real replied_to shape", () => {
  // Shape verified live 2026-09-07 against GET /api/v2/chats/{chatId}/messages
  // on a genuine reply in the bot DM:
  //   replied_to: { id, content, time: <epoch ms NUMBER>, type, sender: {id,name} }
  const realRepliedTo = {
    id: "1788763506530354244429666",
    content: "parent body text",
    time: 1788763506530,
    type: "text",
    sender: { id: "b-2500338000009392001", name: "Livia" },
  };

  it("parses replied_to (regression: the key was never recognized)", () => {
    const out = parseCliqReplyToContext({ replied_to: realRepliedTo });
    expect(out).toBeDefined();
    expect(out?.messageId).toBe("1788763506530354244429666");
    expect(out?.text).toBe("parent body text");
    expect(out?.senderName).toBe("Livia");
    expect(out?.senderId).toBe("b-2500338000009392001");
  });

  it("normalizes the numeric epoch-ms time to ISO-8601", () => {
    const out = parseCliqReplyToContext({ replied_to: realRepliedTo });
    expect(out?.time).toBe(new Date(1788763506530).toISOString());
  });

  it("drops an implausible numeric time instead of rendering a bogus date", () => {
    const out = parseCliqReplyToContext({ replied_to: { content: "x", time: 5 } });
    expect(out?.time).toBeUndefined();
  });

  it("keeps an already-formatted time string as-is", () => {
    const out = parseCliqReplyToContext({
      replied_to: { content: "x", time: "22 Juli 2026, 10:58 AM" },
    });
    expect(out?.time).toBe("22 Juli 2026, 10:58 AM");
  });
});

describe("recoverCliqInboundContextFromHistory", () => {
  const replyEntry = {
    messageId: "m-live",
    text: "my reply",
    senderId: "u-1",
    timestamp: "2026-09-07T06:45:06.530Z",
    messageType: "text",
    repliedTo: {
      id: "m-parent",
      content: "parent body",
      time: 1788763506530,
      sender: { id: "b-1", name: "Livia" },
    },
  };
  const clientWith = (messages: unknown[]) => ({
    listChatMessages: vi.fn().mockResolvedValue(messages as never),
  });

  it("recovers reply context the handler never delivered", async () => {
    const client = clientWith([replyEntry]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      enabled: true,
    });
    expect(out?.replyTo?.text).toBe("parent body");
    expect(out?.replyTo?.senderName).toBe("Livia");
  });

  it("picks the newest match when the same text was sent twice", async () => {
    const older = {
      ...replyEntry,
      messageId: "m-old",
      timestamp: "2026-09-07T05:00:00.000Z",
      repliedTo: { ...replyEntry.repliedTo, content: "older parent" },
    };
    // Deliberately unordered: recency must not depend on list order.
    const client = clientWith([replyEntry, older]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      enabled: true,
    });
    expect(out?.replyTo?.text).toBe("parent body");
  });

  it("does not match another user's identical text", async () => {
    const client = clientWith([{ ...replyEntry, senderId: "someone-else" }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("recovers forward context from the same single lookup", async () => {
    const client = clientWith([{
      messageId: "m-fwd",
      text: "forwarded body",
      senderId: "u-1",
      messageType: "forwarded",
      forwardInfo: { sender: "111111111", dname: "Original Author", time: "1788704063087" },
    }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "forwarded body",
      senderId: "u-1",
      enabled: true,
    });
    expect(out?.forward?.senderName).toBe("Original Author");
  });

  it("performs no read at all when the feature is disabled", async () => {
    const client = clientWith([replyEntry]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      enabled: false,
    });
    expect(out).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("skips an empty body that cannot be matched", async () => {
    const client = clientWith([replyEntry]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "   ",
      enabled: true,
    });
    expect(out).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("degrades to no context when the history read fails", async () => {
    const client = { listChatMessages: vi.fn().mockRejectedValue(new Error("boom")) };
    const onError = vi.fn();
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      enabled: true,
      onError,
    });
    expect(out).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { kind: "inbound-context-recovery" });
  });

  it("returns nothing for an ordinary message with neither reply nor forward", async () => {
    const client = clientWith([
      { messageId: "m-plain", text: "just text", senderId: "u-1", messageType: "text" },
    ]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "just text",
      senderId: "u-1",
      enabled: true,
    });
    expect(out).toBeUndefined();
  });
});

describe("parseCliqReplyToContext", () => {
  it("returns undefined when no reply-to fields are present", () => {
    expect(parseCliqReplyToContext({ message: { text: "hi" } })).toBeUndefined();
    expect(parseCliqReplyToContext({})).toBeUndefined();
    expect(parseCliqReplyToContext(null)).toBeUndefined();
    expect(parseCliqReplyToContext("x")).toBeUndefined();
  });

  it("parses message.reply_to as a string id", () => {
    expect(
      parseCliqReplyToContext({ message: { text: "ok", reply_to: "msg_123" } }),
    ).toEqual({ messageId: "msg_123" });
  });

  it("parses message.reply_to as a parent object", () => {
    expect(
      parseCliqReplyToContext({
        message: {
          text: "agreed",
          reply_to: {
            id: "msg_456",
            text: "Let's ship it",
            sender: { id: "u-1", name: "Alice" },
            time: "2026-07-04T10:00:00Z",
          },
        },
      }),
    ).toEqual({
      messageId: "msg_456",
      text: "Let's ship it",
      senderId: "u-1",
      senderName: "Alice",
      time: "2026-07-04T10:00:00Z",
    });
  });

  it("parses root-level parent / quoted variants", () => {
    expect(
      parseCliqReplyToContext({
        message: { text: "yes" },
        parent: { id: "p1", text: "parent text" },
      }),
    ).toEqual({ messageId: "p1", text: "parent text" });
    expect(
      parseCliqReplyToContext({
        message: { text: "yes" },
        quoted_message: { id: "q1", text: "quote", sender: { id: "s1" } },
      }),
    ).toEqual({ messageId: "q1", text: "quote", senderId: "s1" });
  });

  it("parses parent / quoted variants nested under message (issue #230)", () => {
    expect(
      parseCliqReplyToContext({
        message: {
          text: "yes",
          parent_message: { id: "pm1", text: "nested parent msg" },
        },
      }),
    ).toEqual({ messageId: "pm1", text: "nested parent msg" });
  });

  it("prefers message.reply_to over root variants", () => {
    expect(
      parseCliqReplyToContext({
        message: { text: "yes", reply_to: "inner-id" },
        parent: { id: "root-id" },
      }),
    ).toEqual({ messageId: "inner-id" });
  });

  it("unwraps params-wrapped payloads", () => {
    expect(
      parseCliqReplyToContext({
        params: { message: { text: "yes", reply_to: "wrapped-id" } },
      }),
    ).toEqual({ messageId: "wrapped-id" });
  });

  it("joins first_name + last_name for senderName", () => {
    expect(
      parseCliqReplyToContext({
        message: {
          text: "yes",
          reply_to: {
            id: "m1",
            sender: { first_name: "Scott", last_name: "Fisher" },
          },
        },
      }),
    ).toEqual({
      messageId: "m1",
      senderName: "Scott Fisher",
    });
  });

  it("falls back to content when text is absent", () => {
    expect(
      parseCliqReplyToContext({
        quoted: { id: "q2", content: "caption text" },
      }),
    ).toEqual({ messageId: "q2", text: "caption text" });
  });

  it("returns undefined when parent object has no id or text", () => {
    expect(
      parseCliqReplyToContext({ parent: { sender: { id: "u1" } } }),
    ).toBeUndefined();
  });

  it("returns messageId-only for a bare string reply_to at root", () => {
    expect(
      parseCliqReplyToContext({ message: { text: "yes" }, reply_to: "root-str-id" }),
    ).toEqual({ messageId: "root-str-id" });
  });
});

describe("resolveCliqReplyToContext", () => {
  function makeClient(messages: { messageId: string; chatId?: string; text?: string }[]) {
    return {
      listChatMessages: vi.fn(async () => messages),
    };
  }

  it("returns undefined unchanged", async () => {
    const client = makeClient([]);
    expect(await resolveCliqReplyToContext(undefined, { client, canReadChatMessages: true, chatId: "CT_1" }))
      .toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("skips fetch when text already present", async () => {
    const client = makeClient([]);
    const replyTo: CliqReplyToContext = { messageId: "m1", text: "have text" };
    const out = await resolveCliqReplyToContext(replyTo, {
      client,
      chatId: "CT_1",
      canReadChatMessages: true,
    });
    expect(out).toBe(replyTo);
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("skips fetch when canReadChatMessages is false (no refresh token)", async () => {
    const client = makeClient([{ messageId: "m1", text: "found" }]);
    const replyTo: CliqReplyToContext = { messageId: "m1" };
    const out = await resolveCliqReplyToContext(replyTo, {
      client,
      chatId: "CT_1",
      canReadChatMessages: false,
    });
    expect(out).toEqual({ messageId: "m1" });
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("skips fetch when no chatId is available", async () => {
    const client = makeClient([{ messageId: "m1", text: "found" }]);
    const replyTo: CliqReplyToContext = { messageId: "m1" };
    const out = await resolveCliqReplyToContext(replyTo, {
      client,
      chatId: "",
      canReadChatMessages: true,
    });
    expect(out).toEqual({ messageId: "m1" });
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("enriches with text when the parent message is found in the list", async () => {
    const client = makeClient([
      { messageId: "m0", text: "other" },
      { messageId: "m1", text: "the parent text" },
    ]);
    const out = await resolveCliqReplyToContext(
      { messageId: "m1", senderName: "Bob" },
      { client, chatId: "CT_1", canReadChatMessages: true },
    );
    expect(out).toEqual({ messageId: "m1", senderName: "Bob", text: "the parent text" });
    expect(client.listChatMessages).toHaveBeenCalledWith("CT_1", { limit: 50 });
  });

  it("returns input unchanged when the message id is not found", async () => {
    const client = makeClient([{ messageId: "m0", text: "x" }]);
    const replyTo: CliqReplyToContext = { messageId: "m-missing" };
    const out = await resolveCliqReplyToContext(replyTo, {
      client,
      chatId: "CT_1",
      canReadChatMessages: true,
    });
    expect(out).toEqual({ messageId: "m-missing" });
  });

  it("swallows fetch errors and reports via onError", async () => {
    const client = {
      listChatMessages: vi.fn(async () => {
        throw new Error("api down");
      }),
    };
    const onError = vi.fn();
    const replyTo: CliqReplyToContext = { messageId: "m1" };
    const out = await resolveCliqReplyToContext(replyTo, {
      client,
      chatId: "CT_1",
      canReadChatMessages: true,
      onError,
    });
    expect(out).toEqual({ messageId: "m1" });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { kind: "reply-to-fetch" });
  });
});

describe("formatCliqReplyToBlock", () => {
  it("formats with sender name and text", () => {
    const block = formatCliqReplyToBlock({
      messageId: "m1",
      text: "Ship it",
      senderName: "Alice",
    });
    expect(block).toBe("↩ Replying to Alice:\n> Ship it");
  });

  it("falls back to 'previous message' when no sender name", () => {
    const block = formatCliqReplyToBlock({ messageId: "m1", text: "hi" });
    expect(block).toBe("↩ Replying to previous message:\n> hi");
  });

  it("indents multi-line quotes", () => {
    const block = formatCliqReplyToBlock({
      messageId: "m1",
      text: "line one\nline two",
      senderName: "Bob",
    });
    expect(block).toBe("↩ Replying to Bob:\n> line one\n> line two");
  });

  it("truncates very long quotes to 1000 chars", () => {
    const long = "x".repeat(1500);
    const block = formatCliqReplyToBlock({
      messageId: "m1",
      text: long,
      senderName: "Bob",
    });
    expect(block).toContain("…");
    // header + 1 line of indented quote
    expect(block.split("\n")).toHaveLength(2);
    expect(block.split("\n")[1].length).toBe(1001 + 2); // "> " + 1000 + "…"
  });

  it("emits header only when no text but sender present", () => {
    const block = formatCliqReplyToBlock({ messageId: "m1", senderName: "Alice" });
    expect(block).toBe("↩ Replying to Alice:");
  });
});
