import { describe, it, expect, vi } from "vitest";
import {
  parseCliqReplyToContext,
  resolveCliqReplyToContext,
  recoverCliqInboundContextFromHistory,
  mergeCliqReplyToContexts,
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
      timestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out?.replyTo?.text).toBe("parent body");
    expect(out?.replyTo?.senderName).toBe("Livia");
  });

  it("does not guess when two recent messages normalize to the same text", async () => {
    const other = {
      ...replyEntry,
      messageId: "m-other",
      text: "my   reply",
      timestamp: "2026-09-07T06:45:05.530Z",
      repliedTo: { ...replyEntry.repliedTo, content: "other parent" },
    };
    const out = await recoverCliqInboundContextFromHistory({
      client: clientWith([replyEntry, other]) as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("uses a native message id to disambiguate identical texts", async () => {
    const other = { ...replyEntry, messageId: "m-other" };
    const out = await recoverCliqInboundContextFromHistory({
      client: clientWith([replyEntry, other]) as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      messageId: "m-live",
      enabled: true,
    });
    expect(out?.replyTo?.text).toBe("parent body");
  });

  it.each(["evt:m-live", "syn:m-live"])('does not treat %s as a native id', async (messageId) => {
    const other = { ...replyEntry, messageId: "m-other" };
    const out = await recoverCliqInboundContextFromHistory({
      client: clientWith([replyEntry, other]) as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      messageId,
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("rejects an old text-only match even when it is unique", async () => {
    const out = await recoverCliqInboundContextFromHistory({
      client: clientWith([replyEntry]) as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      timestamp: "2026-09-07T07:00:00.000Z",
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it.each([
    { ...replyEntry, senderId: undefined },
    { ...replyEntry, timestamp: undefined },
    { ...replyEntry, timestamp: "invalid" },
  ])("rejects text-only matches without a valid sender or timestamp", async (entry) => {
    const out = await recoverCliqInboundContextFromHistory({
      client: clientWith([entry]) as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("does not recover a text-only match without an inbound timestamp", async () => {
    const out = await recoverCliqInboundContextFromHistory({
      client: clientWith([replyEntry]) as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("does not match another user's identical text", async () => {
    const client = clientWith([{ ...replyEntry, senderId: "someone-else" }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("recovers forward context from the same single lookup", async () => {
    const client = clientWith([{
      messageId: "m-fwd",
      text: "forwarded body",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      messageType: "forwarded",
      forwardInfo: { sender: "111111111", dname: "Original Author", time: "1788704063087" },
    }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "forwarded body",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
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
      { messageId: "m-plain", text: "just text", senderId: "u-1", timestamp: replyEntry.timestamp, messageType: "text" },
    ]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "just text",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("collapses whitespace on both sides by default (multi-line history record)", async () => {
    const client = clientWith([{ ...replyEntry, text: "my\n  reply" }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "  my   reply ",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out?.replyTo?.text).toBe("parent body");
  });

  it("matches a history record that still carries the bot mention via normalizeText", async () => {
    const client = clientWith([{ ...replyEntry, text: "@Bot my reply" }]);
    const stripBotMention = (t: string) =>
      t.replace(/@Bot\s*/gi, "").replace(/\s+/g, " ").trim();
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      timestamp: replyEntry.timestamp,
      enabled: true,
      normalizeText: stripBotMention,
    });
    expect(out?.replyTo?.text).toBe("parent body");
  });

  it("performs no read when normalization empties the live text", async () => {
    const client = clientWith([replyEntry]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "@Bot",
      enabled: true,
      normalizeText: (t) => t.replace(/@Bot/gi, ""),
    });
    expect(out).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });
});

describe("mergeCliqReplyToContexts", () => {
  it("fills missing fields when both references identify the same parent", () => {
    expect(mergeCliqReplyToContexts(
      { messageId: "parent-1" },
      { messageId: "parent-1", text: "parent body", senderName: "Bot", senderId: "bot", time: "2026-11-10T20:00:00.000Z" },
    )).toEqual({
      messageId: "parent-1", text: "parent body", senderName: "Bot", senderId: "bot", time: "2026-11-10T20:00:00.000Z",
    });
  });

  it("keeps explicit handler fields when the parent IDs agree", () => {
    expect(mergeCliqReplyToContexts(
      { messageId: "p1", text: "handler text", senderName: "Handler" },
      { messageId: "p1", text: "recovered text", senderName: "Recovered", senderId: "r-1" },
    )).toEqual({ messageId: "p1", text: "handler text", senderName: "Handler", senderId: "r-1", time: undefined });
  });

  it.each([
    [{ messageId: "handler-id" }, { messageId: "other-id", text: "other parent" }],
    [{ messageId: "handler-id" }, { text: "unidentified parent" }],
    [{ text: "handler text" }, { messageId: "other-id", text: "other parent" }],
    [{ messageId: "evt:synthetic" }, { messageId: "parent-id", text: "other parent" }],
  ])("does not merge references with different or missing parent IDs", (handler, recovered) => {
    expect(mergeCliqReplyToContexts(handler, recovered)).toEqual(handler);
  });

  it("returns the only present side", () => {
    expect(mergeCliqReplyToContexts(undefined, { messageId: "r1" })).toEqual({ messageId: "r1" });
    expect(mergeCliqReplyToContexts({ messageId: "h1" }, undefined)).toEqual({ messageId: "h1" });
    expect(mergeCliqReplyToContexts(undefined, undefined)).toBeUndefined();
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
