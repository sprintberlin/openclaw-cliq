import { describe, it, expect, vi } from "vitest";
import {
  createLiveEditDeliver,
  getLiveEditDeliverStats,
} from "./live-edit.js";
import type { CliqClient } from "./client.js";

/** A minimal fake client recording sendMessage/editMessage calls. */
interface FakeClient {
  sends: { to: string; text: string; isDm?: boolean }[];
  edits: { chatId: string; messageId: string; text: string }[];
  sendMessage: (opts: { to: string; text: string; isDm?: boolean }) => Promise<{
    messageId?: string;
    chatId?: string;
  }>;
  editMessage: (opts: {
    chatId: string;
    messageId: string;
    text: string;
  }) => Promise<{ messageId?: string; chatId?: string }>;
}

function makeFakeClient(opts: {
  dmChatId?: string;
  editFails?: boolean;
} = {}): FakeClient & Pick<CliqClient, "sendMessage" | "editMessage"> {
  const sends: { to: string; text: string; isDm?: boolean }[] = [];
  const edits: { chatId: string; messageId: string; text: string }[] = [];
  const fake: FakeClient = {
    sends,
    edits,
    sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
      sends.push(o);
      // DM send: respond with message_details-style ref (chatId present).
      // Group send: respond with only a top-level id (no chatId).
      return o.isDm
        ? { messageId: `m${sends.length}`, chatId: opts.dmChatId ?? `chat-${o.to}` }
        : { messageId: `m${sends.length}` };
    }),
    editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
      edits.push(o);
      if (opts.editFails) throw new Error("edit rejected");
      return { messageId: o.messageId, chatId: o.chatId };
    }),
  };
  return fake;
}

describe("createLiveEditDeliver — disabled (legacy)", () => {
  it("sends each block as a separate message", async () => {
    const fake = makeFakeClient();
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: false,
    });
    await deliver({ text: "block one" });
    await deliver({ text: "block two" });
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[0].text).toBe("block one");
    expect(fake.sends[1].text).toBe("block two");
    expect(fake.edits).toHaveLength(0);
  });

  it("chunks a single reply exceeding the char limit", async () => {
    const fake = makeFakeClient();
    const long = "a".repeat(6000);
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: false,
      charLimit: 5000,
    });
    await deliver({ text: long });
    // One send call would exceed 5000 → chunked into two messages.
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[0].text.length).toBeLessThanOrEqual(5000);
    expect(fake.sends[1].text.length).toBeLessThanOrEqual(5000);
    expect(fake.sends[0].text + fake.sends[1].text).toContain("a".repeat(100));
  });

  it("skips empty/missing text payloads", async () => {
    const fake = makeFakeClient();
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: false,
    });
    await deliver({});
    await deliver({ text: "" });
    expect(fake.sends).toHaveLength(0);
  });
});

describe("createLiveEditDeliver — enabled (live-edit)", () => {
  it("sends the first block then edits in place for subsequent blocks (DM)", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
    });
    await deliver({ text: "hello" });
    await deliver({ text: "world" });
    await deliver({ text: "more" });
    // First block: one send. Subsequent: two edits. No extra sends.
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].text).toBe("hello");
    expect(fake.edits).toHaveLength(2);
    // Edit text is the accumulated plain text markdown-converted.
    expect(fake.edits[0].text).toBe("hello\n\nworld");
    expect(fake.edits[1].text).toBe("hello\n\nworld\n\nmore");
    // Edit targets the chatId/messageId returned by the DM send.
    expect(fake.edits[0].chatId).toBe("chat-u1");
    expect(fake.edits[0].messageId).toBe("m1");
  });

  it("starts a new message when accumulated text overflows the limit", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
      charLimit: 30,
    });
    await deliver({ text: "first" });
    // Fits into the draft → edit.
    await deliver({ text: "second block here" });
    // Appended to the accumulated text, exceeds 30 → new message with just
    // this block (which alone fits).
    await deliver({ text: "overflow now please" });
    expect(fake.sends).toHaveLength(2);
    expect(fake.edits).toHaveLength(1);
    expect(fake.sends[1].text).toBe("overflow now please");
  });

  it("edits again on a block after an overflow reset (new draft)", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
      charLimit: 30,
    });
    await deliver({ text: "first" });
    await deliver({ text: "second block here" }); // edit
    await deliver({ text: "overflow now please" }); // overflow → new draft
    await deliver({ text: "tail" }); // edit the new draft
    expect(fake.sends).toHaveLength(2);
    expect(fake.edits).toHaveLength(2);
    expect(fake.edits[1].text).toBe("overflow now please\n\ntail");
    // Edit targets the SECOND message's ref (m2 / chat-u1).
    expect(fake.edits[1].messageId).toBe("m2");
  });

  it("delivers a single over-limit block as separate non-editable messages", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
      charLimit: 50,
    });
    // A single block that itself exceeds the cap → chunked into 2 sends,
    // no editable draft retained.
    await deliver({ text: "x".repeat(60) });
    expect(fake.sends).toHaveLength(2);
    expect(fake.edits).toHaveLength(0);
    // A follow-up small block starts a fresh draft (send, not edit).
    await deliver({ text: "after" });
    expect(fake.sends).toHaveLength(3);
    expect(fake.edits).toHaveLength(0);
    expect(fake.sends[2].text).toBe("after");
  });

  it("falls back to a new message when edit fails", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1", editFails: true });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
    });
    await deliver({ text: "hello" });
    await deliver({ text: "world" });
    // First block: send. Edit fails → fallback send of accumulated text.
    expect(fake.sends).toHaveLength(2);
    expect(fake.edits).toHaveLength(1);
    expect(fake.sends[1].text).toBe("hello\n\nworld");
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.editFailures).toBe(1);
  });

  it("group posts fall back to `to` as chatId for edits", async () => {
    const fake = makeFakeClient();
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "CT_channel_chat",
      isDm: false,
      enabled: true,
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    // Group send returned no chatId → the `to` (chatid) is used for edit.
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].chatId).toBe("CT_channel_chat");
  });

  it("converts markdown on send and edit", async () => {
    const fake = makeFakeClient({ dmChatId: "c1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
    });
    await deliver({ text: "**bold** start" });
    await deliver({ text: "_italic_ next" });
    expect(fake.sends[0].text).toBe("*bold* start");
    // Accumulated plain text is converted as a whole on edit.
    expect(fake.edits[0].text).toBe("*bold* start\n\n_italic_ next");
  });

  it("exposes send/edit/failure stats", async () => {
    const fake = makeFakeClient({ dmChatId: "c1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
    });
    await deliver({ text: "a" });
    await deliver({ text: "b" });
    await deliver({ text: "c" });
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats).toBeDefined();
    expect(stats!.sends).toBe(1);
    expect(stats!.edits).toBe(2);
    expect(stats!.editFailures).toBe(0);
  });
});
