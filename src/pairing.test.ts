import { describe, it, expect, vi } from "vitest";
import {
  CLIQ_PAIRING_APPROVED_MESSAGE,
  CLIQ_PAIRING_ID_LABEL,
  buildCliqSenderIdLine,
  issueCliqPairingChallenge,
  notifyCliqPairingApproval,
} from "./pairing.js";
import type { CliqRuntime, ParsedCliqInbound } from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

function account(overrides: Partial<ResolvedCliqAccount> = {}): ResolvedCliqAccount {
  return {
    accountId: "acct-1",
    clientId: "id",
    clientSecret: "secret",
    botId: "bot",
    botName: "Bot",
    webhookSecret: undefined,
    allowFrom: [],
    dmPolicy: "pairing",
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    blockStreaming: false,
    thinking: { mode: "off", text: "💭 …" },
    ...overrides,
  };
}

function dmParsed(overrides: Partial<ParsedCliqInbound> = {}): ParsedCliqInbound {
  return {
    text: "hi",
    messageId: "m1",
    timestamp: "",
    senderId: "u1",
    senderName: "Alice",
    chatId: "CT_dm-B1",
    isGroup: false,
    isMention: false,
    mentionIds: [],
    attachments: [],
    handler: "message",
    ...overrides,
  };
}

interface MockPairingApi {
  upsert: ReturnType<typeof vi.fn>;
  buildReply: ReturnType<typeof vi.fn>;
  readStore: ReturnType<typeof vi.fn>;
}

interface UpsertCall {
  channel: string;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
}

function mockRuntime(api: Partial<MockPairingApi> = {}): CliqRuntime {
  const upsert =
    api.upsert ??
    vi.fn(async (_p: UpsertCall) => ({ code: "CODE123", created: true }));
  const buildReply =
    api.buildReply ??
    vi.fn((p: { channel: string; idLine: string; code: string }) =>
      `pairing reply ${p.channel} ${p.code}`,
    );
  const readStore = api.readStore ?? vi.fn(async () => []);
  return {
    channel: {
      pairing: {
        upsertPairingRequest: upsert,
        buildPairingReply: buildReply,
        readAllowFromStore: readStore,
      },
    },
  } as unknown as CliqRuntime;
}


