/**
 * Event-triggered, bounded recovery for inbound Cliq messages that exist in a
 * chat but never reached the webhook turn (issue #229).
 *
 * The webhook remains primary ingress. Catch-up runs only after a new,
 * admitted direct-message webhook turn; it has no timer, no polling loop, and
 * no Cliq MCP dependency. A persisted opaque native-message cursor establishes
 * a safe lower bound, while the current live message is content-anchored in
 * the same history window. Without both safety facts we dispatch nothing.
 */

import type { CliqChatMessageRef, ResolvedCliqAccount } from "./client.js";
import type { ParsedCliqInbound } from "./inbound.js";
import { parseCliqForwardContext } from "./inbound-forward.js";

export const DEFAULT_CLIQ_INBOUND_CATCHUP_LIMIT = 50;
export const MAX_CLIQ_INBOUND_CATCHUP_LIMIT = 50;

export interface CliqInboundCatchupResult {
  attempted: boolean;
  reason:
    | "disabled"
    | "group"
    | "missing_chat_id"
    | "missing_refresh_token"
    | "history_fetch_failed"
    | "empty_history"
    | "unanchored_live"
    | "baselined"
    | "nothing_to_recover"
    | "recovered";
  /** Historic records, oldest-first, excluding the current live webhook. */
  candidates: CliqChatMessageRef[];
  /** Opaque native message id to persist only after a complete scan. */
  advanceCursorTo?: string;
}

/**
 * Convert one trusted history record into the normalized inbound model. The
 * caller must run normal dedupe before dispatch. We do not invent data:
 * records without sender identity, native id, or readable content are dropped.
 */
export function parseCliqHistoryMessage(
  entry: CliqChatMessageRef,
  live: ParsedCliqInbound,
): ParsedCliqInbound | null {
  const senderId = entry.senderId?.trim();
  const messageId = entry.messageId?.trim();
  if (!senderId || !messageId || !hasRecoverableInboundContent(entry)) return null;
  const forward = entry.messageType === "forwarded" && entry.forwardInfo !== undefined
    ? parseCliqForwardContext({ forwarded_message: entry.forwardInfo })
    : undefined;
  const text = entry.text?.trim() || forward?.text || fileFallbackText(entry);
  if (!text) return null;
  return {
    text,
    messageId,
    timestamp: entry.timestamp ?? live.timestamp,
    senderId,
    senderName: entry.senderName?.trim() || senderId,
    senderEmail: entry.senderEmail,
    organization: undefined,
    chatId: live.chatId,
    channelId: undefined,
    channelName: undefined,
    channelUniqueName: undefined,
    isGroup: false,
    isMention: false,
    mentionIds: [],
    attachments: entry.file?.id
      ? [{
          fileId: entry.file.id,
          fileName: entry.file.name,
          mimeType: entry.file.type,
        }]
      : [],
    threadId: undefined,
    replyTo: undefined,
    confirmAction: undefined,
    pairingAction: undefined,
    formName: undefined,
    formValues: undefined,
    forward,
    handler: "catchup",
  };
}

/**
 * Inspect one bounded recent-history window. Cliq returns recent messages
 * newest-first; this selection reverses only the recoverable range so callers
 * dispatch oldest-first. The current webhook must match a *newest* same-sender
 * same-text history entry. If it cannot, no cursor advances and no historic
 * message is replayed — a false negative is safer than a duplicate tool turn.
 */
export function selectCliqInboundCatchupCandidates(params: {
  history: readonly CliqChatMessageRef[];
  live: ParsedCliqInbound;
  account: Pick<ResolvedCliqAccount, "botId" | "botName" | "selfSenderIds">;
  cursor?: string;
}): { candidates: CliqChatMessageRef[]; advanceCursorTo?: string; anchored: boolean } {
  if (params.live.isGroup || !params.live.chatId) {
    return { candidates: [], anchored: false };
  }
  const anchorIndex = findLiveHistoryAnchor(params.history, params.live);
  if (anchorIndex < 0) return { candidates: [], anchored: false };
  const anchor = params.history[anchorIndex];
  const anchorId = anchor?.messageId?.trim();
  if (!anchorId) return { candidates: [], anchored: false };

  // There is no replay-safe history boundary on first opt-in. Seed from the
  // live message and recover only messages missed *after* that baseline.
  if (!params.cursor) {
    return { candidates: [], advanceCursorTo: anchorId, anchored: true };
  }

  const self = new Set(
    [params.account.botId, params.account.botName, ...(params.account.selfSenderIds ?? [])]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.toLowerCase()),
  );
  const cursorIndex = params.history.findIndex(
    (entry) => entry.messageId?.trim() === params.cursor,
  );
  // History is newest-first. If the cursor is present, only entries between
  // live anchor and cursor are newer than that persisted lower bound. When it
  // fell out of the bounded window, every record behind the anchor is newer.
  const newestExclusive = anchorIndex;
  const oldestExclusive = cursorIndex >= 0 ? cursorIndex : params.history.length;
  const eligibleNewestFirst = params.history.slice(newestExclusive + 1, oldestExclusive);
  const seen = new Set<string>();
  const candidates: CliqChatMessageRef[] = [];
  for (const entry of [...eligibleNewestFirst].reverse()) {
    const id = entry.messageId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (entry.chatId && entry.chatId !== params.live.chatId) continue;
    const senderId = entry.senderId?.trim();
    if (!senderId || self.has(senderId.toLowerCase())) continue;
    if (!hasRecoverableInboundContent(entry)) continue;
    candidates.push(entry);
  }
  return { candidates, advanceCursorTo: anchorId, anchored: true };
}

