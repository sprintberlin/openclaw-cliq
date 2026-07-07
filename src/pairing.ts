/**
 * DM pairing flow for the Cliq channel.
 *
 * When the DM policy is `pairing` and the sender is not on the allowlist, the
 * webhook handler issues a pairing challenge instead of dispatching the
 * message to the agent:
 *
 *   1. Upsert a pending pairing request in the channel pairing store
 *      (`runtime.channel.pairing.upsertPairingRequest`).
 *   2. If a new request was created, build the standard OpenClaw pairing reply
 *      (`runtime.channel.pairing.buildPairingReply`) and send it to the sender
 *      via `CliqClient.sendMessage`. The reply contains the pairing code and
 *      the `openclaw pairing approve cliq <code>` instruction for the bot owner.
 *   3. If the request already existed (sender already has a pending code), do
 *      nothing — the sender was already told the code and we avoid spam.
 *
 * Once the owner approves the code (`openclaw pairing approve cliq <code>`),
 * the SDK calls the plugin's `pairing.text.notify` adapter, which delivers the
 * approval message to the now-allowed sender via `CliqClient`.
 *
 * The pairing store and reply builder are surfaced on `PluginRuntime.channel
 * .pairing` (see `types-D7eu8baG.d.ts` around line 7070). We keep a narrow
 * `CliqRuntime` slice so the webhook handler can be unit-tested with a mock.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { approveChannelPairingCode } from "openclaw/plugin-sdk/conversation-runtime";
import {
  CliqClient,
  resolveCliqConfig,
  type NormalizedCliqTarget,
  type ResolvedCliqAccount,
} from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";
import type { CliqRuntime, ParsedCliqInbound } from "./inbound.js";
import type { CliqButton } from "./presentation.js";

/** Label shown in the pairing store UI / diagnostics for a Cliq sender id. */
export const CLIQ_PAIRING_ID_LABEL = "cliqSenderId";

/** Message delivered to a sender once their pairing request is approved. */
export const CLIQ_PAIRING_APPROVED_MESSAGE =
  "OpenClaw: your access has been approved. You can now message the bot directly.";

/**
 * Prefix the Approve button's `invoke.bot` message carries, followed by a
 * single space and the pairing code. Detected on the next webhook call to
 * admit the sender via the SDK pairing store (no CLI step needed).
 */
export const CLIQ_PAIRING_APPROVE_SENTINEL = "__cliq_pairing_approve__";

/**
 * Prefix the Deny button's `invoke.bot` message carries, followed by a
 * single space and the pairing code. Detected on the next webhook call to
 * reply to the owner that the request was denied (the pending request is
 * left in place — the SDK exposes no plugin-facing pending-request removal,
 * so a denied sender who messages again is simply re-challenged
 * idempotently).
 */
export const CLIQ_PAIRING_DENY_SENTINEL = "__cliq_pairing_deny__";

/** Parsed pairing-approval button-click action. */
export interface CliqPairingApprovalParse {
  kind: "approve" | "deny" | undefined;
  /** The pairing code recovered from the button payload (uppercased). */
  code: string;
  /** The original text with any sentinel + code stripped (trimmed). */
  text: string;
}

/**
 * Inspect a raw inbound message text for a pairing approve/deny sentinel
 * posted by the approval-card buttons. Returns `{ kind, code, text }` where
 * `code` is the pairing code recovered after the sentinel and `text` is the
 * message with the sentinel + code removed (empty on a clean sentinel click).
 * When no sentinel is present, `kind` is `undefined`, `code` is `""`, and
 * `text` is the input verbatim (trimmed). The code is uppercased to match
 * the pairing store's case-insensitive code lookup.
 */
