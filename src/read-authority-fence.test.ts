import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  cliqMessageActions,
  describeCliqMessageTool,
  type CliqClientLike,
} from "./message-actions.js";
import { setCliqClientRegistry, CliqClientRegistry } from "./runtime-api.js";

const FETCH_RUNTIME_MODULE = "openclaw/plugin-sdk/fetch-runtime";

function makeCfg(refreshToken = "rt"): OpenClawConfig {
  return {
    channels: {
      cliq: {
        clientId: "id",
        clientSecret: "secret",
        botId: "bot",
        refreshToken,
      },
    },
  } as unknown as OpenClawConfig;
}

describe("Cliq message(action=read) authority and target fencing", () => {
  beforeEach(() => {
    setCliqClientRegistry(null);
  });

  afterEach(() => {
    setCliqClientRegistry(null);
    vi.doUnmock(FETCH_RUNTIME_MODULE);
    vi.resetModules();
  });

  it("keeps read schema current-channel scoped (no blanket cross-channel discovery)", () => {
    const discovery = describeCliqMessageTool({ cfg: makeCfg() });
    expect(discovery).not.toBeNull();
    const schema = discovery!.schema;
    expect(Array.isArray(schema)).toBe(false);
    if (!schema || Array.isArray(schema)) throw new Error("expected schema contribution");
    // Cross-channel discovery stays grant-scoped in core (planned readAuthorizations);
    // the plugin must not open a blanket gate via "all-configured".
    expect(schema.visibility).toBe("current-channel");
    expect(schema.actions).toEqual(["read"]);
    expect(schema.properties.chatId).toBeDefined();
    expect(schema.properties.fromTimeMs).toBeDefined();
    expect(schema.properties.toTimeMs).toBeDefined();
  });

  it("declares provider-owned read gates plus read authority actions for host admission", () => {
    expect(cliqMessageActions.providerOwnedReadGates).toEqual(["read"]);
    const authorityActions = (cliqMessageActions as { readAuthorityActions?: readonly string[] }).readAuthorityActions;
    expect(authorityActions).toEqual(["read"]);
  });

  it("messageActionTargetAliases.read mirrors the bare native chatId for the shared target path", () => {
    const spec = cliqMessageActions.messageActionTargetAliases?.read;
    expect(spec).toBeDefined();
    expect(spec?.aliases).toContain("chatId");
    expect(spec?.deliveryTargetAliases).toContain("chatId");
    // Host normalization mirrors this exact value into target/to; delegated
    // cross-context admission compares the bare native id (to.trim() === chatId),
    // so a prefixed form here would make every granted read fail as a conflict.
    expect(spec?.resolveDeliveryTarget?.({ args: { chatId: "CT_abc123" } })).toBe("CT_abc123");
    expect(spec?.resolveDeliveryTarget?.({ args: { chatId: "  CT_abc123  " } })).toBe("CT_abc123");
    expect(spec?.resolveDeliveryTarget?.({ args: {} })).toBeUndefined();
    expect(spec?.resolveDeliveryTarget?.({ args: { chatId: "   " } })).toBeUndefined();
  });

  it("rejects cross-provider read when no host read-authority callback is provided", async () => {
    vi.doMock(FETCH_RUNTIME_MODULE, () => ({ captureChannelReadAuthority: () => undefined }));
    const client: Partial<CliqClientLike> = {
      listChatMessages: vi.fn(),
      resolveChannelChatId: vi.fn(),
    };
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client as CliqClientLike;
    setCliqClientRegistry(reg);

    const result = await cliqMessageActions.handleAction!({
      channel: "cliq",
      action: "read",
      cfg: makeCfg(),
      params: { chatId: "CT_123" },
      accountId: null,
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: "telegram" as unknown as undefined },
    });

    expect(result.details).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/host read authority/i),
    });
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("rejects cross-provider read with channel name instead of explicit native CT_ chatId", async () => {
    const assertCurrent = vi.fn();
    vi.doMock(FETCH_RUNTIME_MODULE, () => ({ captureChannelReadAuthority: () => assertCurrent }));
    const client: Partial<CliqClientLike> = {
      listChatMessages: vi.fn(),
      resolveChannelChatId: vi.fn(),
    };
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client as CliqClientLike;
    setCliqClientRegistry(reg);

    const result = await cliqMessageActions.handleAction!({
      channel: "cliq",
      action: "read",
      cfg: makeCfg(),
      params: { to: "cliq:channel:general" },
      accountId: null,
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: "telegram" as unknown as undefined },
    });

    expect(result.details).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/explicit native `chatId`/i),
    });
    expect(client.resolveChannelChatId).not.toHaveBeenCalled();
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("rejects cross-provider read with any roomId value", async () => {
    const assertCurrent = vi.fn();
    vi.doMock(FETCH_RUNTIME_MODULE, () => ({ captureChannelReadAuthority: () => assertCurrent }));
    const client: Partial<CliqClientLike> = {
      listChatMessages: vi.fn(),
      resolveChannelChatId: vi.fn(),
    };
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client as CliqClientLike;
    setCliqClientRegistry(reg);

    const result = await cliqMessageActions.handleAction!({
      channel: "cliq",
      action: "read",
      cfg: makeCfg(),
      params: { chatId: "CT_123", roomId: "CT_123" },
      accountId: null,
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: "telegram" as unknown as undefined },
    });

    expect(result.details).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/conflicting targets \(`roomId`\)/i),
    });
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("rejects cross-provider read with conflicting target params", async () => {
    const assertCurrent = vi.fn();
    vi.doMock(FETCH_RUNTIME_MODULE, () => ({ captureChannelReadAuthority: () => assertCurrent }));
    const client: Partial<CliqClientLike> = {
      listChatMessages: vi.fn(),
      resolveChannelChatId: vi.fn(),
    };
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client as CliqClientLike;
    setCliqClientRegistry(reg);

    const result = await cliqMessageActions.handleAction!({
      channel: "cliq",
      action: "read",
      cfg: makeCfg(),
      params: { chatId: "CT_123", to: "cliq:channel:different" },
      accountId: null,
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: "telegram" as unknown as undefined },
    });

    expect(result.details).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/conflicting target/i),
    });
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it("passes native CT_ chatId and passes assertReadCurrent to listChatMessages when host authority is active", async () => {
    const assertCurrent = vi.fn();
    vi.doMock(FETCH_RUNTIME_MODULE, () => ({ captureChannelReadAuthority: () => assertCurrent }));
    const client: Partial<CliqClientLike> = {
      listChatMessages: vi.fn(async (_chatId, opts) => {
        opts?.assertReadCurrent?.();
        return [{ messageId: "m1", chatId: "CT_valid", text: "hello" }];
      }),
      resolveChannelChatId: vi.fn(),
    };
    const reg = new CliqClientRegistry();
    (reg as unknown as { getOrCreate: () => CliqClientLike }).getOrCreate = () => client as CliqClientLike;
    setCliqClientRegistry(reg);

    const result = await cliqMessageActions.handleAction!({
      channel: "cliq",
      action: "read",
      cfg: makeCfg(),
      params: { chatId: "CT_valid", limit: 10 },
      accountId: null,
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: "telegram" as unknown as undefined },
    });

    expect(result.details).toMatchObject({
      action: "read",
      chatId: "CT_valid",
      count: 1,
    });
    expect(client.resolveChannelChatId).not.toHaveBeenCalled();
    expect(client.listChatMessages).toHaveBeenCalledWith("CT_valid", expect.objectContaining({
      limit: 10,
      strictResponse: true,
      assertReadCurrent: assertCurrent,
    }));
    expect(assertCurrent).toHaveBeenCalled();
  });
});
