import { describe, expect, it, vi } from "vitest";
import {
  formatCliqForwardBlock,
  hasCliqForwardMarker,
  parseCliqForwardContext,
  resolveCliqForwardContext,
} from "./inbound-forward.js";

describe("parseCliqForwardContext", () => {
  it("returns undefined when no forward fields are present", () => {
    expect(parseCliqForwardContext({ message: "hi", user: { id: "u1" } })).toBeUndefined();
    expect(parseCliqForwardContext(null)).toBeUndefined();
    expect(parseCliqForwardContext("nope")).toBeUndefined();
    expect(parseCliqForwardContext([1, 2])).toBeUndefined();
  });

  it("parses a root-level forwarded_message object", () => {
    const out = parseCliqForwardContext({
      message: "",
      forwarded_message: {
        id: "m-orig",
        text: "Hi Gregor\nHier nochmal etwas für die Wand",
        time: "22 Juli 2026, 10:58 AM",
        sender: { id: "u-seb", name: "Sebastian" },
      },
    });
    expect(out).toEqual({
      text: "Hi Gregor\nHier nochmal etwas für die Wand",
      senderName: "Sebastian",
      senderId: "u-seb",
      time: "22 Juli 2026, 10:58 AM",
      messageId: "m-orig",
      sourceTitle: undefined,
    });
  });

  it("parses the forward nested under message", () => {
    const out = parseCliqForwardContext({
      message: { text: "", forwarded: { text: "original body", sender: { name: "Ada" } } },
    });
    expect(out?.text).toBe("original body");
    expect(out?.senderName).toBe("Ada");
  });

  it("unwraps the params-wrapped shape", () => {
    const out = parseCliqForwardContext({
      params: { forwarded_message: { text: "wrapped body", sender: { name: "Bob" } } },
    });
    expect(out?.text).toBe("wrapped body");
    expect(out?.senderName).toBe("Bob");
  });

  it("accepts a bare string forward body", () => {
    expect(parseCliqForwardContext({ forwarded: "just the text" })?.text).toBe("just the text");
  });

  it("joins first_name + last_name for the original author", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { text: "x", sender: { first_name: "Scott", last_name: "Fisher" } },
    });
    expect(out?.senderName).toBe("Scott Fisher");
  });

  it("reads content.text and content.comment variants", () => {
    expect(
      parseCliqForwardContext({ forwarded_message: { content: { text: "via content.text" } } })?.text,
    ).toBe("via content.text");
    expect(
      parseCliqForwardContext({ forwarded_message: { content: { comment: "via comment" } } })?.text,
    ).toBe("via comment");
  });

  it("carries the originating chat title when present", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { text: "x", chat: { title: "#sales" } },
    });
    expect(out?.sourceTitle).toBe("#sales");
  });

  it("merges a sparse and a rich source first-wins", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { text: "body only" },
      original_message: { text: "ignored", sender: { name: "Cara" }, time: "t1" },
    });
    expect(out?.text).toBe("body only");
    expect(out?.senderName).toBe("Cara");
    expect(out?.time).toBe("t1");
  });

  it("ignores an empty marker object that carries neither text nor author", () => {
    expect(parseCliqForwardContext({ forwarded_message: {} })).toBeUndefined();
    expect(parseCliqForwardContext({ forwarded_message: { chat: { title: "#x" } } })).toBeUndefined();
  });
});

describe("hasCliqForwardMarker", () => {
  it("detects a boolean marker at the root and under message", () => {
    expect(hasCliqForwardMarker({ is_forwarded: true })).toBe(true);
    expect(hasCliqForwardMarker({ message: { isForwarded: true } })).toBe(true);
  });

  it("detects an empty forward object the parser cannot use", () => {
    expect(hasCliqForwardMarker({ forwarded_message: {} })).toBe(true);
    expect(parseCliqForwardContext({ forwarded_message: {} })).toBeUndefined();
  });

  it("detects a params-wrapped marker", () => {
    expect(hasCliqForwardMarker({ params: { forwarded_message: {} } })).toBe(true);
  });

  it("is false for an ordinary message", () => {
    expect(hasCliqForwardMarker({ message: "hi", user: { id: "u" } })).toBe(false);
    expect(hasCliqForwardMarker(null)).toBe(false);
  });
});

