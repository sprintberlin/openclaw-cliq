import type { ChannelGatewayAdapter } from "openclaw/plugin-sdk/channel-runtime";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-message";
import type { ResolvedCliqAccount } from "./client.js";

/**
 * Passive gateway lifecycle for the webhook-driven Cliq transport.
 *
 * `/cliq/webhook` is owned by the plugin HTTP route registry, so there is no
 * socket or polling loop to start here. The gateway nevertheless needs a
 * long-lived account task: returning from `startAccount` is interpreted as a
 * stopped transport and causes the health monitor to restart a channel whose
 * webhook is actually healthy. Waiting for the lifecycle abort signal models
 * the event-driven transport honestly and lets OpenClaw maintain `running`.
 */
export const cliqGatewayAdapter: ChannelGatewayAdapter<ResolvedCliqAccount> = {
  startAccount: async ({ abortSignal, accountId, setStatus, log }) => {
    const statusSink = createAccountStatusSink({ accountId, setStatus });
    log?.info?.(`[${accountId}] starting passive webhook transport (/cliq/webhook)`);
    await runPassiveAccountLifecycle({
      abortSignal,
      start: async () => {
        statusSink({
          mode: "webhook",
          webhookPath: "/cliq/webhook",
        });
      },
    });
  },
};
