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
  deletes: { chatId: string; messageId: string }[];
  chatIdResolves: { name: string; chatId: string | undefined }[];
  messageListCalls: { chatId: string; limit?: number }[];
  sendMessage: (opts: { to: string; text: string; isDm?: boolean }) => Promise<{
    messageId?: string;
    chatId?: string;
  }>;
  editMessage: (opts: {
    chatId: string;
    messageId: string;
    text: string;
  }) => Promise<{ messageId?: string; chatId?: string }>;
  resolveChannelChatId: (name: string) => Promise<string | undefined>;
  listChatMessages: (
    chatId: string,
    opts?: { limit?: number },
  ) => Promise<{ messageId: string; chatId: string; text?: string }[]>;
  deleteMessage: (opts: { chatId: string; messageId: string }) => Promise<boolean>;
}

function makeFakeClient(opts: {
  dmChatId?: string;
  editFails?: boolean;
  channelChatId?: string | undefined;
  recentMessages?: { messageId: string; chatId: string; text?: string }[];
  channelResolveFails?: boolean;
  deleteFails?: boolean;
  dmSendFails?: boolean;
} = {}): FakeClient & Pick<
  CliqClient,
  "sendMessage" | "editMessage" | "resolveChannelChatId" | "listChatMessages" | "deleteMessage"
