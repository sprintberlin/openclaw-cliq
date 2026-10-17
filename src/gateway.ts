import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ResolvedCliqAccount } from "./client.js";
import { resolveChannelReadyPatch } from "./sdk-compat.js";
import { cliqTransportStatusFields } from "./webhook-account.js";
import { getCliqIngressMonitorRegistry } from "./ingress-runtime.js";

type ChannelGatewayAdapter<ResolvedAccount = unknown> = NonNullable<
  ChannelPlugin<ResolvedAccount>["gateway"]
>;

/**
 * Build the status patch that marks the passive webhook transport ready.
 *
 * Newer gateways set `lifecycle: "starting"` before calling `startAccount`
 * and keep it there until the channel reports readiness; a channel that never
 * advances it stays "starting" forever and is eventually judged unhealthy.
 * `channelReadyPatch` is the SDK's canonical way to say "ready", but it does
  * not exist on older OpenClaw runtimes, so it is resolved dynamically and
 * falls back to the running/connected fields those versions understand.
 *
 * `connected: true` is deliberate and honest here: the health policy treats
 * `connected === false` as `disconnected` and restarts the account, and for a
 * webhook channel there is no socket whose absence should mean "broken" — the
 * route is registered and serving.
 */
async function buildReadyStatusPatch(): Promise<Record<string, unknown>> {
  const transport = cliqTransportStatusFields();
  const readyPatch = await resolveChannelReadyPatch();
  if (readyPatch) return readyPatch(transport);
  return {
    running: true,
    connected: true,
    lastStartAt: Date.now(),
    lastError: null,
    ...transport,
  };
}

/**
 * Passive gateway lifecycle for the webhook-driven Cliq transport.
 *
 * `/cliq/webhook` is owned by the plugin HTTP route registry, so there is no
 * socket or polling loop to start here. The gateway nevertheless needs a
 * long-lived account task: a channel without `startAccount` never reaches
 * `running: true`, so the health policy reports `not-running` and the health
 * monitor restarts a channel whose webhook is actually healthy (issue #98).
 * Waiting for the lifecycle abort signal models the event-driven transport
 * honestly and lets OpenClaw maintain `running` until shutdown.
 *
 * Durable ingress (issue #261): this lifecycle also OWNS the account's
 * `createChannelIngressMonitor` instance — create + start on startAccount,
 * stop + unregister on stop. The HTTP route only ever calls `admit`; a
 * request that arrives before this monitor is running is answered `503`
 * rather than dispatching unrecorded work.
 */
export const cliqGatewayAdapter: ChannelGatewayAdapter<ResolvedCliqAccount> = {
  startAccount: async ({ abortSignal, accountId, setStatus, log }) => {
    const statusSink = createAccountStatusSink({ accountId, setStatus });
    log?.info?.(
      `[${accountId}] starting passive webhook transport (/cliq/webhook)`,
    );
    const ingress = getCliqIngressMonitorRegistry();
    const ingressStart = await ingress.startAccount(accountId, {
      abortSignal,
    });
    if (ingressStart === "unavailable") {
      // The registry already logged the one actionable diagnostic; keep
      // the account running so an unauthorized/path install never crash
      // loops — the webhook simply uses its pre-queue behaviour.
      log?.warn?.(
        `[${accountId}] durable ingress queue unavailable — webhook keeps the pre-queue behaviour (see the earlier [cliq] ingress diagnostic)`,
      );
    }
    await runPassiveAccountLifecycle({
      abortSignal,
      start: async () => {
        statusSink(await buildReadyStatusPatch());
      },
      onStop: async () => {
        // Stop + unregister the monitor the same way the account started
        // it, so stop/start cycles (config reload, health restart) never
        // leak a second monitor for the same account.
        await ingress.stopAccount(accountId);
        // Report the stop that actually happened. Without this the last
        // published state stays "ready" after shutdown, which would be a
        // different flavor of the same lie this fix removes.
        statusSink({
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
      },
    });
  },
};
