/**
 * Stop / abort intent detection for the Cliq channel.
 *
 * Zoho Cliq has no first-class "cancel the running turn" webhook event, so a
 * user interrupts the in-flight agent run by sending a stop intent as an
 * ordinary message (`stop`, `/stop`, `esc`, plus common localized equivalents
 * such as `arrête` / `停止` / `стоп`). The OpenClaw runtime already ships a
 * shared abort detector — `isAbortRequestText` from
 * `openclaw/plugin-sdk/reply-runtime` — and a fast-abort dispatch path
 * (`tryFastAbortFromMessage` inside `dispatchReplyFromConfig`) that, when the
 * inbound turn is recognized as an *authorized* abort, cancels the active run
 * for the session (`acpManager.cancelSession` + `abortSessionRunTarget` +
 * cleared followup queues), stops spawned sub-agents, and replies with the
 * canonical `formatAbortReplyText` ("⚙️ Agent was aborted.") through the
 * channel's own `deliver` callback. That is exactly the "interrupt the
 * in-flight agent run instead of queueing another turn" behavior the roadmap
 * asks for — we only have to (a) recognize the intent with the SAME trigger
 * set every other channel uses and (b) mark the turn as an authorized command
 * so the SDK's abort path honors it.
 *
 * Why we delegate the trigger list: the SDK's `ABORT_TRIGGERS` set is the
 * shared source of truth across every channel (Telegram, Discord, …). Keeping
 * a Cliq-specific copy would drift out of sync the moment a new localized
 * equivalent is added upstream. Re-exporting the SDK helper keeps one
 * authoritative list.
 *
 * Why `CommandSource: "text"` + `CommandAuthorized: true`: the SDK's abort
 * authorization gate (`resolveCommandSenderAuthorization`) returns
 * `commandAuthorized && (isOwnerForCommands || nativeCommandAuthorized)` for
 * channels without a configured `commands.allowFrom`. Cliq ships no
 * `commands.allowFrom` and no owner allowlist, so `isOwnerForCommands` is
 * `true` by default and the gate collapses to `commandAuthorized`. The
 * `finalizeInboundContext` finalizer derives `CommandAuthorized` from
 * `CommandTurn.authorized`, which is itself derived from `CommandSource`:
 * only `source === "text"` or `"native"` survive as `authorized: true`; a
 * plain `"message"` source is forced to `authorized: false`. So to make the
 * abort stick we mark the turn as a text-command turn. This does NOT fire a
 * command handler — `stop` carries no registered command name, so the
 * runtime's command-gate finds no match and falls through to the abort path,
 * which runs before agent dispatch.
 */

import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";

/**
 * Whether an inbound Cliq message text is a stop / abort intent. Wraps the
 * SDK's shared `isAbortRequestText` so the trigger set (`stop`, `/stop`,
 * `esc`, `halt`, `arrête`, `停止`, `стоп`, …) matches every other channel
 * exactly. The input is the mention-stripped body the agent will see — the
 * same string the SDK's `tryFastAbortFromMessage` re-checks internally, so the
 * two detections agree. The optional `botName` is forwarded to the SDK helper
 * so a `/stop@<botName>` suffix (Cliq's slash-command + bot-handle form) is
 * normalized away even when the caller passes the un-stripped text.
 */
export function isCliqAbortIntent(
  text: string | undefined | null,
  botName?: string,
): boolean {
  if (!text) return false;
  return isAbortRequestText(text, botName ? { botUsername: botName } : undefined);
}

/**
 * The inbound-context fields the SDK's `tryFastAbortFromMessage` fast-abort
 * path needs to (a) recognize the turn as an authorized command and (b)
 * target the in-flight run for the inbound session. Spread onto the
 * `finalizeInboundContext` input for an abort-intent turn so the SDK aborts
 * the active run + sends the "Stopped." reply via the channel's `deliver`
 * callback instead of queueing a new agent turn.
 *
 * Returning a fresh object each call keeps the ctx payload mutation-free for
 * the finalizer's `value !== undefined && ctx[key] === undefined` merge.
 */
export function cliqAbortCtxFields(): {
  CommandSource: "text";
  CommandAuthorized: true;
} {
  return { CommandSource: "text", CommandAuthorized: true };
}
