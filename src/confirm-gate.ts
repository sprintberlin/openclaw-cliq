/**
 * Confirmation gate for sensitive inbound actions (Phase 3 — the remaining
 * piece of the interactive status card item).
 *
 * When `thinking.mode === "card"` AND `thinking.confirm` is set, an inbound
 * message that looks sensitive is NOT dispatched to the agent immediately.
 * Instead the inbound path posts a `prompt`-theme Message Card (titled with
 * `thinking.confirmText`, default `⚠️ Confirm action?`) carrying two
 * `invoke.bot` buttons:
 *  - **Confirm** — re-posts the original message to the bot prefixed with the
 *    {@link CLIQ_CONFIRM_SENTINEL} sentinel. The next webhook call strips the
 *    sentinel, marks the turn `confirmAction: "confirm"`, and dispatches the
 *    agent normally (the gate is skipped so there is no re-prompt loop).
 *  - **Cancel** — posts the {@link CLIQ_CANCEL_SENTINEL} sentinel. The next
 *    webhook call marks the turn `confirmAction: "cancel"` and replies with
 *    `thinking.cancelledText` (default `🚫 Cancelled.`) WITHOUT dispatching
 *    the agent.
 *
 * The button clicks arrive as ordinary inbound messages via the bot's Message
 * handler (`invoke.bot` posts `message` to the bot) — no Cliq Context handler
 * is required, so this works with the existing Deluge webhook wiring. The
 * gate is a UX guardrail, not a security boundary: the agent's own tool /
 * permission policy still applies to the confirmed dispatch. A user manually
 * crafting a `__cliq_confirm__ …` message merely dispatches the text after
 * the sentinel — exactly what they could have sent directly.
 *
 * The original message text is encoded verbatim after the confirm sentinel.
 * Cliq caps a single message at 5000 chars; the sentinel + button payload
 * must stay well under that. Messages longer than
 * {@link CLIQ_CONFIRM_MAX_TEXT_LEN} bypass the gate and dispatch normally
 * (we cannot safely encode them in a button payload).
 */
import type { CliqButton } from "./presentation.js";
import type { ParsedCliqInbound } from "./inbound.js";
import type { ResolvedCliqAccount } from "./client.js";
import {
  DEFAULT_CLIQ_CONFIRM_TEXT,
  DEFAULT_CLIQ_CONFIRM_LABEL,
  DEFAULT_CLIQ_CANCEL_LABEL,
  DEFAULT_CLIQ_CANCELLED_TEXT,
} from "./client.js";

/**
 * Prefix the Confirm button's `invoke.bot` message carries, followed by a
 * single space and the original inbound text. Detected on the next webhook
 * call to skip the gate and dispatch the original text.
 */
export const CLIQ_CONFIRM_SENTINEL = "__cliq_confirm__";

/**
 * Prefix the Cancel button's `invoke.bot` message carries. Detected on the
 * next webhook call to short-circuit the turn with the cancelled reply.
 */
export const CLIQ_CANCEL_SENTINEL = "__cliq_cancel__";

/**
 * Max original-text length that can be safely encoded in a confirm button
 * payload. The sentinel + space + text must stay well under Cliq's 5000-char
 * message cap; 1500 leaves ample headroom for the sentinel, button JSON
 * wrapping, and Deluge forwarding overhead. Longer messages bypass the gate.
 */
export const CLIQ_CONFIRM_MAX_TEXT_LEN = 1500;

/**
 * Default destructive-verb keyword list used when `thinking.confirm ===
 * "sensitive"` and no `thinking.confirmKeywords` is configured. Matched as
 * case-insensitive word boundaries against the cleaned inbound text. The list
 * is deliberately conservative — it favors precision (few false gates) over
 * recall, since a false gate adds a friction step to a benign turn.
 */
export const DEFAULT_CLIQ_CONFIRM_KEYWORDS = [
  "delete",
  "drop",
  "reset",
  "wipe",
  "purge",
  "remove",
  "destroy",
  "overwrite",
  "truncate",
  "decommission",
  "terminate",
  "shutdown",
  "reboot",
  "force",
  "production",
  "prod",
  "live",
  "deploy",
  "rollback",
  "execute",
  "run",
  "sudo",
  "rm ",
  "drop table",
  "drop database",
];

/** Default title for the confirm prompt card. */
export { DEFAULT_CLIQ_CONFIRM_TEXT };

/** Default Confirm button label (≤30 chars per the v3 Message Cards docs). */
export { DEFAULT_CLIQ_CONFIRM_LABEL };

/** Default Cancel button label. */
export { DEFAULT_CLIQ_CANCEL_LABEL };

/** Default reply text posted when the user cancels a gated action. */
export { DEFAULT_CLIQ_CANCELLED_TEXT };

/**
 * Result of inspecting an inbound message text for a confirm/cancel sentinel
 * posted by a confirm-card button click. `text` is the message with any
 * sentinel stripped (the original inbound text on a confirm; empty on a
 * cancel).
 */
export interface CliqConfirmParse {
  action: "confirm" | "cancel" | undefined;
  text: string;
}

