import { afterEach, describe, expect, it, vi } from "vitest";

const RUNTIME_MODULE = "openclaw/plugin-sdk/conversation-runtime";
const GATEWAY_MODULE = "openclaw/plugin-sdk/gateway-runtime";

async function loadResolver() {
  vi.resetModules();
  return import("./sdk-compat.js");
}

afterEach(() => {
  vi.doUnmock(RUNTIME_MODULE);
  vi.doUnmock(GATEWAY_MODULE);
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
