import { afterEach, describe, expect, it, vi } from "vitest";

const RUNTIME_MODULE = "openclaw/plugin-sdk/conversation-runtime";
const GATEWAY_MODULE = "openclaw/plugin-sdk/gateway-runtime";
const CHANNEL_INBOUND_MODULE = "openclaw/plugin-sdk/channel-inbound";
const WEBHOOK_GUARDS_MODULE = "openclaw/plugin-sdk/webhook-request-guards";

async function loadResolver() {
  vi.resetModules();
  return import("./sdk-compat.js");
}

afterEach(() => {
  vi.doUnmock(RUNTIME_MODULE);
  vi.doUnmock(GATEWAY_MODULE);
  vi.doUnmock(CHANNEL_INBOUND_MODULE);
  vi.doUnmock(WEBHOOK_GUARDS_MODULE);
  vi.resetModules();
});

describe("resolveChannelPairingApprove", () => {
  it("returns and caches the helper when the symbol is present", async () => {
    const approve = vi.fn(async () => ({ id: "user-1" }));
    const factory = vi.fn(() => ({ approveChannelPairingCode: approve }));
    vi.doMock(RUNTIME_MODULE, factory);

    const { resolveChannelPairingApprove } = await loadResolver();

    await expect(resolveChannelPairingApprove()).resolves.toBe(approve);
    await expect(resolveChannelPairingApprove()).resolves.toBe(approve);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("returns null when the symbol is absent", async () => {
    vi.doMock(RUNTIME_MODULE, () => ({ readChannelAllowFromStore: vi.fn() }));

    const { resolveChannelPairingApprove } = await loadResolver();

    await expect(resolveChannelPairingApprove()).resolves.toBeNull();
  });

  it("returns null when importing the SDK module throws", async () => {
    vi.doMock(RUNTIME_MODULE, () => {
      throw new Error("module unavailable");
    });

    const { resolveChannelPairingApprove } = await loadResolver();

    await expect(resolveChannelPairingApprove()).resolves.toBeNull();
  });

  it("returns null when the property is not a function", async () => {
    vi.doMock(RUNTIME_MODULE, () => ({ approveChannelPairingCode: "not-callable" }));

    const { resolveChannelPairingApprove } = await loadResolver();

    await expect(resolveChannelPairingApprove()).resolves.toBeNull();
  });
});

describe("resolveChannelReadyPatch", () => {
  it("returns and caches the helper when the symbol is present", async () => {
    const ready = vi.fn((extras?: Record<string, unknown>) => ({
      running: true,
      connected: true,
      lifecycle: "ready",
      ...extras,
    }));
    const factory = vi.fn(() => ({ channelReadyPatch: ready }));
    vi.doMock(GATEWAY_MODULE, factory);

    const { resolveChannelReadyPatch } = await loadResolver();

    await expect(resolveChannelReadyPatch()).resolves.toBe(ready);
    await expect(resolveChannelReadyPatch()).resolves.toBe(ready);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("returns null when the symbol is absent (older OpenClaw)", async () => {
    vi.doMock(GATEWAY_MODULE, () => ({ createConnectedChannelStatusPatch: vi.fn() }));

    const { resolveChannelReadyPatch } = await loadResolver();

    await expect(resolveChannelReadyPatch()).resolves.toBeNull();
  });

  it("returns null when importing the SDK module throws", async () => {
    vi.doMock(GATEWAY_MODULE, () => {
      throw new Error("module unavailable");
    });

    const { resolveChannelReadyPatch } = await loadResolver();

    await expect(resolveChannelReadyPatch()).resolves.toBeNull();
  });
});

describe("readInboundProcessedOutcome", () => {
  it("reads a processed outcome attached to the turn result", async () => {
    vi.doMock(CHANNEL_INBOUND_MODULE, () => ({}));
    const { readInboundProcessedOutcome } = await loadResolver();

    await expect(
      readInboundProcessedOutcome({
        processedOutcome: { outcome: "skipped", reason: "duplicate" },
      }),
    ).resolves.toEqual({ outcome: "skipped", reason: "duplicate" });
  });

  it("uses and caches a dynamically resolved reader when available", async () => {
    const reader = vi.fn(() => ({ outcome: "skipped", reason: "reply-operation-active" }));
    const factory = vi.fn(() => ({ readInboundProcessedOutcome: reader }));
    vi.doMock(CHANNEL_INBOUND_MODULE, factory);
    const {
      readInboundProcessedOutcome,
      resolveInboundProcessedOutcomeReader,
    } = await loadResolver();

    const result = { dispatchResult: { queuedFinal: false } };
    await expect(readInboundProcessedOutcome(result)).resolves.toEqual({
      outcome: "skipped",
      reason: "reply-operation-active",
    });
    await expect(resolveInboundProcessedOutcomeReader()).resolves.toBe(reader);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("returns null when no compatible reader or outcome is available", async () => {
    vi.doMock(CHANNEL_INBOUND_MODULE, () => ({ runChannelInboundEvent: vi.fn() }));
    const { readInboundProcessedOutcome } = await loadResolver();

    await expect(readInboundProcessedOutcome({ dispatchResult: {} })).resolves.toBeNull();
  });
});

describe("resolveRunDetachedWebhookWork (issue #122)", () => {
  it("returns and caches the helper when the symbol is present (>= 2026.8.1-beta.3)", async () => {
    const runDetached = vi.fn(async (work: () => Promise<unknown>) => await work());
    const factory = vi.fn(() => ({ runDetachedWebhookWork: runDetached }));
    vi.doMock(WEBHOOK_GUARDS_MODULE, factory);

    const { resolveRunDetachedWebhookWork } = await loadResolver();

    await expect(resolveRunDetachedWebhookWork()).resolves.toBe(runDetached);
    await expect(resolveRunDetachedWebhookWork()).resolves.toBe(runDetached);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("returns null when the symbol is absent (2026.7.1-2)", async () => {
    vi.doMock(WEBHOOK_GUARDS_MODULE, () => ({ someOtherGuard: vi.fn() }));

    const { resolveRunDetachedWebhookWork } = await loadResolver();

    await expect(resolveRunDetachedWebhookWork()).resolves.toBeNull();
  });

  it("returns null when importing the SDK module throws", async () => {
    vi.doMock(WEBHOOK_GUARDS_MODULE, () => {
      throw new Error("module unavailable");
    });

    const { resolveRunDetachedWebhookWork } = await loadResolver();

    await expect(resolveRunDetachedWebhookWork()).resolves.toBeNull();
  });

  it("returns null when the property is not a function", async () => {
    vi.doMock(WEBHOOK_GUARDS_MODULE, () => ({ runDetachedWebhookWork: "not-callable" }));

    const { resolveRunDetachedWebhookWork } = await loadResolver();

    await expect(resolveRunDetachedWebhookWork()).resolves.toBeNull();
  });
});