export function parseCliqPairingApprovalAction(raw: string): CliqPairingApprovalParse {
  const text = raw ?? "";
  for (const sentinel of [CLIQ_PAIRING_APPROVE_SENTINEL, CLIQ_PAIRING_DENY_SENTINEL]) {
    if (text.startsWith(sentinel + " ")) {
      const rest = text.slice(sentinel.length + 1).trim();
      const code = rest.split(/\s+/)[0]?.toUpperCase() ?? "";
      const kind: "approve" | "deny" =
        sentinel === CLIQ_PAIRING_APPROVE_SENTINEL ? "approve" : "deny";
      return { kind, code, text: rest.slice(code.length).trim() };
    }
    if (text === sentinel || text.startsWith(sentinel)) {
      const kind: "approve" | "deny" =
        sentinel === CLIQ_PAIRING_APPROVE_SENTINEL ? "approve" : "deny";
      return { kind, code: "", text: "" };
    }
  }
  return { kind: undefined, code: "", text: text.trim() };
}

/**
 * Build the Approve / Deny `invoke.bot` buttons for a pairing approval
 * prompt card. Each carries `<sentinel> <code>` as its `data` (the message
 * the Cliq Message handler receives on click). Returns `null` when no
 * `botId` is configured (`invoke.bot` needs a bot to address) or the code
 * is empty.
 */
export function buildPairingApprovalButtons(opts: {
  botId?: string;
  code: string;
  approveLabel?: string;
  denyLabel?: string;
}): { approve: CliqButton; deny: CliqButton } | null {
  const { botId, code } = opts;
  if (!botId) return null;
  if (!code) return null;
  const approve: CliqButton = {
    label: opts.approveLabel?.trim() || "Approve",
    type: "post",
    action: "invoke",
    data: `${CLIQ_PAIRING_APPROVE_SENTINEL} ${code}`,
  };
  const deny: CliqButton = {
    label: opts.denyLabel?.trim() || "Deny",
    type: "post",
    action: "invoke",
    data: `${CLIQ_PAIRING_DENY_SENTINEL} ${code}`,
  };
  return { approve, deny };
}

/**
 * Build the text body for the pairing approval prompt card — a short
 * summary of who is requesting access (sender id / name / email) plus the
 * pairing code, so the owner can decide without leaving the card.
 */
export function buildPairingApprovalCardBody(params: {
  idLine: string;
  code: string;
}): string {
  return `${params.idLine}\nCode: ${params.code}`.trim();
}

/**
 * Build the multi-line "id line" included in the pairing reply so the bot
 * owner can see who is requesting access. Mirrors the shape other channels use
 * (`Sender id: ...\nName: ...\nEmail: ...`), omitting fields that are absent.
 */
export function buildCliqSenderIdLine(parsed: ParsedCliqInbound): string {
  const lines: string[] = [`Sender id: ${parsed.senderId}`];
  if (parsed.senderName && parsed.senderName !== "unknown") {
    lines.push(`Name: ${parsed.senderName}`);
  }
  if (parsed.senderEmail) {
    lines.push(`Email: ${parsed.senderEmail}`);
  }
  return lines.join("\n");
}

export interface IssueCliqPairingChallengeParams {
  runtime: CliqRuntime;
  account: ResolvedCliqAccount;
  parsed: ParsedCliqInbound;
  env?: NodeJS.ProcessEnv;
  /** Override the outbound client (used in tests). Defaults to a fresh CliqClient. */
  client?: Pick<CliqClient, "sendMessage" | "sendCard">;
  onReplyError?: (err: unknown) => void;
  /** Called when the owner approval card post fails (best-effort). */
  onOwnerCardError?: (err: unknown) => void;
}

export interface IssueCliqPairingChallengeResult {
  created: boolean;
  code?: string;
  /** Whether an owner approval card was posted (false when not configured / failed). */
  ownerCardPosted?: boolean;
}

/**
 * Issue a pairing challenge for an inbound DM whose sender is not on the
 * allowlist. Persists a pending pairing request, and — only when a new
 * request is created — sends the pairing reply (with the approval code) back
 * to the sender via the Cliq bot.
 *
 * Errors while sending the pairing reply are swallowed (logged via
 * `onReplyError`) so a transient Cliq API failure does not crash the webhook
 * handler or cause a 5xx; the pairing request is still persisted and can be
 * approved by the owner.
 */
