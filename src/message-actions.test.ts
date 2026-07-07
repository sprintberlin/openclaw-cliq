import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  cliqMessageActions,
  describeCliqMessageTool,
  resolveCliqActions,
  resolveChatIdForAction,
  resolveSendButtons,
  CLIQ_ACTIONS_ALL,
  CLIQ_MESSAGE_CAPABILITIES,
  type CliqClientLike,
} from "./message-actions.js";
import type { ResolvedCliqAccount } from "./client.js";

function makeAccount(
  overrides: Partial<ResolvedCliqAccount> = {},
): ResolvedCliqAccount {
  return {
    accountId: null,
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    allowFrom: [],
    dmPolicy: undefined,
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    blockStreaming: false,
    thinking: { mode: "off", text: "💭 …" },
    welcome: { enabled: false, text: "", textRejoin: "" },
    ...overrides,
  };
}

function makeCfg(account: Partial<ResolvedCliqAccount>): OpenClawConfig {
  return {
    channels: {
      cliq: {
        clientId: account.clientId ?? "id",
        clientSecret: account.clientSecret ?? "secret",
        botId: account.botId ?? "bot",
        ...(account.refreshToken ? { refreshToken: account.refreshToken } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

interface FakeClient {
  sends: { to: string; text: string; isDm?: boolean }[];
  cards: { to: string; text?: string; isDm?: boolean; buttons?: unknown[]; theme?: string; pollOptions?: string[] }[];
  edits: { chatId: string; messageId: string; text: string }[];
  deletes: { chatId: string; messageId: string }[];
  reads: { chatId: string; limit?: number }[];
  reacts: { chatId: string; messageId: string; emoji: string; op: "add" | "remove" }[];
  chatIdResolves: string[];
  sendMessage: CliqClientLike["sendMessage"];
  sendCard: CliqClientLike["sendCard"];
  editMessage: CliqClientLike["editMessage"];
  deleteMessage: CliqClientLike["deleteMessage"];
  listChatMessages: CliqClientLike["listChatMessages"];
  resolveChannelChatId: CliqClientLike["resolveChannelChatId"];
  addMessageReaction: CliqClientLike["addMessageReaction"];
  removeMessageReaction: CliqClientLike["removeMessageReaction"];
}

function makeFakeClient(opts: {
  chatIdFor?: string;
  deleteOk?: boolean;
  reactOk?: boolean;
  messages?: { messageId: string; chatId: string; text?: string }[];
} = {}): FakeClient {
  const sends: FakeClient["sends"] = [];
  const cards: FakeClient["cards"] = [];
  const edits: FakeClient["edits"] = [];
  const deletes: FakeClient["deletes"] = [];
  const reads: FakeClient["reads"] = [];
  const reacts: FakeClient["reacts"] = [];
  const chatIdResolves: string[] = [];
  const reactOk = opts.reactOk ?? true;
  return {
    sends,
    cards,
    edits,
    deletes,
    reads,
    reacts,
    chatIdResolves,
    sendMessage: vi.fn(async (o: { to: string; text: string; isDm?: boolean }) => {
      sends.push(o);
      return { messageId: "m-sent", chatId: o.isDm ? "dm-chat" : undefined };
    }),
    sendCard: vi.fn(async (o: { to: string; text?: string; isDm?: boolean; buttons?: unknown[]; theme?: string; pollOptions?: string[] }) => {
      cards.push(o);
      return { messageId: "m-card", chatId: o.isDm ? "dm-chat" : undefined };
    }),
    editMessage: vi.fn(async (o: { chatId: string; messageId: string; text: string }) => {
      edits.push(o);
      return { messageId: o.messageId, chatId: o.chatId };
    }),
    deleteMessage: vi.fn(async (o: { chatId: string; messageId: string }) => {
      deletes.push(o);
      return opts.deleteOk ?? true;
    }),
    listChatMessages: vi.fn(async (chatId: string, o?: { limit?: number }) => {
      reads.push({ chatId, limit: o?.limit });
      return opts.messages ?? [];
    }),
    resolveChannelChatId: vi.fn(async (name: string) => {
      chatIdResolves.push(name);
      return opts.chatIdFor ?? "CT_resolved";
    }),
    addMessageReaction: vi.fn(async (o: { chatId: string; messageId: string; emoji: string }) => {
      reacts.push({ ...o, op: "add" });
      return reactOk;
    }),
    removeMessageReaction: vi.fn(async (o: { chatId: string; messageId: string; emoji: string }) => {
      reacts.push({ ...o, op: "remove" });
      return reactOk;
    }),
  };
}

describe("cliqMessageActions.describeMessageTool", () => {
  it("returns null when the channel is unconfigured", () => {
    const cfg = { channels: {} } as unknown as OpenClawConfig;
    expect(describeCliqMessageTool({ cfg })).toBeNull();
  });

  it("exposes only `send` when no refresh token is configured (DM-only setup)", () => {
    const cfg = makeCfg(makeAccount({ refreshToken: undefined }));
    const discovery = describeCliqMessageTool({ cfg });
    expect(discovery).not.toBeNull();
    expect(discovery!.actions).toEqual(["send"]);
  });

  it("exposes send/edit/delete/read when a refresh token is configured", () => {
    const cfg = makeCfg(makeAccount({ refreshToken: "rt" }));
    const discovery = describeCliqMessageTool({ cfg });
    expect(discovery!.actions?.slice().sort()).toEqual(
      ["send", "edit", "delete", "read", "react"].slice().sort(),
    );
  });

  it("supportsAction returns true for the canonical Cliq action set", () => {
    for (const a of CLIQ_ACTIONS_ALL) {
      expect(cliqMessageActions.supportsAction!({ action: a })).toBe(true);
    }
    expect(cliqMessageActions.supportsAction!({ action: "pin" })).toBe(false);
  });

  it("resolveExecutionMode is always local", () => {
    expect(cliqMessageActions.resolveExecutionMode!({ action: "send" })).toBe("local");
  });

  it("advertises the portable `presentation` capability", () => {
    const cfg = makeCfg(makeAccount({}));
    const discovery = describeCliqMessageTool({ cfg });
    expect(discovery!.capabilities).toEqual([...CLIQ_MESSAGE_CAPABILITIES]);
    expect(discovery!.capabilities).toContain("presentation");
  });
});

describe("resolveCliqActions", () => {
  it("send only without refresh token", () => {
    expect(resolveCliqActions(makeAccount({ refreshToken: undefined }))).toEqual(["send"]);
  });

  it("full set with refresh token", () => {
    const out = resolveCliqActions(makeAccount({ refreshToken: "rt" }));
    expect(out).toContain("send");
    expect(out).toContain("edit");
    expect(out).toContain("delete");
    expect(out).toContain("read");
    expect(out).toContain("react");
  });
});

describe("resolveChatIdForAction", () => {
  it("explicit chatId param wins", async () => {
    const client = makeFakeClient();
    const id = await resolveChatIdForAction(client, {
      chatId: "CT_explicit",
      to: "cliq:channel:general",
    });
    expect(id).toBe("CT_explicit");
    expect(client.chatIdResolves).toHaveLength(0);
  });

  it("cliq:channel:<name> resolves via resolveChannelChatId", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const id = await resolveChatIdForAction(client, { to: "cliq:channel:general" });
    expect(id).toBe("CT_chan");
    expect(client.chatIdResolves).toEqual(["general"]);
  });

  it("cliq:user:<id> (DM) cannot be resolved → undefined", async () => {
    const client = makeFakeClient();
    const id = await resolveChatIdForAction(client, { to: "cliq:user:u-1" });
    expect(id).toBeUndefined();
    expect(client.chatIdResolves).toHaveLength(0);
  });

  it("bare `to` is treated as a channel unique name", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_bare" });
    const id = await resolveChatIdForAction(client, { to: "dev-team" });
    expect(id).toBe("CT_bare");
  });

  it("missing `to` and `chatId` returns undefined", async () => {
    const client = makeFakeClient();
    const id = await resolveChatIdForAction(client, {});
    expect(id).toBeUndefined();
  });
});

describe("cliqMessageActions.handleAction", () => {
  function buildCtx(params: Record<string, unknown>, account: ResolvedCliqAccount) {
    return {
      channel: "cliq" as const,
      action: "send" as const,
      cfg: makeCfg(account),
      params,
      accountId: null,
    };
  }

  it("returns a failure result when the channel is unconfigured", async () => {
    const result = await cliqMessageActions.handleAction!({
      channel: "cliq",
      action: "send",
      cfg: { channels: {} } as unknown as OpenClawConfig,
      params: { to: "cliq:channel:general", message: "hi" },
      accountId: null,
    });
    expect(result.details).toMatchObject({ status: "failed" });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("send: dispatches a channel post via sendMessage", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const account = makeAccount({});
    // Inject the fake client by patching resolveCliqClient via the module
    // registry singleton.
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx(
          { to: "cliq:channel:general", message: "**hello**" },
          account,
        ) as Parameters<NonNullable<typeof cliqMessageActions.handleAction>>[0],
      );
      expect(result.details).toMatchObject({ action: "send", to: "cliq:channel:general", messageId: "m-sent" });
      expect(client.sends).toHaveLength(1);
      // Markdown conversion: **bold** → *bold* (Cliq native)
      expect(client.sends[0].text).toBe("*hello*");
      expect(client.sends[0].isDm).toBe(false);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("send with `buttons` param: dispatches a card via sendCard (no plain send)", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const account = makeAccount({});
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx(
          {
            to: "cliq:user:u-1",
            message: "Pick one",
            buttons: [
              { label: "Open", url: "https://example.com" },
              { label: "Confirm", value: "yes" },
            ],
          },
          account,
        ) as Parameters<NonNullable<typeof cliqMessageActions.handleAction>>[0],
      );
      expect(result.details).toMatchObject({
        action: "send",
        messageId: "m-card",
        buttons: 2,
      });
      expect(client.cards).toHaveLength(1);
      expect(client.sends).toHaveLength(0);
      const card = client.cards[0];
      expect(card.to).toBe("u-1");
      expect(card.isDm).toBe(true);
      // Markdown conversion applies to the body text.
      expect(card.text).toBe("Pick one");
      expect(card.buttons).toHaveLength(2);
      expect(card.buttons![0]).toMatchObject({ action: "openurl", url: "https://example.com" });
      expect(card.buttons![1]).toMatchObject({ action: "invoke", data: "yes" });
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("send with theme=poll + pollOptions dispatches a poll card (no plain send)", async () => {
    const client = makeFakeClient({});
    const account = makeAccount({});
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx(
          {
            to: "cliq:channel:dev-team",
            message: "Which feature should we prioritize?",
            theme: "poll",
            pollOptions: ["OAuth 2.0", "Dark mode", "Push notifications"],
          },
          account,
        ) as Parameters<NonNullable<typeof cliqMessageActions.handleAction>>[0],
      );
      expect(result.details).toMatchObject({
        action: "send",
        messageId: "m-card",
        theme: "poll",
        pollOptions: 3,
      });
      expect(client.cards).toHaveLength(1);
      expect(client.sends).toHaveLength(0);
      const card = client.cards[0];
      expect(card.to).toBe("dev-team");
      expect(card.isDm).toBe(false);
      expect(card.theme).toBe("poll");
      expect(card.pollOptions).toEqual([
        "OAuth 2.0",
        "Dark mode",
        "Push notifications",
      ]);
      // A poll carries no action buttons.
      expect(card.buttons).toEqual([]);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("send with theme=poll but <2 pollOptions fails with a helpful error", async () => {
    const client = makeFakeClient({});
    const account = makeAccount({});
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx(
          {
            to: "cliq:channel:dev-team",
            message: "Pick one",
            theme: "poll",
            pollOptions: ["only"],
          },
          account,
        ) as Parameters<NonNullable<typeof cliqMessageActions.handleAction>>[0],
      );
      expect(result.details).toMatchObject({ status: "failed" });
      expect(result.content[0].type === "text" && result.content[0].text).toContain("pollOptions");
      expect(client.cards).toHaveLength(0);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("send with `buttons` only (no message) is accepted", async () => {
    const client = makeFakeClient({});
    const account = makeAccount({});
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx(
          { to: "cliq:channel:general", buttons: [{ label: "OK", value: "ok" }] },
          account,
        ) as Parameters<NonNullable<typeof cliqMessageActions.handleAction>>[0],
      );
      expect(result.details).toMatchObject({ action: "send", buttons: 1, messageId: "m-card" });
      expect(client.cards).toHaveLength(1);
      expect(client.cards[0].text).toBeUndefined();
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("send with `presentation` object: body text derives from text/title blocks", async () => {
    const client = makeFakeClient({});
    const account = makeAccount({});
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx(
          {
            to: "cliq:user:u-9",
            presentation: {
              title: "Choose",
              blocks: [
                { type: "text", text: "An action:" },
                { type: "buttons", buttons: [{ label: "Run", value: "run" }] },
              ],
            },
          },
          account,
        ) as Parameters<NonNullable<typeof cliqMessageActions.handleAction>>[0],
      );
      expect(result.details).toMatchObject({ action: "send", buttons: 1 });
      expect(client.cards).toHaveLength(1);
      // Title + text block concatenated into the body.
      expect(client.cards[0].text).toBe("Choose\n\nAn action:");
      expect(client.cards[0].buttons![0]).toMatchObject({ data: "run" });
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("send with neither message nor buttons is rejected", async () => {
    const client = makeFakeClient({});
    const account = makeAccount({});
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!(
        buildCtx({ to: "cliq:channel:general" }, account) as Parameters<
          NonNullable<typeof cliqMessageActions.handleAction>
        >[0],
      );
      expect(result.details).toMatchObject({ status: "failed" });
      expect(client.cards).toHaveLength(0);
      expect(client.sends).toHaveLength(0);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("`buttons` param takes precedence over `presentation`", () => {
    const out = resolveSendButtons({
      buttons: [{ label: "A", value: "a" }],
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "B", value: "b" }] }],
      },
    });
    expect(out.buttons).toHaveLength(1);
    expect(out.buttons[0]).toMatchObject({ label: "A" });
  });

  it("resolveSendButtons returns empty for no button params", () => {
    expect(resolveSendButtons({ message: "hi" }).buttons).toEqual([]);
  });

  it("edit: requires chatId resolution + markdown conversion", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "edit",
        cfg: makeCfg(account),
        params: { to: "cliq:channel:general", messageId: "m1", message: "_italic_" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ action: "edit", chatId: "CT_chan", messageId: "m1" });
      expect(client.edits).toHaveLength(1);
      expect(client.edits[0].text).toBe("_italic_");
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("edit: returns a failure when chatId cannot be resolved (DM)", async () => {
    const client = makeFakeClient();
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "edit",
        cfg: makeCfg(account),
        params: { to: "cliq:user:u-1", messageId: "m1", message: "x" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
      expect(client.edits).toHaveLength(0);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("edit without refresh token is rejected up front", async () => {
    const client = makeFakeClient();
    const account = makeAccount({ refreshToken: undefined });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "edit",
        cfg: makeCfg(account),
        params: { chatId: "CT_x", messageId: "m1", message: "x" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
      expect(result.details).toMatchObject({ error: expect.stringContaining("refresh token") });
      expect(client.edits).toHaveLength(0);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("delete: dispatches deleteMessage with the resolved chat id", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan", deleteOk: true });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "delete",
        cfg: makeCfg(account),
        params: { to: "cliq:channel:general", messageId: "m1" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ action: "delete", chatId: "CT_chan", messageId: "m1" });
      expect(client.deletes).toEqual([{ chatId: "CT_chan", messageId: "m1" }]);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("delete: surfaces a rejected delete as a failure", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan", deleteOk: false });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "delete",
        cfg: makeCfg(account),
        params: { to: "cliq:channel:general", messageId: "m1" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("read: dispatches listChatMessages with the resolved chat id + limit", async () => {
    const client = makeFakeClient({
      chatIdFor: "CT_chan",
      messages: [{ messageId: "m1", chatId: "CT_chan", text: "hi" }],
    });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "read",
        cfg: makeCfg(account),
        params: { to: "cliq:channel:general", limit: 10 },
        accountId: null,
      });
      expect(result.details).toMatchObject({ action: "read", chatId: "CT_chan", count: 1 });
      expect(client.reads).toEqual([{ chatId: "CT_chan", limit: 10 }]);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("react (add): dispatches addMessageReaction with the resolved chat id + emoji", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "react",
        cfg: makeCfg(account),
        params: { to: "cliq:channel:general", messageId: "m1", emoji: ":smile:" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ action: "react", op: "add", chatId: "CT_chan", messageId: "m1", emoji: ":smile:" });
      expect(client.reacts).toEqual([{ chatId: "CT_chan", messageId: "m1", emoji: ":smile:", op: "add" }]);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("react (remove): op=remove dispatches removeMessageReaction", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "react",
        cfg: makeCfg(account),
        params: { to: "cliq:channel:general", messageId: "m1", emoji: "😄", op: "remove" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ action: "react", op: "remove", emoji: "😄" });
      expect(client.reacts).toEqual([{ chatId: "CT_chan", messageId: "m1", emoji: "😄", op: "remove" }]);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("react without refresh token is rejected up front", async () => {
    const client = makeFakeClient();
    const account = makeAccount({ refreshToken: undefined });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "react",
        cfg: makeCfg(account),
        params: { chatId: "CT_x", messageId: "m1", emoji: ":smile:" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
      expect(result.details).toMatchObject({ error: expect.stringContaining("refresh token") });
      expect(client.reacts).toHaveLength(0);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("react: missing emoji is a failure (no throw)", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan" });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "react",
        cfg: makeCfg(account),
        params: { chatId: "CT_x", messageId: "m1" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
      expect(client.reacts).toHaveLength(0);
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("react: surfaces a rejected react as a failure", async () => {
    const client = makeFakeClient({ chatIdFor: "CT_chan", reactOk: false });
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "react",
        cfg: makeCfg(account),
        params: { chatId: "CT_x", messageId: "m1", emoji: ":smile:" },
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
    } finally {
      setCliqClientRegistry(null);
    }
  });

  it("unsupported action returns a failure (no throw)", async () => {
    const client = makeFakeClient();
    const account = makeAccount({ refreshToken: "rt" });
    const { setCliqClientRegistry, CliqClientRegistry } = await import("./runtime-api.js");
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client;
    setCliqClientRegistry(reg);
    try {
      const result = await cliqMessageActions.handleAction!({
        channel: "cliq",
        action: "pin",
        cfg: makeCfg(account),
        params: {},
        accountId: null,
      });
      expect(result.details).toMatchObject({ status: "failed" });
    } finally {
      setCliqClientRegistry(null);
    }
  });
});
