/**
 * Default-visible inbound outcomes for `/cliq/webhook` (issue #232).
 *
 * The webhook has many paths that acknowledge Cliq with `200` **without**
 * creating an agent turn: self-message protection, dedupe, admission, pairing,
 * mention gating, welcome replays, unreadable bodies and parser rejects.
 * Historically most of those logged at `debug` — or nothing at all — so a
 * default gateway/journald view showed no inbound line even though Zoho had
 * posted successfully.
 *
 * That is the same operational ambiguity issue #224 fixed for exactly one
 * branch (parser-null). During the 2026-09-05 forward incident it made a
 * short Zoho handler execution with `output: {}` indistinguishable between
 * "the POST never arrived" and "the POST arrived and was silently skipped" —
 * see issue #227. Until every non-dispatch path is visible at the default log
 * level, that boundary cannot be proven from the gateway side.
 *
 * ## Contract
 *
 * Every authenticated inbound that does not create an agent turn emits
 * **exactly one** line from this module, built from a small stable vocabulary
 * so doctor/metrics can match on it without parsing prose.
 *
 * ## Safety
 *
 * These lines are emitted at `warn`, i.e. into the default operator view, so
 * they must never carry user content. Only a fixed reason code plus opaque
 * identifiers (message id, sender id, dedupe kind, admission reason code) are
 * included. Message text, attachment names, form values, display names, email
 * addresses, handler scripts, tokens and the webhook secret are never passed
 * here — `formatCliqInboundSkip` has no parameter that could carry them.
 */

/**
 * The stable skip vocabulary. Keep these codes append-only: doctor output,
 * dashboards and operator greps match on them.
 *
 *  - `empty_body` — authenticated POST whose body was empty/unparseable.
 *  - `parser_rejected` — body parsed as JSON but yielded no usable message.
 *  - `self` — the bot's own message (or a configured `selfSenderIds` bot).
 *  - `duplicate` — dedupe tombstone hit; already processed.
 *  - `inflight` — dedupe claim held by an in-flight dispatch of the same id.
 *  - `not_mentioned` — group message that did not address the bot.
 *  - `not_admitted` — denied by DM/group admission policy.
 *  - `pairing` — unknown sender routed into the pairing challenge flow.
 *  - `pairing_action` — approval/deny card click; a control message, not a turn.
 *  - `welcome_skipped` — a replayed subscribe event, already greeted.
 */
export const CLIQ_INBOUND_SKIP_REASONS = [
  "empty_body",
  "parser_rejected",
  "self",
  "duplicate",
  "inflight",
  "not_mentioned",
  "not_admitted",
  "pairing",
  "pairing_action",
  "welcome_skipped",
] as const;

export type CliqInboundSkipReason = (typeof CLIQ_INBOUND_SKIP_REASONS)[number];

/** Stable prefix every skip line carries, for greps and log pipelines. */
export const CLIQ_INBOUND_SKIP_PREFIX = "[cliq] inbound skipped";

export interface CliqInboundSkipInfo {
  /** Stable reason code from {@link CLIQ_INBOUND_SKIP_REASONS}. */
  reason: CliqInboundSkipReason;
  /**
   * The Cliq message id (or the synthetic `evt:`/`syn:` id) when the payload
   * parsed far enough to have one. Opaque identifier, never content.
   */
  messageId?: string;
  /** Zoho user id of the sender. Opaque identifier, never a name or email. */
  senderId?: string;
  /**
   * A short machine-readable qualifier — an admission reason code
   * (`not_in_allowlist`), a matched self-message *field name*, or a parser
   * rejection summary that is already value-free by construction.
   *
   * Must never contain message text or any other user content.
   */
  detail?: string;
}

/**
 * Render one default-visible, value-free skip line.
 *
 * Shape: `[cliq] inbound skipped: <reason> (message=<id> sender=<id> detail=<d>)`
 * with absent fields omitted entirely, so a skip before parsing still produces
 * a useful line.
 */
export function formatCliqInboundSkip(info: CliqInboundSkipInfo): string {
  const parts: string[] = [];
  if (info.messageId) parts.push(`message=${info.messageId}`);
  if (info.senderId) parts.push(`sender=${info.senderId}`);
  if (info.detail) parts.push(`detail=${info.detail}`);
  const suffix = parts.length > 0 ? ` (${parts.join(" ")})` : "";
  return `${CLIQ_INBOUND_SKIP_PREFIX}: ${info.reason}${suffix}`;
}

/**
 * Map a dedupe claim kind to its skip reason. `claimed` means the message is
 * ours to process and therefore has no skip reason.
 */
export function cliqDedupeSkipReason(
  kind: "claimed" | "duplicate" | "inflight",
): CliqInboundSkipReason | null {
  if (kind === "duplicate") return "duplicate";
  if (kind === "inflight") return "inflight";
  return null;
}
