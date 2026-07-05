import type {
  ChannelAccountSnapshot,
  ChannelStatusAdapter,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  resolveCliqConfig,
  type ResolvedCliqAccount,
} from "./client.js";
import { probeCliqHeartbeat } from "./heartbeat.js";

/**
 * Status probe result for a Cliq account. The probe fetches an OAuth access
 * token (the cheapest end-to-end check that exercises clientId/clientSecret +
 * the EU OAuth endpoint reachability without posting a message). `ok` is true
 * only when the token was obtained; `reason` carries a human-readable detail
 * (the error message on failure, or "ok").
 */
export interface CliqStatusProbe {
  ok: boolean;
  reason: string;
  probedAt: number;
}

const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * Probe a resolved Cliq account's health: fetch an OAuth access token under a
 * timeout. Never throws — a failed or timed-out probe returns `{ ok: false }`
 * with a descriptive reason so `openclaw status` can render the failure instead
 * of crashing.
 */
export async function probeCliqStatus(
  account: ResolvedCliqAccount,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<CliqStatusProbe> {
  const probedAt = Date.now();
  const timeout = Math.max(1, Math.min(timeoutMs, DEFAULT_PROBE_TIMEOUT_MS));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<CliqStatusProbe>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          reason: `probe timeout after ${timeout}ms`,
          probedAt,
        }),
      timeout,
    );
  });
  try {
    const result = await Promise.race([
      probeCliqHeartbeat(account),
      timeoutPromise,
    ]);
    return { ...result, probedAt };
  } catch (err) {
    return { ok: false, reason: String(err), probedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isConfiguredAccount(account: ResolvedCliqAccount): boolean {
  return Boolean(account.clientId && account.clientSecret && account.botId);
}

/**
 * Resolve a Cliq account from cfg for a status adapter call without throwing.
 * When the channel is unconfigured there is nothing to probe; the caller
 * handles the null return as "not configured".
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
 * Channel status adapter for Zoho Cliq.
 *
 * Surfaces Cliq account health to `openclaw status` / `openclaw channels` /
 * `openclaw plugins doctor`. The probe mints an OAuth access token (the
 * cheapest end-to-end credential check) under a timeout, and the adapter
 * reports:
 *  - `configured` — clientId/clientSecret/botId all present,
 *  - `probe.ok` — OAuth token fetch succeeded (account is reachable),
 *  - status issues — a `config` issue when unconfigured, an `auth` issue when
 *    the probe failed (bad creds, EU endpoint unreachable, timeout).
 *
 * The bot itself cannot be pinged without side effects (Cliq bots can only
 * post messages), so OAuth token fetch is the canonical reachability probe —
 * it is exactly what a real outbound reply needs first, so a probe failure
 * guarantees the next reply would fail too.
 */
export const cliqStatusAdapter: ChannelStatusAdapter<
  ResolvedCliqAccount,
  CliqStatusProbe
> = createComputedAccountStatusAdapter<ResolvedCliqAccount, CliqStatusProbe>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
    botId: null as string | null,
    probe: null as CliqStatusProbe | null,
  }),
  probeAccount: async ({ account, timeoutMs }) =>
    probeCliqStatus(account, timeoutMs),
  resolveAccountSnapshot: ({ account, probe }) => {
    const configured = isConfiguredAccount(account);
    return {
      accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account.botName ?? account.botId,
      enabled: configured,
      configured,
      extra: {
        botId: account.botId,
        probe: probe ?? null,
      },
    };
  },
  buildChannelSummary: ({ snapshot }) => {
    const probe = (snapshot as ChannelAccountSnapshot & {
      probe?: CliqStatusProbe | null;
    }).probe ?? null;
    return {
      configured: snapshot.configured ?? false,
      botId:
        (snapshot as ChannelAccountSnapshot & { botId?: string | null }).botId ??
        null,
      probeOk: probe?.ok ?? null,
      probeReason: probe?.reason ?? null,
      probedAt: probe?.probedAt ?? null,
    };
  },
  collectStatusIssues: (accounts) => {
    const issues: ChannelStatusIssue[] = [];
    for (const snapshot of accounts) {
      const accountId = snapshot.accountId ?? DEFAULT_ACCOUNT_ID;
      const configured = snapshot.configured ?? false;
      const probe = (snapshot as ChannelAccountSnapshot & {
        probe?: CliqStatusProbe | null;
      }).probe ?? null;
      if (!configured) {
        issues.push({
          channel: "cliq",
          accountId,
          kind: "config",
          message: "Zoho Cliq account is not fully configured (clientId/clientSecret/botId required).",
          fix: "Run `openclaw configure` and fill in the Cliq clientId, clientSecret, and botId.",
        });
        continue;
      }
      if (probe && !probe.ok) {
        issues.push({
          channel: "cliq",
          accountId,
          kind: "auth",
          message: `Cliq OAuth probe failed: ${probe.reason}`,
          fix: "Verify clientId/clientSecret and that accounts.zoho.eu is reachable.",
        });
      }
    }
    return issues;
  },
  resolveAccountState: ({ configured }) =>
    configured ? ("configured" as const) : ("not configured" as const),
});

/**
 * Resolve the status adapter's account from cfg without throwing — exported so
 * tests + future doctor/diagnostics can reuse the safe resolution path.
 */
export function resolveCliqStatusAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCliqAccount | null {
  return resolveAccountSafe(cfg, accountId);
}
