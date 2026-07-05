import type { ParsedCliqInbound } from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";

export interface CliqSelfMessageMatch {
  self: boolean;
  /** Which sender identity field matched (for diagnostics). */
  matchedField?: "senderId" | "senderName" | "senderEmail";
  /** The raw value that matched (for diagnostics). */
  matchedValue?: string;
  /** The normalized bot identity it matched against. */
  matchedIdentity?: string;
}

/**
 * Build the set of sender identities (lowercased, trimmed, non-empty) that
 * should be treated as the bot itself — its own messages must never re-enter
 * the agent pipeline (otherwise the bot answers itself, looping).
 *
 * The set always includes the configured `botId` (bot unique name used in the
 * Cliq API URL) and `botName` (display name). Operators can add extra ids via
 * `selfSenderIds` for two cases:
 *   1. The webhook delivers the bot's *user id* (zuid) rather than its
 *      unique name — e.g. a Deluge handler that fires on the bot's own
 *      outgoing messages and reports `user.id` as a zuid that differs from
 *      `botId`. Add that zuid here so it is recognised as self.
 *   2. Other Cliq bots in the same workspace whose messages should never
 *      trigger this agent (bot-to-bot loop prevention). Cliq does not expose
 *      a reliable `is_bot` flag on the sender, so an explicit id list is the
 *      only robust signal.
 */
export function resolveCliqBotIdentities(
  account: Pick<ResolvedCliqAccount, "botId" | "botName" | "selfSenderIds">,
): Set<string> {
  const ids = new Set<string>();
  const add = (v?: string) => {
    const s = (v ?? "").trim().toLowerCase();
    if (s) ids.add(s);
  };
  add(account.botId);
  add(account.botName);
  for (const extra of account.selfSenderIds ?? []) add(extra);
  return ids;
}

/**
 * Determine whether an inbound message was authored by the bot itself (or by
 * a sender the operator explicitly marked as a bot to ignore). Comparisons
 * are case-insensitive and trimmed, and check `senderId`, `senderName`, and
 * `senderEmail` against the resolved bot identity set.
 *
 * Returns `{ self: false }` when there is nothing configured to match
 * against (e.g. an account with no `botId`/`botName`/`selfSenderIds`), so
 * the webhook handler can short-circuit without dropping legitimate traffic.
 */
export function isCliqSelfMessage(
  parsed: Pick<
    ParsedCliqInbound,
    "senderId" | "senderName" | "senderEmail"
  >,
  account: Pick<ResolvedCliqAccount, "botId" | "botName" | "selfSenderIds">,
): CliqSelfMessageMatch {
  const identities = resolveCliqBotIdentities(account);
  if (identities.size === 0) return { self: false };
  const candidates: Array<{
    field: "senderId" | "senderName" | "senderEmail";
    value?: string;
  }> = [
    { field: "senderId", value: parsed.senderId },
    { field: "senderName", value: parsed.senderName },
    { field: "senderEmail", value: parsed.senderEmail },
  ];
  for (const c of candidates) {
    const s = (c.value ?? "").trim().toLowerCase();
    if (!s) continue;
    if (identities.has(s)) {
      return {
        self: true,
        matchedField: c.field,
        matchedValue: c.value,
        matchedIdentity: s,
      };
    }
  }
  return { self: false };
}
