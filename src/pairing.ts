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
import { CliqClient, resolveCliqConfig, type ResolvedCliqAccount } from "./client.js";
import { resolveCliqClient } from "./runtime-api.js";
import type { CliqRuntime, ParsedCliqInbound } from "./inbound.js";

/** Label shown in the pairing store UI / diagnostics for a Cliq sender id. */
export const CLIQ_PAIRING_ID_LABEL = "cliqSenderId";

/** Message delivered to a sender once their pairing request is approved. */
export const CLIQ_PAIRING_APPROVED_MESSAGE =
  "OpenClaw: your access has been approved. You can now message the bot directly.";

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
  client?: Pick<CliqClient, "sendMessage">;
  onReplyError?: (err: unknown) => void;
}

export interface IssueCliqPairingChallengeResult {
  created: boolean;
  code?: string;
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
  const { runtime, account, parsed, env, client, onReplyError } = params;
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

  return { created: true, code: upserted.code };
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
