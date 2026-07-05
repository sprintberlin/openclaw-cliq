import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { resolveCliqConfig, type ResolvedCliqAccount } from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";

export interface CliqHeartbeatProbeResult {
  ok: boolean;
  reason: string;
}

/**
 * Probe Cliq account readiness for the heartbeat runner. Fetching an OAuth
 * access token is the cheapest end-to-end check that exercises credentials +
 * the EU OAuth endpoint reachability without posting a message. Used as the
 * gate before a heartbeat delivery / "ok" ping so a misconfigured account
 * doesn't burn a model turn.
 */
export async function probeCliqHeartbeat(
  account: ResolvedCliqAccount,
): Promise<CliqHeartbeatProbeResult> {
  try {
    const client = resolveCliqClient(account);
    await client.getAccessToken();
    return { ok: true, reason: "ok" };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/**
 * Resolve a Cliq account from cfg for a heartbeat adapter call without
 * throwing. When the channel is unconfigured there is nothing to probe or
 * pre-warm; the adapter returns a benign "not ready" / no-op.
 */
function resolveAccountSafe(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount | null {
  try {
    return resolveCliqConfig(cfg, accountId ?? null);
  } catch {
    return null;
  }
}

/**
 * Channel heartbeat adapter for Zoho Cliq.
 *
 * `checkReady` — probes OAuth token fetch; gates heartbeat delivery so a
 * broken account is skipped instead of producing a failed model turn.
 *
 * `sendTyping` — Zoho Cliq exposes NO bot "typing" REST API (bots can only
 * post messages). With the default `ackPolicy: "after_dispatch"`, Cliq's own
 * native "bot is processing" indicator already covers the UX while the agent
 * works (the Deluge handler is still awaiting our HTTP response). To still be
 * a useful heartbeat citizen we pre-warm the cached OAuth token here so the
 * first real reply after an idle gap doesn't pay the OAuth round-trip; the
 * call is cached and near-free while a token is valid. A failed pre-warm is
 * swallowed — typing must never break an agent turn.
 *
 * `clearTyping` — no-op; Cliq has no typing state to clear.
 */
export const cliqHeartbeatAdapter = {
  checkReady: async (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }): Promise<CliqHeartbeatProbeResult> => {
    const account = resolveAccountSafe(params.cfg, params.accountId);
    if (!account) return { ok: false, reason: "cliq not configured" };
    return probeCliqHeartbeat(account);
  },
  sendTyping: (params: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
  }): void => {
    const account = resolveAccountSafe(params.cfg, params.accountId);
    if (!account || !params.to) return;
    const client = resolveCliqClient(account);
    void client.getAccessToken().catch(() => {
      // Swallow: a failed typing keepalive must never break the agent turn.
    });
  },
  clearTyping: (): void => {
    // No-op: Cliq has no typing state to clear.
  },
};