describe("parseCliqForwardContext with Cliq's real forward_info shape", () => {
  // Field shape verified live 2026-09-06 against
  // GET /api/v2/chats/{chatId}/messages (3 forwards in a 72-message window):
  // sender is the ORIGINAL author's user id as a STRING, dname the display
  // name, msguid the original message id, time epoch milliseconds as a string.
  const realForwardInfo = {
    sender: "929484733",
    dname: "Sebastian",
    chid: "1424577094875623543",
    msguid: "1788704063087311235313263",
    time: "1788704063087",
  };

  it("parses forward_info with a string sender (regression: used to return undefined)", () => {
    const out = parseCliqForwardContext({ forwarded_message: realForwardInfo });
    expect(out).toBeDefined();
    expect(out?.senderName).toBe("Sebastian");
    expect(out?.senderId).toBe("929484733");
    expect(out?.messageId).toBe("1788704063087311235313263");
    expect(out?.sourceChatId).toBe("1424577094875623543");
  });

  it("normalizes epoch-millisecond time to ISO-8601", () => {
    const out = parseCliqForwardContext({ forwarded_message: realForwardInfo });
    expect(out?.time).toBe(new Date(1788704063087).toISOString());
  });

  it("keeps a non-epoch time string as-is", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { dname: "Ada", time: "22 Juli 2026, 10:58 AM" },
    });
    expect(out?.time).toBe("22 Juli 2026, 10:58 AM");
  });

  it("drops an implausible epoch rather than rendering a bogus date", () => {
    const out = parseCliqForwardContext({ forwarded_message: { dname: "Ada", time: "1" } });
    expect(out?.time).toBeUndefined();
  });

  it("still parses the object sender form a hand-assembled handler may send", () => {
    const out = parseCliqForwardContext({
      forwarded_message: { sender: { id: "u9", name: "Cara" }, text: "hi" },
    });
    expect(out?.senderId).toBe("u9");
    expect(out?.senderName).toBe("Cara");
  });

  it("does not treat the source chat id as a display title", () => {
    const out = parseCliqForwardContext({ forwarded_message: realForwardInfo });
    expect(out?.sourceTitle).toBeUndefined();
    expect(formatCliqForwardBlock(out!)).not.toContain("1424577094875623543");
  });
});

describe("resolveCliqForwardContext", () => {
  const forwardEntry = {
    messageId: "m-live",
    text: "forwarded body",
    messageType: "forwarded",
    forwardInfo: { sender: "111111111", dname: "Original Author", time: "1788704063087" },
  };
  const clientWith = (messages: unknown[]) => ({
    listChatMessages: vi.fn().mockResolvedValue(messages as never),
  });

  it("recovers attribution by native message id when the handler sent nothing", async () => {
    const client = clientWith([forwardEntry]);
    const out = await resolveCliqForwardContext(undefined, {
      client: client as never,
      chatId: "CT_1",
      messageId: "m-live",
      text: "forwarded body",
      canReadChatMessages: true,
    });
    expect(out?.senderName).toBe("Original Author");
    expect(out?.senderId).toBe("111111111");
  });

  it("falls back to a unique exact text match when no id is available", async () => {
    const client = clientWith([forwardEntry]);
    const out = await resolveCliqForwardContext(undefined, {
      client: client as never,
      chatId: "CT_1",
      text: "forwarded body",
      canReadChatMessages: true,
    });
    expect(out?.senderName).toBe("Original Author");
  });

  it("refuses to guess when the same forwarded text appears twice", async () => {
    const client = clientWith([
      forwardEntry,
      { ...forwardEntry, messageId: "m-other", forwardInfo: { dname: "Someone Else" } },
    ]);
    const out = await resolveCliqForwardContext(undefined, {
      client: client as never,
      chatId: "CT_1",
      text: "forwarded body",
      canReadChatMessages: true,
    });
    expect(out).toBeUndefined();
  });

  it("never overrides attribution the handler already delivered", async () => {
    const client = clientWith([forwardEntry]);
    const out = await resolveCliqForwardContext(
      { senderName: "From Handler" },
      {
        client: client as never,
        chatId: "CT_1",
        messageId: "m-live",
        canReadChatMessages: true,
      },
    );
    expect(out?.senderName).toBe("From Handler");
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("skips the read when no refresh token grants the user-context scope", async () => {
    const client = clientWith([forwardEntry]);
    const out = await resolveCliqForwardContext(undefined, {
      client: client as never,
      chatId: "CT_1",
      messageId: "m-live",
      canReadChatMessages: false,
    });
    expect(out).toBeUndefined();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("ignores non-forwarded history entries", async () => {
    const client = clientWith([
      { messageId: "m-live", text: "forwarded body", messageType: "text" },
    ]);
    const out = await resolveCliqForwardContext(undefined, {
      client: client as never,
      chatId: "CT_1",
      messageId: "m-live",
      text: "forwarded body",
      canReadChatMessages: true,
    });
    expect(out).toBeUndefined();
  });

  it("degrades to no attribution when the history read fails", async () => {
    const client = { listChatMessages: vi.fn().mockRejectedValue(new Error("boom")) };
    const onError = vi.fn();
    const out = await resolveCliqForwardContext(undefined, {
      client: client as never,
      chatId: "CT_1",
      messageId: "m-live",
      canReadChatMessages: true,
      onError,
    });
    expect(out).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { kind: "inbound-forward-fetch" });
  });
});

describe("formatCliqForwardBlock", () => {
  it("renders author, source, time and quoted body", () => {
    const block = formatCliqForwardBlock({
      text: "line one\nline two",
      senderName: "Sebastian",
      sourceTitle: "#sales",
      time: "22 Juli 2026, 10:58 AM",
    });
    expect(block).toBe(
      "⤷ Forwarded message from Sebastian in #sales (22 Juli 2026, 10:58 AM):\n> line one\n> line two",
    );
  });

  it("renders a header-only block when the body was promoted to the turn text", () => {
    expect(formatCliqForwardBlock({ senderName: "Ada" })).toBe("⤷ Forwarded message from Ada:");
  });

  it("degrades to a bare header when nothing but text is known", () => {
    expect(formatCliqForwardBlock({ text: "body" })).toBe("⤷ Forwarded message:\n> body");
  });

  it("truncates a very long forwarded body", () => {
    const block = formatCliqForwardBlock({ text: "x".repeat(2500) });
    expect(block.endsWith("…")).toBe(true);
    expect(block.length).toBeLessThan(2200);
  });
});
