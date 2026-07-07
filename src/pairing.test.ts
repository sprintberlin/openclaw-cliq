import { describe, it, expect, vi } from "vitest";
import {
  CLIQ_PAIRING_APPROVED_MESSAGE,
  CLIQ_PAIRING_APPROVE_SENTINEL,
  CLIQ_PAIRING_DENY_SENTINEL,
  CLIQ_PAIRING_ID_LABEL,
  buildCliqSenderIdLine,
  buildPairingApprovalButtons,
  buildPairingApprovalCardBody,
  handleCliqPairingApprovalAction,
  issueCliqPairingChallenge,
  notifyCliqPairingApproval,
  parseCliqPairingApprovalAction,
} from "./pairing.js";
import type { CliqRuntime, ParsedCliqInbound } from "./inbound.js";
import type { NormalizedCliqTarget, ResolvedCliqAccount } from "./client.js";
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
    welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: { notifyOwnerTarget: null, approveLabel: "Approve", denyLabel: "Deny", approvalTitle: "🔐 Pairing request", approvedOwnerText: "✅ Approved.", deniedOwnerText: "🚫 Denied." },
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
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) };
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
    expect(res).toEqual({ created: true, code: "ABC", ownerCardPosted: false });
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
      client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) },
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
      client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) },
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
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) };
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
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) };
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
      sendCard: vi.fn(async () => ({ messageId: "ok" })),
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
    expect(res).toEqual({ created: true, code: "C1", ownerCardPosted: false });
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
      client: { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) },
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
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) };
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
    const sendClient = { sendMessage: vi.fn(async () => ({ messageId: "ok" })), sendCard: vi.fn(async () => ({ messageId: "ok" })) };
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

describe("parseCliqPairingApprovalAction", () => {
  it("parses an approve sentinel + code", () => {
    const r = parseCliqPairingApprovalAction(`${CLIQ_PAIRING_APPROVE_SENTINEL} ABC123`);
    expect(r.kind).toBe("approve");
    expect(r.code).toBe("ABC123");
    expect(r.text).toBe("");
  });
  it("uppercases the code", () => {
    const r = parseCliqPairingApprovalAction(`${CLIQ_PAIRING_APPROVE_SENTINEL} abc123`);
    expect(r.code).toBe("ABC123");
  });
  it("parses a deny sentinel + code", () => {
    const r = parseCliqPairingApprovalAction(`${CLIQ_PAIRING_DENY_SENTINEL} XYZ`);
    expect(r.kind).toBe("deny");
    expect(r.code).toBe("XYZ");
  });
  it("returns undefined kind for an ordinary message", () => {
    const r = parseCliqPairingApprovalAction("hello bot");
    expect(r.kind).toBeUndefined();
    expect(r.code).toBe("");
    expect(r.text).toBe("hello bot");
  });
  it("handles a bare sentinel with no code", () => {
    const r = parseCliqPairingApprovalAction(CLIQ_PAIRING_APPROVE_SENTINEL);
    expect(r.kind).toBe("approve");
    expect(r.code).toBe("");
  });
});

describe("buildPairingApprovalButtons", () => {
  it("builds approve + deny invoke buttons carrying the code", () => {
    const b = buildPairingApprovalButtons({ botId: "bot", code: "CODE1" })!;
    expect(b).not.toBeNull();
    expect(b.approve.action).toBe("invoke");
    expect(b.approve.data).toBe(`${CLIQ_PAIRING_APPROVE_SENTINEL} CODE1`);
    expect(b.deny.data).toBe(`${CLIQ_PAIRING_DENY_SENTINEL} CODE1`);
  });
  it("returns null without a botId", () => {
    expect(buildPairingApprovalButtons({ botId: undefined, code: "C" })).toBeNull();
  });
  it("returns null with an empty code", () => {
    expect(buildPairingApprovalButtons({ botId: "bot", code: "" })).toBeNull();
  });
  it("uses custom labels", () => {
    const b = buildPairingApprovalButtons({
      botId: "bot",
      code: "C",
      approveLabel: "Allow",
      denyLabel: "Block",
    })!;
    expect(b.approve.label).toBe("Allow");
    expect(b.deny.label).toBe("Block");
  });
});

describe("buildPairingApprovalCardBody", () => {
  it("includes the id line and code", () => {
    const body = buildPairingApprovalCardBody({
      idLine: "Sender id: u1\nName: Alice",
      code: "CODE1",
    });
    expect(body).toContain("Sender id: u1");
    expect(body).toContain("Code: CODE1");
  });
});

