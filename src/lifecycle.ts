import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelLifecycleAdapter } from "openclaw/plugin-sdk/channel-runtime";
import {
  getCliqClientRegistry,
  type CliqAccountIdentity,
} from "./runtime-api.js";
import {
  resolveCliqConfig,
  CLIQ_DEFAULT_ACCOUNT_ID,
  type ResolvedCliqAccount,
} from "./client.js";
import { detectCliqLegacyStateMigrations } from "./legacy-state-migrations.js";

/**
 * Lifecycle hooks for the Cliq channel.
 *
 * Zoho Cliq webhooks are configured via a Deluge script in the Cliq bot
 * handler — there is no REST endpoint to register a webhook URL the way
 * Telegram's `setWebhook` does. So "register webhook on start, clean up on
 * stop" cannot be taken literally for Cliq: the wiring is necessarily
 * manual (paste the gateway URL + shared secret into the Deluge handler).
 *
 * What the lifecycle hooks CAN do to reduce the manual-setup burden and keep
 * the runtime honest:
 *
 *  - `runStartupMaintenance` (on start): enumerate every configured account,
 *    warn on a missing webhook secret (inbound cannot be verified without
 *    one), log the canonical webhook path operators must wire into the
 *    Deluge handler, and best-effort pre-warm the OAuth access token so the
 *    first inbound message after an idle gap doesn't pay the
 *    `accounts.zoho.eu` round-trip. Failures are swallowed — startup
 *    maintenance must never block the gateway from coming up.
 *
 *  - `onAccountConfigChanged` / `onAccountRemoved` (config-change cleanup):
 *    evict the cached `CliqClient` for the affected account so the next
 *    send mints a fresh client with the updated credentials. Without this,
 *    a `openclaw configure` edit that rotates `clientSecret` / `botId` /
 *    `refreshToken` would keep reusing the stale cached client (and its
 *    cached OAuth token) until the process restarts.
 */

const WEBHOOK_PATH = "/cliq/webhook";

/**
 * Enumerate the Cliq account ids that have a resolvable config section.
 * Returns `[null]` for the single-account (top-level only) layout, the
 * explicit `accounts.<id>` keys for the multi-account layout, or `[]` when
 * the channel is entirely unconfigured. `null` is the sentinel
 * `resolveCliqConfig` uses for the unnamed single-account case.
 */
function listConfiguredCliqAccountIds(cfg: OpenClawConfig): (string | null)[] {
  const channels = (cfg as unknown as {
    channels?: Record<string, unknown>;
  }).channels;
  const section = channels?.["cliq"];
  if (!section || typeof section !== "object") return [];
  const sec = section as { accounts?: Record<string, unknown> };
  const accountIds = sec.accounts
    ? Object.keys(sec.accounts).filter((id) => id !== CLIQ_DEFAULT_ACCOUNT_ID)
    : [];
  if (accountIds.length > 0) return accountIds;
  // Single-account layout: the top-level section is the account.
  return [null];
}

/**
 * Resolve a Cliq account defensively. Returns `null` when the account is
 * not configured (missing credentials) instead of throwing — startup
 * maintenance logs the gap and moves on.
 */
function resolveAccountSafe(
  cfg: OpenClawConfig,
  accountId: string | null,
): ResolvedCliqAccount | null {
  try {
    return resolveCliqConfig(cfg, accountId);
  } catch {
    return null;
  }
}

/**
 * Build the set of cache keys to evict for an account identity. Covers both
 * the per-account key (`acct:<id>`) and the single-account key
 * (`cc:<clientId>:<botId>`) so an eviction lands regardless of which layout
 * the operator used.
 */
function evictAccountClients(identities: CliqAccountIdentity[]): void {
  const registry = getCliqClientRegistry();
  for (const identity of identities) {
    registry.evict(identity);
  }
}

/**
 * Collect the identities to evict when an account's config changes. Evicts
 * the `acct:<accountId>` slot plus the `cc:<clientId>:<botId>` slots for
 * both the previous and the next resolved accounts — a credential rotation
 * (e.g. `clientSecret` change) means the old cached client is stale, and a
 * `botId` change means the new client would otherwise collide with the old
 * slot until evicted.
 */
function collectAccountConfigChangeIdentities(
  prevCfg: OpenClawConfig,
  nextCfg: OpenClawConfig,
  accountId: string,
): CliqAccountIdentity[] {
  const identities: CliqAccountIdentity[] = [];
  // Per-account slot (always evict for a named account).
  if (accountId && accountId !== CLIQ_DEFAULT_ACCOUNT_ID) {
    identities.push({ accountId, clientId: "", botId: "" });
  }
  for (const cfg of [prevCfg, nextCfg]) {
    const acct = accountId && accountId !== CLIQ_DEFAULT_ACCOUNT_ID
      ? accountId
      : null;
    const resolved = resolveAccountSafe(cfg, acct);
    if (resolved) {
      identities.push({
        accountId: resolved.accountId,
        clientId: resolved.clientId,
        botId: resolved.botId,
      });
    }
  }
  return identities;
}

