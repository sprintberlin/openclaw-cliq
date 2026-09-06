import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectCliqInboundCatchup,
  parseCliqHistoryMessage,
  selectCliqInboundCatchupCandidates,
} from "./inbound-catchup.js";
import type { ParsedCliqInbound } from "./inbound.js";

function live(overrides: Partial<ParsedCliqInbound> = {}): ParsedCliqInbound {
  return {
    text: "live",
    messageId: "evt:live-delivery",
    timestamp: "2026-09-06T08:00:00Z",
    senderId: "u-live",
    senderName: "Live sender",
    chatId: "CT_1",
    isGroup: false,
    isMention: false,
    mentionIds: [],
    attachments: [],
    handler: "message",
    ...overrides,
  };
}

const account = {
  botId: "bot",
  botName: "OpenClaw",
  selfSenderIds: ["other-bot"],
  refreshToken: "rt",
  inboundCatchup: { enabled: true, limit: 50 },
};

const history = [
  // Cliq list order is newest-first. The live handler only supplied a Deluge
  // event id, so anchoring relies on sender+text, never an invented identity.
  { messageId: "native-live", chatId: "CT_1", senderId: "u-live", text: "live" },
  { messageId: "missed-newer", chatId: "CT_1", senderId: "u2", text: "newer" },
  { messageId: "missed-older", chatId: "CT_1", senderId: "u1", text: "older" },
  { messageId: "saved-cursor", chatId: "CT_1", senderId: "u0", text: "old processed" },
];

describe("selectCliqInboundCatchupCandidates", () => {
  it("requires a persisted opaque cursor before it ever replays historic content", () => {
    const selected = selectCliqInboundCatchupCandidates({ live: live(), account, history });
    expect(selected).toEqual({ candidates: [], advanceCursorTo: "native-live", anchored: true });
  });

  it("selects only the bounded gap oldest-first between a live anchor and cursor", () => {
    const selected = selectCliqInboundCatchupCandidates({
      live: live(), account, history, cursor: "saved-cursor",
    });
    expect(selected.candidates.map((item) => item.messageId)).toEqual(["missed-older", "missed-newer"]);
    expect(selected.advanceCursorTo).toBe("native-live");
  });

  it("does not replay when the current webhook turn cannot be anchored", () => {
    expect(selectCliqInboundCatchupCandidates({
      live: live({ text: "different" }), account, history, cursor: "saved-cursor",
    })).toEqual({ candidates: [], anchored: false });
  });

  it("does not recover bot/self records, foreign chats, unreadable records, or repeated ids", () => {
    const selected = selectCliqInboundCatchupCandidates({
      live: live(), account, cursor: "saved-cursor",
      history: [
        history[0],
        { messageId: "self", chatId: "CT_1", senderId: "bot", text: "no" },
        { messageId: "self2", chatId: "CT_1", senderId: "other-bot", text: "no" },
        { messageId: "foreign", chatId: "CT_2", senderId: "u1", text: "no" },
        { messageId: "empty", chatId: "CT_1", senderId: "u1" },
        { messageId: "dupe", chatId: "CT_1", senderId: "u1", text: "first" },
        { messageId: "dupe", chatId: "CT_1", senderId: "u1", text: "second" },
        history[3],
      ],
    });
    expect(selected.candidates).toEqual([{ messageId: "dupe", chatId: "CT_1", senderId: "u1", text: "second" }]);
  });

  it("never searches a group chat", () => {
    expect(selectCliqInboundCatchupCandidates({
      live: live({ isGroup: true }), account, history, cursor: "saved-cursor",
    })).toEqual({ candidates: [], anchored: false });
  });
});

describe("parseCliqHistoryMessage", () => {
  it("represents the live-proven forwarded record with original author/text", () => {
    const parsed = parseCliqHistoryMessage({
      messageId: "1783502114151_267378657650",
      chatId: "CT_1",
      senderId: "u-forward",
      senderName: "Forwarder",
      timestamp: "2026-09-05T10:00:00Z",
      messageType: "forwarded",
      forwardInfo: {
        content: { text: "Original business instruction" },
        sender: { id: "u-original", name: "Original author" },
        time: "2026-09-02T09:00:00Z",
      },
    }, live());
    expect(parsed).toMatchObject({
      handler: "catchup",
      messageId: "1783502114151_267378657650",
      text: "Original business instruction",
      senderId: "u-forward",
      forward: {
        text: "Original business instruction",
        senderId: "u-original",
        senderName: "Original author",
      },
    });
  });

  it("turns a historic file into the normal media model", () => {
    const parsed = parseCliqHistoryMessage({
      messageId: "file-1",
      chatId: "CT_1",
      senderId: "u1",
      file: { id: "F_1", name: "note.pdf", type: "application/pdf" },
    }, live());
    expect(parsed).toMatchObject({
      text: "<file: note.pdf>",
      attachments: [{ fileId: "F_1", fileName: "note.pdf", mimeType: "application/pdf" }],
    });
  });
});

describe("inspectCliqInboundCatchup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is opt-in and leaves normal delivery untouched by default", async () => {
    const list = vi.fn();
    await expect(inspectCliqInboundCatchup({
      account: { ...account, inboundCatchup: { enabled: false, limit: 50 } },
      live: live(),
      listChatMessages: list,
    })).resolves.toEqual({ attempted: false, reason: "disabled", candidates: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it("does not call the API without refresh-token access", async () => {
    const list = vi.fn();
    await expect(inspectCliqInboundCatchup({
      account: { ...account, refreshToken: undefined },
      live: live(),
      listChatMessages: list,
    })).resolves.toEqual({ attempted: false, reason: "missing_refresh_token", candidates: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it("uses one bounded history read and only returns a cursor-bounded gap", async () => {
    const list = vi.fn(async () => history);
    const result = await inspectCliqInboundCatchup({
      account: { ...account, inboundCatchup: { enabled: true, limit: 999 } },
      live: live(),
      cursor: "saved-cursor",
      listChatMessages: list,
    });
    expect(list).toHaveBeenCalledWith("CT_1", { limit: 50 });
    expect(result).toMatchObject({ attempted: true, reason: "recovered", advanceCursorTo: "native-live" });
    expect(result.candidates.map((item) => item.messageId)).toEqual(["missed-older", "missed-newer"]);
  });

  it("baselines the current live record without replaying an unbounded backlog", async () => {
    const result = await inspectCliqInboundCatchup({
      account, live: live(), listChatMessages: async () => history,
    });
    expect(result).toEqual({
      attempted: true,
      reason: "baselined",
      candidates: [],
      advanceCursorTo: "native-live",
    });
  });

  it("reports a failed history read but does not throw", async () => {
    const onError = vi.fn();
    await expect(inspectCliqInboundCatchup({
      account, live: live(), cursor: "saved-cursor",
      listChatMessages: async () => { throw new Error("denied"); },
      onError,
    })).resolves.toEqual({ attempted: true, reason: "history_fetch_failed", candidates: [] });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { kind: "inbound-catchup-history-fetch" });
  });
});
