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

  it("matches a unique sender, text, and source time using parsed timestamps", async () => {
    const client = clientWith([
      { ...replyEntry, messageId: "m-stale", timestamp: "2026-09-06T06:45:06.530Z" },
      replyEntry,
      { ...replyEntry, messageId: "m-other-sender", senderId: "u-2" },
      { ...replyEntry, messageId: "m-other-text", text: "another reply" },
    ]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "  my reply  ",
      senderId: " u-1 ",
      sourceTimestamp: "2026-09-07T08:45:06.530+02:00",
      enabled: true,
    });
    expect(out?.replyTo).toEqual({
      messageId: "m-parent",
      text: "parent body",
      senderId: "b-1",
      senderName: "Livia",
      time: new Date(1788763506530).toISOString(),
    });
    expect(client.listChatMessages).toHaveBeenCalledOnce();
    expect(client.listChatMessages).toHaveBeenCalledWith("CT_1", { limit: 50 });
  });

  it("does not read history without a valid source timestamp", async () => {
    for (const sourceTimestamp of [
      undefined,
      "",
      "  ",
      "not-a-date",
      "syn:0123456789abcdef",
      "evt:delivery-1",
      "syn:1",
      "evt:1",
    ]) {
      const client = clientWith([replyEntry]);
      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        text: "my reply",
        senderId: "u-1",
        sourceTimestamp,
        enabled: true,
      })).toBeUndefined();
      expect(client.listChatMessages).not.toHaveBeenCalled();
    }
  });

  it("rejects a unique stale sender/text record even one millisecond away", async () => {
    for (const timestamp of [
      "2026-09-06T06:45:06.530Z",
      "2026-09-07T06:45:06.529Z",
      "2026-09-07T06:45:06.531Z",
    ]) {
      const client = clientWith([{ ...replyEntry, timestamp }]);
      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        text: "my reply",
        senderId: "u-1",
        sourceTimestamp: replyEntry.timestamp,
        enabled: true,
      })).toBeUndefined();
      expect(client.listChatMessages).toHaveBeenCalledOnce();
    }
  });

  it("rejects missing or invalid history timestamps", async () => {
    for (const timestamp of [undefined, "", "not-a-date", 0]) {
      const client = clientWith([{ ...replyEntry, timestamp }]);
      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        text: "my reply",
        senderId: "u-1",
        sourceTimestamp: replyEntry.timestamp,
        enabled: true,
      })).toBeUndefined();
      expect(client.listChatMessages).toHaveBeenCalledOnce();
    }
  });

  it("does not treat synthetic or event ids as history timestamps", async () => {
    for (const timestamp of ["syn:1", "evt:1"]) {
      const client = clientWith([{ ...replyEntry, timestamp }]);
      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        text: "my reply",
        senderId: "u-1",
        sourceTimestamp: "2001-01-01T00:00:00.000Z",
        enabled: true,
      })).toBeUndefined();
      expect(client.listChatMessages).toHaveBeenCalledOnce();
    }
  });

  it("honors recovery enabled and read guard", async () => {
    const enabledClient = clientWith([replyEntry]);
    expect(await recoverCliqInboundContextFromHistory({
      client: enabledClient as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeDefined();
    const disabledClient = clientWith([replyEntry]);
    expect(await recoverCliqInboundContextFromHistory({
      client: disabledClient as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
      allowTextMatch: false,
    })).toBeUndefined();
    expect(disabledClient.listChatMessages).not.toHaveBeenCalled();
  });

  it("matches a native id exactly without needing text or timestamps", async () => {
    const textless = {
      messageId: "m-textless",
      senderId: "u-1",
      messageType: "text",
      repliedTo: { ...replyEntry.repliedTo, content: "quoted parent" },
    };
    for (const sourceTimestamp of [undefined, "not-a-date", "2026-09-07T06:45:06.530Z"]) {
      const client = clientWith([textless]);
      const out = await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        messageId: "m-textless",
        senderId: "u-1",
        sourceTimestamp,
        allowTextMatch: false,
        enabled: true,
      });
      expect(out?.replyTo?.text).toBe("quoted parent");
      expect(client.listChatMessages).toHaveBeenCalledOnce();
    }
  });

  it("matches only one native record and rejects ambiguity", async () => {
    const duplicate = {
      ...replyEntry,
      text: "duplicate text",
      repliedTo: { ...replyEntry.repliedTo, content: "other parent" },
    };
    const client = clientWith([replyEntry, duplicate]);
    expect(await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      messageId: "no-such-id",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    const dupeClient = clientWith([duplicate, duplicate]);
    expect(await recoverCliqInboundContextFromHistory({
      client: dupeClient as never,
      chatId: "CT_1",
      messageId: duplicate.messageId,
      text: "duplicate text",
      senderId: "u-1",
      sourceTimestamp: duplicate.timestamp,
      enabled: true,
    })).toBeUndefined();
  });

  it("never falls back from a supplied native id to text", async () => {
    const differentReply = {
      messageId: "m-other",
      text: "my reply",
      senderId: "u-1",
      timestamp: "2026-09-07T06:45:06.530Z",
      messageType: "text",
      repliedTo: { ...replyEntry.repliedTo, content: "wrong parent" },
    };
    const client = clientWith([differentReply]);
    expect(await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      messageId: "m-missing",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    expect(client.listChatMessages).toHaveBeenCalledOnce();
  });

  it("rejects mismatched native sender", async () => {
    const client = clientWith([{ ...replyEntry, senderId: "u-other" }]);
    expect(await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      messageId: "m-live",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
  });

  it("treats synthetic and event ids as missing ids rather than native matches", async () => {
    for (const synthetic of ["syn:0123456789abcdef", "evt:delivery-1"]) {
      const client = clientWith([{ ...replyEntry, messageId: synthetic }]);
      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        messageId: synthetic,
        text: "my reply",
        senderId: "u-1",
        enabled: true,
      })).toBeUndefined();
      expect(client.listChatMessages).not.toHaveBeenCalled();

      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        messageId: synthetic,
        text: "my reply",
        senderId: "u-1",
        sourceTimestamp: "2026-09-07T06:45:06.531Z",
        enabled: true,
      })).toBeUndefined();
      expect(client.listChatMessages).toHaveBeenCalledOnce();

      expect(await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        messageId: synthetic,
        text: "my reply",
        senderId: "u-1",
        sourceTimestamp: replyEntry.timestamp,
        enabled: true,
      })).toEqual({ replyTo: {
        messageId: "m-parent",
        text: "parent body",
        senderId: "b-1",
        senderName: "Livia",
        time: new Date(1788763506530).toISOString(),
      } });
      expect(client.listChatMessages).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects duplicates when two equal-time matches exist", async () => {
    const duplicate = {
      ...replyEntry,
      messageId: "m-second",
      timestamp: "2026-09-07T08:45:06.530+02:00",
    };
    const client = clientWith([replyEntry, duplicate]);
    expect(await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    expect(client.listChatMessages).toHaveBeenCalledOnce();
  });

  it("requires chat id and handles an empty id search without reading", async () => {
    const client = clientWith([replyEntry]);
    expect(await recoverCliqInboundContextFromHistory({
      client: client as never,
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("does not text-match missing sender, wrong sender, duplicates or mention-only text", async () => {
    const duplicate = { ...replyEntry, messageId: "m-second" };
    const duplicateClient = clientWith([replyEntry, duplicate]);
    expect(await recoverCliqInboundContextFromHistory({
      client: duplicateClient as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    expect(duplicateClient.listChatMessages).toHaveBeenCalledOnce();

    const missingSenderClient = clientWith([replyEntry]);
    expect(await recoverCliqInboundContextFromHistory({
      client: missingSenderClient as never,
      chatId: "CT_1",
      text: "my reply",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    expect(missingSenderClient.listChatMessages).not.toHaveBeenCalled();

    const wrongSenderClient = clientWith([replyEntry]);
    expect(await recoverCliqInboundContextFromHistory({
      client: wrongSenderClient as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-other",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    })).toBeUndefined();
    expect(wrongSenderClient.listChatMessages).toHaveBeenCalledOnce();

    for (const emptyText of ["   ", "@Zora", "@Zora @Livia"]) {
      const mentionClient = clientWith([{ ...replyEntry, text: emptyText }]);
      expect(await recoverCliqInboundContextFromHistory({
        client: mentionClient as never,
        chatId: "CT_1",
        text: emptyText,
        senderId: "u-1",
        sourceTimestamp: replyEntry.timestamp,
        enabled: true,
      })).toBeUndefined();
      expect(mentionClient.listChatMessages).not.toHaveBeenCalled();
    }
  });

  it("recovers nonempty mixed mention text from one sender record", async () => {
    const client = clientWith([{ ...replyEntry, text: "@Zora please" }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "@Zora please",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out?.replyTo?.text).toBe("parent body");
  });

  it("respects allowTextMatch false", async () => {
    const client = clientWith([replyEntry]);
    expect(await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
      allowTextMatch: false,
    })).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("recovers forward context from the same single lookup", async () => {
    const client = clientWith([{
      messageId: "m-fwd",
      text: "forwarded body",
      senderId: "u-1",
      timestamp: "2026-09-07T06:45:06.530Z",
      messageType: "forwarded",
      forwardInfo: { sender: "111111111", dname: "Original Author", time: "1788704063087" },
    }]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "forwarded body",
      senderId: "u-1",
      sourceTimestamp: "2026-09-07T06:45:06.530Z",
      enabled: true,
    });
    expect(out?.forward?.senderName).toBe("Original Author");
  });

  it("recovers a forward by native id with mismatched text", async () => {
    const forwardEntry = {
      messageId: "m-forwarded",
      text: "live-not-forward-text",
      senderId: "u-1",
      messageType: "forwarded",
      forwardInfo: { sender: "111111111", dname: "Original Author", time: "1788704063087" },
    };
    const client = clientWith([forwardEntry]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      messageId: "m-forwarded",
      text: "different body",
      senderId: "u-1",
      enabled: true,
    });
    expect(out?.forward?.senderName).toBe("Original Author");
  });

  it("returns nothing for a native id without reply or forward", async () => {
    const client = clientWith([
      { messageId: "m-plain", text: "", senderId: "u-1", messageType: "text" },
    ]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      messageId: "m-plain",
      senderId: "u-1",
      enabled: true,
    });
    expect(out).toBeUndefined();
  });

  it("performs no read at all when the feature is disabled", async () => {
    const client = clientWith([replyEntry]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "my reply",
      senderId: "u-1",
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
      senderId: "u-1",
      sourceTimestamp: replyEntry.timestamp,
      enabled: true,
    });
    expect(out).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("degrades to no context when the history read fails", async () => {
    const client = { listChatMessages: vi.fn().mockRejectedValue(new Error("boom")) };
    const onError = vi.fn();
    for (const params of [
      { messageId: "m-live", senderId: "u-1" },
      { text: "my reply", senderId: "u-1", sourceTimestamp: replyEntry.timestamp },
    ]) {
      const out = await recoverCliqInboundContextFromHistory({
        client: client as never,
        chatId: "CT_1",
        enabled: true,
        onError,
        ...params,
      });
      expect(out).toBeUndefined();
    }
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { kind: "inbound-context-recovery" });
  });

  it("returns nothing for an ordinary message with neither reply nor forward", async () => {
    const client = clientWith([
      {
        messageId: "m-plain",
        text: "just text",
        senderId: "u-1",
        timestamp: "2026-09-07T06:45:06.530Z",
        messageType: "text",
      },
    ]);
    const out = await recoverCliqInboundContextFromHistory({
      client: client as never,
      chatId: "CT_1",
      text: "just text",
      senderId: "u-1",
      sourceTimestamp: "2026-09-07T06:45:06.530Z",
      enabled: true,
    });
    expect(out).toBeUndefined();
    expect(client.listChatMessages).toHaveBeenCalledOnce();
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