describe("issueCliqPairingChallenge — owner approval card", () => {
  function ownerAccount(target: string | null): ResolvedCliqAccount {
    return account({
      botId: "bot",
      pairing: {
        notifyOwnerTarget: target
          ? ({ to: target, isDm: true } as NormalizedCliqTarget)
          : null,
        approveLabel: "Approve",
        denyLabel: "Deny",
        approvalTitle: "🔐 Pairing request",
        approvedOwnerText: "✅ Approved.",
        deniedOwnerText: "🚫 Denied.",
      },
    });
  }

  it("posts an approval card to the owner when a target is configured", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: true }));
    const sendCard = vi.fn(async () => ({ messageId: "card1" }));
    const sendClient = {
      sendMessage: vi.fn(async () => ({ messageId: "ok" })),
      sendCard,
    };
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: ownerAccount("owner1"),
      parsed: dmParsed({ senderId: "u9", senderName: "Zoe" }),
      client: sendClient,
    });
    expect(res.ownerCardPosted).toBe(true);
    expect(sendCard).toHaveBeenCalledOnce();
    expect(sendCard).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner1",
        isDm: true,
        theme: "prompt",
      }),
    );
    const call = (sendCard.mock.calls[0] as unknown as [
      { buttons: Array<{ data: string }> },
    ])[0];
    expect(call.buttons).toHaveLength(2);
    expect(call.buttons[0].data).toBe(`${CLIQ_PAIRING_APPROVE_SENTINEL} ABC`);
    expect(call.buttons[1].data).toBe(`${CLIQ_PAIRING_DENY_SENTINEL} ABC`);
  });

  it("does not post a card when no owner target is configured", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: true }));
    const sendCard = vi.fn(async () => ({ messageId: "card1" }));
    const sendClient = {
      sendMessage: vi.fn(async () => ({ messageId: "ok" })),
      sendCard,
    };
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: ownerAccount(null),
      parsed: dmParsed(),
      client: sendClient,
    });
    expect(res.ownerCardPosted).toBe(false);
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("does not post a card when the request already existed", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: false }));
    const sendCard = vi.fn(async () => ({ messageId: "card1" }));
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: ownerAccount("owner1"),
      parsed: dmParsed(),
      client: {
        sendMessage: vi.fn(async () => ({ messageId: "ok" })),
        sendCard,
      },
    });
    expect(res.created).toBe(false);
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("swallows a card post failure and reports via onOwnerCardError", async () => {
    const upsert = vi.fn(async (_p: UpsertCall) => ({ code: "ABC", created: true }));
    const sendCard = vi.fn(async () => {
      throw new Error("card api down");
    });
    const onOwnerCardError = vi.fn();
    const runtime = mockRuntime({ upsert });
    const res = await issueCliqPairingChallenge({
      runtime,
      account: ownerAccount("owner1"),
      parsed: dmParsed(),
      client: {
        sendMessage: vi.fn(async () => ({ messageId: "ok" })),
        sendCard,
      },
      onOwnerCardError,
    });
    expect(res.ownerCardPosted).toBe(false);
    expect(onOwnerCardError).toHaveBeenCalledOnce();
  });
});

describe("handleCliqPairingApprovalAction", () => {
  function ownerTarget(): NormalizedCliqTarget {
    return { to: "owner1", isDm: true };
  }

  it("admits the sender on approve and notifies them + replies to the owner", async () => {
    const sendClient = {
      sendMessage: vi.fn(async () => ({ messageId: "ok" })),
    };
    const approveFn = vi.fn(async () => ({ id: "u1" }));
    const res = await handleCliqPairingApprovalAction({
      account: account(),
      action: { kind: "approve", code: "ABC" },
      ownerTarget: ownerTarget(),
      client: sendClient,
      approveFn,
    });
    expect(res.admitted).toBe(true);
    expect(res.senderId).toBe("u1");
    expect(approveFn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "cliq", code: "ABC" }),
    );
    // notified the sender + replied to the owner
    const texts = sendClient.sendMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { text: string }).text,
    );
    expect(texts).toContain(CLIQ_PAIRING_APPROVED_MESSAGE);
    expect(texts).toContain("✅ Approved.");
  });

  it("replies to the owner on deny without admitting", async () => {
    const sendClient = {
      sendMessage: vi.fn(async () => ({ messageId: "ok" })),
    };
    const approveFn = vi.fn(async () => ({ id: "u1" }));
    const res = await handleCliqPairingApprovalAction({
      account: account(),
      action: { kind: "deny", code: "ABC" },
      ownerTarget: ownerTarget(),
      client: sendClient,
      approveFn,
    });
    expect(res.admitted).toBe(false);
    expect(approveFn).not.toHaveBeenCalled();
    expect(sendClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner1", text: "🚫 Denied." }),
    );
  });

  it("returns admitted=false when the code is already approved / invalid", async () => {
    const sendClient = {
      sendMessage: vi.fn(async () => ({ messageId: "ok" })),
    };
    const approveFn = vi.fn(async () => null);
    const res = await handleCliqPairingApprovalAction({
      account: account(),
      action: { kind: "approve", code: "GONE" },
      ownerTarget: ownerTarget(),
      client: sendClient,
      approveFn,
    });
    expect(res.admitted).toBe(false);
    // still replied to the owner
    expect(sendClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "✅ Approved." }),
    );
  });

  it("swallows an approve error and still replies to the owner", async () => {
    const sendClient = {
      sendMessage: vi.fn(async () => ({ messageId: "ok" })),
    };
    const approveFn = vi.fn(async () => {
      throw new Error("store locked");
    });
    const onError = vi.fn();
    const res = await handleCliqPairingApprovalAction({
      account: account(),
      action: { kind: "approve", code: "ABC" },
      ownerTarget: ownerTarget(),
      client: sendClient,
      approveFn,
      onError,
    });
    expect(res.admitted).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});
