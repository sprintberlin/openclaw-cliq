import { afterEach, describe, expect, it, vi } from "vitest";

const RUNTIME_MODULE = "openclaw/plugin-sdk/conversation-runtime";

async function loadResolver() {
  vi.resetModules();
  return import("./sdk-compat.js");
}

afterEach(() => {
  vi.doUnmock(RUNTIME_MODULE);
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