/**
 * Fetch and select a one-shot recovery window. A caller owns dispatch and
 * cursor persistence; this boundary guarantees a failed history read cannot
 * affect the already-admitted live turn.
 */
export async function inspectCliqInboundCatchup(params: {
  account: Pick<ResolvedCliqAccount, "refreshToken" | "inboundCatchup" | "botId" | "botName" | "selfSenderIds">;
  live: ParsedCliqInbound;
  cursor?: string;
  listChatMessages: (chatId: string, opts?: { limit?: number }) => Promise<CliqChatMessageRef[]>;
  onError?: (err: unknown, info: { kind: string }) => void;
}): Promise<CliqInboundCatchupResult> {
  if (!params.account.inboundCatchup?.enabled) {
    return { attempted: false, reason: "disabled", candidates: [] };
  }
  if (params.live.isGroup) {
    return { attempted: false, reason: "group", candidates: [] };
  }
  if (!params.live.chatId) {
    return { attempted: false, reason: "missing_chat_id", candidates: [] };
  }
  if (!params.account.refreshToken) {
    return { attempted: false, reason: "missing_refresh_token", candidates: [] };
  }
  const limit = Math.max(
    1,
    Math.min(
      params.account.inboundCatchup?.limit || DEFAULT_CLIQ_INBOUND_CATCHUP_LIMIT,
      MAX_CLIQ_INBOUND_CATCHUP_LIMIT,
    ),
  );
  let history: CliqChatMessageRef[];
  try {
    history = await params.listChatMessages(params.live.chatId, { limit });
  } catch (err) {
    params.onError?.(err, { kind: "inbound-catchup-history-fetch" });
    return { attempted: true, reason: "history_fetch_failed", candidates: [] };
  }
  if (!Array.isArray(history) || history.length === 0) {
    return { attempted: true, reason: "empty_history", candidates: [] };
  }
  const selected = selectCliqInboundCatchupCandidates({
    history,
    live: params.live,
    account: params.account,
    cursor: params.cursor,
  });
  if (!selected.anchored) {
    return { attempted: true, reason: "unanchored_live", candidates: [] };
  }
  if (!params.cursor) {
    return {
      attempted: true,
      reason: "baselined",
      candidates: [],
      advanceCursorTo: selected.advanceCursorTo,
    };
  }
  return {
    attempted: true,
    reason: selected.candidates.length > 0 ? "recovered" : "nothing_to_recover",
    candidates: selected.candidates,
    advanceCursorTo: selected.advanceCursorTo,
  };
}

function findLiveHistoryAnchor(
  history: readonly CliqChatMessageRef[],
  live: ParsedCliqInbound,
): number {
  const liveText = live.text.trim();
  if (!liveText || !live.senderId) return -1;
  // The list is newest-first; the first equality is the actual current event
  // even when a sender deliberately repeats the same message body.
  return history.findIndex((entry) =>
    entry.chatId === live.chatId &&
    entry.senderId?.trim() === live.senderId &&
    entry.text?.trim() === liveText,
  );
}

function hasRecoverableInboundContent(entry: CliqChatMessageRef): boolean {
  return Boolean(
    entry.text?.trim() ||
      entry.file?.id ||
      entry.file?.name ||
      (entry.messageType === "forwarded" && entry.forwardInfo !== undefined),
  );
}

function fileFallbackText(entry: CliqChatMessageRef): string | undefined {
  if (!entry.file) return undefined;
  return entry.file.name ? `<file: ${entry.file.name}>` : "<file>";
}