/**
 * Inspect a raw inbound message text for a confirm/cancel sentinel. Returns
 * `{ action, text }` where `text` is the original message with the sentinel
 * removed (on confirm: the text after the sentinel; on cancel: empty). When
 * no sentinel is present, `action` is `undefined` and `text` is the input
 * verbatim (trimmed). Trims whitespace around the recovered original text.
 */
export function parseCliqConfirmAction(raw: string): CliqConfirmParse {
  const text = raw ?? "";
  if (text.startsWith(CLIQ_CONFIRM_SENTINEL + " ")) {
    return {
      action: "confirm",
      text: text.slice(CLIQ_CONFIRM_SENTINEL.length + 1).trim(),
    };
  }
  if (text === CLIQ_CONFIRM_SENTINEL || text.startsWith(CLIQ_CONFIRM_SENTINEL)) {
    // A confirm sentinel with no original text — treat as a confirm of an
    // empty message (will dispatch nothing useful). Strip + return empty.
    return { action: "confirm", text: "" };
  }
  if (text === CLIQ_CANCEL_SENTINEL || text.startsWith(CLIQ_CANCEL_SENTINEL)) {
    return { action: "cancel", text: "" };
  }
  return { action: undefined, text: text.trim() };
}

/**
 * Whether the confirm gate is armed for this account — i.e. `thinking.mode
 * === "card"` (the card surface the prompt renders on) AND `thinking.confirm`
 * is `"sensitive"` or `"always"`. The gate also inherits the thinking-card
 * preconditions (a `refreshToken` for edits, streaming preview off) which the
 * inbound path enforces separately before posting any card.
 */
export function isConfirmGateArmed(account: ResolvedCliqAccount): boolean {
  if (account.thinking.mode !== "card") return false;
  const mode = account.thinking.confirm;
  return mode === "sensitive" || mode === "always";
}
/**
 * Whether an inbound message is "sensitive" and should be gated behind a
 * confirm card. Returns `true` when the gate is armed AND:
 *  - `thinking.confirm === "always"` (every turn is gated), OR
 *  - `thinking.confirm === "sensitive"` AND the cleaned text matches any
 *    keyword (case-insensitive word-boundary match against
 *    `thinking.confirmKeywords`, defaulting to
 *    {@link DEFAULT_CLIQ_CONFIRM_KEYWORDS}).
 *
 * Messages longer than {@link CLIQ_CONFIRM_MAX_TEXT_LEN} are never gated
 * (they cannot be safely encoded in the confirm button payload) — they
 * dispatch normally. A turn already carrying a `confirmAction` (a button-click
 * re-dispatch) is never gated (loop prevention).
 */
export function isSensitiveInbound(
  parsed: ParsedCliqInbound,
  account: ResolvedCliqAccount,
): boolean {
  if (!isConfirmGateArmed(account)) return false;
  if (parsed.confirmAction) return false;
  const text = parsed.text ?? "";
  if (!text) return false;
  if (text.length > CLIQ_CONFIRM_MAX_TEXT_LEN) return false;
  const mode = account.thinking.confirm;
  if (mode === "always") return true;
  if (mode !== "sensitive") return false;
  const keywords = account.thinking.confirmKeywords ?? DEFAULT_CLIQ_CONFIRM_KEYWORDS;
  if (keywords.length === 0) return false;
  const haystack = ` ${text.toLowerCase()} `;
  for (const raw of keywords) {
    const kw = raw?.trim().toLowerCase();
    if (!kw) continue;
    // Multi-word keywords (e.g. "drop table") match as a substring; single
    // words match on a word boundary so "deleted" matches "delete" but
    // "reseat" does not match "reset". A word boundary here is any non-
    // alphanumeric run (space, punctuation, start/end).
    if (kw.includes(" ")) {
      if (haystack.includes(kw)) return true;
      continue;
    }
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(kw)}([^a-z0-9]|$)`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the two `invoke.bot` buttons for a confirm prompt card. The Confirm
 * button carries `<sentinel> <originalText>` as its `data` (the message the
 * Cliq Message handler receives on click); the Cancel button carries just the
 * cancel sentinel. Both address the bot by `botId` (required for
 * `invoke.bot` — without it the button is dropped by the v3 renderer, so the
 * gate is skipped when no botId is configured). Returns `null` when `botId`
 * is absent or the original text cannot be safely encoded (over cap).
 */
export function buildConfirmCardButtons(opts: {
  botId?: string;
  originalText: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): { confirm: CliqButton; cancel: CliqButton } | null {
  const { botId, originalText } = opts;
  if (!botId) return null;
  if (originalText.length > CLIQ_CONFIRM_MAX_TEXT_LEN) return null;
  const confirm: CliqButton = {
    label: opts.confirmLabel?.trim() || DEFAULT_CLIQ_CONFIRM_LABEL,
    type: "post",
    action: "invoke",
    data: `${CLIQ_CONFIRM_SENTINEL} ${originalText}`,
  };
  const cancel: CliqButton = {
    label: opts.cancelLabel?.trim() || DEFAULT_CLIQ_CANCEL_LABEL,
    type: "post",
    action: "invoke",
    data: CLIQ_CANCEL_SENTINEL,
  };
  return { confirm, cancel };
}
