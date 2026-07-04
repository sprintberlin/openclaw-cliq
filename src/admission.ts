/**
 * DM admission for the Cliq channel.
 *
 * The webhook handler must decide, for each inbound DM, whether to dispatch it
 * to the agent (`allow`), drop it (`deny`), or route the sender through the
 * pairing flow (`pairing`). Groups are not gated here — mention gating already
 * filters groups, and group policy is a separate concern not yet implemented.
 *
 * The decision reuses the SDK's shared allowlist helper
 * (`isNormalizedSenderAllowed`) so wildcard (`*`), case-insensitive, and
 * empty-list semantics match every other bundled channel.
 */

import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/allow-from";
import type { ResolvedCliqAccount } from "./client.js";
import type { ParsedCliqInbound } from "./inbound.js";

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
    const senderAllowed = isCliqSenderAllowed(parsed.senderId, account.allowFrom);
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
