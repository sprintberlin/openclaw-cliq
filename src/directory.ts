import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  createChannelDirectoryAdapter,
  type ChannelDirectoryEntry,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  resolveCliqConfig,
  type CliqDirectoryEntry,
  type ResolvedCliqAccount,
} from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";

/** Default upper bound on entries returned per directory call. */
const DEFAULT_LIST_LIMIT = 200;

/**
 * Resolve a Cliq account from cfg for a directory adapter call without
 * throwing. When the channel is unconfigured there is nothing to list; the
 * adapter returns an empty list rather than crashing `openclaw directory`.
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
 * Apply a case-insensitive substring query and a positive result limit to a
 * directory entry list. Matching runs across `id`, `name`, and `handle` so a
 * search like "ops" matches both the channel named "Ops Channel" and the user
 * whose email contains "ops". The limit is applied *after* filtering.
 */
function applyQueryAndLimit(
  entries: CliqDirectoryEntry[],
  query: string | null | undefined,
  limit: number | null | undefined,
): ChannelDirectoryEntry[] {
  const q = query?.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => {
        const hay = [e.id, e.name, e.handle]
          .filter((v): v is string => Boolean(v))
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
    : entries;
  const cap = typeof limit === "number" && limit > 0 ? limit : filtered.length;
  return filtered.slice(0, cap).map((e) => ({
    kind: e.kind,
    id: e.id,
    name: e.name,
    handle: e.handle,
    raw: e.raw,
  }));
}

/**
 * Wrap a Cliq listing call so it (1) resolves the account safely, (2) swallows
 * API errors into an empty list (directory must never crash the CLI), and
 * (3) applies query + limit. The caller picks `kind` and the underlying
 * `CliqClient` method.
 */
async function listCliqEntries(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  fetch: (client: ReturnType<typeof resolveCliqClient>, maxItems: number) => Promise<CliqDirectoryEntry[]>;
  defaultLimit?: number;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolveAccountSafe(params.cfg, params.accountId);
  if (!account) return [];
  try {
    const client = resolveCliqClient(account);
    const maxItems =
      (typeof params.limit === "number" && params.limit > 0
        ? params.limit
        : params.defaultLimit ?? DEFAULT_LIST_LIMIT);
    const entries = await params.fetch(client, maxItems);
    return applyQueryAndLimit(entries, params.query, params.limit);
  } catch {
    // Directory is a read-only convenience surface; a failed API call (bad
    // scope, unreachable endpoint, quota) degrades to an empty list rather
    // than crashing `openclaw directory`.
    return [];
  }
}

/** Resolve the bot's own directory entry from config (no API call). */
function resolveCliqSelfEntry(account: ResolvedCliqAccount): ChannelDirectoryEntry {
  return {
    kind: "user",
    id: account.botId,
    name: account.botName ?? account.botId,
  };
}

/**
 * Channel directory adapter for Zoho Cliq.
 *
 * - `self` returns the configured bot identity (no API call) so
 *   `openclaw directory` can show "this account" without a round-trip.
 * - `listPeers` calls `GET /api/v2/users` (scope `ZohoCliq.Users.READ`) and
 *   returns organization users as `user` entries.
 * - `listGroups` calls `GET /api/v2/channels` (scope `ZohoCliq.Channels.READ`)
 *   and returns channels as `group` entries (with `unique_name` as `handle`).
 *
 * All listing methods apply a case-insensitive `query` filter across
 * id/name/handle and a positive `limit` cap. API failures degrade to an empty
 * list so the directory surface never crashes the CLI.
 */
export const cliqDirectoryAdapter = createChannelDirectoryAdapter({
  self: async ({ cfg, accountId }) => {
    const account = resolveAccountSafe(cfg, accountId);
    if (!account) return null;
    return resolveCliqSelfEntry(account);
  },
  listPeers: async ({ cfg, accountId, query, limit }) =>
    listCliqEntries({
      cfg,
      accountId,
      query,
      limit,
      fetch: (client, maxItems) => client.listUsers(maxItems),
    }),
  listGroups: async ({ cfg, accountId, query, limit }) =>
    listCliqEntries({
      cfg,
      accountId,
      query,
      limit,
      fetch: (client, maxItems) => client.listChannels(maxItems),
    }),
});

/**
 * Pure helpers exported for tests. `applyCliqDirectoryQueryAndLimit` applies
 * the same query/limit filtering the adapter does to a pre-fetched entry list.
 */
export function applyCliqDirectoryQueryAndLimit(
  entries: CliqDirectoryEntry[],
  query: string | null | undefined,
  limit: number | null | undefined,
): ChannelDirectoryEntry[] {
  return applyQueryAndLimit(entries, query, limit);
}