export async function issueCliqPairingChallenge(
  params: IssueCliqPairingChallengeParams,
): Promise<IssueCliqPairingChallengeResult> {
  const { runtime, account, parsed, env, client, onReplyError, onOwnerCardError } = params;
  const accountId = account.accountId ?? "";

  const upserted = await runtime.channel.pairing.upsertPairingRequest({
    channel: "cliq",
    id: parsed.senderId,
    accountId,
    meta: {
      senderName: parsed.senderName ?? undefined,
      senderEmail: parsed.senderEmail ?? undefined,
      handler: parsed.handler || undefined,
      chatId: parsed.chatId || undefined,
    },
    env,
  });

  if (!upserted.created) {
    return { created: false };
  }

  const idLine = buildCliqSenderIdLine(parsed);
  const replyText = runtime.channel.pairing.buildPairingReply({
    channel: "cliq",
    idLine,
    code: upserted.code,
  });

  const sendClient =
    client ??
    resolveCliqClient(account);

  try {
    await sendClient.sendMessage({
      to: parsed.senderId,
      text: replyText,
      isDm: true,
    });
  } catch (err) {
    if (onReplyError) {
      onReplyError(err);
    }
  }

  // Form-driven pairing approval (Phase 3, sub-part b): when an owner
  // target is configured, ALSO post an approval prompt card there so the
  // owner can admit the sender by tapping Approve instead of running
  // `openclaw pairing approve cliq <code>` on the CLI. The CLI step keeps
  // working alongside the card. The card post is best-effort — a failure
  // is swallowed + reported so a transient Cliq API error never breaks
  // the pairing challenge (the sender still has the CLI path). Requires a
  // `botId` (the v3 `invoke.bot` button renderer drops buttons without
  // one); when absent the card is skipped.
  let ownerCardPosted = false;
  const ownerTarget = account.pairing?.notifyOwnerTarget ?? null;
  if (ownerTarget && account.botId) {
    const buttons = buildPairingApprovalButtons({
      botId: account.botId,
      code: upserted.code,
      approveLabel: account.pairing?.approveLabel,
      denyLabel: account.pairing?.denyLabel,
    });
    if (buttons) {
      const cardBody = buildPairingApprovalCardBody({
        idLine,
        code: upserted.code,
      });
      try {
        await sendClient.sendCard({
          to: ownerTarget.to,
          isDm: ownerTarget.isDm,
          text: cardBody,
          theme: "prompt",
          buttons: [buttons.approve, buttons.deny],
        });
        ownerCardPosted = true;
      } catch (err) {
        if (onOwnerCardError) {
          onOwnerCardError(err);
        }
      }
    }
  }

  return { created: true, code: upserted.code, ownerCardPosted };
}

/**
 * Notify a Cliq sender that their pairing request was approved. Used as the
 * plugin's `pairing.text.notify` adapter — the SDK invokes it after an admin
 * runs `openclaw pairing approve cliq <code>`.
 *
 * Resolves the account from the live config so the approval notification is
 * sent from the same bot identity the webhook uses. Throws if the channel is
 * not configured (the owner should fix config before approving codes).
 */
export async function notifyCliqPairingApproval(params: {
  cfg: OpenClawConfig;
  id: string;
  message?: string;
  client?: Pick<CliqClient, "sendMessage">;
}): Promise<void> {
  const { cfg, id, message, client } = params;
  const account = resolveCliqConfig(cfg, null);
  const sendClient =
    client ??
    resolveCliqClient(account);
  await sendClient.sendMessage({
    to: id,
    text: message ?? CLIQ_PAIRING_APPROVED_MESSAGE,
    isDm: true,
  });
}

