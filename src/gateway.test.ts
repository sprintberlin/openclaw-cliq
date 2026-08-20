import { describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-runtime";
import type { ResolvedCliqAccount } from "./client.js";
import { cliqGatewayAdapter } from "./gateway.js";

function account(): ResolvedCliqAccount {
  return {
    accountId: null,
    clientId: "client",
    clientSecret: "secret",
    botId: "bot",
    webhookSecret: "webhook-secret",
    allowFrom: [],
    dmPolicy: "open",
    ackPolicy: "after_dispatch",
    selfSenderIds: [],
    blockStreaming: false,
    thinking: { mode: "off", text: "thinking" },
    welcome: { enabled: false, text: "", textRejoin: "" },
    pairing: {
      notifyOwnerTarget: null,
      approveLabel: "Approve",
      denyLabel: "Deny",
      approvalTitle: "Pairing request",
      approvedOwnerText: "Approved.",
      deniedOwnerText: "Denied.",
    },
  };
}

function context(controller: AbortController) {
  const setStatus = vi.fn();
  const info = vi.fn();
  return {
    setStatus,
    info,
    ctx: {
      cfg: {},
      accountId: "default",
      account: account(),
      runtime: {},
      abortSignal: controller.signal,
      log: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getStatus: () => ({ accountId: "default" }),
      setStatus,
    } as unknown as ChannelGatewayContext<ResolvedCliqAccount>,
  };
}

describe("cliqGatewayAdapter", () => {
  it("keeps a configured webhook account alive and publishes transport metadata", async () => {
    const controller = new AbortController();
    const { ctx, setStatus } = context(controller);
    const task = cliqGatewayAdapter.startAccount!(ctx);

    let settled = false;
    void task.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(setStatus).toHaveBeenCalledWith({
      accountId: "default",
      mode: "webhook",
      webhookPath: "/cliq/webhook",
    });
    expect(setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ running: false }),
    );

    controller.abort();
    await expect(task).resolves.toBeUndefined();
  });

  it("resolves immediately and cleanly when startup receives an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = context(controller);
    await expect(cliqGatewayAdapter.startAccount!(ctx)).resolves.toBeUndefined();
  });
});
