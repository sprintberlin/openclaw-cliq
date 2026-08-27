/**
 * DM and group admission for the Cliq channel.
 *
 * The webhook handler must decide, for each inbound message, whether to
 * dispatch it to the agent (`allow`), drop it (`deny`), or route the sender
 * through the pairing flow (`pairing`). DMs are gated by `dmPolicy` /
 * `allowFrom`; groups are gated by `groupPolicy` (`resolveCliqGroupAdmission`)
 * on top of the mention requirement.
 *
 * Neither path verifies the sender's Zoho organization: Cliq webhook payloads
 * carry no signed tenant claim (see `src/identity.ts`). The organization
 * boundary that actually holds is the authenticated webhook transport plus
 * the bot installation context.
 *
 * The decision reuses the SDK's shared allowlist helper
 * (`isNormalizedSenderAllowed`) so wildcard (`*`), case-insensitive, and
 * empty-list semantics match every other bundled channel.
 */

import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/allow-from";
import type { ResolvedCliqAccount } from "./client.js";
import type { ParsedCliqInbound } from "./inbound.js";
import { readCliqApprovedSenders } from "./pairing-store.js";

/** Canonical DM policy values, aligned with the SDK's `DmPolicy` type. */
export type CliqDmPolicy = "open" | "allowlist" | "pairing" | "disabled";

export interface CliqDmAdmission {
  decision: "allow" | "pairing" | "deny";
  policy: CliqDmPolicy;
  reason: string;
  senderAllowed: boolean;
}

/**
 * Resolve the effective DM policy for an account. Falls back to `allowlist`
 * to match the plugin's `security.dm.defaultPolicy` of `"allowlist"`.
 * Unknown / unparseable configured values also fall back to `allowlist`
 * (safe default — deny-by-default).
 */
export function resolveCliqDmPolicy(account: {
  dmPolicy?: string;
}): CliqDmPolicy {
  const raw = account.dmPolicy?.trim().toLowerCase();
  if (
    raw === "open" ||
    raw === "allowlist" ||
    raw === "pairing" ||
    raw === "disabled"
  ) {
    return raw;
  }
  return "allowlist";
}

/**
 * Check whether `senderId` is permitted by `allowFrom` using the SDK's shared
 * allowlist helper. Returns false when the allowlist is empty (deny-by-default
 * for `allowlist` policy); returns true when `*` is present.
 */
export function isCliqSenderAllowed(
  senderId: string | undefined,
  allowFrom: Array<string | number> | undefined,
): boolean {
  return isNormalizedSenderAllowed({
    senderId: senderId ?? "",
    allowFrom: allowFrom ?? [],
  });
}

/**
 * Check whether the sender was admitted through a plugin-owned pairing
 * approval (an owner tapping Approve on the pairing card). A store read
 * failure is treated as "not approved" — it must never widen access.
 */
export function isCliqSenderApproved(
  senderId: string | undefined,
  account: Pick<ResolvedCliqAccount, "accountId">,
  options?: { env?: NodeJS.ProcessEnv; storePath?: string },
): boolean {
  if (!senderId) return false;
  try {
    const approved = readCliqApprovedSenders({
      accountId: account.accountId,
      env: options?.env,
      storePath: options?.storePath,
    });
    if (approved.length === 0) return false;
    return isNormalizedSenderAllowed({ senderId, allowFrom: approved });
  } catch {
    return false;
  }
}

export function resolveCliqGroupAdmission(
  parsed: ParsedCliqInbound,
  account: Pick<ResolvedCliqAccount, "groupPolicy" | "groups">,
): CliqDmAdmission {
  const raw = account.groupPolicy?.trim().toLowerCase();
  if (raw === "disabled") {
    return {
      decision: "deny",
      policy: "disabled",
      reason: "group_policy_disabled",
      senderAllowed: false,
    };
  }
  if (raw === "allowlist") {
    const groupId = (
      parsed.channelUniqueName ?? parsed.channelId ?? parsed.chatId
    )
      .trim()
      .toLowerCase();
    const allowed = Object.keys(account.groups ?? {}).some(
      (entry) => entry.trim().toLowerCase() === groupId || entry.trim() === "*",
    );
    return {
      decision: allowed ? "allow" : "deny",
      policy: "allowlist",
      reason: allowed ? "group_allowlist_match" : "group_not_in_allowlist",
      senderAllowed: allowed,
    };
  }
  return {
    decision: "allow",
    policy: "open",
    reason: "group_policy_open",
    senderAllowed: true,
  };
}


/**
 * Decide admission for an inbound Cliq message.
 *
 * - Groups always `allow` (mention gating already filtered them).
 * - `open` → always allow DMs.
 * - `disabled` → always deny DMs.
 * - `allowlist` → allow when sender matches `allowFrom`, else deny.
 * - `pairing` → allow when sender matches `allowFrom` (covers already-paired
 *   senders and wildcard); else emit a `pairing` decision so the webhook
 *   handler can kick off the pairing flow (not yet implemented — currently
 *   the handler logs and drops).
 */
export function resolveCliqDmAdmission(
  parsed: ParsedCliqInbound,
  account: ResolvedCliqAccount,
  options?: {
    env?: NodeJS.ProcessEnv;
    storePath?: string;
    sdkAllowFrom?: Array<string | number>;
  },
): CliqDmAdmission {
  const policy = resolveCliqDmPolicy(account);
  if (!parsed.isGroup) {
    if (policy === "open") {
      return {
        decision: "allow",
        policy,
        reason: "dm_policy_open",
        senderAllowed: true,
      };
    }
    if (policy === "disabled") {
      return {
        decision: "deny",
        policy,
        reason: "dm_policy_disabled",
        senderAllowed: false,
      };
    }
    // Effective allow set = configured `allowFrom` ∪ plugin approval store.
    // The SDK allow-from store is honored separately by the SDK itself (so
    // `openclaw pairing approve cliq <code>` keeps working); the plugin store
    // covers button approvals on versions where the SDK approve helper was
    // withdrawn. Wildcard, case-insensitivity, and empty-list deny-by-default
    // semantics are unchanged — a store read only ever adds concrete ids.
    const senderAllowed =
      isCliqSenderAllowed(parsed.senderId, account.allowFrom) ||
      isCliqSenderAllowed(parsed.senderId, options?.sdkAllowFrom) ||
      isCliqSenderApproved(parsed.senderId, account, options);
    if (policy === "allowlist") {
      return {
        decision: senderAllowed ? "allow" : "deny",
        policy,
        reason: senderAllowed ? "allowlist_match" : "not_in_allowlist",
        senderAllowed,
      };
    }
    // policy === "pairing"
    return {
      decision: senderAllowed ? "allow" : "pairing",
      policy,
      reason: senderAllowed ? "allowlist_match" : "needs_pairing",
      senderAllowed,
    };
  }
  // Groups: mention gating handles access; DM policy does not apply.
  return {
    decision: "allow",
    policy,
    reason: "group_message",
    senderAllowed: true,
  };
}