export interface HandleCliqPairingApprovalActionParams {
  account: ResolvedCliqAccount;
  /** The parsed approval action (`kind` is `"approve"` or `"deny"`). */
  action: { kind: "approve" | "deny"; code: string };
  /** The owner target to reply to (the card originator). */
  ownerTarget: NormalizedCliqTarget;
  env?: NodeJS.ProcessEnv;
  /** Override the outbound client (tests). Defaults to a fresh CliqClient. */
  client?: Pick<CliqClient, "sendMessage">;
  /** Override the SDK admission call (tests). Defaults to `approveChannelPairingCode`. */
  approveFn?: typeof approveChannelPairingCode;
  onError?: (err: unknown, info: { kind: string }) => void;
}

export interface HandleCliqPairingApprovalActionResult {
  /** Whether the sender was admitted to the allowlist (approve + valid code). */
  admitted: boolean;
  /** The sender id that was admitted (when available). */
  senderId?: string;
}

/**
 * Handle a pairing approve/deny button click re-dispatched as an inbound
 * message. For **approve**: calls the SDK's `approveChannelPairingCode` to
 * admit the sender (writing them to the channel allowFrom store), then
 * notifies the now-admitted sender via `notifyCliqPairingApproval` and
 * replies to the owner with the configured `approvedOwnerText`. For
 * **deny**: replies to the owner with `deniedOwnerText` (the pending
 * request is left in place — the SDK exposes no plugin-facing pending-
 * request removal; a denied sender who messages again is re-challenged
 * idempotently).
 *
 * Errors are swallowed + reported via `onError` so a transient failure
 * never crashes the webhook (the owner can retry by tapping again, or use
 * the CLI). A missing/invalid code (already-approved, expired, or
 * malformed) resolves `admitted: false` and posts the `approvedOwnerText`
 * anyway so the owner gets feedback.
 */
export async function handleCliqPairingApprovalAction(
  params: HandleCliqPairingApprovalActionParams,
): Promise<HandleCliqPairingApprovalActionResult> {
  const { account, action, ownerTarget, env, client, approveFn, onError } = params;
  const sendClient = client ?? resolveCliqClient(account);
  const accountId = account.accountId ?? undefined;
  const approve = approveFn ?? approveChannelPairingCode;

  if (action.kind === "deny") {
    try {
      await sendClient.sendMessage({
        to: ownerTarget.to,
        text: account.pairing?.deniedOwnerText ?? "🚫 Denied.",
        isDm: ownerTarget.isDm,
      });
    } catch (err) {
      onError?.(err, { kind: "pairing-deny-reply" });
    }
    return { admitted: false };
  }

  // kind === "approve"
  let senderId: string | undefined;
  let admitted = false;
  if (action.code) {
    try {
      const result = await approve({
        channel: "cliq",
        code: action.code,
        accountId,
        env,
      });
      if (result?.id) {
        senderId = String(result.id);
        admitted = true;
      }
    } catch (err) {
      onError?.(err, { kind: "pairing-approve" });
    }
  }

  // Notify the now-admitted sender they can message the bot. Best-effort:
  // a failure here does not undo the admission (the allowFrom store was
  // already written). Skipped when no sender id was recovered (the code
  // was already approved / expired).
  if (admitted && senderId) {
    try {
      await sendClient.sendMessage({
        to: senderId,
        text: CLIQ_PAIRING_APPROVED_MESSAGE,
        isDm: true,
      });
    } catch (err) {
      onError?.(err, { kind: "pairing-approve-notify-sender" });
    }
  }

  // Reply to the owner with the configured outcome text so the card gets
  // visible feedback. Best-effort.
  try {
    await sendClient.sendMessage({
      to: ownerTarget.to,
      text: account.pairing?.approvedOwnerText ?? "✅ Approved.",
      isDm: ownerTarget.isDm,
    });
  } catch (err) {
    onError?.(err, { kind: "pairing-approve-reply" });
  }

  return { admitted, senderId };
}