describe("CLIQ_PAIRING_ID_LABEL / CLIQ_PAIRING_APPROVED_MESSAGE", () => {
  it("exposes a stable id label", () => {
    expect(CLIQ_PAIRING_ID_LABEL).toBe("cliqSenderId");
  });
  it("exposes a non-empty approval message", () => {
    expect(CLIQ_PAIRING_APPROVED_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("buildCliqSenderIdLine", () => {
  it("includes the sender id", () => {
    const line = buildCliqSenderIdLine(dmParsed({ senderId: "u42" }));
    expect(line).toContain("Sender id: u42");
  });
  it("includes the name when present and not 'unknown'", () => {
    const line = buildCliqSenderIdLine(
      dmParsed({ senderId: "u1", senderName: "Alice" }),
    );
    expect(line).toContain("Name: Alice");
  });
  it("omits the name when it is 'unknown'", () => {
    const line = buildCliqSenderIdLine(
      dmParsed({ senderId: "u1", senderName: "unknown" }),
    );
    expect(line).not.toContain("Name:");
  });
  it("includes the email when present", () => {
    const line = buildCliqSenderIdLine(
      dmParsed({ senderId: "u1", senderEmail: "a@b.com" }),
    );
    expect(line).toContain("Email: a@b.com");
  });
  it("omits email when absent", () => {
    const line = buildCliqSenderIdLine(dmParsed({ senderId: "u1" }));
    expect(line).not.toContain("Email:");
  });
});

describe("issueCliqPairingChallenge", () => {
  it("upserts a pairing request with channel=cliq and the sender id", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: true }));
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })) };
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: account(),
      parsed: dmParsed({ senderId: "u9" }),
      client: sendClient,
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "cliq", id: "u9" }),
    );
    expect(res).toEqual({ created: true, code: "ABC" });
  });

  it("includes meta with senderName/handler/chatId", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: true }));
    const runtime = mockRuntime({ upsert });
    await issueCliqPairingChallenge({
      runtime,
      account: account(),
      parsed: dmParsed({
        senderId: "u9",
        senderName: "Bob",
        handler: "message",
        chatId: "CT_dm-B9",
      }),
      client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })) },
    });
    const arg = upsert.mock.calls[0][0];
    expect(arg.meta).toMatchObject({
      senderName: "Bob",
      handler: "message",
      chatId: "CT_dm-B9",
    });
  });

  it("passes accountId (empty string when null)", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: true }));
    const runtime = mockRuntime({ upsert });
    await issueCliqPairingChallenge({
      runtime,
      account: account({ accountId: null }),
      parsed: dmParsed(),
      client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })) },
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({ accountId: "" });
  });

  it("sends the pairing reply via CliqClient when a new request is created", async () => {
    const buildReply = vi.fn(
      () => "REPLY-TEXT",
    );
    const runtime = mockRuntime({
      upsert: vi.fn(async (_p: UpsertCall) => ({ code: "C1", created: true })),
      buildReply,
    });
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })) };
    await issueCliqPairingChallenge({
      runtime,
      account: account(),
      parsed: dmParsed({ senderId: "u9", senderName: "Zoe" }),
      client: sendClient,
    });
    expect(buildReply).toHaveBeenCalledWith({
      channel: "cliq",
      idLine: expect.stringContaining("Sender id: u9"),
      code: "C1",
    });
    expect(sendClient.sendMessage).toHaveBeenCalledWith({
      to: "u9",
      text: "REPLY-TEXT",
      isDm: true,
    });
  });

  it("does not send a reply when the request already existed (created=false)", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "C1", created: false }));
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })) };
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: account(),
      parsed: dmParsed(),
      client: sendClient,
    });
    expect(res).toEqual({ created: false });
    expect(sendClient.sendMessage).not.toHaveBeenCalled();
  });

  it("swallows send errors and still returns created+code", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "C1", created: true }));
    const sendClient = {
      sendMessage: vi.fn(async () => {
        throw new Error("cliq down");
      }),
    };
    const onReplyError = vi.fn();
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: account(),
      parsed: dmParsed(),
      client: sendClient,
      onReplyError,
    });
    expect(res).toEqual({ created: true, code: "C1" });
    expect(onReplyError).toHaveBeenCalledOnce();
    expect(String(onReplyError.mock.calls[0][0])).toContain("cliq down");
  });

  it("forwards env to upsertPairingRequest", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "C1", created: true }));
    const runtime = mockRuntime({ upsert });
    const env = { OPENCLAW_HOME: "/tmp/oc" } as NodeJS.ProcessEnv;
    await issueCliqPairingChallenge({
      runtime,
      account: account(),
      parsed: dmParsed(),
      client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })) },
      env,
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({ env });
  });
});

describe("notifyCliqPairingApproval", () => {
  function cfg(): OpenClawConfig {
    return {
      channels: { cliq: { clientId: "id", clientSecret: "s", botId: "b" } },
    } as unknown as OpenClawConfig;
  }

  it("sends the default approval message when none provided", async () => {
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })) };
    await notifyCliqPairingApproval({
      cfg: cfg(),
      id: "u3",
      client: sendClient,
    });
    expect(sendClient.sendMessage).toHaveBeenCalledWith({
      to: "u3",
      text: CLIQ_PAIRING_APPROVED_MESSAGE,
      isDm: true,
    });
  });

  it("sends the provided message override", async () => {
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })) };
    await notifyCliqPairingApproval({
      cfg: cfg(),
      id: "u3",
      message: "custom approval",
      client: sendClient,
    });
    expect(sendClient.sendMessage).toHaveBeenCalledWith({
      to: "u3",
      text: "custom approval",
      isDm: true,
    });
  });

  it("throws when the channel is not configured", async () => {
    await expect(
      notifyCliqPairingApproval({
        cfg: { channels: {} } as unknown as OpenClawConfig,
        id: "u3",
        client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })) },
      }),
    ).rejects.toThrow(/clientId is required/);
  });
});