/**
 * Startup maintenance: validate the Cliq config, log the webhook path
 * operators must wire into the Deluge handler, warn on a missing webhook
 * secret, and best-effort pre-warm the OAuth access token for each
 * configured account. Swallows every failure — startup maintenance must
 * never block the gateway from coming up (the runtime wraps the call in a
 * try/catch too, but we keep the log noise focused by handling errors here).
 */
export async function runCliqStartupMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  trigger?: string;
  logPrefix?: string;
}): Promise<void> {
  const { cfg, log } = params;
  const prefix = (params.logPrefix ?? "cliq").trim() || "cliq";
  const accountIds = listConfiguredCliqAccountIds(cfg);
  if (accountIds.length === 0) {
    log.info?.(
      `${prefix}: no accounts configured; webhook ${WEBHOOK_PATH} will return 503 until credentials are set.`,
    );
    return;
  }
  // Log the canonical webhook path once per startup so operators wiring the
  // Deluge handler don't have to guess. The gateway base URL is not known
  // to the plugin, so we print the path and let the operator prefix their
  // gateway's external URL.
  log.info?.(
    `${prefix}: inbound webhook path is ${WEBHOOK_PATH} — configure the Deluge bot handler to POST to <gateway-base-url>${WEBHOOK_PATH} with header x-cliq-webhook-secret: <your shared secret>.`,
  );
  for (const accountId of accountIds) {
    const label = accountId ?? "default";
    const account = resolveAccountSafe(cfg, accountId);
    if (!account) {
      log.warn?.(
        `${prefix}: account "${label}" is missing required credentials (clientId/clientSecret/botId); skipping.`,
      );
      continue;
    }
    if (!account.webhookSecret) {
      log.warn?.(
        `${prefix}: account "${label}" has no webhook secret — inbound delivery cannot be verified. Set channels.cliq.webhookSecret (recommended).`,
      );
    }
    try {
      const client = getCliqClientRegistry().getOrCreate(account);
      await client.getAccessToken("ZohoCliq.Webhooks.CREATE");
      log.info?.(
        `${prefix}: OAuth token pre-warmed for account "${label}" (bot ${account.botId}).`,
      );
    } catch (err) {
      log.warn?.(
        `${prefix}: OAuth pre-warm failed for account "${label}": ${String(err)}`,
      );
    }
  }
}

/**
 * Evict the cached `CliqClient` for an account whose config changed so the
 * next outbound send / inbound dispatch mints a fresh client with the new
 * credentials (the old cached client would keep the stale OAuth token and
 * credentials until evicted). Synchronous — eviction is a Map delete.
 */
export function onCliqAccountConfigChanged(params: {
  prevCfg: OpenClawConfig;
  nextCfg: OpenClawConfig;
  accountId: string;
}): void {
  const identities = collectAccountConfigChangeIdentities(
    params.prevCfg,
    params.nextCfg,
    params.accountId,
  );
  evictAccountClients(identities);
}

/**
 * Evict the cached `CliqClient` for a removed account so its stale OAuth
 * token / credentials are dropped from the registry immediately. The
 * previous config is consulted for the identity to evict (the account is
 * gone from the new config by definition).
 */
export function onCliqAccountRemoved(params: {
  prevCfg: OpenClawConfig;
  accountId: string;
}): void {
  const { prevCfg, accountId } = params;
  const identities: CliqAccountIdentity[] = [];
  if (accountId && accountId !== CLIQ_DEFAULT_ACCOUNT_ID) {
    identities.push({ accountId, clientId: "", botId: "" });
  }
  const acct = accountId && accountId !== CLIQ_DEFAULT_ACCOUNT_ID
    ? accountId
    : null;
  const resolved = resolveAccountSafe(prevCfg, acct);
  if (resolved) {
    identities.push({
      accountId: resolved.accountId,
      clientId: resolved.clientId,
      botId: resolved.botId,
    });
  }
  evictAccountClients(identities);
}

/**
 * Compose the full Cliq lifecycle adapter: startup maintenance + account
 * config-change / removal eviction + the legacy-state-migration detector
 * (kept in `legacy-state-migrations.ts`). Each hook is optional on the SDK
 * type; omitting `onAccountConfigChanged` / `onAccountRemoved` would leave
 * stale `CliqClient` instances in the registry after a `openclaw configure`
 * edit, so both are wired.
 */
export const cliqLifecycleAdapter: ChannelLifecycleAdapter = {
  runStartupMaintenance: runCliqStartupMaintenance,
  onAccountConfigChanged: onCliqAccountConfigChanged,
  onAccountRemoved: onCliqAccountRemoved,
  detectLegacyStateMigrations: detectCliqLegacyStateMigrations,
};