> {
  const sends: { to: string; text: string; isDm?: boolean }[] = [];
  const edits: { chatId: string; messageId: string; text: string }[] = [];
  const deletes: { chatId: string; messageId: string }[] = [];
  const chatIdResolves: { name: string; chatId: string | undefined }[] = [];
  const messageListCalls: { chatId: string; limit?: number }[] = [];
  const fake: FakeClient = {
    sends,
    edits,
    deletes,
    chatIdResolves,
    messageListCalls,
    sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
      if (opts.dmSendFails) throw new Error("send rejected");
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
    resolveChannelChatId: vi.fn(async (name: string) => {
      const result = opts.channelResolveFails ? undefined : (opts.channelChatId ?? undefined);
      chatIdResolves.push({ name, chatId: result });
      return result;
    }),
    listChatMessages: vi.fn(async (chatId: string, callOpts?: { limit?: number }) => {
      messageListCalls.push({ chatId, limit: callOpts?.limit });
      return opts.recentMessages ?? [];
    }),
    deleteMessage: vi.fn(async (o: { chatId: string; messageId: string }) => {
      deletes.push(o);
      if (opts.deleteFails) throw new Error("delete rejected");
      return true;
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

  it("group posts resolve the channel chat id via resolveChannelChatId for edits", async () => {
    const fake = makeFakeClient({ channelChatId: "CT_dev_team" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: true,
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    // The channel unique name was resolved to a chat id once after the send.
    expect(fake.chatIdResolves).toHaveLength(1);
    expect(fake.chatIdResolves[0].name).toBe("dev-team");
    expect(fake.chatIdResolves[0].chatId).toBe("CT_dev_team");
    // Edit targets the resolved chat id (NOT the channel unique name).
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].chatId).toBe("CT_dev_team");
    expect(fake.edits[0].messageId).toBe("m1");
  });

  it("group posts with no resolvable chat id leave the draft non-editable", async () => {
    const fake = makeFakeClient({ channelChatId: undefined });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: true,
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    // Resolution returned undefined → no draftChatId → each block is a fresh
    // send, and each group send re-attempts resolution (negatives are not
    // cached, since a missing channel may become available later).
    expect(fake.chatIdResolves).toHaveLength(2);
    expect(fake.edits).toHaveLength(0);
    expect(fake.sends).toHaveLength(2);
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.editFailures).toBe(0);
  });

  it("group edit failure recovers via listChatMessages then retries", async () => {
    // First edit fails (wrong chat id), but listChatMessages returns the
    // canonical editable ref with a different chat id → retry succeeds.
    let editCalls = 0;
    const fake = makeFakeClient({
      channelChatId: "CT_dev_team",
      recentMessages: [{ messageId: "m1", chatId: "CT_real_chat" }],
    });
    const edits = fake.edits;
    fake.editMessage = vi.fn(async (o) => {
      editCalls++;
      edits.push(o);
      if (editCalls === 1) throw new Error("wrong chat id");
      return { messageId: o.messageId, chatId: o.chatId };
    });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: true,
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    // First edit (with resolved chat id) failed → recovery listed messages
    // → second edit (with recovered chat id) succeeded.
    expect(edits).toHaveLength(2);
    expect(edits[0].chatId).toBe("CT_dev_team");
    expect(edits[1].chatId).toBe("CT_real_chat");
    expect(fake.messageListCalls).toHaveLength(1);
    expect(fake.messageListCalls[0].chatId).toBe("CT_dev_team");
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.edits).toBe(1); // the recovered retry counts as a successful edit
    expect(stats?.editFailures).toBe(0);
  });

  it("group edit failure with no recoverable ref degrades to a new message", async () => {
    const fake = makeFakeClient({
      channelChatId: "CT_dev_team",
      editFails: true,
      recentMessages: [],
    });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: true,
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[1].text).toBe("first\n\nsecond");
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.editFailures).toBe(1);
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

describe("createLiveEditDeliver — initialDraft (thinking placeholder)", () => {
  it("legacy mode: edits the placeholder into the final reply (DM, single chunk)", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: false,
      initialDraft: { messageId: "ph-1", chatId: "chat-u1" },
    });
    await deliver({ text: "the final reply" });
    // No fresh send — the placeholder was edited in place.
    expect(fake.sends).toHaveLength(0);
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].messageId).toBe("ph-1");
    expect(fake.edits[0].chatId).toBe("chat-u1");
    expect(fake.edits[0].text).toBe("the final reply");
    expect(fake.deletes).toHaveLength(0);
  });

  it("legacy mode: edits placeholder with first chunk, sends overflow chunks (DM)", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const long = "a".repeat(6000);
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: false,
      charLimit: 5000,
      initialDraft: { messageId: "ph-1", chatId: "chat-u1" },
    });
    await deliver({ text: long });
    // First chunk edits the placeholder; the second is a fresh send.
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].messageId).toBe("ph-1");
    expect(fake.edits[0].text.length).toBeLessThanOrEqual(5000);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].text.length).toBeLessThanOrEqual(5000);
    expect(fake.deletes).toHaveLength(0);
  });

  it("legacy mode: deletes the placeholder + sends fresh when edit fails", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1", editFails: true });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: false,
      initialDraft: { messageId: "ph-1", chatId: "chat-u1" },
    });
    await deliver({ text: "reply" });
    // Edit rejected → placeholder deleted, reply sent as a fresh message.
    expect(fake.edits).toHaveLength(1);
    expect(fake.deletes).toHaveLength(1);
    expect(fake.deletes[0].messageId).toBe("ph-1");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].text).toBe("reply");
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.editFailures).toBe(1);
  });

  it("legacy mode: group placeholder resolves chat id lazily before editing", async () => {
    const fake = makeFakeClient({ channelChatId: "CT_dev_team" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: false,
      // Group send response has no chatId — must be resolved on first edit.
      initialDraft: { messageId: "ph-1" },
    });
    await deliver({ text: "reply" });
    expect(fake.chatIdResolves).toHaveLength(1);
    expect(fake.chatIdResolves[0].name).toBe("dev-team");
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].chatId).toBe("CT_dev_team");
    expect(fake.edits[0].messageId).toBe("ph-1");
    expect(fake.sends).toHaveLength(0);
  });

  it("legacy mode: deletes placeholder + sends fresh when group chat id unresolvable", async () => {
    const fake = makeFakeClient({ channelChatId: undefined });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: false,
      initialDraft: { messageId: "ph-1" },
    });
    await deliver({ text: "reply" });
    expect(fake.chatIdResolves).toHaveLength(1);
    expect(fake.deletes).toHaveLength(0); // no chatId → cannot delete
    expect(fake.edits).toHaveLength(0);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].text).toBe("reply");
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.editFailures).toBe(1);
  });

  it("live-edit mode: edits the placeholder for the first block (DM)", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
      initialDraft: { messageId: "ph-1", chatId: "chat-u1" },
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    await deliver({ text: "third" });
    // Placeholder edited in place across all blocks — no fresh sends.
    expect(fake.sends).toHaveLength(0);
    expect(fake.edits).toHaveLength(3);
    expect(fake.edits[0].text).toBe("first");
    expect(fake.edits[1].text).toBe("first\n\nsecond");
    expect(fake.edits[2].text).toBe("first\n\nsecond\n\nthird");
    expect(fake.edits[0].messageId).toBe("ph-1");
    expect(fake.edits[0].chatId).toBe("chat-u1");
  });

  it("live-edit mode: group placeholder resolves chat id on first edit", async () => {
    const fake = makeFakeClient({ channelChatId: "CT_dev_team" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "dev-team",
      isDm: false,
      enabled: true,
      initialDraft: { messageId: "ph-1" },
    });
    await deliver({ text: "first" });
    await deliver({ text: "second" });
    expect(fake.chatIdResolves).toHaveLength(1);
    expect(fake.edits).toHaveLength(2);
    expect(fake.edits[0].chatId).toBe("CT_dev_team");
    expect(fake.edits[0].messageId).toBe("ph-1");
    expect(fake.sends).toHaveLength(0);
  });

  it("live-edit mode: first block overflow edits placeholder with chunk[0], sends rest fresh", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1" });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
      charLimit: 30,
      initialDraft: { messageId: "ph-1", chatId: "chat-u1" },
    });
    // A single block that itself exceeds the cap.
    await deliver({ text: "x".repeat(60) });
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].messageId).toBe("ph-1");
    expect(fake.edits[0].text.length).toBeLessThanOrEqual(30);
    expect(fake.sends).toHaveLength(1);
    expect(fake.deletes).toHaveLength(0);
    // Draft is sealed — a follow-up block sends a fresh message (no edit).
    await deliver({ text: "tail" });
    expect(fake.sends).toHaveLength(2);
    expect(fake.edits).toHaveLength(1);
  });

  it("live-edit mode: edit failure on placeholder deletes it + sends fresh", async () => {
    const fake = makeFakeClient({ dmChatId: "chat-u1", editFails: true });
    const deliver = createLiveEditDeliver({
      client: fake,
      to: "u1",
      isDm: true,
      enabled: true,
      initialDraft: { messageId: "ph-1", chatId: "chat-u1" },
    });
    await deliver({ text: "first" });
    // Edit failed → placeholder deleted, first block sent fresh.
    expect(fake.edits).toHaveLength(1);
    expect(fake.deletes).toHaveLength(1);
    expect(fake.deletes[0].messageId).toBe("ph-1");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].text).toBe("first");
    const stats = getLiveEditDeliverStats(deliver);
    expect(stats?.editFailures).toBe(1);
  });
});
