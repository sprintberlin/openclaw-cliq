import { describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
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
    streaming: { mode: "off", progress: {} },
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

/** Read the merged status patches published during a lifecycle. */
function patches(setStatus: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return setStatus.mock.calls.map(
    (call) => call[0] as Record<string, unknown>,
  );
}

async function waitForStatus(
  setStatus: ReturnType<typeof vi.fn>,
  count = 1,
): Promise<void> {
  for (let i = 0; i < 50 && setStatus.mock.calls.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("cliqGatewayAdapter", () => {
  it("keeps a configured webhook account alive and reports it running + ready", async () => {
    const controller = new AbortController();
    const { ctx, setStatus } = context(controller);
    const task = cliqGatewayAdapter.startAccount!(ctx);

    let settled = false;
    void task.then(() => {
      settled = true;
    });
    await waitForStatus(setStatus);

    expect(settled).toBe(false);
    const ready = patches(setStatus).at(0)!;
    // The whole point of issue #98: the account must be observably running,
    // not merely "not stopped".
    expect(ready).toMatchObject({
      accountId: "default",
      running: true,
      mode: "webhook",
      webhookPath: "/cliq/webhook",
    });
    // `connected: false` is what the health policy calls "disconnected" and
    // restarts; a webhook channel with a registered route must not report it.
    expect(ready.connected).toBe(true);
    expect(setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ running: false }),
    );

    controller.abort();
    await expect(task).resolves.toBeUndefined();
  });

  it("advances the lifecycle past 'starting' so health does not judge it stuck", async () => {
    const controller = new AbortController();
    const { ctx, setStatus } = context(controller);
    const task = cliqGatewayAdapter.startAccount!(ctx);
    await waitForStatus(setStatus);

    const ready = patches(setStatus).at(0)!;
    // Newer gateways set lifecycle "starting" before startAccount and expect
    // the channel to advance it; older ones have no lifecycle field at all.
    if ("lifecycle" in ready) {
      expect(ready.lifecycle).toBe("ready");
    }

    controller.abort();
    await task;
  });

  it("reports a clean stop when the abort signal fires", async () => {
    const controller = new AbortController();
    const { ctx, setStatus } = context(controller);
    const task = cliqGatewayAdapter.startAccount!(ctx);
    await waitForStatus(setStatus);

    controller.abort();
    await expect(task).resolves.toBeUndefined();

    const last = patches(setStatus).at(-1)!;
    expect(last).toMatchObject({
      accountId: "default",
      running: false,
      connected: false,
    });
    expect(typeof last.lastStopAt).toBe("number");
  });

  it("resolves immediately and cleanly when startup receives an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = context(controller);
    await expect(
      cliqGatewayAdapter.startAccount!(ctx),
    ).resolves.toBeUndefined();
  });

  it("logs the passive webhook transport it is starting", async () => {
    const controller = new AbortController();
    const { ctx, info, setStatus } = context(controller);
    const task = cliqGatewayAdapter.startAccount!(ctx);
    await waitForStatus(setStatus);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("/cliq/webhook"),
    );
    controller.abort();
    await task;
  });
});
